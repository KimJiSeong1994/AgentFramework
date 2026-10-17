"""P7 platform matrix: run the unchanged tui.py PTY suite inside each terminal transport.

Cells: macos-local, macos-tmux, linux-local, linux-ssh, linux-ssh-tmux.  Every cell launches the same
product entry (`bun run test/pty/interactive-fixture.ts`) through tui.py's own PtySession/TerminalScreen
(imported read-only from --root); only the transport between the harness PTY and the product differs:

  local      direct child on the harness PTY (exactly what tui.py does)
  tmux       fresh private tmux server (default config + status line off), client attached to the harness PTY
  ssh        `ssh -tt` (strict host keys, dedicated known_hosts, batch public-key auth) to --ssh-target
  ssh-tmux   `ssh -tt` running the tmux client above

For transported cells a wrapper runs inside the transport: it records the product's tty path, initial
termios and exit status, then runs the product as its child.  The harness reads termios from that inner
tty, so raw/cooked/restored proofs describe the terminal the product really owns.

Authentication failure, a missing tool, a wrong platform, a failed assertion or a missing cell is a
FAILURE.  Nothing in this harness skips.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import pty
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
import traceback
from pathlib import Path
from typing import Any

SCHEMA = 1
CELLS = {
    "macos-local": ("darwin", "local"),
    "macos-tmux": ("darwin", "tmux"),
    "linux-local": ("linux", "local"),
    "linux-ssh": ("linux", "ssh"),
    "linux-ssh-tmux": ("linux", "ssh-tmux"),
}
PLATFORM_CELLS = {
    "darwin": ["macos-local", "macos-tmux"],
    "linux": ["linux-local", "linux-ssh", "linux-ssh-tmux"],
}
CORE_SCENARIOS = (
    "approve", "reject", "busyFifo", "restore", "sdkObserver", "skills", "readlineSkills", "skillGrants",
    "skillRestoreExit", "skillRestoreKill", "skillToolScope", "skillToolCancel", "skillMainWrite", "workflowDI",
    "pauseResume", "cancelUnconfirmed", "pausedCancel", "ctrlCThresholds", "signals",
    "ux01-long-approval", "ux02-status-pressure", "ux03-focus", "ux04-task-results",
    "ux05-composer-queue", "ux06-recovery", "ux07-accessibility", "ux08-diagnostics",
)
CORE_SIGNALS = ("SIGINT", "SIGTERM", "SIGHUP")
SHIFT_ENTER = b"\x1b[13;2u"
CTRL_J = b"\n"
PASTE = b"\x1b[200~ab\x1b[201~"
UNICODE = "é한".encode()

WRAPPER = r'''
import json, os, signal, subprocess, sys, termios
ctl, argv = sys.argv[1], sys.argv[3:]
def cc(v):
    return v if isinstance(v, int) else "b:" + bytes(v).hex()
attrs = termios.tcgetattr(0)
info = {"tty": os.ttyname(0), "termios": [attrs[0], attrs[1], attrs[2], attrs[3], attrs[4], attrs[5], [cc(c) for c in attrs[6]]]}
child = subprocess.Popen(argv)
info["pid"] = child.pid
with open(os.path.join(ctl, "info.json.tmp"), "w") as handle:
    json.dump(info, handle)
os.replace(os.path.join(ctl, "info.json.tmp"), os.path.join(ctl, "info.json"))
def forward(number, _frame):
    try:
        child.send_signal(number)
    except OSError:
        pass
for number in (signal.SIGHUP, signal.SIGTERM):
    signal.signal(number, forward)
signal.signal(signal.SIGINT, signal.SIG_IGN)
code = child.wait()
with open(os.path.join(ctl, "exit.json.tmp"), "w") as handle:
    json.dump({"returncode": code}, handle)
os.replace(os.path.join(ctl, "exit.json.tmp"), os.path.join(ctl, "exit.json"))
sys.exit(code if code >= 0 else 128 - code)
'''

KEY_PROBE = r'''
import json, os, select, sys, time, tty
ctl = sys.argv[1]
sys.stdout.write("\x1b[?2004h\x1b[>4;2m\x1b[>1u")
sys.stdout.flush()
tty.setraw(0)
sys.stdout.write("Otter-PROBE-READY\r\n")
sys.stdout.flush()
data = b""
deadline = time.time() + 20
while not data.endswith(b"Q") and time.time() < deadline:
    ready, _, _ = select.select([0], [], [], 0.2)
    if ready:
        data += os.read(0, 4096)
sys.stdout.write("\x1b[<u\x1b[>4;0m\x1b[?2004l")
sys.stdout.flush()
with open(os.path.join(ctl, "probe.json"), "w") as handle:
    json.dump({"hex": data.hex(), "term": os.environ.get("TERM")}, handle)
'''

PRIVATE_KEY_RE = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def tool_version(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"unavailable: {type(error).__name__}: {error}"
    return (result.stdout + result.stderr).strip()


class Context:
    def __init__(self):
        self.cell = ""
        self.kind = "local"
        self.profile = "direct"
        self.out = Path(".")
        self.args: argparse.Namespace = argparse.Namespace()
        self.records: list[dict[str, Any]] = []
        self.base_env = dict(os.environ)
        self.counter = 0
        self.redirect: dict[int, Any] = {}
        self.scratch: list[Path] = []

    def next_id(self) -> int:
        self.counter += 1
        return self.counter


CTX = Context()


def decode_termios(info: list[Any]) -> list[Any]:
    cc = [value if isinstance(value, int) else bytes.fromhex(value[2:]) for value in info[6]]
    return [info[0], info[1], info[2], info[3], info[4], info[5], cc]


def ssh_base_argv() -> list[str]:
    argv = [
        "ssh", "-tt", "-e", "none",
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={CTX.args.ssh_known_hosts}",
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes",
        "-o", "PreferredAuthentications=publickey",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "ConnectTimeout=15",
        "-o", "LogLevel=ERROR",
    ]
    if CTX.args.ssh_identity:
        argv += ["-i", str(CTX.args.ssh_identity), "-o", "IdentitiesOnly=yes"]
    return argv


def tmux_conf(profile: str) -> tuple[Path, str]:
    # tmux default configuration (user config bypassed with -f) with only the status line off, so the pane
    # is exactly the harness terminal size.  "extended" additionally enables extended-keys.
    text = "set -g status off\n" + ("set -s extended-keys on\n" if profile == "extended" else "")
    directory = Path(tempfile.mkdtemp(prefix="ottertm"))
    CTX.scratch.append(directory)
    path = directory / f"{profile}.conf"
    path.write_text(text, encoding="utf-8")
    return path, text


class TransportProcess:
    """Popen-shaped view of the product (pid/exit status are the product's) running inside a transport."""

    def __init__(self, client: subprocess.Popen, ctl: Path, args: list[str], tmux_sock: Path | None, wait_client: bool):
        self.client, self.ctl, self.args, self.tmux_sock, self.wait_client = client, ctl, args, tmux_sock, wait_client
        self._info: dict[str, Any] | None = None
        self._code: int | None = None
        self._exit_seen: float | None = None

    def info(self) -> dict[str, Any] | None:
        if self._info is None:
            try:
                self._info = json.loads((self.ctl / "info.json").read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError):
                return None
        return self._info

    @property
    def pid(self) -> int:
        info = self.info()
        return info["pid"] if info else self.client.pid

    def _exit_file(self) -> int | None:
        try:
            return int(json.loads((self.ctl / "exit.json").read_text(encoding="utf-8"))["returncode"])
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            return None

    def poll(self, hold: bool = True) -> int | None:
        if self._code is not None:
            return self._code
        code = self._exit_file()
        if code is None:
            if self.client.poll() is None:
                return None
            time.sleep(0.3)
            code = self._exit_file()
            if code is None:
                code = self.client.returncode or 255  # transport ended without the product reporting a status
        elif hold and self.wait_client and self.client.poll() is None:
            # The transport client prints its own teardown (alt-screen restore) after the product exits;
            # report completion only once it has flushed it.
            self._exit_seen = self._exit_seen or time.monotonic()
            if time.monotonic() - self._exit_seen < 5:
                return None
        self._code = code
        return code

    @property
    def returncode(self) -> int | None:
        return self.poll()

    def wait(self, timeout: float | None = None) -> int:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            code = self.poll(hold=False)
            if code is not None:
                return code
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self.args, timeout)
            time.sleep(0.02)

    def send_signal(self, number: int):
        os.kill(self.pid, number)

    def kill(self):
        if self.info():
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
        self.teardown()

    def teardown(self):
        if self.tmux_sock is not None:
            subprocess.run(["tmux", "-S", str(self.tmux_sock), "kill-server"], capture_output=True, check=False)
        if self.client.poll() is None:
            self.client.kill()
        try:
            self.client.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def transport_argv(inner: list[str], ctl: Path, env_pairs: dict[str, str], cwd: str, profile: str):
    """Argv running `wrapper ctl -- inner` inside CTX.kind; returns (argv, tmux_sock, tmux_conf_text)."""
    wrapper = CTX.out / CTX.cell / "transport" / "wrapper.py"
    command = shlex.join([sys.executable, str(wrapper), str(ctl), "--", *inner])
    tmux_sock = None
    tmux_argv: list[str] = []
    if CTX.kind in ("tmux", "ssh-tmux"):
        sock_dir = Path(tempfile.mkdtemp(prefix="ottertm"))
        CTX.scratch.append(sock_dir)
        tmux_sock = sock_dir / "s"
        conf, _text = tmux_conf(profile)
        tmux_argv = ["tmux", "-u", "-S", str(tmux_sock), "-f", str(conf), "new-session", "-s", "otter", "-c", cwd, command]
    if CTX.kind == "tmux":
        return tmux_argv, tmux_sock
    if CTX.kind == "local":
        return [sys.executable, str(wrapper), str(ctl), "--", *inner], None
    pairs = shlex.join(f"{key}={value}" for key, value in sorted(env_pairs.items()))
    remote_command = command if CTX.kind == "ssh" else shlex.join(tmux_argv)
    remote = f"cd {shlex.quote(cwd)} && exec env {pairs} {remote_command}"
    return [*ssh_base_argv(), CTX.args.ssh_target, remote], tmux_sock


def launch_transport(inner, cwd, env, stdio, ctl, preexec, profile) -> TransportProcess:
    ctl.mkdir(parents=True, exist_ok=True)
    pairs = {key: value for key, value in env.items() if CTX.base_env.get(key) != value and key != "TERM"}
    pairs["PATH"] = env.get("PATH", "")
    argv, tmux_sock = transport_argv(inner, ctl, pairs, cwd, profile)
    env = {key: value for key, value in env.items() if key != "TMUX"}
    client = subprocess.Popen(argv, cwd=cwd, env=env, stdin=stdio, stdout=stdio, stderr=stdio,
                              start_new_session=True, preexec_fn=preexec)
    return TransportProcess(client, ctl, inner, tmux_sock, wait_client=CTX.kind != "local")


# --------------------------------------------------------------------------------------------------
# tui.py integration (imported read-only; behaviour is injected here)
# --------------------------------------------------------------------------------------------------
def load_tui(root: Path):
    path = root / "framework" / "test" / "pty" / "tui.py"
    spec = importlib.util.spec_from_file_location("otter_pty_tui", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["otter_pty_tui"] = module
    spec.loader.exec_module(module)
    return module


def install(tui):
    class TmuxScreen(tui.TerminalScreen):
        """tui.TerminalScreen plus the cursor/edit operations a tmux client emits when redrawing."""

        def __init__(self, columns: int, rows: int):
            super().__init__(columns, rows)
            self.top, self.bottom, self.saved, self.last_char = 0, rows - 1, (0, 0), " "

        def resize(self, columns: int, rows: int):
            super().resize(columns, rows)
            self.top, self.bottom = 0, rows - 1

        def _scroll_up(self, count=1):
            for _ in range(count):
                del self.grid[self.top]
                self.grid.insert(self.bottom, [" "] * self.columns)

        def _scroll_down(self, count=1):
            for _ in range(count):
                del self.grid[self.bottom]
                self.grid.insert(self.top, [" "] * self.columns)

        def _put(self, character: str):
            super()._put(character)
            self.last_char = character

        def _linefeed(self):
            if self.row == self.bottom:
                self._scroll_up()
            else:
                self.row = min(self.rows - 1, self.row + 1)

        def _character(self, character: str):
            if self.state == "skip":
                self.state = "text"
            elif self.state == "escape" and character in "()*+#%":
                self.state = "skip"
            elif self.state == "escape" and character == "7":
                self.saved, self.state = (self.row, self.column), "text"
            elif self.state == "escape" and character == "8":
                (self.row, self.column), self.state = self.saved, "text"
            elif self.state == "escape" and character in "DE":
                if character == "E":
                    self.column = 0
                self._linefeed()
                self.state = "text"
            elif self.state == "escape" and character == "M":
                if self.row == self.top:
                    self._scroll_down()
                else:
                    self.row = max(0, self.row - 1)
                self.state = "text"
            elif self.state == "escape" and character in "P_^X":
                self.state, self.string_esc = "string", False
            elif self.state == "text" and character == "\n":
                self._linefeed()
            else:
                super()._character(character)

        def _csi(self, parameters: str, final: str):
            if not re.fullmatch(r"[0-9;]*", parameters):
                return super()._csi(parameters, final)
            numbers = self._numbers(parameters)
            count = (numbers[0] if numbers else 0) or 1
            line = self.grid[self.row]
            if final == "X":
                for x in range(self.column, min(self.columns, self.column + count)):
                    line[x] = " "
            elif final == "@":
                line[self.column:] = ([" "] * count + line[self.column:])[: self.columns - self.column]
            elif final == "P":
                line[self.column:] = (line[self.column + count:] + [" "] * count)[: self.columns - self.column]
            elif final in "LM" and self.top <= self.row <= self.bottom:
                saved_top, self.top = self.top, self.row
                (self._scroll_down if final == "L" else self._scroll_up)(count)
                self.top = saved_top
            elif final == "S":
                self._scroll_up(count)
            elif final == "T":
                self._scroll_down(count)
            elif final == "r":
                top = (numbers[0] if numbers and numbers[0] else 1) - 1
                bottom = (numbers[1] if len(numbers) > 1 and numbers[1] else self.rows) - 1
                if 0 <= top < bottom < self.rows:
                    self.top, self.bottom = top, bottom
                self.row = self.column = 0
            elif final == "b":
                for _ in range(count):
                    self._put(self.last_char)
            elif final == "s":
                self.saved = (self.row, self.column)
            elif final == "u":
                self.row, self.column = self.saved
            else:
                super()._csi(parameters, final)

    class TermiosShim:
        """tcgetattr on a transported session's client PTY reads the product's own tty instead."""

        def __getattr__(self, name):
            return getattr(termios, name)

        def tcgetattr(self, fd):
            session = CTX.redirect.get(fd)
            return termios.tcgetattr(session.inner_fd() if session else fd)

    class SubprocessShim:
        def __getattr__(self, name):
            return getattr(subprocess, name)

        @staticmethod
        def Popen(argv, **kwargs):
            session = Session.starting
            if session is None or CTX.kind == "local":
                return subprocess.Popen(argv, **kwargs)
            ctl = session.temp_root / f"{session.label}.ctl-{CTX.next_id()}"
            return launch_transport([str(part) for part in argv], str(kwargs["cwd"]), kwargs["env"], kwargs["stdin"],
                                    ctl, kwargs.get("preexec_fn"), CTX.profile)

    class Session(tui.PtySession):
        starting: Any = None

        def __init__(self, scenario, temp_root, columns=tui.DEFAULT_COLUMNS, rows=tui.DEFAULT_ROWS, label=None, extra_env=None):
            super().__init__(scenario, temp_root, columns, rows, label, extra_env)
            self._inner: int | None = None
            self.inner_tty = os.ttyname(self.slave)
            self.seq = CTX.next_id()
            if CTX.kind in ("tmux", "ssh-tmux"):
                self.screen = TmuxScreen(columns, rows)
            if CTX.kind != "local":
                CTX.redirect[self.slave] = self

        def start(self):
            Session.starting = self
            try:
                return super().start()
            finally:
                Session.starting = None

        def inner_fd(self, timeout=10.0) -> int:
            if self._inner is None:
                deadline = time.monotonic() + timeout
                info = self.process.info()
                while info is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                    info = self.process.info()
                if info is None:
                    raise OSError("transport wrapper never reported the product tty")
                self.inner_tty = info["tty"]
                self.initial_termios = decode_termios(info["termios"])
                self._inner = os.open(info["tty"], os.O_RDWR | os.O_NOCTTY)
            return self._inner

        def evidence(self) -> dict[str, Any]:
            if CTX.kind != "local":
                try:
                    self.inner_fd(2.0)
                except OSError:
                    pass
            raw_dir = CTX.out / CTX.cell / "raw" / CTX.profile
            raw_dir.mkdir(parents=True, exist_ok=True)
            raw_path = raw_dir / f"{self.seq:03d}-{self.label}.bin"
            raw_path.write_bytes(PRIVATE_KEY_RE.sub(b"[redacted private key]", bytes(self.output)))
            initial = self.initial_termios
            return {
                "label": self.label, "scenario": self.scenario, "transport": CTX.kind, "profile": CTX.profile,
                "productTty": self.inner_tty, "productPid": self.process.pid if self.process else None,
                "exitCode": self.process.poll() if self.process else None,
                "initialLocalFlags": initial[3] if initial else None,
                "terminalCleanupEvidence": self.terminal_cleanup_evidence,
                "modeProof": self.mode_proof,
                "checkpointModes": {n: {"rawMode": c["rawMode"], "cookedMode": c["cookedMode"]} for n, c in self.checkpoints.items()},
                "rawFile": str(raw_path.relative_to(CTX.out / CTX.cell)), "rawBytes": len(self.output),
            }

        def close(self):
            try:
                CTX.records.append(self.evidence())
            except Exception as error:  # evidence loss must be visible, never silent
                CTX.records.append({"label": self.label, "evidenceError": f"{type(error).__name__}: {error}"})
            try:
                super().close()
            finally:
                if isinstance(self.process, TransportProcess):
                    self.process.teardown()
                CTX.redirect.pop(self.slave, None)
                if self._inner is not None:
                    try:
                        os.close(self._inner)
                    except OSError:
                        pass
                    self._inner = None

    tui.PtySession = Session
    tui.termios = TermiosShim()
    tui.subprocess = SubprocessShim()
    return Session


# --------------------------------------------------------------------------------------------------
# Key-transport probe (shows exactly which bytes each tmux/ssh profile delivers to an application that
# requests modifyOtherKeys + kitty keyboard, the way TerminalDriver does)
# --------------------------------------------------------------------------------------------------
def run_key_probe(profile: str, directory: Path) -> dict[str, Any]:
    ctl = directory / f"probe-{profile}.ctl"
    probe = directory / "key-probe.py"
    probe.write_text(KEY_PROBE, encoding="utf-8")
    master, slave = pty.openpty()
    import fcntl
    import struct
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = dict(CTX.base_env, TERM="xterm-256color")
    process = launch_transport([sys.executable, str(probe), str(ctl)], str(directory), env, slave, ctl, None, profile)
    output = bytearray()

    def pump(seconds: float, until: bytes | None = None):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if until is not None and until in output:
                return True
            if select.select([master], [], [], 0.05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return until is None
                if not chunk:
                    return until is None
                output.extend(chunk)
        return until is None

    try:
        if not pump(20, b"Otter-PROBE-READY"):
            raise AssertionError(f"key probe never started under {CTX.kind}/{profile}: {bytes(output)[-500:]!r}")
        time.sleep(0.3)
        for packet in (SHIFT_ENTER, CTRL_J, PASTE, UNICODE, b"Q"):
            os.write(master, packet)
            pump(0.2)
        process.wait(timeout=20)
        pump(1.0)
        result = json.loads((ctl / "probe.json").read_text(encoding="utf-8"))
    finally:
        process.teardown()
        os.close(master)
        os.close(slave)
    got = bytes.fromhex(result["hex"])
    enhanced = got.startswith(SHIFT_ENTER) or got.startswith(b"\x1b[27;2;13~")
    bare_enter = got.startswith(b"\r") or got.startswith(b"\n")
    return {
        "profile": profile, "transport": CTX.kind, "term": result["term"], "sentHex": (SHIFT_ENTER + CTRL_J + PASTE + UNICODE + b"Q").hex(),
        "receivedHex": got.hex(),
        "shiftEnterDelivered": "enhanced" if enhanced else ("legacy-enter" if bare_enter else "other"),
        "ctrlJPreserved": b"\n" in got[len(SHIFT_ENTER):] if got.startswith(SHIFT_ENTER) else None,
        "pastePreserved": b"\x1b[200~ab\x1b[201~" in got,
        "unicodePreserved": UNICODE in got,
        "legacyLimitation": not enhanced,
    }


# --------------------------------------------------------------------------------------------------
# Cells
# --------------------------------------------------------------------------------------------------
def flatten_scenarios(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    flat: dict[str, dict[str, Any]] = {}
    for name, value in report.get("scenarios", {}).items():
        if name == "signals":
            for signal_name, item in value.items():
                flat[f"signals.{signal_name}"] = item
        else:
            flat[name] = value
    return flat


def find_skips(value: Any, path: str = "") -> list[str]:
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("status", "result") and isinstance(item, str) and item.lower() in ("skipped", "skip", "blocked", "failed"):
                found.append(f"{path}/{key}={item}")
            found += find_skips(item, f"{path}/{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found += find_skips(item, f"{path}[{index}]")
    return found


def matrix_checks(cell: str, kind: str, report: dict[str, Any], records: list[dict[str, Any]], probes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: Any = None):
        checks.append({"name": name, "passed": bool(ok), "detail": detail})

    flat = flatten_scenarios(report)
    expected = [*(s for s in CORE_SCENARIOS if s != "signals"), *(f"signals.{n}" for n in CORE_SIGNALS)]
    missing = [name for name in expected if name not in flat]
    check("suite status passed", report.get("status") == "passed", report.get("status"))
    check("all core scenarios present", not missing, missing)
    check("no skipped/blocked/failed marker anywhere in report", not find_skips(report), find_skips(report)[:10])
    cleanup = {
        name: item.get("capture", {}).get("termiosRestored") for name, item in flat.items()
        if isinstance(item, dict) and isinstance(item.get("capture"), dict) and "termiosRestored" in item["capture"]
    }
    check("termios restored in every captured scenario", bool(cleanup) and all(v is True for v in cleanup.values()), cleanup)
    check("every session produced raw+mode evidence", bool(records) and all("evidenceError" not in r and r.get("rawBytes", 0) > 0 for r in records),
          [r for r in records if "evidenceError" in r or not r.get("rawBytes")][:5])
    signal_exits = {n: flat.get(f"signals.{n}", {}).get("exitCode") for n in CORE_SIGNALS}
    check("signal exits 130/143/129", signal_exits == {"SIGINT": 130, "SIGTERM": 143, "SIGHUP": 129}, signal_exits)
    if kind != "local":
        tty_ok = [r for r in records if r.get("productTty") and r.get("initialLocalFlags") is not None]
        check("transport reported product tty+termios for every session", len(tty_ok) == len(records), len(records) - len(tty_ok))
    if kind in ("tmux", "ssh-tmux"):
        by_profile = {p["profile"]: p for p in probes}
        extended = by_profile.get("extended", {})
        check("tmux extended-keys: Shift+Enter truly transmitted to application", extended.get("shiftEnterDelivered") == "enhanced"
              and extended.get("pastePreserved") and extended.get("unicodePreserved"), extended)
        default = by_profile.get("default", {})
        check("tmux default profile probed and legacy limitation recorded (not counted as an enhanced pass)",
              default.get("shiftEnterDelivered") in ("enhanced", "legacy-enter") and default.get("legacyLimitation") == (default.get("shiftEnterDelivered") != "enhanced"),
              default)
    return checks


def ssh_preflight(directory: Path) -> dict[str, Any]:
    known = Path(CTX.args.ssh_known_hosts)
    if not known.is_file() or known.stat().st_size == 0:
        raise AssertionError(f"dedicated ssh known_hosts missing or empty: {known}")
    argv = [*ssh_base_argv(), CTX.args.ssh_target, "echo otter-ssh-ok; tty; id -un; command -v bun python3 tmux"]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60, check=False, stdin=subprocess.DEVNULL)
    text = (result.stdout + result.stderr).strip()
    if result.returncode != 0 or "otter-ssh-ok" not in result.stdout:
        raise AssertionError(f"ssh authentication/strict-host-key probe FAILED (exit {result.returncode}): {text[-800:]}")
    evidence = {
        "argv": [*ssh_base_argv(), CTX.args.ssh_target], "exitCode": result.returncode, "output": text,
        "sshVersion": tool_version(["ssh", "-V"]),
        "knownHostsFile": str(known), "knownHostsSha256": sha256_file(known),
        "knownHostsLines": [line.split(" ", 1)[0] + " " + " ".join(line.split()[1:2]) + " " + hashlib.sha256(line.encode()).hexdigest()[:16]
                            for line in known.read_text().splitlines() if line.strip() and not line.startswith("#")],
    }
    write_json(directory / "ssh-preflight.json", evidence)
    return evidence


def run_cell(cell: str, args: argparse.Namespace) -> dict[str, Any]:
    host_platform, kind = CELLS[cell]
    cell_dir = args.out / cell
    if cell_dir.exists():
        shutil.rmtree(cell_dir)
    (cell_dir / "transport").mkdir(parents=True)
    (cell_dir / "transport" / "wrapper.py").write_text(WRAPPER, encoding="utf-8")
    CTX.cell, CTX.kind, CTX.out, CTX.args, CTX.records = cell, kind, args.out, args, []
    CTX.profile = "extended" if kind in ("tmux", "ssh-tmux") else "direct"
    started = time.time()
    result: dict[str, Any] = {"cell": cell, "transport": kind, "platform": host_platform, "status": "failed"}
    report: dict[str, Any] = {}
    probes: list[dict[str, Any]] = []
    error: str | None = None
    try:
        if not sys.platform.startswith(host_platform):
            raise AssertionError(f"cell {cell} needs {host_platform} but this host is {sys.platform}")
        versions = {name: tool_version(argv) for name, argv in {
            "bun": ["bun", "--version"], "python": [sys.executable, "--version"], "tmux": ["tmux", "-V"], "ssh": ["ssh", "-V"],
            "uname": ["uname", "-a"]}.items()}
        write_json(cell_dir / "transport" / "versions.json", versions)
        if kind in ("tmux", "ssh-tmux"):
            conf_default = tmux_conf("default")
            conf_extended = tmux_conf("extended")
            (cell_dir / "transport" / "tmux-default.conf").write_text(conf_default[1], encoding="utf-8")
            (cell_dir / "transport" / "tmux-extended.conf").write_text(conf_extended[1], encoding="utf-8")
        if kind in ("ssh", "ssh-tmux"):
            ssh_preflight(cell_dir / "transport")
        tui = load_tui(args.root)
        install(tui)
        preflight = tui.preflight_evidence()
        if kind in ("tmux", "ssh-tmux"):
            for profile in ("default", "extended"):
                CTX.profile = profile
                probes.append(run_key_probe(profile, cell_dir / "transport"))
            CTX.profile = "extended"
        report = tui.run_all(preflight)
        report["matrixTransport"] = {"cell": cell, "kind": kind, "tmuxProfileForSuite": CTX.profile if "tmux" in kind else None}
    except BaseException as exc:  # noqa: BLE001 - any failure fails the cell, evidence is still written
        error = f"{type(exc).__name__}: {exc}"
        write_json(cell_dir / "error.json", {"error": error, "traceback": traceback.format_exc()})
    finally:
        for directory in CTX.scratch:
            shutil.rmtree(directory, ignore_errors=True)
        CTX.scratch = []
    checks = matrix_checks(cell, kind, report, CTX.records, probes) if report else []
    failed_checks = [c for c in checks if not c["passed"]]
    write_json(cell_dir / "modes.json", {"schemaVersion": SCHEMA, "cell": cell, "sessions": CTX.records, "keyProbes": probes})
    report_out = {"schemaVersion": SCHEMA, "cell": cell, "transport": kind, "suite": report, "matrixChecks": checks, "error": error}
    write_json(cell_dir / "report.json", report_out)
    scenarios = flatten_scenarios(report)
    observed = report.get("coverage", {}).get("observed", [])
    mode_assertions = sum(1 for r in CTX.records for v in r.get("modeProof", {}).values() if v is True)
    passed = error is None and bool(report) and not failed_checks
    result.update({
        "status": "passed" if passed else "failed",
        "error": error or (f"failed matrix checks: {[c['name'] for c in failed_checks]}" if failed_checks else None),
        "scenarios": len(scenarios), "scenarioNames": sorted(scenarios), "skipped": 0,
        "assertions": {"suiteObserved": len(observed), "matrixChecks": len(checks), "matrixChecksPassed": len(checks) - len(failed_checks),
                       "modeProofTrue": mode_assertions, "sessions": len(CTX.records)},
        "durationSeconds": round(time.time() - started, 1),
        "platform": platform.platform(),
    })
    files = {}
    for path in sorted(cell_dir.rglob("*")):
        if path.is_file():
            files[str(path.relative_to(args.out))] = sha256_file(path)
    result["files"] = files
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, required=True, help="worktree containing framework/test/pty/tui.py")
    parser.add_argument("--cells", required=True, help="comma-separated: " + ",".join(CELLS))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--require-all", action="store_true", help="every host-platform cell must be requested and pass; none may be skipped")
    parser.add_argument("--ssh-target", default="localhost")
    parser.add_argument("--ssh-known-hosts", type=Path, help="dedicated known_hosts for ssh cells (default: <out>/known_hosts)")
    parser.add_argument("--ssh-identity", type=Path)
    args = parser.parse_args()
    args.root = args.root.resolve()
    args.out = args.out.resolve()
    args.ssh_known_hosts = (args.ssh_known_hosts or args.out / "known_hosts").resolve()
    requested = [cell.strip() for cell in args.cells.split(",") if cell.strip()]
    unknown = [cell for cell in requested if cell not in CELLS]
    if unknown or not requested:
        print(f"unknown or empty --cells: {unknown or requested}", file=sys.stderr)
        return 2
    host = "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else sys.platform
    required = PLATFORM_CELLS.get(host, [])
    args.out.mkdir(parents=True, exist_ok=True)
    results = []
    for cell in requested:
        print(f"== cell {cell}", flush=True)
        outcome = run_cell(cell, args)
        print(f"== cell {cell}: {outcome['status']}" + (f" ({outcome['error']})" if outcome.get("error") else ""), flush=True)
        results.append(outcome)
    missing = [cell for cell in required if cell not in requested] if args.require_all else []
    failed = [r["cell"] for r in results if r["status"] != "passed"]
    ok = not failed and not missing and bool(results) and (not args.require_all or bool(required))
    source = subprocess.run(["git", "-C", str(args.root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    summary = {
        "schemaVersion": SCHEMA, "status": "passed" if ok else "failed", "requireAll": args.require_all,
        "hostPlatform": host, "requestedCells": requested, "requiredCells": required, "missingCells": missing, "failedCells": failed,
        "cells": results, "skipped": 0,
        "harness": {"matrixSha256": sha256_file(Path(__file__)), "tuiSha256": sha256_file(args.root / "framework/test/pty/tui.py"),
                    "fixtureSha256": sha256_file(args.root / "framework/test/pty/interactive-fixture.ts")},
        "root": str(args.root), "rootGitHead": source.stdout.strip() or None, "python": platform.python_version(),
        "candidateSourceHash": os.environ.get("OTTER_UX_SOURCE_HASH"),
        "command": [sys.executable, *sys.argv],
    }
    write_json(args.out / "summary.json", summary)
    print(json.dumps({k: summary[k] for k in ("status", "requestedCells", "missingCells", "failedCells")}), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
