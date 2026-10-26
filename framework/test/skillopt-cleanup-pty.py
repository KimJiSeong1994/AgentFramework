#!/usr/bin/python3
"""Observe cleanup cancellation through a real controlling PTY."""

import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import stat
import struct
import sys
import termios
import time


MAX_CAPTURE_BYTES = 64 * 1024
PROMPT_TIMEOUT_SECONDS = 25
SIGNAL_TIMEOUT_SECONDS = 8
PTY_SETUP_TIMEOUT_SECONDS = 5


class HarnessFailure(Exception):
    def __init__(self, code, message, evidence=None):
        super().__init__(message)
        self.code = code
        self.evidence = evidence or {}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--state-home", required=True)
    parser.add_argument("--report")
    return parser.parse_args()


def private_directory(parent, name):
    path = os.path.join(parent, name)
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
            stat.S_IMODE(info.st_mode) & 0o077):
        raise HarnessFailure("user_config_isolation_failed", "isolated CLI configuration path is not a private owned directory")
    return path


def child_environment(state_home):
    if not os.path.isabs(state_home) or os.path.realpath(state_home) != state_home:
        raise HarnessFailure("state_home_invalid", "the test-owned stateHome path is not canonical and absolute")
    state_info = os.lstat(state_home)
    if (not stat.S_ISDIR(state_info.st_mode) or state_info.st_uid != os.getuid() or
            stat.S_IMODE(state_info.st_mode) & 0o077):
        raise HarnessFailure("state_home_invalid", "the test-owned stateHome is not a private owned directory")

    home = private_directory(state_home, "cleanup-pty-home")
    xdg_config = private_directory(home, "config")
    xdg_cache = private_directory(home, "cache")
    xdg_data = private_directory(home, "data")
    xdg_state = private_directory(home, "xdg-state")
    temp_dir = private_directory(home, "tmp")
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": home,
        "OTTER_STATE_HOME": state_home,
        "XDG_CONFIG_HOME": xdg_config,
        "XDG_CACHE_HOME": xdg_cache,
        "XDG_DATA_HOME": xdg_data,
        "XDG_STATE_HOME": xdg_state,
        "TMPDIR": temp_dir,
        "LANG": "C",
        "LC_ALL": "C",
        "TERM": "dumb",
        "NO_COLOR": "1",
    }


def terminal_state(fd):
    attrs = termios.tcgetattr(fd)

    def serialize(value):
        if isinstance(value, bytes):
            return value.hex()
        return int(value)

    def fields(value):
        return {
            "iflag": value[0],
            "oflag": value[1],
            "cflag": value[2],
            "lflag": value[3],
            "ispeed": value[4],
            "ospeed": value[5],
            "cc": [serialize(item) for item in value[6]],
        }

    serializable = fields(attrs)
    normalized = list(attrs)
    normalized[3] &= ~getattr(termios, "PENDIN", 0)
    normalized[6] = tuple(normalized[6])
    return attrs, serializable, fields(normalized)


def write_control_record(fd, value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode("ascii")
    if len(data) > 16 * 1024:
        raise RuntimeError("supervisor control record exceeded the 16 KiB bound")
    offset = 0
    while offset < len(data):
        offset += os.write(fd, data[offset:])


def run_cli_child(slave, control_fd, bun, cwd, argv, env, session_id):
    try:
        os.setpgid(0, 0)
        for descriptor in (0, 1, 2):
            os.dup2(slave, descriptor)
        if slave > 2:
            os.close(slave)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        foreground_deadline = time.monotonic() + PTY_SETUP_TIMEOUT_SECONDS
        while os.tcgetpgrp(0) != os.getpgrp():
            if time.monotonic() >= foreground_deadline:
                raise RuntimeError("CLI child did not become foreground on its controlling PTY")
            time.sleep(0.005)
        if (not all(os.isatty(descriptor) for descriptor in (0, 1, 2)) or
                os.getsid(0) != session_id or os.tcgetpgrp(0) != os.getpgrp()):
            raise RuntimeError("CLI child is not attached to the verified foreground controlling PTY")
        write_control_record(control_fd, {
            "kind": "cli-ready", "actualChildPid": os.getpid(), "actualChildSessionId": os.getsid(0),
            "actualChildProcessGroup": os.getpgrp(), "stdinIsTTY": os.isatty(0),
            "stdoutIsTTY": os.isatty(1), "stderrIsTTY": os.isatty(2),
            "foregroundProcessGroup": os.tcgetpgrp(0),
        })
        os.close(control_fd)
        os.chdir(cwd)
        os.execve(bun, argv, env)
    except BaseException:
        try:
            os.write(2, b"PTY CLI child setup or exec failed\n")
        except OSError:
            pass
        os._exit(126)


def supervisor(slave, control_fd, bun, cwd, argv, env):
    child_pid = None
    child_wait_status = None

    def stop_supervisor(_signum, _frame):
        raise InterruptedError("PTY supervisor received its bounded reap request")

    try:
        # Keep this session leader alive through the real CLI's exit and terminal snapshot.
        # The CLI gets a distinct foreground process group so Ctrl-C targets only that child.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, stop_supervisor)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        supervisor_pid = os.getpid()
        if os.getsid(0) != supervisor_pid or os.getpgrp() != supervisor_pid:
            raise RuntimeError("supervisor did not become its own session and process-group leader")

        child_pid = os.fork()
        if child_pid == 0:
            run_cli_child(slave, control_fd, bun, cwd, argv, env, supervisor_pid)
            os._exit(127)

        deadline = time.monotonic() + PTY_SETUP_TIMEOUT_SECONDS
        while True:
            try:
                child_group = os.getpgid(child_pid)
                child_session = os.getsid(child_pid)
            except ProcessLookupError:
                waited, wait_status = os.waitpid(child_pid, 0)
                child_wait_status = wait_status
                write_control_record(control_fd, {
                    "kind": "child-reaped", "actualChildPid": waited, "actualChildWaitStatus": wait_status,
                    "actualChildExitCode": child_exit_code(wait_status)[0],
                    "actualChildSignal": child_exit_code(wait_status)[1],
                })
                _, after_raw, after_normalized = terminal_state(slave)
                write_control_record(control_fd, {
                    "kind": "result", "setupError": "CLI child exited before acquiring its own foreground process group",
                    "actualChildPid": waited, "actualChildWaitStatus": wait_status,
                    "actualChildExitCode": child_exit_code(wait_status)[0],
                    "actualChildSignal": child_exit_code(wait_status)[1],
                    "terminalAfter": after_raw, "terminalAfterNormalized": after_normalized,
                    "supervisorPid": supervisor_pid, "supervisorAliveDuringTerminalSnapshot": os.getpid() == supervisor_pid,
                })
                os._exit(0)
            if child_group == child_pid and child_session == supervisor_pid:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("CLI child did not acquire its own process group within the PTY setup timeout")
            time.sleep(0.005)

        os.tcsetpgrp(slave, child_pid)
        foreground_group = os.tcgetpgrp(slave)
        session_id = os.getsid(0)
        if foreground_group != child_pid or session_id != supervisor_pid:
            raise RuntimeError("CLI child is not the PTY foreground group in the supervisor-owned session")
        write_control_record(control_fd, {
            "kind": "ready", "supervisorPid": supervisor_pid, "supervisorSessionId": os.getsid(0),
            "supervisorProcessGroup": os.getpgrp(), "actualChildPid": child_pid,
            "actualChildSessionId": child_session, "actualChildProcessGroup": child_group,
            "controllingTerminalVerified": os.isatty(slave), "foregroundProcessGroup": foreground_group,
        })

        waited, wait_status = os.waitpid(child_pid, 0)
        if waited != child_pid:
            raise RuntimeError("supervisor did not collect the actual CLI child")
        child_wait_status = wait_status
        child_code, child_signal = child_exit_code(wait_status)
        write_control_record(control_fd, {
            "kind": "child-reaped", "actualChildPid": child_pid, "actualChildWaitStatus": wait_status,
            "actualChildExitCode": child_code, "actualChildSignal": child_signal,
        })
        _, after_raw, after_normalized = terminal_state(slave)
        result = {
            "kind": "result", "actualChildPid": child_pid, "actualChildWaitStatus": wait_status,
            "actualChildExitCode": child_code, "actualChildSignal": child_signal,
            "terminalAfter": after_raw, "terminalAfterNormalized": after_normalized,
            "supervisorPid": supervisor_pid, "supervisorSessionId": os.getsid(0),
            "supervisorAliveDuringTerminalSnapshot": os.getpid() == supervisor_pid,
        }
        write_control_record(control_fd, result)
        os.close(control_fd)
        os._exit(0)
    except BaseException as error:
        if child_pid is not None and child_wait_status is None:
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.kill(child_pid, signal.SIGKILL)
            except OSError:
                pass
            reap_deadline = time.monotonic() + 2
            while time.monotonic() < reap_deadline:
                try:
                    waited, wait_status = os.waitpid(child_pid, os.WNOHANG)
                    if waited == child_pid:
                        child_wait_status = wait_status
                        break
                    time.sleep(0.01)
                except InterruptedError:
                    continue
                except ChildProcessError:
                    break
        try:
            write_control_record(control_fd, {
                "kind": "failure", "message": type(error).__name__ + ": " + str(error),
                "actualChildPid": child_pid, "actualChildWaitStatus": child_wait_status,
            })
        except OSError:
            pass
        os._exit(125)


def tty_input_ready(attrs):
    required_flags = termios.ICANON | termios.ECHO | termios.ISIG
    if attrs[3] & required_flags != required_flags:
        return False
    vintr = attrs[6][termios.VINTR]
    if isinstance(vintr, bytes):
        return vintr == b"\x03"
    return int(vintr) == 3


def prompt_pattern(run_id):
    encoded_id = run_id.encode("ascii")
    return re.compile(
        rb"Inspect the experiment scope, selected data, models, and budget first\. "
        rb"Type 'APPROVE " + encoded_id + rb" ([a-f0-9]{64})' or 'REJECT " +
        encoded_id + rb" \1 <reason>': "
    )


def append_capture(output, chunk):
    if len(output) + len(chunk) > MAX_CAPTURE_BYTES:
        raise HarnessFailure("capture_limit_exceeded", "actual PTY output exceeded the bounded capture size")
    output.extend(chunk)


def read_pty(master, output):
    try:
        chunk = os.read(master, 4096)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    if not chunk:
        return False
    append_capture(output, chunk)
    return True


def child_exit_code(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        try:
            name = signal.Signals(number).name
        except ValueError:
            name = "SIGNAL_" + str(number)
        return None, name
    return None, None


def read_control_records(fd, buffered, records, state):
    chunk = os.read(fd, 4096)
    if not chunk:
        state["control_eof"] = True
        return
    if len(buffered) + len(chunk) > 32 * 1024:
        raise HarnessFailure("control_limit_exceeded", "PTY supervisor control pipe exceeded its 32 KiB bound")
    buffered.extend(chunk)
    while True:
        newline = buffered.find(b"\n")
        if newline < 0:
            break
        line = bytes(buffered[:newline])
        del buffered[:newline + 1]
        if len(line) > 16 * 1024:
            raise HarnessFailure("control_limit_exceeded", "PTY supervisor record exceeded its 16 KiB bound")
        try:
            record = json.loads(line.decode("ascii"))
        except (UnicodeDecodeError, ValueError) as error:
            raise HarnessFailure("control_record_invalid", "PTY supervisor sent invalid structured evidence: " + str(error))
        if not isinstance(record, dict) or record.get("kind") not in ("child-reaped", "cli-ready", "ready", "result", "failure"):
            raise HarnessFailure("control_record_invalid", "PTY supervisor sent an unknown structured record")
        records.append(record)
        if record["kind"] == "child-reaped":
            state["actual_child_pid"] = record.get("actualChildPid")
            state["actual_child_wait_status"] = record.get("actualChildWaitStatus")
            state["actual_child_exit_code"] = record.get("actualChildExitCode")
            state["actual_child_signal"] = record.get("actualChildSignal")


def read_ready(master, control_fd, output, buffered, records, state):
    deadline = time.monotonic() + PTY_SETUP_TIMEOUT_SECONDS
    while True:
        ready_record = next((record for record in records if record["kind"] == "ready"), None)
        cli_ready_record = next((record for record in records if record["kind"] == "cli-ready"), None)
        for record in records:
            if record["kind"] == "failure":
                raise HarnessFailure("tty_mismatch", "PTY supervisor setup failed: " + str(record.get("message")))
            if record["kind"] == "result":
                raise HarnessFailure("tty_mismatch", "PTY CLI exited before a valid foreground controlling-terminal handshake")
        if ready_record and cli_ready_record:
            return ready_record, cli_ready_record
        if state["control_eof"]:
            raise HarnessFailure("tty_mismatch", "PTY supervisor closed its control pipe before a valid terminal handshake")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HarnessFailure("tty_mismatch", "PTY supervisor did not confirm the controlling foreground terminal before timeout")
        readers = [control_fd]
        if master >= 0:
            readers.append(master)
        ready, _, _ = select.select(readers, [], [], remaining)
        if not ready:
            continue
        if control_fd in ready:
            read_control_records(control_fd, buffered, records, state)
        if master in ready:
            if not read_pty(master, output):
                state["pty_output_eof"] = True


def drain_ready(master, output, state):
    if master < 0:
        return
    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            return
        if not read_pty(master, output):
            state["pty_output_eof"] = True
            return


def capture_cli(args):
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", args.run, re.IGNORECASE):
        raise HarnessFailure("run_id_invalid", "test fixture run ID is not a UUID")
    if not os.path.isabs(args.bun) or not os.path.isfile(args.bun) or not os.access(args.bun, os.X_OK):
        raise HarnessFailure("bun_unavailable", "the Bun test runtime executable is not an absolute executable file")
    if not os.path.isabs(args.cwd) or not os.path.isdir(args.cwd):
        raise HarnessFailure("cwd_invalid", "repository cwd is not an absolute directory")
    script = os.path.join(args.cwd, "scripts", "otter-skillopt.ts")
    if not os.path.isfile(script):
        raise HarnessFailure("cli_unavailable", "the actual cleanup CLI script is missing from the repository cwd")
    if not os.path.isabs(args.root):
        raise HarnessFailure("root_invalid", "cleanup root argument must be absolute")

    env = child_environment(args.state_home)
    argv = ["bun", "scripts/otter-skillopt.ts", "cleanup", "--root", args.root, "--run", args.run]
    output = bytearray()
    state = {
        "argv": argv,
        "controlling_tty_verified": False,
        "signal_sent": False,
        "actual_child_pid": None,
        "handshake_child_pid": None,
        "actual_child_process_group": None,
        "foreground_process_group": None,
        "actual_child_wait_status": None,
        "actual_child_exit_code": None,
        "actual_child_signal": None,
        "supervisor_pid": None,
        "supervisor_wait_status": None,
        "supervisor_exit_code": None,
        "supervisor_signal": None,
        "supervisor_reaped": False,
        "reap_timed_out": False,
        "control_eof": False,
        "pty_output_eof": False,
        "terminal_before": None,
        "terminal_after": None,
        "terminal_before_normalized": None,
        "terminal_after_normalized": None,
        "terminal_restored": False,
        "supervisor_alive_during_terminal_snapshot": False,
        "tty_canonical": False,
        "tty_echo": False,
        "tty_isig": False,
    }
    master = -1
    slave = -1
    control_read = -1
    control_write = -1
    pid = None
    failure = None
    report = None
    control_buffer = bytearray()
    control_records = []
    try:
        master, slave = pty.openpty()
        if not os.isatty(slave) or not hasattr(termios, "TIOCSCTTY"):
            raise HarnessFailure("tty_mismatch", "system PTY does not provide a controlling-terminal interface")
        if hasattr(termios, "TIOCSWINSZ"):
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        before_attrs, before_serializable, before_normalized = terminal_state(slave)
        state["terminal_before"] = before_serializable
        state["terminal_before_normalized"] = before_normalized
        state["tty_canonical"] = bool(before_attrs[3] & termios.ICANON)
        state["tty_echo"] = bool(before_attrs[3] & termios.ECHO)
        state["tty_isig"] = bool(before_attrs[3] & termios.ISIG)
        if not tty_input_ready(before_attrs):
            raise HarnessFailure("tty_mismatch", "PTY is not in canonical, echoing, ISIG mode with Ctrl-C as VINTR")

        control_read, control_write = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(master)
            os.close(control_read)
            supervisor(slave, control_write, args.bun, args.cwd, argv, env)
            os._exit(125)
        state["supervisor_pid"] = pid
        os.close(control_write)
        control_write = -1

        ready_record, cli_ready_record = read_ready(master, control_read, output, control_buffer, control_records, state)
        state["actual_child_pid"] = ready_record.get("actualChildPid")
        state["handshake_child_pid"] = ready_record.get("actualChildPid")
        state["actual_child_process_group"] = ready_record.get("actualChildProcessGroup")
        state["foreground_process_group"] = ready_record.get("foregroundProcessGroup")
        state["controlling_tty_verified"] = (
            ready_record.get("controllingTerminalVerified") is True and
            ready_record.get("supervisorPid") == pid and
            ready_record.get("supervisorSessionId") == pid and
            ready_record.get("supervisorProcessGroup") == pid and
            ready_record.get("actualChildPid") != pid and
            ready_record.get("actualChildSessionId") == pid and
            ready_record.get("actualChildProcessGroup") == ready_record.get("actualChildPid") and
            ready_record.get("foregroundProcessGroup") == ready_record.get("actualChildPid") and
            cli_ready_record.get("actualChildPid") == ready_record.get("actualChildPid") and
            cli_ready_record.get("actualChildSessionId") == pid and
            cli_ready_record.get("actualChildProcessGroup") == ready_record.get("actualChildPid") and
            cli_ready_record.get("foregroundProcessGroup") == ready_record.get("actualChildPid") and
            cli_ready_record.get("stdinIsTTY") is True and cli_ready_record.get("stdoutIsTTY") is True and
            cli_ready_record.get("stderrIsTTY") is True
        )
        if not state["controlling_tty_verified"]:
            raise HarnessFailure("tty_mismatch", "supervisor did not verify the actual CLI as foreground process group on its controlling PTY")
        os.close(slave)
        slave = -1

        matcher = prompt_pattern(args.run)
        prompt_deadline = time.monotonic() + PROMPT_TIMEOUT_SECONDS
        signal_deadline = None
        prompt_match = matcher.search(output)
        if prompt_match:
            sent = os.write(master, b"\x03")
            if sent != 1:
                raise HarnessFailure("signal_send_failed", "PTY did not accept exactly one Ctrl-C VINTR byte")
            state["signal_sent"] = True
            state["control_bytes_written_hex"] = "03"
            signal_deadline = time.monotonic() + SIGNAL_TIMEOUT_SECONDS

        result_record = None
        while result_record is None:
            deadline = signal_deadline if state["signal_sent"] else prompt_deadline
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if state["signal_sent"]:
                    raise HarnessFailure("signal_timeout", "cleanup CLI did not exit after the PTY-generated SIGINT")
                raise HarnessFailure("prompt_timeout", "exact cleanup approval prompt did not appear before the bounded timeout")
            readers = [control_read]
            if master >= 0:
                readers.append(master)
            ready, _, _ = select.select(readers, [], [], min(0.05, remaining))
            if master in ready:
                try:
                    got_output = read_pty(master, output)
                except OSError as error:
                    raise HarnessFailure("pty_read_failed", "failed to capture actual PTY output: " + str(error))
                if not got_output:
                    state["pty_output_eof"] = True
                if not state["signal_sent"] and got_output:
                    prompt_match = matcher.search(output)
                    if prompt_match:
                        sent = os.write(master, b"\x03")
                        if sent != 1:
                            raise HarnessFailure("signal_send_failed", "PTY did not accept exactly one Ctrl-C VINTR byte")
                        state["signal_sent"] = True
                        state["control_bytes_written_hex"] = "03"
                        signal_deadline = time.monotonic() + SIGNAL_TIMEOUT_SECONDS

            if control_read in ready:
                read_control_records(control_read, control_buffer, control_records, state)
                for record in control_records:
                    if record["kind"] == "failure":
                        raise HarnessFailure("supervisor_failed", "PTY supervisor failed: " + str(record.get("message")))
                    if record["kind"] == "result":
                        result_record = record
                        break

            if not state["supervisor_reaped"]:
                try:
                    waited, status = os.waitpid(pid, os.WNOHANG)
                except InterruptedError:
                    continue
                except ChildProcessError:
                    state["supervisor_reaped"] = True
                    waited, status = pid, None
                if waited == pid:
                    if status is not None:
                        state["supervisor_wait_status"] = status
                        state["supervisor_exit_code"], state["supervisor_signal"] = child_exit_code(status)
                    if result_record is None and state["control_eof"]:
                        raise HarnessFailure("supervisor_failed", "PTY supervisor exited without reporting actual CLI status and terminal snapshot")
            if state["control_eof"] and result_record is None:
                raise HarnessFailure("supervisor_failed", "PTY supervisor closed its control pipe without actual CLI status and terminal snapshot")

        if result_record.get("setupError"):
            state["actual_child_wait_status"] = result_record.get("actualChildWaitStatus")
            state["actual_child_exit_code"] = result_record.get("actualChildExitCode")
            state["actual_child_signal"] = result_record.get("actualChildSignal")
            raise HarnessFailure("tty_mismatch", str(result_record["setupError"]))
        if result_record.get("actualChildPid") != state["handshake_child_pid"]:
            raise HarnessFailure("child_identity_mismatch", "actual CLI wait status belongs to a different child than the PTY handshake")
        state["actual_child_wait_status"] = result_record.get("actualChildWaitStatus")
        state["actual_child_exit_code"] = result_record.get("actualChildExitCode")
        state["actual_child_signal"] = result_record.get("actualChildSignal")
        state["terminal_after"] = result_record.get("terminalAfter")
        state["terminal_after_normalized"] = result_record.get("terminalAfterNormalized")
        state["supervisor_alive_during_terminal_snapshot"] = result_record.get("supervisorAliveDuringTerminalSnapshot") is True
        if result_record.get("supervisorPid") != pid or result_record.get("supervisorSessionId") != pid:
            raise HarnessFailure("supervisor_invalid", "terminal snapshot was not measured by the original live session leader")
        if not state["supervisor_alive_during_terminal_snapshot"]:
            raise HarnessFailure("supervisor_invalid", "supervisor did not report itself alive during the post-CLI terminal snapshot")
        actual_status = state["actual_child_wait_status"]
        if not isinstance(actual_status, int):
            raise HarnessFailure("child_status_missing", "supervisor omitted the actual CLI waitpid status")
        actual_code, actual_signal = child_exit_code(actual_status)
        if actual_code != state["actual_child_exit_code"] or actual_signal != state["actual_child_signal"]:
            raise HarnessFailure("child_status_invalid", "actual CLI exit fields do not match the supervisor's waitpid status")
        state["exit_code"] = actual_code
        state["terminating_signal"] = actual_signal

        if not state["signal_sent"] or not prompt_match:
            raise HarnessFailure("no_prompt", "cleanup CLI exited without the exact interactive approval prompt")

        text = bytes(output).decode("utf-8", "replace")
        if '"reasonCode":"operator_decision_aborted"' not in text:
            raise HarnessFailure("signal_not_observed", "actual cleanup CLI output did not report operator_decision_aborted after SIGINT")
        if state["exit_code"] != 1 or state["terminating_signal"] is not None:
            raise HarnessFailure("unexpected_exit", "cleanup CLI did not handle SIGINT and exit through its cancellation error path")
        if '"state":"CONSENT_REQUIRED"' not in text:
            raise HarnessFailure("prompt_context_missing", "approval prompt was not preceded by cleanup consent metadata")

        consent_metadata = None
        error_metadata = None
        for line in text.splitlines():
            candidate = line.strip()
            if not candidate.startswith("{"):
                continue
            try:
                value = json.loads(candidate)
            except (ValueError, TypeError):
                continue
            if value.get("operation") == "cleanup" and value.get("state") == "CONSENT_REQUIRED":
                consent_metadata = value
            if value.get("reasonCode") == "operator_decision_aborted":
                error_metadata = value
        if not consent_metadata or consent_metadata.get("runId") != args.run or not error_metadata:
            raise HarnessFailure("cli_output_invalid", "actual PTY output did not contain matching cleanup prompt and cancellation records")

        state["terminal_restored"] = state["terminal_before_normalized"] == state["terminal_after_normalized"]
        if not isinstance(state["terminal_after"], dict) or not isinstance(state["terminal_after_normalized"], dict):
            raise HarnessFailure("terminal_snapshot_missing", "supervisor did not send actual post-CLI termios snapshots")
        if not state["terminal_restored"]:
            raise HarnessFailure("terminal_not_restored", "actual PTY termios snapshots differ after cleanup CLI cancellation")

        reap_deadline = time.monotonic() + 3
        while not state["supervisor_reaped"] and time.monotonic() < reap_deadline:
            readers = [control_read]
            if master >= 0:
                readers.append(master)
            ready, _, _ = select.select(readers, [], [], 0.02)
            if master in ready:
                if not read_pty(master, output):
                    state["pty_output_eof"] = True
            if control_read in ready:
                read_control_records(control_read, control_buffer, control_records, state)
            try:
                waited, status = os.waitpid(pid, os.WNOHANG)
            except InterruptedError:
                continue
            if waited == pid:
                state["supervisor_wait_status"] = status
                state["supervisor_exit_code"], state["supervisor_signal"] = child_exit_code(status)
                state["supervisor_reaped"] = True
        if not state["supervisor_reaped"]:
            raise HarnessFailure("supervisor_reap_timeout", "supervisor remained alive after sending the actual terminal snapshot")
        drain_ready(master, output, state)
        if state["supervisor_exit_code"] != 0 or state["supervisor_signal"] is not None:
            raise HarnessFailure("supervisor_exit_invalid", "supervisor did not exit normally after reporting actual child evidence")
        if not state["pty_output_eof"]:
            readers, _, _ = select.select([master], [], [], 0.1)
            if readers and not read_pty(master, output):
                state["pty_output_eof"] = True
        if not state["pty_output_eof"]:
            raise HarnessFailure("pty_drain_incomplete", "actual PTY output did not reach EOF after both owned processes exited")

        prompt_text = prompt_match.group(0).decode("ascii")
        report = {
            "schema": "skillopt-cleanup-pty/v1",
            "status": "captured",
            "scope": "real CLI cleanup prompt on a controlling PTY for a synthetic expired PREPARED row; zero-attempt/no-model-dispatch evidence only, not genuine human production approval or whole-TUI proof",
            "invocation": {
                "executable": args.bun,
                "argv": argv,
                "cwd": args.cwd,
                "rootArgument": args.root,
                "runId": args.run,
                "shell": False,
            },
            "helper": {
                "python": "/usr/bin/python3",
                "isolationFlags": ["-I", "-S", "-B"],
                "stdlibOnly": True,
            },
            "environment": {
                "home": env["HOME"],
                "stateHome": env["OTTER_STATE_HOME"],
                "userConfigurationIsolated": True,
                "skillOptPythonProvided": False,
                "executionAuthorityPathOverrideProvided": False,
            },
            "pty": {
                "controllingTtyVerified": state["controlling_tty_verified"],
                "stdinIsTTY": True,
                "stdoutIsTTY": True,
                "stderrIsTTY": True,
                "promptObserved": True,
                "promptText": prompt_text,
                "signal": "SIGINT",
                "controlBytesWrittenHex": "03",
                "approvalTextBytesWritten": 0,
                "exitCode": state["exit_code"],
                "terminatingSignal": state["terminating_signal"],
                "actualChildPid": state["actual_child_pid"],
                "actualChildProcessGroup": state["actual_child_process_group"],
                "foregroundProcessGroup": state["foreground_process_group"],
                "actualChildWaitStatus": state["actual_child_wait_status"],
                "childReaped": state["actual_child_wait_status"] is not None,
                "captureLimitBytes": MAX_CAPTURE_BYTES,
                "outputBytes": len(output),
                "outputBase64": base64.b64encode(output).decode("ascii"),
                "outputText": text,
                "consentMetadata": consent_metadata,
                "cancellationMetadata": error_metadata,
            },
            "supervisor": {
                "pid": pid,
                "sessionLeader": True,
                "aliveDuringTerminalSnapshot": state["supervisor_alive_during_terminal_snapshot"],
                "exitCode": state["supervisor_exit_code"],
                "terminatingSignal": state["supervisor_signal"],
                "reaped": state["supervisor_reaped"],
            },
            "terminal": {
                "canonical": state["tty_canonical"],
                "echo": state["tty_echo"],
                "isig": state["tty_isig"],
                "restored": state["terminal_restored"],
                "normalization": "PENDIN is ignored when comparing termios; raw before/after snapshots are retained",
                "before": state["terminal_before"],
                "after": state["terminal_after"],
                "afterMeasuredBy": "live session-leader supervisor after waiting for actual CLI child and before supervisor exit",
            },
            "claims": {
                "syntheticExpiredRowOnly": True,
                "approvalLineSent": False,
                "productionHumanApproval": False,
                "candidateQualification": "not asserted",
                "wholeTuiProof": False,
            },
        }
    except HarnessFailure as error:
        failure = error
    except BaseException as error:
        failure = HarnessFailure("harness_error", "PTY harness failed: " + type(error).__name__ + ": " + str(error))
    finally:
        if pid is not None and not state["supervisor_reaped"]:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            reap_deadline = time.monotonic() + 3
            while time.monotonic() < reap_deadline:
                readers = [descriptor for descriptor in (control_read, master) if descriptor >= 0]
                if readers:
                    ready, _, _ = select.select(readers, [], [], 0.02)
                    if control_read in ready:
                        try:
                            read_control_records(control_read, control_buffer, control_records, state)
                        except (OSError, HarnessFailure):
                            pass
                    if master in ready:
                        try:
                            if not read_pty(master, output):
                                state["pty_output_eof"] = True
                        except (OSError, HarnessFailure):
                            pass
                try:
                    waited, status = os.waitpid(pid, os.WNOHANG)
                except InterruptedError:
                    continue
                except ChildProcessError:
                    state["supervisor_reaped"] = True
                    break
                if waited == pid:
                    state["supervisor_wait_status"] = status
                    state["supervisor_exit_code"], state["supervisor_signal"] = child_exit_code(status)
                    state["supervisor_reaped"] = True
                    break
            if not state["supervisor_reaped"]:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
                reap_deadline = time.monotonic() + 2
                while time.monotonic() < reap_deadline:
                    try:
                        waited, status = os.waitpid(pid, os.WNOHANG)
                    except InterruptedError:
                        continue
                    except ChildProcessError:
                        state["supervisor_reaped"] = True
                        break
                    if waited == pid:
                        state["supervisor_wait_status"] = status
                        state["supervisor_exit_code"], state["supervisor_signal"] = child_exit_code(status)
                        state["supervisor_reaped"] = True
                        break
                    time.sleep(0.01)
            if not state["supervisor_reaped"]:
                state["reap_timed_out"] = True
                if failure is None:
                    failure = HarnessFailure("child_reap_timeout", "owned PTY supervisor was not reaped within bounded cleanup")
        for descriptor in (control_read, control_write, slave, master):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    if failure:
        evidence = {
            "argv": state["argv"],
            "controllingTtyVerified": state["controlling_tty_verified"],
            "signalSent": state["signal_sent"],
            "controlBytesWrittenHex": state.get("control_bytes_written_hex"),
            "actualChildPid": state["actual_child_pid"],
            "actualChildWaitStatus": state["actual_child_wait_status"],
            "exitCode": state["actual_child_exit_code"],
            "terminatingSignal": state["actual_child_signal"],
            "supervisorPid": state["supervisor_pid"],
            "supervisorExitCode": state["supervisor_exit_code"],
            "supervisorReaped": state["supervisor_reaped"],
            "reapTimedOut": state["reap_timed_out"],
            "terminalRestored": state["terminal_restored"],
            "terminalBefore": state["terminal_before"],
            "terminalAfter": state["terminal_after"],
            "outputBytes": len(output),
            "outputBase64": base64.b64encode(output).decode("ascii"),
        }
        failure.evidence = evidence
        raise failure
    return report


def persist_exclusive(path, report):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise HarnessFailure("report_permissions_invalid", "exclusive PTY report file is not owned with mode 0600")
        report["persistedReport"] = {"path": path, "mode": "0600", "exclusiveCreate": True}
        data = (json.dumps(report, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        offset = 0
        while offset < len(data):
            offset += os.write(descriptor, data[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main():
    args = parse_args()
    try:
        report = capture_cli(args)
        if args.report:
            persist_exclusive(args.report, report)
        sys.stdout.write(json.dumps(report, ensure_ascii=True, separators=(",", ":")) + "\n")
        return 0
    except HarnessFailure as error:
        sys.stderr.write(json.dumps({
            "status": "failed",
            "errorCode": error.code,
            "message": str(error),
            "evidence": error.evidence,
        }, ensure_ascii=True, separators=(",", ":")) + "\n")
        return 1
    except OSError as error:
        sys.stderr.write(json.dumps({
            "status": "failed",
            "errorCode": "helper_io_failed",
            "message": str(error),
        }, ensure_ascii=True, separators=(",", ":")) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
