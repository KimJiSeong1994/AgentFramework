#!/usr/bin/python3
"""Fixed JSON-over-UNIX-socket client for the root Linux verifier gate."""

from __future__ import annotations

import json
import os
import select
import socket
import stat
import struct
import sys
import time
from typing import Any


PROTOCOL = "otter.linux-verifier.v1"
CONTROL_SOCKET = "/run/otter-verifier/control.sock"
MAX_MESSAGE_BYTES = 48 * 1024 * 1024
MAX_FRAME_BYTES = 1_048_576


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _read_request() -> tuple[dict[str, Any], bytes]:
    raw = sys.stdin.buffer.read(MAX_MESSAGE_BYTES + 1)
    if len(raw) > MAX_MESSAGE_BYTES:
        raise ValueError("request exceeds the fixed size limit")
    request = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique_object)
    if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
        raise ValueError("request protocol is invalid")
    op = request.get("op")
    if op not in {"preflight", "prepare", "start", "inspect", "cancel"}:
        raise ValueError("request operation is invalid")
    if op == "preflight" and set(request) != {"protocol", "op"}:
        raise ValueError("preflight request fields are invalid")
    if op == "prepare" and set(request) != {"protocol", "op", "request"}:
        raise ValueError("prepare request fields are invalid")
    if op in {"start", "inspect", "cancel"} and set(request) != {"protocol", "op", "reference"}:
        raise ValueError("reference request fields are invalid")
    encoded = json.dumps(request, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("ascii")
    if not encoded or len(encoded) > MAX_MESSAGE_BYTES:
        raise ValueError("request exceeds the fixed size limit")
    return request, encoded


def _verify_socket_path() -> None:
    current = "/"
    parts = [part for part in CONTROL_SOCKET.split("/") if part]
    for index, part in enumerate(parts):
        current = os.path.join(current, part)
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
            raise RuntimeError("root verifier socket path is not trusted")
        if index < len(parts) - 1:
            if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
                raise RuntimeError("root verifier socket directory is unsafe")
        elif not stat.S_ISSOCK(info.st_mode):
            raise RuntimeError("root verifier endpoint is not a UNIX socket")


def _send_request(connection: socket.socket, payload: bytes) -> None:
    if not payload or len(payload) > MAX_MESSAGE_BYTES:
        raise ValueError("request exceeds the fixed frame limit")
    connection.sendall(struct.pack("!I", len(payload)) + payload)


def _recv_exact(connection: socket.socket, count: int, deadline: float) -> bytes:
    result = bytearray()
    while len(result) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("root verifier response timed out")
        readable, _, _ = select.select([connection], [], [], remaining)
        if not readable:
            raise TimeoutError("root verifier response timed out")
        chunk = connection.recv(count - len(result))
        if not chunk:
            raise EOFError("root verifier closed the response")
        result.extend(chunk)
    return bytes(result)


def _receive_response(connection: socket.socket) -> dict[str, Any]:
    deadline = time.monotonic() + 90
    length = struct.unpack("!I", _recv_exact(connection, 4, deadline))[0]
    if length <= 0 or length > MAX_FRAME_BYTES:
        raise ValueError("root verifier response frame is invalid")
    response = json.loads(_recv_exact(connection, length, deadline).decode("utf-8", errors="strict"), object_pairs_hook=_unique_object)
    if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
        raise ValueError("root verifier response is invalid")
    return response


def _exchange(payload: bytes) -> dict[str, Any]:
    _verify_socket_path()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(15)
        connection.connect(CONTROL_SOCKET)
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, _gid = struct.unpack("3i", raw)
        if pid <= 1 or uid != 0:
            raise RuntimeError("control peer is not the root verifier gate")
        _send_request(connection, payload)
        return _receive_response(connection)
    finally:
        connection.close()


def _emit(response: dict[str, Any]) -> int:
    raw = json.dumps(response, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("ascii")
    sys.stdout.buffer.write(raw + b"\n")
    sys.stdout.buffer.flush()
    return 0 if response.get("ok") is True else 1


def main() -> int:
    try:
        _request, encoded = _read_request()
        response = _exchange(encoded)
    except (OSError, ValueError, RuntimeError, TimeoutError, EOFError, UnicodeError, json.JSONDecodeError):
        return _emit({"ok": False, "error": "fixed root verifier request failed"})
    return _emit(response)


if __name__ == "__main__":
    raise SystemExit(main())
