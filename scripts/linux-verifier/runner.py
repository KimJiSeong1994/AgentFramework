#!/usr/bin/python3
"""Unprivileged one-shot runner for the fixed otter-verifier.service."""

from __future__ import annotations

import codecs
import contextlib
import ctypes
import os
import re
import select
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time
from typing import Any


PROTOCOL = "otter.linux-verifier.v1"
RUNNER_SOCKET = "/run/otter-verifier/runner.sock"
WORKSPACE = "/workspace"
MAX_FRAME_BYTES = 1_048_576
MAX_OUTPUT_CHARS = 65_536
TICKET_RE = re.compile(r"^[0-9a-f]{32}$")


def _protect_control_channel() -> None:
    # The workload shares this UID, but must not ptrace this trusted wrapper or
    # duplicate its authenticated socket. Do not depend on a host Yama setting.
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    if prctl(4, 0, 0, 0, 0) != 0 or prctl(3, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "trusted runner memory protection failed")


def _json_bytes(value: Any) -> bytes:
    import json

    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("ascii")


def _take_output(text: str, remaining: int) -> tuple[str, int]:
    encoded = text.encode("utf-16-le", errors="strict")
    visible = encoded[:remaining * 2].decode("utf-16-le", errors="ignore")
    # Exhaust the budget at the first truncation, even if a whole astral character
    # cannot fit. Later chunks must not replace the skipped middle of the stream.
    return visible, max(0, remaining - len(encoded) // 2)


def _safe_server_socket() -> None:
    current = "/"
    parts = [part for part in RUNNER_SOCKET.split("/") if part]
    for index, part in enumerate(parts):
        current = os.path.join(current, part)
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
            raise RuntimeError("runner socket path is not root-owned and protected")
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError("runner socket parent is not a directory")
        if index < len(parts) - 1 and info.st_mode & 0o022:
            raise RuntimeError("runner socket parent is writable by an untrusted role")
    if not stat.S_ISSOCK(info.st_mode):
        raise RuntimeError("runner socket is not a UNIX socket")


def _send_frame(connection: socket.socket, value: Any) -> None:
    payload = _json_bytes(value)
    if not payload or len(payload) > MAX_FRAME_BYTES:
        raise RuntimeError("runner protocol frame exceeds its bound")
    connection.sendall(struct.pack("!I", len(payload)) + payload)


def _recv_exact(connection: socket.socket, count: int, timeout: float) -> bytes:
    deadline = time.monotonic() + timeout
    output = bytearray()
    while len(output) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("gate handshake timed out")
        readable, _, _ = select.select([connection], [], [], remaining)
        if not readable:
            raise TimeoutError("gate handshake timed out")
        part = connection.recv(count - len(output))
        if not part:
            raise EOFError("gate closed the handshake")
        output.extend(part)
    return bytes(output)


def _recv_frame(connection: socket.socket, timeout: float) -> dict[str, Any]:
    import json

    length = struct.unpack("!I", _recv_exact(connection, 4, timeout))[0]
    if length <= 0 or length > MAX_FRAME_BYTES:
        raise RuntimeError("gate frame length is invalid")

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    value = json.loads(_recv_exact(connection, length, timeout).decode("utf-8", errors="strict"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise RuntimeError("gate frame is not an object")
    return value


def _authenticate_gate(connection: socket.socket) -> None:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", raw)
    if pid <= 1 or uid != 0:
        raise RuntimeError("runner rejected a non-root gate peer")


def _connect_gate() -> socket.socket:
    _safe_server_socket()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(10)
    connection.connect(RUNNER_SOCKET)
    _authenticate_gate(connection)
    _send_frame(connection, {"protocol": PROTOCOL, "op": "runner-hello"})
    return connection


def _validate_assignment(value: dict[str, Any]) -> tuple[str, str, int, int]:
    if set(value) != {"protocol", "op", "ticket", "command", "deadlineAt", "maxOutputChars"}:
        raise RuntimeError("gate assignment fields are invalid")
    if value["protocol"] != PROTOCOL or value["op"] != "execute":
        raise RuntimeError("gate assignment protocol is invalid")
    ticket = value["ticket"]
    command = value["command"]
    deadline = value["deadlineAt"]
    limit = value["maxOutputChars"]
    if not isinstance(ticket, str) or not TICKET_RE.fullmatch(ticket):
        raise RuntimeError("gate assignment ticket is invalid")
    if not isinstance(command, str) or "\x00" in command or len(command) > 262_144:
        raise RuntimeError("gate assignment command is invalid")
    if isinstance(deadline, bool) or not isinstance(deadline, int) or deadline <= 0:
        raise RuntimeError("gate assignment deadline is invalid")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_OUTPUT_CHARS:
        raise RuntimeError("gate assignment output bound is invalid")
    return ticket, command, deadline, limit


def _validate_release(value: dict[str, Any], ticket: str) -> None:
    if value != {"protocol": PROTOCOL, "op": "release", "ticket": ticket}:
        raise RuntimeError("gate did not authenticate command release")


def _report_child_exit(connection: socket.socket, ticket: str, parent_exit: int) -> None:
    _send_frame(connection, {
        "protocol": PROTOCOL,
        "type": "child-exit",
        "ticket": ticket,
        "parentExit": parent_exit,
    })
    acknowledgement = _recv_frame(connection, 30)
    if acknowledgement != {
        "protocol": PROTOCOL,
        "type": "child-exit-ack",
        "ticket": ticket,
    }:
        raise RuntimeError("gate did not acknowledge durable child exit")


def _send_output(connection: socket.socket, ticket: str, text: str) -> None:
    for offset in range(0, len(text), 1024):
        _send_frame(connection, {"protocol": PROTOCOL, "type": "output", "ticket": ticket, "text": text[offset : offset + 1024]})


def _stop_direct_child(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    with contextlib.suppress(ProcessLookupError, OSError):
        process.terminate()
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, OSError):
            process.kill()
        with contextlib.suppress(subprocess.TimeoutExpired, OSError):
            process.wait(timeout=1.0)


def _execute(connection: socket.socket, ticket: str, command: str, deadline_at: int, output_limit: int) -> None:
    if int(time.time() * 1000) >= deadline_at:
        _report_child_exit(connection, ticket, 127)
        return
    if not os.path.isdir(WORKSPACE):
        _report_child_exit(connection, ticket, 127)
        return
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
    }
    try:
        process = subprocess.Popen(
            ["/bin/sh", "-c", command],
            cwd=WORKSPACE,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=False,
            umask=0o077,
        )
    except (OSError, ValueError):
        _report_child_exit(connection, ticket, 127)
        return
    assert process.stdout is not None
    _send_frame(connection, {"protocol": PROTOCOL, "type": "started", "ticket": ticket})
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    remaining = output_limit
    try:
        while selector.get_map():
            events = selector.select(timeout=0.5)
            if not events:
                continue
            for key, _mask in events:
                try:
                    raw = os.read(key.fd, 8192)
                except OSError:
                    raw = b""
                if not raw:
                    selector.unregister(key.fileobj)
                    continue
                text = decoder.decode(raw, final=False)
                if remaining:
                    visible, remaining = _take_output(text, remaining)
                    if visible:
                        _send_output(connection, ticket, visible)
        final_text = decoder.decode(b"", final=True)
        if remaining and final_text:
            visible, remaining = _take_output(final_text, remaining)
            if visible:
                _send_output(connection, ticket, visible)
        parent_exit = process.wait()
        _report_child_exit(connection, ticket, parent_exit)
    except (BrokenPipeError, ConnectionError, EOFError, OSError):
        _stop_direct_child(process)
        raise
    finally:
        selector.close()
        process.stdout.close()


def main() -> int:
    if not sys.platform.startswith("linux") or os.geteuid() == 0:
        return 1
    connection: socket.socket | None = None
    try:
        _protect_control_channel()
        connection = _connect_gate()
        assignment = _recv_frame(connection, 30)
        ticket, command, deadline_at, output_limit = _validate_assignment(assignment)
        _send_frame(connection, {"protocol": PROTOCOL, "type": "accepted", "ticket": ticket})
        release = _recv_frame(connection, 30)
        _validate_release(release, ticket)
        _execute(connection, ticket, command, deadline_at, output_limit)
        return 0
    except (OSError, RuntimeError, ValueError, TimeoutError, EOFError, ConnectionError):
        return 1
    finally:
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
