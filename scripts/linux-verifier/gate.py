#!/usr/bin/python3
"""Root-owned, single-use Linux verifier authority.

This module intentionally exposes only the fixed JSON protocol in the contract.  It
does not accept manager commands, unit names, executable paths, or cgroup paths from
callers.  All workload execution is delegated to runner.py after the native binding
has been durably recorded.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import errno
import fcntl
import hashlib
import json
import os
import pwd
import re
import select
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Iterator


PROTOCOL = "otter.linux-verifier.v1"
PROFILE_SCHEMA = "otter.linux-verifier.profile.v2"
RECORD_SCHEMA = "otter.linux-verifier.record.v1"
RECEIPT_SCHEMA = "otter.linux-verifier.retirement.v1"
UNIT = "otter-verifier.service"
GATE_UNIT = "otter-verifier-gate.service"
CONTROL_SOCKET = "/run/otter-verifier/control.sock"
RUNNER_SOCKET = "/run/otter-verifier/runner.sock"
PROFILE_PATH = "/etc/otter-verifier/profile.json"
JOURNALD_DROPIN = "/etc/systemd/journald.conf.d/otter-verifier.conf"
HELPER_DIR = "/usr/local/libexec/otter-verifier"
STATE_DIR = "/var/lib/otter-verifier"
RECORD_DIR = f"{STATE_DIR}/records"
INPUT_DIR = f"{STATE_DIR}/inputs"
PRIVATE_DIR = f"{STATE_DIR}/private"
GIT_TMP_DIR = f"{PRIVATE_DIR}/git-tmp"
ACTIVATION_LOCK = f"{STATE_DIR}/activation.lock"
SIGNING_KEY = f"{PRIVATE_DIR}/signing-key.pem"
CURRENT_INPUT = f"{STATE_DIR}/current"
QUARANTINE_PATH = f"{STATE_DIR}/quarantine.json"
CGROUP_ROOT = "/sys/fs/cgroup"
SYSTEMCTL = "/usr/bin/systemctl"
JOURNALCTL = "/usr/bin/journalctl"
SYSTEMD_ANALYZE = "/usr/bin/systemd-analyze"
OPENSSL = "/usr/bin/openssl"
GIT = "/usr/bin/git"
CGROUP_PATH = "/otter.slice/otter-verifier.service"
STOP_MESSAGE_ID = "9d1aaa27d60140bd96365438aad20286"
MAX_CONTROL_BYTES = 48 * 1024 * 1024
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_UNPACKED_BYTES = MAX_ARCHIVE_BYTES
MAX_ARCHIVE_ENTRIES = 20_000
MAX_FILE_BYTES = MAX_ARCHIVE_BYTES
MAX_PENDING_TICKETS = 16
MAX_PENDING_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_COMMAND_CHARS = 262_144
MAX_CWD_CHARS = 4_096
MAX_RECEIPT_BYTES = 16_384
MAX_OUTPUT_CHARS = 65_536
MAX_FRAME_BYTES = 1_048_576
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_RUNTIME_MS = 120_000
DEACTIVATED_MESSAGE_ID = "7ad2d189f7e94e70a38c781354912448"
FAILED_MESSAGE_ID = "d9b373ed55a64feb8242e02dbe79a49c"
RETIREMENT_MESSAGE_IDS = frozenset({STOP_MESSAGE_ID, DEACTIVATED_MESSAGE_ID, FAILED_MESSAGE_ID})
SYSTEMD_PROPERTIES = (
    "ActiveState", "SubState", "Result", "InvocationID", "MainPID", "ControlGroup",
    "LoadState", "NeedDaemonReload",
    "FragmentPath", "DropInPaths", "User", "Group", "Slice", "KillMode", "Delegate",
    "Restart", "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities",
    "ProtectControlGroups", "ProtectSystem", "ProtectHome", "PrivateTmp", "PrivateNetwork",
    "RestrictAddressFamilies", "RestrictNamespaces", "ExitType", "RemainAfterExit",
    "MemoryMax", "TasksMax", "RuntimeMaxUSec",
)
HEX40_OR_64 = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
INVOCATION_RE = re.compile(r"^[0-9a-f]{32}$")
BOOT_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MACHINE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
REQUIRED_PROFILE_FILES = {
    f"{HELPER_DIR}/gate.py",
    f"{HELPER_DIR}/runner.py",
    f"{HELPER_DIR}/client.py",
    f"/etc/systemd/system/{UNIT}",
    f"/etc/systemd/system/{GATE_UNIT}",
    "/etc/systemd/system/otter.slice",
    "/etc/polkit-1/rules.d/90-otter-verifier.rules",
    "/etc/sudoers.d/00-otter-verifier-deny",
    JOURNALD_DROPIN,
}
_PROCESS_STATE_MUTEX = threading.RLock()
_ACTIVATION_MUTEX = threading.Lock()


class GateError(Exception):
    """A bounded, non-sensitive caller-visible rejection."""


class UnknownState(Exception):
    """A native fact needed for admission or proof was unavailable."""


class ManagerTimeout(UnknownState):
    """A manager call exceeded its bounded control-plane budget."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def parse_json_object(raw: bytes, *, limit: int = MAX_CONTROL_BYTES) -> dict[str, Any]:
    if len(raw) > limit:
        raise ValueError("JSON message exceeds the size limit")
    value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique_object)
    if not isinstance(value, dict):
        raise ValueError("JSON message must be an object")
    return value


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("ascii")


def _output_units(text: str) -> int:
    return len(text.encode("utf-16-le", errors="strict")) // 2


def _validate_execution_id(value: Any) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ValueError("invalid executionID")
    return value


def validate_reference(value: Any) -> dict[str, Any]:
    """Validate the immutable public ticket shape; native IDs never come from it."""
    expected = {
        "kind", "executionID", "profile", "invocationID", "inputSnapshotID", "inputDigest",
        "deadlineAt", "maxOutputChars", "unit", "bootID",
    }
    if not isinstance(value, dict) or set(value) != expected or "cgroupInode" in value:
        raise ValueError("invalid Linux verifier reference fields")
    if value["kind"] != "verifier" or value["profile"] != "linux-single-use" or value["unit"] != UNIT:
        raise ValueError("reference is outside the fixed Linux verifier profile")
    _validate_execution_id(value["executionID"])
    if not isinstance(value["invocationID"], str) or not INVOCATION_RE.fullmatch(value["invocationID"]):
        raise ValueError("invalid logical invocationID")
    if not isinstance(value["inputSnapshotID"], str) or not HEX40_OR_64.fullmatch(value["inputSnapshotID"]):
        raise ValueError("invalid Git tree ID")
    if not isinstance(value["inputDigest"], str) or not HEX64.fullmatch(value["inputDigest"]):
        raise ValueError("invalid input digest")
    if hashlib.sha256(value["inputSnapshotID"].encode("ascii")).hexdigest() != value["inputDigest"]:
        raise ValueError("input digest does not bind the Git tree ID")
    if (
        isinstance(value["deadlineAt"], bool)
        or not isinstance(value["deadlineAt"], int)
        or not 0 < value["deadlineAt"] <= MAX_SAFE_INTEGER
    ):
        raise ValueError("invalid deadlineAt")
    if isinstance(value["maxOutputChars"], bool) or not isinstance(value["maxOutputChars"], int):
        raise ValueError("invalid maxOutputChars")
    if not 1 <= value["maxOutputChars"] <= MAX_OUTPUT_CHARS:
        raise ValueError("maxOutputChars exceeds the fixed bound")
    if not isinstance(value["bootID"], str) or not BOOT_RE.fullmatch(value["bootID"]):
        raise ValueError("invalid bootID")
    return value


def validate_prepare_request(value: Any, *, now_ms: int | None = None) -> dict[str, Any]:
    expected = {
        "executionID", "profile", "command", "cwd", "inputSnapshotID", "inputDigest",
        "deadlineAt", "maxOutputChars", "inputArchive",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("invalid prepare request fields")
    execution_id = _validate_execution_id(value["executionID"])
    if value["profile"] != "linux-single-use":
        raise ValueError("unsupported verifier profile")
    command = value["command"]
    cwd = value["cwd"]
    if not isinstance(command, str) or len(command) > MAX_COMMAND_CHARS or "\x00" in command:
        raise ValueError("invalid command")
    if not isinstance(cwd, str) or len(cwd) > MAX_CWD_CHARS or "\x00" in cwd:
        raise ValueError("invalid informational cwd")
    tree = value["inputSnapshotID"]
    digest = value["inputDigest"]
    if not isinstance(tree, str) or not HEX40_OR_64.fullmatch(tree):
        raise ValueError("invalid Git tree ID")
    if not isinstance(digest, str) or not HEX64.fullmatch(digest):
        raise ValueError("invalid input digest")
    if hashlib.sha256(tree.encode("ascii")).hexdigest() != digest:
        raise ValueError("input digest does not bind the Git tree ID")
    now = int(time.time() * 1000) if now_ms is None else now_ms
    deadline = value["deadlineAt"]
    if (
        isinstance(deadline, bool) or not isinstance(deadline, int)
        or not now < deadline <= min(MAX_SAFE_INTEGER, now + MAX_RUNTIME_MS)
    ):
        raise ValueError("deadlineAt must be within the fixed 120-second runtime bound")
    output_limit = value["maxOutputChars"]
    if isinstance(output_limit, bool) or not isinstance(output_limit, int) or not 1 <= output_limit <= MAX_OUTPUT_CHARS:
        raise ValueError("maxOutputChars exceeds the fixed bound")
    encoded = value["inputArchive"]
    if not isinstance(encoded, str) or len(encoded) > ((MAX_ARCHIVE_BYTES + 2) // 3) * 4:
        raise ValueError("invalid or oversized inputArchive")
    try:
        archive = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("inputArchive is not valid base64") from exc
    if not archive or len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("inputArchive is empty or exceeds the fixed bound")
    return {
        "executionID": execution_id,
        "profile": "linux-single-use",
        "command": command,
        "cwd": cwd,
        "inputSnapshotID": tree,
        "inputDigest": digest,
        "deadlineAt": deadline,
        "maxOutputChars": output_limit,
        "archive": archive,
    }


@dataclass(frozen=True)
class ArchiveEntry:
    path: bytes
    kind: str
    mode: int
    content: bytes


def _safe_archive_path(name: str, kind: str) -> bytes:
    raw = os.fsencode(name)
    if not raw or raw.startswith(b"/") or b"\x00" in raw or len(raw) > 4096:
        raise ValueError("unsafe archive path")
    if kind == "directory" and raw.endswith(b"/"):
        raw = raw[:-1]
    if not raw:
        raise ValueError("archive root entry is not allowed")
    components = raw.split(b"/")
    if any(part in (b"", b".", b"..") or len(part) > 255 for part in components):
        raise ValueError("unsafe archive path component")
    if b".git" in components:
        raise ValueError("archive contains Git control metadata")
    return raw


def parse_input_archive(archive: bytes) -> list[ArchiveEntry]:
    """Parse only bounded regular files/directories; never extract links or devices."""
    if not isinstance(archive, bytes) or not archive or len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("archive is empty or oversized")
    entries: list[ArchiveEntry] = []
    explicit: set[bytes] = set()
    files: set[bytes] = set()
    directories: set[bytes] = set()
    unpacked = 0
    stream = None
    try:
        stream = tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024)
        stream.write(archive)
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r:") as bundle:
            for member in bundle:
                if len(entries) >= MAX_ARCHIVE_ENTRIES:
                    raise ValueError("archive contains too many entries")
                if any(key not in {"path", "mtime", "comment"} for key in member.pax_headers):
                    raise ValueError("unsupported PAX archive metadata")
                if member.type in (tarfile.DIRTYPE,):
                    kind = "directory"
                elif member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
                    kind = "file"
                else:
                    raise ValueError("archive contains a link or special file")
                if member.linkname:
                    raise ValueError("archive contains a link target")
                path = _safe_archive_path(member.name, kind)
                if path in explicit:
                    raise ValueError("archive contains duplicate paths")
                explicit.add(path)
                parents = [b"/".join(path.split(b"/")[:index]) for index in range(1, len(path.split(b"/")))]
                if any(parent in files for parent in parents):
                    raise ValueError("archive path collides with a file")
                if kind == "directory":
                    if path in files:
                        raise ValueError("archive path collides with a directory")
                    directories.add(path)
                    mode = 0o040000
                    content = b""
                else:
                    if member.size < 0 or member.size > MAX_FILE_BYTES:
                        raise ValueError("archive member exceeds the file-size bound")
                    if path in directories or any(path.startswith(directory + b"/") for directory in files):
                        raise ValueError("archive path collides with an existing entry")
                    unpacked += member.size
                    if unpacked > MAX_UNPACKED_BYTES:
                        raise ValueError("archive exceeds the unpacked-size bound")
                    item = bundle.extractfile(member)
                    if item is None:
                        raise ValueError("archive file payload is missing")
                    with item:
                        content = item.read(member.size + 1)
                    if len(content) != member.size:
                        raise ValueError("archive file payload length is inconsistent")
                    mode = 0o100755 if member.mode & 0o111 else 0o100644
                    files.add(path)
                entries.append(ArchiveEntry(path=path, kind=kind, mode=mode, content=content))
        offset = getattr(bundle, "offset", 0)
        tail = archive[offset:]
        if len(tail) < 1024 or any(tail):
            raise ValueError("archive has missing end markers or non-zero trailing data")
    except (tarfile.TarError, OSError, EOFError, UnicodeError) as exc:
        raise ValueError("invalid or unsupported Git tar archive") from exc
    finally:
        if stream is not None:
            stream.close()
    # Reject implicit file/directory collisions even when the parent appears later.
    for path in files:
        if path in directories or any(other.startswith(path + b"/") for other in files if other != path):
            raise ValueError("archive contains a file/directory collision")
    return entries


def _safe_git_env() -> dict[str, str]:
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": "/nonexistent",
        "LANG": "C",
        "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
    }


def _git(repo: str, args: list[str], *, data: bytes | None = None, timeout: int = 30) -> bytes:
    if not os.path.isfile(GIT):
        raise UnknownState("fixed Git executable is unavailable")
    command = [GIT, f"--git-dir={repo}", *args]
    try:
        result = subprocess.run(
            command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=_safe_git_env(), timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise UnknownState("Git tree validation failed") from exc
    if result.returncode != 0:
        raise UnknownState("Git tree validation failed")
    return result.stdout


def _new_git_repo(tree_id: str) -> str:
    object_format = "sha256" if len(tree_id) == 64 else "sha1"
    repo = tempfile.mkdtemp(prefix="otter-git-tree-", dir=GIT_TMP_DIR)
    try:
        result = subprocess.run(
            [GIT, "init", "--bare", "--quiet", "--template=/dev/null", f"--object-format={object_format}", repo],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_safe_git_env(), timeout=15, check=False,
        )
        if result.returncode != 0:
            raise UnknownState("required Git object format is unsupported")
        return repo
    except BaseException:
        shutil.rmtree(repo, ignore_errors=True)
        raise


def _tree_from_entries(entries: list[ArchiveEntry], tree_id: str, *, require_match: bool = True) -> tuple[str, str]:
    repo = _new_git_repo(tree_id)
    files: dict[bytes, tuple[int, str]] = {}
    directories: set[bytes] = set()
    try:
        for entry in entries:
            parts = entry.path.split(b"/")
            for index in range(1, len(parts)):
                directories.add(b"/".join(parts[:index]))
            if entry.kind == "directory":
                directories.add(entry.path)
            else:
                oid = _git(repo, ["hash-object", "--no-filters", "-w", "--stdin"], data=entry.content).decode("ascii").strip()
                files[entry.path] = (entry.mode, oid)

        children: dict[bytes, list[tuple[bytes, bool, int, str]]] = {}
        for path in directories:
            parent, _, name = path.rpartition(b"/")
            children.setdefault(parent, []).append((name, True, 0o40000, ""))
        for path, (mode, oid) in files.items():
            parent, _, name = path.rpartition(b"/")
            children.setdefault(parent, []).append((name, False, mode, oid))
        tree_oids: dict[bytes, str] = {}
        for directory in sorted(directories, key=lambda item: (item.count(b"/"), item), reverse=True):
            children.setdefault(directory, [])
        directory_paths = sorted(directories, key=lambda item: (item.count(b"/"), item), reverse=True)
        directory_paths.append(b"")
        for directory in directory_paths:
            records: list[tuple[bytes, bool, int, str]] = list(children.get(directory, []))
            for index, (name, is_dir, mode, oid) in enumerate(records):
                if is_dir:
                    child_path = name if not directory else directory + b"/" + name
                    records[index] = (name, True, mode, tree_oids[child_path])
            records.sort(key=lambda item: item[0] + (b"/" if item[1] else b"\x00"))
            payload = b"".join(
                (f"{mode:o} tree {oid}\t".encode("ascii") + name + b"\x00") if is_dir
                else (f"{mode:o} blob {oid}\t".encode("ascii") + name + b"\x00")
                for name, is_dir, mode, oid in records
            )
            oid = _git(repo, ["mktree", "-z"], data=payload).decode("ascii").strip()
            if directory:
                tree_oids[directory] = oid
            else:
                tree_oids[b""] = oid
        actual = tree_oids[b""]
        if require_match and actual != tree_id:
            raise ValueError("archive content does not reconstruct the supplied Git tree")
        return repo, actual
    except BaseException:
        shutil.rmtree(repo, ignore_errors=True)
        raise


def _write_archive(entries: list[ArchiveEntry], destination: str) -> None:
    root = os.fsencode(destination)
    os.chmod(root, 0o700, follow_symlinks=False)
    directories: set[bytes] = set()
    for entry in entries:
        parts = entry.path.split(b"/")
        parents = [b"/".join(parts[:index]) for index in range(1, len(parts))]
        for parent in parents:
            if parent not in directories:
                os.mkdir(os.path.join(root, parent), 0o700)
                directories.add(parent)
        target = os.path.join(root, entry.path)
        if entry.kind == "directory":
            if entry.path not in directories:
                os.mkdir(target, 0o700)
                directories.add(entry.path)
            continue
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            view = memoryview(entry.content)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fchmod(fd, entry.mode & 0o777)
            os.fsync(fd)
        finally:
            os.close(fd)
    for directory in sorted(directories, key=lambda item: item.count(b"/"), reverse=True):
        os.chmod(os.path.join(root, directory), 0o555, follow_symlinks=False)
    os.chmod(root, 0o555, follow_symlinks=False)
    sync_paths = [os.path.join(root, directory) for directory in sorted(directories, key=lambda item: item.count(b"/"), reverse=True)]
    sync_paths.append(root)
    for directory_path in sync_paths:
        fd = os.open(directory_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _safe_path(path: str, *, expected_type: int | None = None, private: bool = False) -> os.stat_result:
    if not os.path.isabs(path):
        raise GateError("installed path is not absolute")
    if os.path.normpath(path) != path or any(part in {".", ".."} for part in path.split("/")):
        raise GateError("installed path is not canonical")
    current = "/"
    parts = [part for part in path.split("/") if part]
    result: os.stat_result | None = None
    for index, part in enumerate(parts):
        current = os.path.join(current, part)
        try:
            result = os.lstat(current)
        except OSError as exc:
            raise GateError("required installed path is unavailable") from exc
        if stat.S_ISLNK(result.st_mode):
            raise GateError("installed path contains a symlink")
        if result.st_uid != 0 or result.st_mode & 0o022:
            raise GateError("installed path is not root-owned and protected")
        if index != len(parts) - 1 and not stat.S_ISDIR(result.st_mode):
            raise GateError("installed path component is not a directory")
    assert result is not None
    if expected_type is not None and stat.S_IFMT(result.st_mode) != expected_type:
        raise GateError("installed path has an unexpected file type")
    if private and (result.st_mode & 0o077):
        raise GateError("private authority file permissions are unsafe")
    return result


def _atomic_bytes(path: str, raw: bytes, mode: int = 0o600) -> None:
    parent = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=True) as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


def _atomic_json(path: str, value: Any, mode: int = 0o600) -> None:
    _atomic_bytes(path, _canonical_json(value) + b"\n", mode)


def _read_json_file(path: str, limit: int = 2 * 1024 * 1024) -> dict[str, Any]:
    _safe_path(path, expected_type=stat.S_IFREG, private=True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(raw) > limit:
        raise GateError("authority record exceeds the size limit")
    try:
        return parse_json_object(raw, limit=limit)
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("authority record is corrupt") from exc


@contextlib.contextmanager
def _exclusive_lock() -> Iterator[None]:
    with _PROCESS_STATE_MUTEX:
        _safe_path(RECORD_DIR, expected_type=stat.S_IFDIR, private=True)
        lock_path = f"{STATE_DIR}/authority.lock"
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
        fd = os.open(lock_path, flags, 0o600)
        try:
            info = os.fstat(fd)
            path_info = os.lstat(lock_path)
            if (
                info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
            ):
                raise GateError("authority lock permissions are unsafe")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


@contextlib.contextmanager
def _activation_lock() -> Iterator[None]:
    with _ACTIVATION_MUTEX:
        _safe_path(STATE_DIR, expected_type=stat.S_IFDIR, private=True)
        fd = os.open(ACTIVATION_LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            path_info = os.lstat(ACTIVATION_LOCK)
            if (
                info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
            ):
                raise GateError("activation lock permissions are unsafe")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def _send_frame(connection: socket.socket, value: Any) -> None:
    payload = _canonical_json(value)
    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError("protocol frame exceeds the size limit")
    connection.sendall(struct.pack("!I", len(payload)) + payload)


def _read_exact(connection: socket.socket, count: int, deadline: float) -> bytes:
    chunks = bytearray()
    while len(chunks) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("protocol frame timed out")
        # select.select is used rather than a buffered reader so timeouts also cover partial frames.
        readable, _, _ = select.select([connection], [], [], remaining)
        if not readable:
            raise TimeoutError("protocol frame timed out")
        part = connection.recv(count - len(chunks))
        if not part:
            raise EOFError("protocol peer closed the connection")
        chunks.extend(part)
    return bytes(chunks)


def _recv_frame(connection: socket.socket, timeout: float, *, limit: int = MAX_FRAME_BYTES) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    length = struct.unpack("!I", _read_exact(connection, 4, deadline))[0]
    if length <= 0 or length > limit:
        raise ValueError("protocol frame length is invalid")
    return parse_json_object(_read_exact(connection, length, deadline), limit=limit)


def _peer_credentials(connection: socket.socket) -> tuple[int, int, int]:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)


def _manager_environment() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "HOME": "/root", "LANG": "C", "LC_ALL": "C"}


def _systemctl(args: list[str], *, timeout: float = 15.0, allow_failure: bool = False) -> str:
    try:
        result = subprocess.run(
            [SYSTEMCTL, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=_manager_environment(), timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ManagerTimeout("systemd manager request timed out") from exc
    except OSError as exc:
        raise UnknownState("systemd manager request failed") from exc
    if result.returncode != 0 and not allow_failure:
        raise UnknownState("systemd manager request failed")
    return result.stdout.decode("utf-8", errors="replace")


def _parse_properties(text: str) -> dict[str, str]:
    properties: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        properties[key] = value
    return properties


def _unit_status(*, timeout: float = 10.0) -> dict[str, str]:
    text = _systemctl(["show", "--no-pager", f"--property={','.join(SYSTEMD_PROPERTIES)}", UNIT], timeout=timeout)
    properties = _parse_properties(text)
    if any(name not in properties for name in SYSTEMD_PROPERTIES):
        raise UnknownState("systemd unit status is incomplete")
    return properties


def _assert_fixed_unit(profile: dict[str, Any], *, check_hashes: bool = True) -> dict[str, str]:
    properties = _unit_status()
    verifier = pwd.getpwuid(profile["verifierUID"])
    expected = {
        "FragmentPath": f"/etc/systemd/system/{UNIT}",
        "DropInPaths": "",
        "LoadState": "loaded",
        "NeedDaemonReload": "no",
        "User": verifier.pw_name,
        "Group": verifier.pw_name,
        "Slice": "otter.slice",
        "KillMode": "control-group",
        "Delegate": "no",
        "Restart": "no",
        "NoNewPrivileges": "yes",
        "CapabilityBoundingSet": "",
        "AmbientCapabilities": "",
        "ProtectControlGroups": "yes",
        "ProtectSystem": "strict",
        "ProtectHome": "yes",
        "PrivateTmp": "yes",
        "PrivateNetwork": "yes",
        "RestrictAddressFamilies": "AF_UNIX",
        "RestrictNamespaces": "yes",
        "ExitType": "cgroup",
        "RemainAfterExit": "no",
        "MemoryMax": str(512 * 1024 * 1024),
        "TasksMax": "128",
        "RuntimeMaxUSec": "2min",
    }
    if properties.get("User") not in (expected["User"], str(profile["verifierUID"])):
        raise UnknownState("fixed verifier unit user changed")
    if properties.get("Group") not in (expected["Group"], str(verifier.pw_gid)):
        raise UnknownState("fixed verifier unit group changed")
    for name, wanted in expected.items():
        if name in {"User", "Group"}:
            continue
        if properties.get(name) != wanted:
            raise UnknownState("fixed verifier unit properties changed")
    if properties.get("FragmentPath") != expected["FragmentPath"] or properties.get("DropInPaths"):
        raise UnknownState("fixed verifier unit source or drop-ins changed")
    if properties.get("LoadState") != "loaded" or properties.get("NeedDaemonReload") != "no":
        raise UnknownState("fixed verifier unit is not loaded from the authenticated manifest")
    if check_hashes:
        _check_profile_files(profile)
    return properties


def _boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id", "rt", encoding="ascii") as source:
            value = source.read(128).strip().lower()
    except OSError as exc:
        raise UnknownState("kernel boot identity is unavailable") from exc
    if not BOOT_RE.fullmatch(value):
        raise UnknownState("kernel boot identity is invalid")
    return value


def _namespace_map(pid: str, name: str) -> tuple[int, int, int]:
    path = f"/proc/{pid}/{name}_map"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(fd, 4096).decode("ascii", errors="strict")
        finally:
            os.close(fd)
    except (OSError, UnicodeError) as exc:
        raise UnknownState("user namespace identity is unavailable") from exc
    rows: list[tuple[int, int, int]] = []
    try:
        for line in raw.splitlines():
            fields = line.split()
            if len(fields) != 3:
                raise ValueError("malformed namespace map")
            row = tuple(int(value) for value in fields)
            if any(value < 0 for value in row):
                raise ValueError("negative namespace map")
            rows.append(row)  # type: ignore[arg-type]
    except ValueError as exc:
        raise UnknownState("user namespace mapping is invalid") from exc
    if len(rows) != 1:
        raise UnknownState("user namespace is not a single full-range mapping")
    return rows[0]


def _assert_initial_user_namespace() -> None:
    if os.geteuid() != 0:
        raise UnknownState("gate is not root in the initial user namespace")
    expected = (0, 0, 4294967295)
    try:
        self_ns = os.stat("/proc/self/ns/user")
        init_ns = os.stat("/proc/1/ns/user")
    except OSError as exc:
        raise UnknownState("initial user namespace identity is unavailable") from exc
    if (self_ns.st_dev, self_ns.st_ino) != (init_ns.st_dev, init_ns.st_ino):
        raise UnknownState("gate is in a different user namespace from PID 1")
    for pid in ("self", "1"):
        if _namespace_map(pid, "uid") != expected or _namespace_map(pid, "gid") != expected:
            raise UnknownState("gate or PID 1 lacks the full initial UID/GID mappings")


def _read_secure_file(path: str, limit: int = 1024 * 1024) -> bytes:
    _safe_path(path, expected_type=stat.S_IFREG)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(raw) > limit:
        raise GateError("installed file exceeds the size limit")
    return raw


def _load_profile(*, check_hashes: bool = True) -> dict[str, Any]:
    _safe_path(PROFILE_PATH, expected_type=stat.S_IFREG)
    raw = _read_secure_file(PROFILE_PATH, limit=1024 * 1024)
    try:
        profile = parse_json_object(raw, limit=1024 * 1024)
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("root verifier profile is invalid") from exc
    if profile.get("schema") != PROFILE_SCHEMA or profile.get("unit") != UNIT:
        raise GateError("root verifier profile schema is unsupported")
    boot_epoch = profile.get("bootEpoch")
    if not isinstance(boot_epoch, str) or not BOOT_RE.fullmatch(boot_epoch):
        raise GateError("root verifier boot epoch is invalid")
    if not isinstance(profile.get("qualified"), bool):
        raise GateError("root verifier qualification field is invalid")
    for key in ("controllerUID", "verifierUID"):
        if isinstance(profile.get(key), bool) or not isinstance(profile.get(key), int) or profile[key] < 1:
            raise GateError("root verifier role UID is invalid")
    if profile["controllerUID"] == profile["verifierUID"]:
        raise GateError("controller and workload roles must be distinct")
    try:
        controller = pwd.getpwuid(profile["controllerUID"])
        verifier = pwd.getpwuid(profile["verifierUID"])
        supplementary_groups = os.getgrouplist(verifier.pw_name, verifier.pw_gid)
        controller_groups = os.getgrouplist(controller.pw_name, controller.pw_gid)
    except (KeyError, OSError) as exc:
        raise GateError("root verifier role accounts are unavailable") from exc
    if (
        controller.pw_uid == 0
        or verifier.pw_name != "otter-verifier"
        or verifier.pw_uid == 0
        or verifier.pw_gid == 0
        or verifier.pw_shell not in {"/usr/sbin/nologin", "/bin/false"}
        or set(supplementary_groups) != {verifier.pw_gid}
        or verifier.pw_gid in controller_groups
    ):
        raise GateError("root verifier role account configuration changed")
    if not isinstance(profile.get("publicKeyPem"), str) or len(profile["publicKeyPem"]) > 8192:
        raise GateError("root verifier public key is invalid")
    files = profile.get("files")
    if not isinstance(files, dict) or set(files) != REQUIRED_PROFILE_FILES:
        raise GateError("root verifier profile file manifest differs from the fixed installation")
    for path, digest in files.items():
        if not isinstance(path, str) or not os.path.isabs(path) or not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise GateError("root verifier file hash entry is invalid")
    if check_hashes:
        _check_profile_files(profile)
    return profile


def _check_profile_files(profile: dict[str, Any]) -> None:
    for path, expected in profile["files"].items():
        raw = _read_secure_file(path, limit=16 * 1024 * 1024)
        if hashlib.sha256(raw).hexdigest() != expected:
            raise GateError("installed verifier helper or unit hash changed")


def _empty_admission_health() -> dict[str, Any]:
    return {
        "bootEpochMatch": False,
        "journal": {"persistentEffective": False, "persistentEntry": False, "readable": False},
        "pendingTickets": 0,
        "pendingBytes": 0,
        "unknownBound": 0,
        "staleActive": 0,
        "latched": False,
        "quarantineRequired": False,
        "capacityAvailable": False,
        "reasons": [],
    }


def _admission_health(profile: dict[str, Any], records: list[dict[str, Any]] | None) -> dict[str, Any]:
    try:
        current_boot = _boot_id()
    except (OSError, UnicodeError, UnknownState):
        current_boot = None
    boot_epoch_match = (
        current_boot is not None
        and isinstance(profile.get("bootEpoch"), str)
        and BOOT_RE.fullmatch(profile["bootEpoch"]) is not None
        and profile["bootEpoch"] == current_boot
    )

    try:
        journal = _journal_health(current_boot)
    except (OSError, UnknownState, ValueError, subprocess.SubprocessError):
        journal = {"persistentEffective": False, "persistentEntry": False, "readable": False}

    unknown_bound = 0 if records is not None else 1
    stale_active = 0
    now_ms = int(time.time() * 1000)
    pending: list[dict[str, Any]] = []
    if records is not None:
        for record in records:
            state = record["state"]
            binding = record.get("binding")
            if state == "unknown" and isinstance(binding, dict):
                unknown_bound += 1
            if (
                state in {"bound", "running", "retiring", "proving"}
                and isinstance(binding, dict)
                and current_boot is not None
                and binding.get("bootID") == current_boot
            ):
                deadline = record.get("reference", {}).get("deadlineAt")
                if (
                    isinstance(deadline, bool)
                    or not isinstance(deadline, int)
                    or now_ms > deadline + MAX_RUNTIME_MS
                ):
                    stale_active += 1
        pending = [
            record for record in records
            if record["state"] in {"prepared", "launching", "bound", "running", "retiring", "proving"}
            or (record["state"] == "unknown" and isinstance(record.get("binding"), dict))
            or os.path.lexists(record["inputPath"])
        ]

    pending_tickets = len(pending)
    pending_bytes = sum(record["archiveBytes"] for record in pending)
    capacity_available = (
        records is not None
        and pending_tickets < MAX_PENDING_TICKETS
        and pending_bytes < MAX_PENDING_ARCHIVE_BYTES
    )

    reasons: set[str] = set()
    if not boot_epoch_match:
        reasons.add("boot-epoch")
    if unknown_bound:
        reasons.add("unknown-bound")
    if stale_active:
        reasons.add("stale-active")
    if not journal["persistentEffective"]:
        reasons.add("journal-persistence")
    if not journal["persistentEntry"]:
        reasons.add("journal-entry")
    if not journal["readable"]:
        reasons.add("journal-readable")

    quarantine_reasons = [
        reason for reason in ("boot-epoch", "unknown-bound", "stale-active") if reason in reasons
    ]
    latched = _quarantine_is_latched()
    if quarantine_reasons and not latched:
        try:
            _create_quarantine_latch(profile, current_boot, quarantine_reasons)
        except OSError:
            pass
        latched = _quarantine_is_latched()
    if latched:
        reasons.add("latched")

    reason_order = (
        "boot-epoch", "unknown-bound", "stale-active", "latched",
        "journal-persistence", "journal-entry", "journal-readable",
    )
    ordered_reasons = [reason for reason in reason_order if reason in reasons]
    return {
        "bootEpochMatch": boot_epoch_match,
        "journal": journal,
        "pendingTickets": pending_tickets,
        "pendingBytes": pending_bytes,
        "unknownBound": unknown_bound,
        "staleActive": stale_active,
        "latched": latched,
        "quarantineRequired": bool(quarantine_reasons or latched),
        "capacityAvailable": capacity_available,
        "reasons": ordered_reasons,
    }


def _check_state_dirs() -> None:
    for path in (STATE_DIR, RECORD_DIR, INPUT_DIR, PRIVATE_DIR, GIT_TMP_DIR):
        _safe_path(path, expected_type=stat.S_IFDIR, private=True)


def _record_path(ticket: str) -> str:
    if not INVOCATION_RE.fullmatch(ticket):
        raise GateError("invalid logical invocationID")
    return f"{RECORD_DIR}/{ticket}.json"


def _load_record(ticket: str) -> dict[str, Any]:
    record = _read_json_file(_record_path(ticket))
    if record.get("schema") != RECORD_SCHEMA or record.get("ticket") != ticket:
        raise GateError("authority record is corrupt")
    try:
        reference = validate_reference(record.get("reference"))
    except (TypeError, ValueError) as exc:
        raise GateError("authority record reference is corrupt") from exc
    state = record.get("state")
    if reference["invocationID"] != ticket or not isinstance(state, str) or state not in {
        "prepared", "launching", "bound", "running", "retiring", "proving", "terminal", "unknown",
    }:
        raise GateError("authority record state is corrupt")
    command = record.get("command")
    cwd = record.get("cwd")
    output = record.get("output")
    input_path = record.get("inputPath")
    archive_bytes = record.get("archiveBytes")
    if (
        not isinstance(command, str) or len(command) > MAX_COMMAND_CHARS or "\x00" in command
        or not isinstance(cwd, str) or len(cwd) > MAX_CWD_CHARS or "\x00" in cwd
        or not isinstance(output, str) or _output_units(output) > reference["maxOutputChars"]
        or input_path != f"{INPUT_DIR}/{ticket}"
        or isinstance(archive_bytes, bool) or not isinstance(archive_bytes, int) or archive_bytes < 0
    ):
        raise GateError("authority record payload is corrupt")
    for flag in ("timedOut", "cancelled", "released", "commandStarted"):
        if not isinstance(record.get(flag), bool):
            raise GateError("authority record flags are corrupt")
    if "doneReceived" in record and not isinstance(record["doneReceived"], bool):
        raise GateError("authority completion flag is corrupt")
    if record.get("doneReceived") is True and record.get("parentExit") is None:
        raise GateError("authority completion lacks a durable child exit status")
    if "killRequested" in record and not isinstance(record["killRequested"], bool):
        raise GateError("authority cgroup kill intent is corrupt")
    if "killRequestedAt" in record and (
        isinstance(record["killRequestedAt"], bool)
        or not isinstance(record["killRequestedAt"], int)
        or record["killRequestedAt"] <= 0
    ):
        raise GateError("authority cgroup kill timestamp is corrupt")
    if record["commandStarted"] and not record["released"]:
        raise GateError("authority command start precedes durable release")
    parent_exit = record.get("parentExit")
    if parent_exit is not None and (
        isinstance(parent_exit, bool) or not isinstance(parent_exit, int) or not -255 <= parent_exit <= 255
    ):
        raise GateError("authority record exit status is corrupt")
    binding = record.get("binding")
    if state in {"bound", "running", "retiring", "proving", "terminal"} and not isinstance(binding, dict):
        raise GateError("authority record native binding is missing")
    if binding is not None:
        binding_fields = {
            "unit", "bootID", "systemdInvocationID", "mainPID", "startTimeTicks",
            "cgroupPath", "device", "inode",
        }
        if not isinstance(binding, dict) or set(binding) != binding_fields:
            raise GateError("authority record native binding is corrupt")
        if (
            binding["unit"] != UNIT
            or binding["bootID"] != reference["bootID"]
            or not isinstance(binding["systemdInvocationID"], str)
            or not INVOCATION_RE.fullmatch(binding["systemdInvocationID"])
            or isinstance(binding["mainPID"], bool) or not isinstance(binding["mainPID"], int) or binding["mainPID"] <= 1
            or isinstance(binding["startTimeTicks"], bool) or not isinstance(binding["startTimeTicks"], int) or binding["startTimeTicks"] < 0
            or binding["cgroupPath"] != CGROUP_PATH
            or isinstance(binding["device"], bool) or not isinstance(binding["device"], int) or binding["device"] < 0
            or isinstance(binding["inode"], bool) or not isinstance(binding["inode"], int) or binding["inode"] <= 0
        ):
            raise GateError("authority record native binding is corrupt")
    proof_intent = record.get("proofIntent")
    if state == "proving":
        if not isinstance(proof_intent, dict) or set(proof_intent) != {
            "kind", "messageID", "inputIntegrity", "outputSha256",
        }:
            raise GateError("authority proof intent is corrupt")
        proof_kind = proof_intent.get("kind")
        message_id = proof_intent.get("messageID")
        if (
            not isinstance(proof_kind, str)
            or proof_kind not in {"held-deleted-journal", "recovered-journal"}
            or not isinstance(message_id, str)
            or message_id not in RETIREMENT_MESSAGE_IDS
            or proof_intent.get("inputIntegrity") not in {"unchanged", "changed", "unknown"}
            or not isinstance(proof_intent.get("outputSha256"), str)
            or not HEX64.fullmatch(proof_intent["outputSha256"])
        ):
            raise GateError("authority proof intent fields are corrupt")
    elif "proofIntent" in record:
        raise GateError("authority record has an unexpected proof intent")
    if state == "terminal":
        _validate_terminal_record(record)
    elif "result" in record:
        raise GateError("non-terminal authority record contains a result")
    return record


def _validate_terminal_record(record: dict[str, Any]) -> None:
    result = record.get("result")
    if not isinstance(result, dict) or set(result) != {
        "profile", "parentExit", "timedOut", "cancelled", "isolationEstablished", "domainState", "integrity", "output", "proof",
    }:
        raise GateError("terminal authority result is corrupt")
    proof = result.get("proof")
    if not isinstance(proof, dict) or set(proof) != {"reference", "evidence", "receipt", "signature"}:
        raise GateError("terminal authority proof is corrupt")
    if (
        result.get("profile") != "linux-single-use"
        or (result.get("parentExit") is not None and (
            isinstance(result.get("parentExit"), bool)
            or not isinstance(result.get("parentExit"), int)
            or not -255 <= result["parentExit"] <= 255
        ))
        or result.get("parentExit") != record.get("parentExit")
        or result.get("timedOut") is not record.get("timedOut")
        or result.get("cancelled") is not record.get("cancelled")
        or result.get("isolationEstablished") is not True
        or result.get("domainState") != "empty"
        or not isinstance(result.get("integrity"), str)
        or result.get("integrity") not in {"unchanged", "changed", "unknown"}
        or result.get("output") != record.get("output")
        or not _same_reference(proof.get("reference"), record.get("reference"))
        or proof.get("evidence") != "authenticated Linux gate retirement"
    ):
        raise GateError("terminal authority result fields are corrupt")
    receipt_text = proof.get("receipt")
    signature_text = proof.get("signature")
    if not isinstance(receipt_text, str) or not isinstance(signature_text, str):
        raise GateError("terminal authority receipt is corrupt")
    try:
        receipt = receipt_text.encode("utf-8", errors="strict")
        payload = parse_json_object(receipt, limit=MAX_RECEIPT_BYTES)
        signature = base64.b64decode(signature_text, validate=True)
    except (ValueError, UnicodeError, binascii.Error, json.JSONDecodeError) as exc:
        raise GateError("terminal authority receipt is corrupt") from exc
    if len(signature) != 64 or _canonical_json(payload) != receipt:
        raise GateError("terminal authority receipt encoding is corrupt")
    if set(payload) != {"schema", "reference", "binding", "retirement", "result"}:
        raise GateError("terminal authority receipt fields are corrupt")
    if payload.get("schema") != RECEIPT_SCHEMA or not _same_reference(payload.get("reference"), record.get("reference")):
        raise GateError("terminal authority receipt reference is corrupt")
    if payload.get("binding") != record.get("binding"):
        raise GateError("terminal authority receipt binding is corrupt")
    retirement = payload.get("retirement")
    retirement_kind = retirement.get("kind") if isinstance(retirement, dict) else None
    message_id = retirement.get("messageID") if isinstance(retirement, dict) else None
    if (
        not isinstance(retirement, dict)
        or not isinstance(retirement_kind, str)
        or retirement_kind not in {"held-deleted-journal", "recovered-journal"}
    ):
        raise GateError("terminal authority retirement evidence is corrupt")
    if (
        set(retirement) != {"kind", "messageID"}
        or not isinstance(message_id, str)
        or message_id not in RETIREMENT_MESSAGE_IDS
    ):
        raise GateError("terminal authority journal evidence is corrupt")
    receipt_result = payload.get("result")
    if not isinstance(receipt_result, dict) or set(receipt_result) != {
        "parentExit", "timedOut", "cancelled", "inputIntegrity", "outputSha256",
    }:
        raise GateError("terminal authority signed result is corrupt")
    if (
        (receipt_result.get("parentExit") is not None and (
            isinstance(receipt_result.get("parentExit"), bool)
            or not isinstance(receipt_result.get("parentExit"), int)
            or not -255 <= receipt_result["parentExit"] <= 255
        ))
        or receipt_result.get("parentExit") != record.get("parentExit")
        or receipt_result.get("timedOut") is not record.get("timedOut")
        or receipt_result.get("cancelled") is not record.get("cancelled")
        or receipt_result.get("inputIntegrity") != result.get("integrity")
        or receipt_result.get("outputSha256") != hashlib.sha256(result["output"].encode("utf-8")).hexdigest()
    ):
        raise GateError("terminal authority signed result does not match its output")


def _read_admission_records() -> list[dict[str, Any]]:
    _check_state_dirs()
    try:
        names = os.listdir(RECORD_DIR)
    except OSError as exc:
        raise GateError("authority records are unavailable") from exc
    records: list[dict[str, Any]] = []
    for name in sorted(names):
        if name.startswith(".tmp-"):
            raise GateError("interrupted authority record write is unresolved")
        if not re.fullmatch(r"[0-9a-f]{32}\.json", name):
            raise GateError("unexpected file in authority record directory")
        records.append(_load_record(name[:-5]))
    return records


def _iter_records() -> Iterator[dict[str, Any]]:
    _check_state_dirs()
    try:
        names = os.listdir(RECORD_DIR)
    except OSError as exc:
        raise GateError("authority records are unavailable") from exc
    removed_temporary = False
    for name in sorted(names):
        if name.startswith(".tmp-"):
            path = f"{RECORD_DIR}/{name}"
            try:
                info = os.lstat(path)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
                raise GateError("interrupted authority record write left an unsafe temporary file")
            os.unlink(path)
            removed_temporary = True
            continue
        if not re.fullmatch(r"[0-9a-f]{32}\.json", name):
            raise GateError("unexpected file in authority record directory")
        yield _load_record(name[:-5])
    if removed_temporary:
        directory_fd = os.open(RECORD_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def _write_record(record: dict[str, Any]) -> None:
    _atomic_json(_record_path(record["ticket"]), record)


def _remove_input(record: dict[str, Any]) -> None:
    expected = f"{INPUT_DIR}/{record['ticket']}"
    if record.get("inputPath") != expected:
        raise GateError("authority input path is corrupt")
    try:
        info = os.lstat(expected)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        raise GateError("authority input path is unsafe to remove")
    shutil.rmtree(expected)
    directory_fd = os.open(INPUT_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _cleanup_orphan_directories(records: list[dict[str, Any]]) -> None:
    known = {record["ticket"] for record in records}
    reclaim = {
        record["ticket"] for record in records
        if record["state"] == "terminal" or (record["state"] == "unknown" and not isinstance(record.get("binding"), dict))
    }
    for name in os.listdir(INPUT_DIR):
        if not (
            name.startswith("input-")
            or (INVOCATION_RE.fullmatch(name) and name not in known)
            or name in reclaim
        ):
            continue
        path = f"{INPUT_DIR}/{name}"
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(info.st_mode) and info.st_uid == 0:
            shutil.rmtree(path)
    for name in os.listdir(GIT_TMP_DIR):
        if not name.startswith(("otter-git-", "receipt-sign-", "receipt-verify-")):
            continue
        path = f"{GIT_TMP_DIR}/{name}"
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        if info.st_uid != 0 or stat.S_ISLNK(info.st_mode):
            continue
        if stat.S_ISDIR(info.st_mode):
            shutil.rmtree(path)
        elif stat.S_ISREG(info.st_mode):
            os.unlink(path)


def _cancel_prepared_locked(
    record: dict[str, Any],
    reason: str,
    *,
    timed_out: bool = False,
    cancelled: bool = True,
) -> None:
    record["state"] = "unknown"
    record["timedOut"] = bool(timed_out)
    record["cancelled"] = bool(cancelled)
    record["unknownReason"] = reason
    _write_record(record)
    _cleanup_input_async(record)


def _cleanup_input_async(record: dict[str, Any]) -> None:
    cleanup_record = {"ticket": record["ticket"], "inputPath": record["inputPath"]}

    def cleanup() -> None:
        with contextlib.suppress(OSError, GateError):
            _remove_input(cleanup_record)

    threading.Thread(target=cleanup, name=f"otter-input-cleanup-{record['ticket']}", daemon=True).start()


def _same_reference(left: Any, right: Any) -> bool:
    try:
        return _canonical_json(validate_reference(left)) == _canonical_json(validate_reference(right))
    except (TypeError, ValueError):
        return False


def _proc_start_time(pid: int) -> int:
    try:
        fd = os.open(f"/proc/{pid}/stat", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(fd, 16_384).decode("ascii", errors="strict")
        finally:
            os.close(fd)
        close = raw.rfind(")")
        if close < 0:
            raise ValueError("malformed proc stat")
        fields = raw[close + 1 :].strip().split()
        value = int(fields[19])  # field 22 (starttime); fields begin with field 3.
        if value < 0:
            raise ValueError("invalid proc start time")
        return value
    except (OSError, UnicodeError, ValueError, IndexError) as exc:
        raise UnknownState("runner process identity is unavailable") from exc


def _proc_cgroup(pid: int) -> str:
    try:
        fd = os.open(f"/proc/{pid}/cgroup", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            lines = os.read(fd, 16_384).decode("ascii", errors="strict").splitlines()
        finally:
            os.close(fd)
    except (OSError, UnicodeError) as exc:
        raise UnknownState("runner cgroup identity is unavailable") from exc
    unified = [line[3:] for line in lines if line.startswith("0::")]
    if len(unified) != 1 or unified[0] != CGROUP_PATH:
        raise UnknownState("runner is not in the fixed verifier cgroup")
    return unified[0]


def _proc_uids(pid: int) -> tuple[int, int, int, int]:
    try:
        fd = os.open(f"/proc/{pid}/status", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            text = os.read(fd, 65_536).decode("ascii", errors="strict")
        finally:
            os.close(fd)
    except (OSError, UnicodeError) as exc:
        raise UnknownState("runner UID identity is unavailable") from exc
    for line in text.splitlines():
        if line.startswith("Uid:"):
            values = tuple(int(value) for value in line.split()[1:5])
            if len(values) == 4:
                return values  # type: ignore[return-value]
    raise UnknownState("runner UID identity is unavailable")


@dataclass
class CgroupHandle:
    directory_fd: int
    events_fd: int
    device: int
    inode: int

    def close(self) -> None:
        for descriptor in (self.events_fd, self.directory_fd):
            with contextlib.suppress(OSError):
                os.close(descriptor)


def _open_bound_cgroup(path: str, expected_device: int | None = None, expected_inode: int | None = None) -> CgroupHandle:
    if path != CGROUP_PATH:
        raise UnknownState("native cgroup path differs from the fixed unit")
    root_fd = slice_fd = directory_fd = events_fd = -1
    try:
        root_fd = os.open(CGROUP_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        slice_fd = os.open("otter.slice", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        directory_fd = os.open("otter-verifier.service", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=slice_fd)
        os.close(root_fd)
        os.close(slice_fd)
        root_fd = slice_fd = -1
        info = os.fstat(directory_fd)
        if expected_device is not None and info.st_dev != expected_device:
            os.close(directory_fd)
            raise UnknownState("native cgroup device changed")
        if expected_inode is not None and info.st_ino != expected_inode:
            os.close(directory_fd)
            raise UnknownState("native cgroup inode changed")
        events_fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        result = CgroupHandle(directory_fd, events_fd, info.st_dev, info.st_ino)
        directory_fd = events_fd = -1
        return result
    except OSError as exc:
        for descriptor in (events_fd, directory_fd, slice_fd, root_fd):
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)
        if exc.errno == errno.ENODEV:
            raise UnknownState("native cgroup is deleted") from exc
        if exc.errno == errno.ENOENT:
            raise UnknownState("native cgroup is absent") from exc
        raise UnknownState("native cgroup cannot be held safely") from exc


def _cgroup_populated(handle: CgroupHandle) -> int:
    try:
        os.lseek(handle.events_fd, 0, os.SEEK_SET)
        raw = os.read(handle.events_fd, 4096).decode("ascii", errors="strict")
    except OSError as exc:
        if exc.errno == errno.ENODEV:  # ENODEV is native deletion evidence only when journal-bound below.
            raise UnknownState("native cgroup events file was deleted") from exc
        raise UnknownState("native cgroup events are unavailable") from exc
    fields: dict[str, str] = {}
    for line in raw.splitlines():
        pair = line.split()
        if len(pair) == 2:
            fields[pair[0]] = pair[1]
    if fields.get("populated") not in {"0", "1"}:
        raise UnknownState("native cgroup population is unavailable")
    return int(fields["populated"])


def _request_cgroup_kill(handle: CgroupHandle) -> None:
    directory = os.fstat(handle.directory_fd)
    if (directory.st_dev, directory.st_ino) != (handle.device, handle.inode):
        raise UnknownState("held cgroup directory identity changed")
    kill_fd = os.open("cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=handle.directory_fd)
    try:
        if os.write(kill_fd, b"1\n") != 2:
            raise UnknownState("cgroup.kill accepted an incomplete command")
    finally:
        os.close(kill_fd)


def _held_cgroup_deleted(handle: CgroupHandle, binding: dict[str, Any]) -> bool:
    directory = os.fstat(handle.directory_fd)
    if (
        handle.device != binding.get("device")
        or handle.inode != binding.get("inode")
        or (directory.st_dev, directory.st_ino) != (binding.get("device"), binding.get("inode"))
    ):
        return False
    try:
        _cgroup_populated(handle)
    except UnknownState as exc:
        return "deleted" in str(exc)
    return False


def _binding_from_runner(
    connection: socket.socket,
    profile: dict[str, Any],
    boot_id: str,
    prior_systemd_invocation: str,
) -> tuple[dict[str, Any], CgroupHandle]:
    pid, uid, _gid = _peer_credentials(connection)
    if pid <= 1 or uid != profile["verifierUID"]:
        raise UnknownState("runner peer UID or PID is not authorized")
    status_before = _assert_fixed_unit(profile)
    if status_before["ActiveState"] not in {"active", "activating"}:
        raise UnknownState("fixed verifier unit is not freshly active")
    if status_before["MainPID"] != str(pid) or status_before["ControlGroup"] != CGROUP_PATH:
        raise UnknownState("runner peer does not match systemd MainPID and cgroup")
    systemd_id = status_before["InvocationID"]
    if not INVOCATION_RE.fullmatch(systemd_id) or (prior_systemd_invocation and systemd_id == prior_systemd_invocation):
        raise UnknownState("systemd invocation identity is unavailable")
    if _boot_id() != boot_id:
        raise UnknownState("kernel boot identity changed during launch")
    start_time = _proc_start_time(pid)
    if _proc_cgroup(pid) != CGROUP_PATH:
        raise UnknownState("runner process cgroup identity changed")
    if any(value != profile["verifierUID"] for value in _proc_uids(pid)):
        raise UnknownState("runner process UID identity changed")
    handle = _open_bound_cgroup(CGROUP_PATH)
    try:
        if _cgroup_populated(handle) != 1:
            raise UnknownState("runner cgroup is not populated")
        status_after = _assert_fixed_unit(profile)
        if (
            _boot_id() != boot_id
            or status_after["ActiveState"] not in {"active", "activating"}
            or status_after["MainPID"] != str(pid)
            or status_after["InvocationID"] != systemd_id
            or status_after["ControlGroup"] != CGROUP_PATH
            or _proc_start_time(pid) != start_time
            or _proc_cgroup(pid) != CGROUP_PATH
        ):
            raise UnknownState("runner native identity changed during authentication")
    except BaseException:
        handle.close()
        raise
    binding = {
        "unit": UNIT,
        "bootID": boot_id,
        "systemdInvocationID": systemd_id,
        "mainPID": pid,
        "startTimeTicks": start_time,
        "cgroupPath": CGROUP_PATH,
        "device": handle.device,
        "inode": handle.inode,
    }
    return binding, handle


def _assert_runner_binding_active(
    profile: dict[str, Any], binding: dict[str, Any], handle: CgroupHandle,
) -> None:
    if _boot_id() != binding["bootID"]:
        raise UnknownState("kernel boot identity changed before command release")
    properties = _assert_fixed_unit(profile)
    if (
        properties["ActiveState"] not in {"active", "activating"}
        or properties["InvocationID"] != binding["systemdInvocationID"]
        or properties["MainPID"] != str(binding["mainPID"])
        or properties["ControlGroup"] != binding["cgroupPath"]
        or (handle.device, handle.inode) != (binding["device"], binding["inode"])
    ):
        raise UnknownState("fresh fixed-unit identity check failed before command release")
    current = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
    current.close()
    if (
        _proc_start_time(binding["mainPID"]) != binding["startTimeTicks"]
        or _proc_cgroup(binding["mainPID"]) != binding["cgroupPath"]
        or any(value != profile["verifierUID"] for value in _proc_uids(binding["mainPID"]))
        or _cgroup_populated(handle) != 1
    ):
        raise UnknownState("bound runner process changed before command release")


def _journal_retirement(binding: dict[str, Any]) -> str | None:
    if not os.path.isfile(JOURNALCTL):
        return None
    boot_compact = binding["bootID"].replace("-", "")
    args = [
        JOURNALCTL, "--no-pager", "--output=json", f"--boot={boot_compact}",
        "_PID=1", "_UID=0", f"_BOOT_ID={boot_compact}", f"UNIT={UNIT}",
        f"INVOCATION_ID={binding['systemdInvocationID']}",
    ]
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_manager_environment(), timeout=8, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or len(result.stdout) > 2 * 1024 * 1024:
        return None
    for line in result.stdout.splitlines():
        try:
            entry = json.loads(line.decode("utf-8", errors="strict"), object_pairs_hook=_unique_object)
        except (ValueError, UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(entry, dict):
            continue
        if (
            entry.get("_PID") == "1"
            and entry.get("_UID") == "0"
            and entry.get("_BOOT_ID") == boot_compact
            and entry.get("UNIT") == UNIT
            and entry.get("INVOCATION_ID") == binding["systemdInvocationID"]
            and isinstance(entry.get("MESSAGE_ID"), str)
            and entry.get("MESSAGE_ID") in RETIREMENT_MESSAGE_IDS
        ):
            return entry["MESSAGE_ID"]
    return None


def _bounded_command_output(arguments: list[str], *, timeout: float, max_bytes: int) -> bytes | None:
    try:
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=_manager_environment(),
        )
    except OSError:
        return None
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        assert process.stdout is not None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("fixed journal probe timed out")
            readable, _, _ = select.select([process.stdout], [], [], remaining)
            if not readable:
                raise TimeoutError("fixed journal probe timed out")
            chunk = os.read(process.stdout.fileno(), min(64 * 1024, max_bytes + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > max_bytes:
                process.kill()
                process.wait(timeout=1)
                return None
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
        return bytes(output)
    except (OSError, subprocess.SubprocessError, TimeoutError, ValueError):
        if process.poll() is None:
            with contextlib.suppress(OSError):
                process.kill()
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            process.wait(timeout=1)
        return None
    finally:
        if process.stdout is not None:
            process.stdout.close()


def _journal_storage_is_persistent(configuration: str) -> bool:
    source: str | None = None
    section: str | None = None
    effective: tuple[str | None, str | None] | None = None
    for line in configuration.splitlines():
        marker = re.fullmatch(r"#\s+(/[^\r\n]+)", line)
        if marker:
            source = marker.group(1).strip()
            section = None
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", ";")):
            continue
        if stripped.startswith("["):
            section = stripped[1:-1] if stripped.endswith("]") else None
            continue
        if section != "Journal" or not re.match(r"^\s*Storage\s*=", line):
            continue
        setting = re.fullmatch(r"\s*Storage\s*=\s*([^\s#;]*)(?:\s*[#;].*)?\s*", line)
        effective = (setting.group(1) if setting else None, source)
    return effective == ("persistent", JOURNALD_DROPIN)


def _journal_config_is_persistent() -> bool:
    output = _bounded_command_output(
        [SYSTEMD_ANALYZE, "cat-config", "systemd/journald.conf"],
        timeout=5,
        max_bytes=256 * 1024,
    )
    if output is None:
        return False
    try:
        configuration = output.decode("utf-8", errors="strict")
    except UnicodeError:
        return False
    return _journal_storage_is_persistent(configuration)


def _persistent_journal_directory() -> str | None:
    try:
        raw = _read_secure_file("/etc/machine-id", limit=128)
        machine_id = raw.decode("ascii", errors="strict")
        if machine_id.endswith("\n"):
            machine_id = machine_id[:-1]
        if not MACHINE_ID_RE.fullmatch(machine_id):
            return None
        path = f"/var/log/journal/{machine_id}"
        _safe_path(path, expected_type=stat.S_IFDIR)
        return path
    except (GateError, OSError, UnicodeError):
        return None


def _journal_has_current_pid1_entry(boot_id: str, directory: str | None) -> bool:
    boot_compact = boot_id.replace("-", "")
    arguments = [JOURNALCTL]
    if directory is not None:
        arguments.append(f"--directory={directory}")
    arguments.extend(("--no-pager", "--output=json", f"--boot={boot_compact}", "-n", "1", "_PID=1"))
    output = _bounded_command_output(arguments, timeout=8, max_bytes=2 * 1024 * 1024)
    if output is None:
        return False
    try:
        lines = output.decode("utf-8", errors="strict").splitlines()
        if not lines:
            return False
        for line in lines:
            entry = json.loads(line, object_pairs_hook=_unique_object)
            if not isinstance(entry, dict) or entry.get("_PID") != "1" or entry.get("_BOOT_ID") != boot_compact:
                return False
        return True
    except (ValueError, UnicodeError, json.JSONDecodeError):
        return False


def _journald_service_is_running() -> bool:
    output = _bounded_command_output(
        [SYSTEMCTL, "show", "--no-pager", "--property=ActiveState,SubState", "systemd-journald.service"],
        timeout=5,
        max_bytes=16 * 1024,
    )
    if output is None:
        return False
    try:
        lines = output.decode("utf-8", errors="strict").splitlines()
    except UnicodeError:
        return False
    properties: dict[str, str] = {}
    for line in lines:
        name, separator, value = line.partition("=")
        if not separator or name not in {"ActiveState", "SubState"} or name in properties:
            return False
        properties[name] = value
    return properties == {"ActiveState": "active", "SubState": "running"}


def _journal_health(boot_id: str | None) -> dict[str, bool]:
    journal_directory = _persistent_journal_directory()
    readable_entry = bool(boot_id is not None and _journal_has_current_pid1_entry(boot_id, None))
    journald_running = _journald_service_is_running()
    return {
        "persistentEffective": _journal_config_is_persistent(),
        "persistentEntry": bool(
            boot_id is not None
            and journal_directory is not None
            and _journal_has_current_pid1_entry(boot_id, journal_directory)
        ),
        "readable": bool(readable_entry and journald_running),
    }


def _quarantine_is_latched() -> bool:
    try:
        os.lstat(QUARANTINE_PATH)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def _create_quarantine_latch(profile: dict[str, Any], boot_id: str | None, reasons: list[str]) -> None:
    content = _canonical_json({
        "schema": "otter.linux-verifier.quarantine.v1",
        "bootEpoch": profile.get("bootEpoch"),
        "observedBootID": boot_id,
        "reasons": reasons,
    }) + b"\n"
    descriptor = os.open(
        QUARANTINE_PATH,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError(errno.EIO, "quarantine latch write made no progress")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_fd = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _check_signing_key(profile: dict[str, Any]) -> None:
    info = _safe_path(SIGNING_KEY, expected_type=stat.S_IFREG, private=True)
    if info.st_mode & 0o777 != 0o600:
        raise GateError("root signing key permissions are unsafe")
    try:
        result = subprocess.run(
            [OPENSSL, "pkey", "-in", SIGNING_KEY, "-pubout"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_manager_environment(), timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateError("root signing key is unavailable") from exc
    if result.returncode != 0:
        raise GateError("root signing key is invalid")
    try:
        expected = profile["publicKeyPem"].encode("ascii")
    except UnicodeEncodeError as exc:
        raise GateError("root profile public key is invalid") from exc
    if result.stdout.strip() != expected.strip():
        raise GateError("root signing key does not match the fixed profile")
    try:
        key_type = subprocess.run(
            [OPENSSL, "pkey", "-pubin", "-text", "-noout"],
            input=result.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=_manager_environment(), timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateError("root signing key type is unavailable") from exc
    if key_type.returncode != 0 or b"ED25519" not in key_type.stdout:
        raise GateError("root signing key is not Ed25519")


def _sign_receipt(payload: dict[str, Any], profile: dict[str, Any]) -> tuple[str, str]:
    _check_signing_key(profile)
    receipt = _canonical_json(payload)
    if not receipt or len(receipt) > MAX_RECEIPT_BYTES:
        raise GateError("retirement receipt exceeds the fixed size bound")
    try:
        # OpenSSL requires an explicit regular-file input, even when stdin is regular.
        with tempfile.NamedTemporaryFile(prefix="receipt-sign-", dir=GIT_TMP_DIR) as message:
            message.write(receipt)
            message.flush()
            result = subprocess.run(
                [OPENSSL, "pkeyutl", "-sign", "-rawin", "-inkey", SIGNING_KEY, "-in", message.name],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=_manager_environment(), timeout=5, check=False,
            )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateError("root receipt signing failed") from exc
    if result.returncode != 0 or len(result.stdout) != 64:
        raise GateError("root receipt signing failed")
    return receipt.decode("utf-8", errors="strict"), base64.b64encode(result.stdout).decode("ascii")


def _verify_stored_receipt(record: dict[str, Any], profile: dict[str, Any]) -> None:
    _validate_terminal_record(record)
    _check_profile_files(profile)
    _check_signing_key(profile)
    proof = record["result"]["proof"]
    receipt = proof["receipt"].encode("utf-8", errors="strict")
    signature = base64.b64decode(proof["signature"], validate=True)
    # Each descriptor has exactly one owner. Closing stale integer descriptors
    # again in a threaded server can close an unrelated newly allocated socket.
    with tempfile.TemporaryDirectory(prefix="receipt-verify-", dir=GIT_TMP_DIR) as scratch:
        public_path = os.path.join(scratch, "public.pem")
        signature_path = os.path.join(scratch, "signature")
        message_path = os.path.join(scratch, "receipt")
        with open(public_path, "xb") as output, open(signature_path, "xb") as output_signature:
            os.fchmod(output.fileno(), 0o600)
            os.fchmod(output_signature.fileno(), 0o600)
            output.write(profile["publicKeyPem"].encode("ascii", errors="strict"))
            output_signature.write(signature)
        with open(message_path, "xb") as message:
            os.fchmod(message.fileno(), 0o600)
            message.write(receipt)
        try:
            verified = subprocess.run(
                [OPENSSL, "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", public_path,
                 "-sigfile", signature_path, "-in", message_path],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=_manager_environment(), timeout=5, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise GateError("stored retirement signature could not be checked") from exc
        if verified.returncode != 0:
            raise GateError("stored retirement signature is invalid")


def _safe_input_tree(path: str, expected_tree: str) -> str:
    entries: list[ArchiveEntry] = []
    root = os.fsencode(path)
    try:
        root_info = os.lstat(path)
    except OSError as exc:
        raise UnknownState("immutable verifier input is unavailable") from exc
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != 0 or root_info.st_mode & 0o022:
        raise UnknownState("immutable verifier input root permissions are unsafe")
    count = 0
    total = 0

    def visit(directory: bytes, prefix: bytes) -> None:
        nonlocal count, total
        try:
            children = sorted(os.scandir(directory), key=lambda item: os.fsencode(item.name))
        except OSError as exc:
            raise UnknownState("immutable verifier input is unavailable") from exc
        for child in children:
            name = os.fsencode(child.name)
            if not name or b"/" in name or name in (b".", b"..") or b"\x00" in name:
                raise UnknownState("immutable verifier input has an unsafe name")
            child_path = name if not prefix else prefix + b"/" + name
            try:
                info = child.stat(follow_symlinks=False)
            except OSError as exc:
                raise UnknownState("immutable verifier input changed during inspection") from exc
            count += 1
            if count > MAX_ARCHIVE_ENTRIES:
                raise UnknownState("immutable verifier input exceeds the entry bound")
            if stat.S_ISDIR(info.st_mode):
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise UnknownState("immutable verifier input directory permissions changed")
                entries.append(ArchiveEntry(child_path, "directory", 0o040000, b""))
                visit(os.path.join(directory, name), child_path)
            elif stat.S_ISREG(info.st_mode):
                if info.st_uid != 0 or info.st_mode & (0o022 | 0o6000):
                    raise UnknownState("immutable verifier input file permissions changed")
                if info.st_size < 0 or info.st_size > MAX_FILE_BYTES:
                    raise UnknownState("immutable verifier input file exceeds the size bound")
                total += info.st_size
                if total > MAX_UNPACKED_BYTES:
                    raise UnknownState("immutable verifier input exceeds the size bound")
                fd = os.open(os.path.join(directory, name), os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    chunks = bytearray()
                    while len(chunks) <= info.st_size:
                        chunk = os.read(fd, min(1024 * 1024, info.st_size + 1 - len(chunks)))
                        if not chunk:
                            break
                        chunks.extend(chunk)
                    if len(chunks) != info.st_size:
                        raise UnknownState("immutable verifier input changed during inspection")
                finally:
                    os.close(fd)
                entries.append(ArchiveEntry(child_path, "file", 0o100755 if info.st_mode & 0o111 else 0o100644, bytes(chunks)))
            else:
                raise UnknownState("immutable verifier input contains a link or special file")

    visit(root, b"")
    repo = ""
    try:
        repo, actual = _tree_from_entries(entries, expected_tree, require_match=False)
    finally:
        if repo:
            shutil.rmtree(repo, ignore_errors=True)
    return "unchanged" if actual == expected_tree else "changed"


def _result_without_proof(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "profile": "linux-single-use",
        "parentExit": record.get("parentExit"),
        "timedOut": bool(record.get("timedOut")),
        "cancelled": bool(record.get("cancelled")),
        "isolationEstablished": False,
        "domainState": "unknown",
        "integrity": "unknown",
        "output": record.get("output", ""),
    }


class LinuxVerifierGate:
    def __init__(self) -> None:
        self._runtime_lock = threading.Lock()
        self._runtime: dict[str, tuple[socket.socket | None, CgroupHandle | None, threading.Event]] = {}
        self._server_socket: socket.socket | None = None
        self._runner_socket: socket.socket | None = None

    def preflight(self) -> dict[str, Any]:
        problems: list[str] = []
        admission = _empty_admission_health()
        try:
            if not sys.platform.startswith("linux") or os.geteuid() != 0:
                raise GateError("native root Linux service is unavailable")
            _assert_initial_user_namespace()
            _check_state_dirs()
            profile = _load_profile(check_hashes=True)
            with _exclusive_lock():
                try:
                    records = _read_admission_records()
                except (GateError, OSError):
                    records = None
                admission = _admission_health(profile, records)
            if admission["reasons"]:
                problems.append(f"Linux admission health reasons: {','.join(admission['reasons'])}")
            if _boot_id() == "":
                raise GateError("boot identity is unavailable")
            if not os.path.isfile("/sys/fs/cgroup/cgroup.controllers") or not os.path.isfile(f"{CGROUP_ROOT}/otter.slice/cgroup.kill"):
                raise GateError("unified cgroup v2 cgroup.kill support is unavailable")
            if any(not os.path.isfile(path) or not os.access(path, os.X_OK) for path in (SYSTEMCTL, JOURNALCTL, OPENSSL, GIT)):
                raise GateError("fixed host support tools are unavailable")
            with open("/proc/1/comm", "rt", encoding="ascii") as source:
                if source.read(128).strip() != "systemd":
                    raise GateError("systemd is not PID 1")
            version = _systemctl(["--version"], timeout=5).splitlines()[0].split()
            if len(version) < 2 or int(version[1]) < 250:
                raise GateError("systemd lacks required cgroup service semantics")
            _assert_fixed_unit(profile, check_hashes=True)
            _check_signing_key(profile)
        except (OSError, ValueError, GateError, UnknownState, IndexError) as exc:
            problems.append(str(exc) if isinstance(exc, GateError) else "native verifier environment failed a fixed compatibility check")
        return {"ok": True, "compatible": not problems, "problems": problems, "admission": admission}

    def _read_all_records(self) -> list[dict[str, Any]]:
        return list(_iter_records())

    def prepare(self, request: Any) -> dict[str, Any]:
        fields = validate_prepare_request(request)
        entries = parse_input_archive(fields["archive"])
        _assert_initial_user_namespace()
        _check_state_dirs()
        profile = _load_profile(check_hashes=True)
        _check_signing_key(profile)
        boot_id = _boot_id()
        ticket = uuid.uuid4().hex
        input_temp = tempfile.mkdtemp(prefix="input-", dir=INPUT_DIR)
        os.chmod(input_temp, 0o700)
        repo = ""
        published_path: str | None = None
        committed = False
        try:
            _write_archive(entries, input_temp)
            repo, actual = _tree_from_entries(entries, fields["inputSnapshotID"])
            if actual != fields["inputSnapshotID"]:
                raise GateError("input archive does not match the supplied Git tree")
            shutil.rmtree(repo, ignore_errors=True)
            repo = ""
            with _exclusive_lock():
                _assert_initial_user_namespace()
                profile = _load_profile(check_hashes=True)
                try:
                    admission_records = _read_admission_records()
                except (GateError, OSError):
                    admission_records = None
                admission = _admission_health(profile, admission_records)
                if admission["reasons"]:
                    raise GateError(f"Linux admission health refused: {','.join(admission['reasons'])}")
                records = self._read_all_records()
                now_ms = int(time.time() * 1000)
                for record in records:
                    if record["state"] == "prepared" and now_ms >= record["reference"]["deadlineAt"]:
                        _cancel_prepared_locked(record, "prepared ticket expired before activation", timed_out=True, cancelled=False)
                if any(record["reference"]["executionID"] == fields["executionID"] for record in records):
                    raise GateError("executionID has already been allocated")
                pending = [
                    record for record in records
                    if record["state"] in {"prepared", "launching", "bound", "running", "retiring", "proving"}
                    or (record["state"] == "unknown" and isinstance(record.get("binding"), dict))
                    or os.path.lexists(record["inputPath"])
                ]
                pending_bytes = sum(record["archiveBytes"] for record in pending)
                if len(pending) >= MAX_PENDING_TICKETS or pending_bytes + len(fields["archive"]) > MAX_PENDING_ARCHIVE_BYTES:
                    raise GateError("pending verifier ticket capacity is exhausted")
                while os.path.lexists(_record_path(ticket)) or os.path.lexists(f"{INPUT_DIR}/{ticket}"):
                    ticket = uuid.uuid4().hex
                input_path = f"{INPUT_DIR}/{ticket}"
                os.rename(input_temp, input_path)
                input_temp = ""
                published_path = input_path
                parent_fd = os.open(INPUT_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(parent_fd)
                finally:
                    os.close(parent_fd)
                reference = {
                    "kind": "verifier",
                    "executionID": fields["executionID"],
                    "profile": "linux-single-use",
                    "invocationID": ticket,
                    "inputSnapshotID": fields["inputSnapshotID"],
                    "inputDigest": fields["inputDigest"],
                    "deadlineAt": fields["deadlineAt"],
                    "maxOutputChars": fields["maxOutputChars"],
                    "unit": UNIT,
                    "bootID": boot_id,
                }
                record = {
                    "schema": RECORD_SCHEMA,
                    "ticket": ticket,
                    "state": "prepared",
                    "reference": reference,
                    "command": fields["command"],
                    "cwd": fields["cwd"],
                    "createdAt": int(time.time() * 1000),
                    "inputPath": input_path,
                    "archiveBytes": len(fields["archive"]),
                    "output": "",
                    "parentExit": None,
                    "timedOut": False,
                    "cancelled": False,
                    "released": False,
                    "commandStarted": False,
                }
                _write_record(record)
                committed = True
                return {"ok": True, "reference": reference}
        except BaseException:
            if repo:
                shutil.rmtree(repo, ignore_errors=True)
            if input_temp and os.path.exists(input_temp):
                shutil.rmtree(input_temp, ignore_errors=True)
            if published_path and not committed:
                with contextlib.suppress(OSError):
                    shutil.rmtree(published_path)
            raise

    def _check_request_reference(self, value: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        reference = validate_reference(value)
        record = _load_record(reference["invocationID"])
        if not _same_reference(record["reference"], reference):
            raise GateError("reference does not match its durable authority record")
        if reference["unit"] != UNIT:
            raise GateError("reference unit differs from the fixed verifier unit")
        return reference, record

    @staticmethod
    def _unknown(record: dict[str, Any], reason: str) -> dict[str, Any]:
        result = _result_without_proof(record)
        return {"ok": True, "state": "unknown", "reason": reason, "result": result}

    def _assert_unit_inactive(self, profile: dict[str, Any]) -> dict[str, str]:
        properties = _assert_fixed_unit(profile)
        if properties["ActiveState"] not in {"inactive", "failed"} or properties["MainPID"] not in {"0", ""}:
            raise UnknownState("fixed verifier unit is already active")
        if properties["ControlGroup"] not in {"", CGROUP_PATH}:
            raise UnknownState("fixed verifier unit cgroup path is unexpected")
        if properties["ControlGroup"] == CGROUP_PATH:
            try:
                handle = _open_bound_cgroup(CGROUP_PATH)
            except UnknownState as exc:
                if "absent" in str(exc):
                    return properties
                raise
            try:
                if _cgroup_populated(handle) != 0:
                    raise UnknownState("fixed verifier cgroup is not empty")
            finally:
                handle.close()
        return properties

    def _accept_runner(
        self,
        ticket: str,
        profile: dict[str, Any],
        boot_id: str,
        prior_systemd_invocation: str,
    ) -> tuple[socket.socket, dict[str, Any], CgroupHandle]:
        if self._runner_socket is None:
            raise UnknownState("runner handshake socket is unavailable")
        deadline = time.monotonic() + 10.0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise UnknownState("runner handshake timed out")
            self._runner_socket.settimeout(remaining)
            try:
                connection, _ = self._runner_socket.accept()
            except (OSError, socket.timeout) as exc:
                raise UnknownState("runner handshake timed out") from exc
            try:
                pid, uid, _gid = _peer_credentials(connection)
                status = _unit_status()
                if pid <= 1 or uid != profile["verifierUID"] or status.get("MainPID") != str(pid):
                    connection.close()
                    continue
                hello = _recv_frame(connection, 3.0)
                if hello != {"protocol": PROTOCOL, "op": "runner-hello"}:
                    connection.close()
                    continue
                binding, handle = _binding_from_runner(connection, profile, boot_id, prior_systemd_invocation)
                return connection, binding, handle
            except (OSError, ValueError, UnknownState, TimeoutError, EOFError):
                with contextlib.suppress(OSError):
                    connection.close()
                continue

    def start(self, value: Any) -> dict[str, Any]:
        reference = validate_reference(value)
        ticket = reference["invocationID"]
        connection: socket.socket | None = None
        handle: CgroupHandle | None = None
        record_for_recovery: dict[str, Any] | None = None
        with _activation_lock():
            with _exclusive_lock():
                _assert_initial_user_namespace()
                reference, record = self._check_request_reference(reference)
                if record["state"] != "prepared":
                    return self._unknown(record, "ticket is not an unused prepared ticket")
                try:
                    profile = _load_profile(check_hashes=True)
                    try:
                        admission_records = _read_admission_records()
                    except (GateError, OSError):
                        admission_records = None
                    admission = _admission_health(profile, admission_records)
                    if admission["reasons"]:
                        _cancel_prepared_locked(
                            record,
                            f"Linux admission health refused: {','.join(admission['reasons'])}",
                            cancelled=False,
                        )
                        return self._unknown(record, "Linux admission health refused")
                    if _boot_id() != reference["bootID"]:
                        _cancel_prepared_locked(record, "ticket belongs to a different boot", cancelled=False)
                        return self._unknown(record, "ticket belongs to a different boot")
                    if int(time.time() * 1000) >= reference["deadlineAt"]:
                        _cancel_prepared_locked(record, "ticket deadline expired before activation", timed_out=True, cancelled=False)
                        return self._unknown(record, "ticket deadline expired before activation")
                    _check_signing_key(profile)
                    before_status = self._assert_unit_inactive(profile)
                    if _safe_input_tree(record["inputPath"], reference["inputSnapshotID"]) != "unchanged":
                        raise UnknownState("immutable verifier input changed before activation")
                    if int(time.time() * 1000) >= reference["deadlineAt"]:
                        raise UnknownState("ticket deadline expired before activation")
                except (GateError, UnknownState, OSError):
                    _cancel_prepared_locked(record, "fixed native admission failed", cancelled=False)
                    return self._unknown(record, "fixed native admission failed")
                # Durable launch intent precedes manager activation. A restart in this gap is never adopted.
                record["state"] = "launching"
                record["launchIntentAt"] = int(time.time() * 1000)
                _write_record(record)

            try:
                with _exclusive_lock():
                    latest = _load_record(ticket)
                    if latest["state"] != "launching":
                        raise UnknownState("launch intent was superseded before activation")
                    if latest.get("cancelRequested") is True:
                        latest["state"] = "unknown"
                        latest["cancelled"] = True
                        latest["unknownReason"] = "prepared ticket cancelled before native activation"
                        _write_record(latest)
                        _cleanup_input_async(latest)
                        record_for_recovery = latest
                    else:
                        temporary_link = f"{STATE_DIR}/.current-{ticket}"
                        try:
                            existing = os.lstat(CURRENT_INPUT)
                        except FileNotFoundError:
                            existing = None
                        if existing is not None:
                            if not stat.S_ISLNK(existing.st_mode) or existing.st_uid != 0:
                                raise UnknownState("fixed current-input selector is not a root-owned symlink")
                            prior_target = os.readlink(CURRENT_INPUT)
                            if not re.fullmatch(r"inputs/[0-9a-f]{32}", prior_target):
                                raise UnknownState("fixed current-input selector target is not an owned input")
                        with contextlib.suppress(FileNotFoundError):
                            os.unlink(temporary_link)
                        os.symlink(f"inputs/{ticket}", temporary_link)
                        os.replace(temporary_link, CURRENT_INPUT)
                        state_fd = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                        try:
                            os.fsync(state_fd)
                        finally:
                            os.close(state_fd)
                        _systemctl(["start", UNIT], timeout=20)
                if record_for_recovery is not None:
                    return self._unknown(record_for_recovery, record_for_recovery.get("unknownReason", "launch was cancelled"))
                # Do not hold the authority lock while waiting for the runner to connect.
                connection, binding, handle = self._accept_runner(
                    ticket,
                    profile,
                    reference["bootID"],
                    before_status.get("InvocationID", ""),
                )
            except (GateError, UnknownState, OSError, ValueError, TimeoutError, EOFError, subprocess.SubprocessError):
                with _exclusive_lock():
                    latest = _load_record(ticket)
                    if not latest.get("binding"):
                        latest["state"] = "unknown"
                        latest["unknownReason"] = "unbound launch outcome; invocation was never adopted"
                        _write_record(latest)
                    record_for_recovery = latest
            else:
                with _exclusive_lock():
                    latest = _load_record(ticket)
                    if latest["state"] != "launching" or not _same_reference(latest["reference"], reference):
                        latest["state"] = "unknown"
                        latest["unknownReason"] = "launch authority changed before runner binding"
                        _write_record(latest)
                        record_for_recovery = latest
                    else:
                        latest["binding"] = binding
                        latest["state"] = "bound"
                        latest["boundAt"] = int(time.time() * 1000)
                        _write_record(latest)
                        expired = int(time.time() * 1000) >= reference["deadlineAt"]
                        cancelled = latest.get("cancelRequested") is True
                        if expired or cancelled:
                            latest["timedOut"] = bool(expired)
                            latest["cancelled"] = bool(cancelled)
                            latest["state"] = "retiring"
                            latest["retireReason"] = "deadline-before-release" if expired else "cancel-before-release"
                            _write_record(latest)
                            self._stop_exact_locked(latest, handle)
                            record_for_recovery = latest
                        else:
                            try:
                                _assert_runner_binding_active(profile, binding, handle)
                                _send_frame(connection, {
                                    "protocol": PROTOCOL,
                                    "op": "execute",
                                    "ticket": ticket,
                                    "command": latest["command"],
                                    "deadlineAt": reference["deadlineAt"],
                                    "maxOutputChars": reference["maxOutputChars"],
                                })
                                accepted = _recv_frame(connection, 2.0)
                                if accepted != {"protocol": PROTOCOL, "type": "accepted", "ticket": ticket}:
                                    raise UnknownState("runner did not accept the one-shot assignment")
                                _assert_runner_binding_active(profile, binding, handle)
                                latest["released"] = True
                                latest["state"] = "running"
                                _write_record(latest)
                                _send_frame(connection, {"protocol": PROTOCOL, "op": "release", "ticket": ticket})
                                record_for_recovery = latest
                            except (GateError, UnknownState, OSError, ValueError, TimeoutError, EOFError):
                                latest["state"] = "retiring"
                                latest["unknownReason"] = "runner release handshake failed"
                                latest["parentExit"] = None
                                _write_record(latest)
                                self._stop_exact_locked(latest, handle)
                                record_for_recovery = latest

        if record_for_recovery is None:
            with _exclusive_lock():
                record_for_recovery = _load_record(ticket)
        if record_for_recovery.get("state") in {"running", "retiring"} and connection is not None and handle is not None:
            finished = threading.Event()
            with self._runtime_lock:
                self._runtime[ticket] = (connection, handle, finished)
            watcher = threading.Thread(target=self._watch_runner, args=(ticket,), name=f"otter-verifier-{ticket}", daemon=True)
            watcher.start()
            with _exclusive_lock():
                current = _load_record(ticket)
                if current["state"] == "terminal":
                    return {"ok": True, "state": "terminal", "result": current["result"]}
                if current["state"] == "running":
                    return {"ok": True, "state": "running"}
                return self._unknown(current, current.get("unknownReason", "native retirement is still in progress"))
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.close()
        if handle is not None:
            handle.close()
        if record_for_recovery.get("state") == "terminal":
            return {"ok": True, "state": "terminal", "result": record_for_recovery["result"]}
        return self._unknown(record_for_recovery, record_for_recovery.get("unknownReason", "launch outcome is unknown"))

    def _watch_runner(self, ticket: str) -> None:
        with self._runtime_lock:
            runtime = self._runtime.get(ticket)
        if runtime is None:
            return
        connection, handle, finished = runtime
        if connection is None or handle is None:
            return
        try:
            while True:
                with _exclusive_lock():
                    record = _load_record(ticket)
                if record["state"] in {"terminal", "unknown"}:
                    return
                if record["state"] == "retiring":
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current["state"] != "retiring":
                            continue
                        self._stop_exact_locked(current, handle)
                        should_finish = current["state"] == "retiring"
                    if should_finish:
                        self._finish_ticket(ticket, handle)
                    time.sleep(0.2)
                    continue
                if record["state"] != "running":
                    return
                deadline = record["reference"]["deadlineAt"] / 1000.0
                remaining = deadline - time.time()
                if remaining <= 0:
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current.get("state") == "running":
                            current["timedOut"] = True
                            current["state"] = "retiring"
                            current["retireReason"] = "deadline"
                            _write_record(current)
                    continue
                try:
                    event = _recv_frame(connection, max(0.05, min(0.5, remaining if remaining > 0 else 0.05)))
                except TimeoutError:
                    continue
                except EOFError:
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current.get("state") == "running":
                            current["state"] = "retiring"
                            if current.get("doneReceived") is True:
                                current["retireReason"] = "completed"
                            else:
                                current["parentExit"] = None
                                current["retireReason"] = "runner-disconnected"
                            _write_record(current)
                    continue
                if event.get("protocol") != PROTOCOL or event.get("ticket") != ticket:
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current.get("state") == "running":
                            current["parentExit"] = None
                            current["state"] = "retiring"
                            current["retireReason"] = "runner-event-invalid"
                            _write_record(current)
                    continue
                if event.get("type") == "started":
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current.get("state") in {"running", "retiring"}:
                            current["commandStarted"] = True
                            _write_record(current)
                    continue
                if event.get("type") == "output":
                    chunk = event.get("text")
                    if not isinstance(chunk, str) or len(chunk) > 1024:
                        with _exclusive_lock():
                            current = _load_record(ticket)
                            if current.get("state") == "running":
                                current["parentExit"] = None
                                current["state"] = "retiring"
                                current["retireReason"] = "runner-output-invalid"
                                _write_record(current)
                        continue
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current.get("state") in {"running", "retiring"}:
                            current["commandStarted"] = True
                            allowance = max(0, current["reference"]["maxOutputChars"] - _output_units(current["output"]))
                            if _output_units(chunk) > allowance:
                                raise GateError("runner output exceeded its fixed bound")
                            if chunk:
                                current["output"] += chunk
                                _write_record(current)
                    continue
                elif event.get("type") == "child-exit":
                    parent_exit = event.get("parentExit")
                    if isinstance(parent_exit, bool) or not isinstance(parent_exit, int) or not -255 <= parent_exit <= 255:
                        parent_exit = None
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if (
                            parent_exit is not None
                            and event == {
                                "protocol": PROTOCOL,
                                "type": "child-exit",
                                "ticket": ticket,
                                "parentExit": parent_exit,
                            }
                            and current.get("doneReceived") is not True
                            and current.get("state") in {"running", "retiring"}
                        ):
                            if current.get("parentExit") is None:
                                current["parentExit"] = parent_exit
                            current["doneReceived"] = True
                            if int(time.time() * 1000) >= current["reference"]["deadlineAt"]:
                                current["timedOut"] = True
                                if current.get("state") == "running":
                                    current["state"] = "retiring"
                                    current["retireReason"] = "deadline"
                            _write_record(current)
                            acknowledged = True
                        else:
                            acknowledged = False
                            if current.get("state") == "running":
                                current["state"] = "retiring"
                                current["parentExit"] = None
                                current["retireReason"] = "runner-child-exit-invalid"
                                _write_record(current)
                    if acknowledged:
                        _send_frame(connection, {
                            "protocol": PROTOCOL,
                            "type": "child-exit-ack",
                            "ticket": ticket,
                        })
                    continue
                with _exclusive_lock():
                    current = _load_record(ticket)
                    if current.get("state") == "running":
                        current["parentExit"] = None
                        current["state"] = "retiring"
                        current["retireReason"] = "runner-event-invalid"
                        _write_record(current)
        except (OSError, ValueError, GateError, UnknownState, TimeoutError, EOFError, subprocess.SubprocessError):
            with contextlib.suppress(Exception):
                connection.close()
                with _exclusive_lock():
                    current = _load_record(ticket)
                    if current.get("state") not in {"terminal", "unknown"} and isinstance(current.get("binding"), dict):
                        current["state"] = "retiring"
                        current["unknownReason"] = "runner monitor could not authenticate completion"
                        _write_record(current)
                        self._stop_exact_locked(current, handle)
                while True:
                    with _exclusive_lock():
                        current = _load_record(ticket)
                    if current["state"] in {"terminal", "unknown"} or current["state"] != "retiring":
                        break
                    self._finish_ticket(ticket, handle)
                    with _exclusive_lock():
                        current = _load_record(ticket)
                        if current["state"] == "retiring":
                            self._stop_exact_locked(current, handle)
                    time.sleep(0.2)
        finally:
            with contextlib.suppress(OSError):
                connection.close()
            with self._runtime_lock:
                self._runtime.pop(ticket, None)
            finished.set()
            handle.close()

    def _start_retirement_monitor(self, ticket: str, handle: CgroupHandle | None) -> bool:
        with self._runtime_lock:
            if ticket in self._runtime:
                return False
            finished = threading.Event()
            self._runtime[ticket] = (None, handle, finished)
        watcher = threading.Thread(target=self._watch_retirement, args=(ticket,), name=f"otter-retire-{ticket}", daemon=True)
        watcher.start()
        return True

    def _watch_retirement(self, ticket: str) -> None:
        with self._runtime_lock:
            runtime = self._runtime.get(ticket)
        if runtime is None:
            return
        _connection, handle, finished = runtime
        try:
            while True:
                with _exclusive_lock():
                    record = _load_record(ticket)
                    if record["state"] in {"terminal", "unknown"}:
                        return
                    if record["state"] != "retiring":
                        return
                    self._stop_exact_locked(record, handle)
                    should_finish = record["state"] == "retiring"
                if should_finish:
                    self._finish_ticket(ticket, handle)
                time.sleep(0.2)
        except (OSError, ValueError, GateError, UnknownState, subprocess.SubprocessError):
            with contextlib.suppress(Exception):
                with _exclusive_lock():
                    record = _load_record(ticket)
                    if record["state"] not in {"terminal", "unknown"}:
                        record["state"] = "unknown"
                        record["unknownReason"] = "retirement monitor could not authenticate native cleanup"
                        _write_record(record)
        finally:
            with self._runtime_lock:
                self._runtime.pop(ticket, None)
            finished.set()
            if handle is not None:
                handle.close()

    def _stop_exact_locked(
        self,
        record: dict[str, Any],
        handle: CgroupHandle | None,
    ) -> None:
        binding = record.get("binding")
        if not isinstance(binding, dict) or handle is None:
            return
        try:
            if _boot_id() != binding.get("bootID") or binding.get("unit") != UNIT:
                raise UnknownState("bound invocation belongs to a different boot or unit")
            if (handle.device, handle.inode) != (binding.get("device"), binding.get("inode")):
                raise UnknownState("held cgroup differs from the durable native binding")
            properties = _unit_status(timeout=1.0)
            active = properties.get("ActiveState") in {"active", "activating", "reloading", "deactivating"}
            if active:
                if (
                    properties.get("InvocationID") != binding.get("systemdInvocationID")
                    or properties.get("ControlGroup") != binding.get("cgroupPath")
                ):
                    raise UnknownState("fixed unit now names a different invocation")
            elif (
                properties.get("ActiveState") not in {"inactive", "failed"}
                or properties.get("InvocationID") not in {"", binding["systemdInvocationID"]}
                or properties.get("ControlGroup") not in {"", binding["cgroupPath"]}
            ):
                raise UnknownState("fixed unit retirement identity changed")
            current = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
            try:
                populated = _cgroup_populated(current)
            finally:
                current.close()
            if populated == 0:
                return
            if not record.get("killRequested"):
                record["killRequested"] = True
                record["killRequestedAt"] = int(time.time() * 1000)
                _write_record(record)
            _request_cgroup_kill(handle)
        except ManagerTimeout:
            return
        except UnknownState as exc:
            if "absent" in str(exc) or "deleted" in str(exc):
                return
            record["state"] = "unknown"
            record["unknownReason"] = "exact bound cgroup could not be killed safely"
            _write_record(record)
        except OSError as exc:
            if exc.errno in {errno.ENOENT, errno.ENODEV}:
                if _held_cgroup_deleted(handle, binding):
                    return
            record["state"] = "unknown"
            record["unknownReason"] = "exact bound cgroup could not be killed safely"
            _write_record(record)

    def _bound_cgroup_path_is_absent(self, binding: dict[str, Any]) -> bool:
        try:
            current = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
        except UnknownState as exc:
            return "absent" in str(exc) or "deleted" in str(exc)
        current.close()
        return False

    def _retirement_kind(self, record: dict[str, Any], handle: CgroupHandle | None) -> tuple[str, str | None] | None:
        binding = record.get("binding")
        if not isinstance(binding, dict) or binding.get("unit") != UNIT:
            return None
        if _boot_id() != binding.get("bootID"):
            return None
        try:
            properties = _unit_status()
        except UnknownState:
            return None
        if properties.get("ActiveState") in {"active", "activating", "reloading", "deactivating"}:
            return None
        if properties.get("ActiveState") not in {"inactive", "failed"}:
            return None
        if properties.get("InvocationID") not in {"", binding["systemdInvocationID"]}:
            return None
        if properties.get("ControlGroup") not in {"", binding["cgroupPath"]}:
            return None
        if handle is not None:
            if (
                not _held_cgroup_deleted(handle, binding)
                or not self._bound_cgroup_path_is_absent(binding)
            ):
                return None
            kind = "held-deleted-journal"
        else:
            if not self._bound_cgroup_path_is_absent(binding):
                return None
            kind = "recovered-journal"
        message = _journal_retirement(binding)
        if message in RETIREMENT_MESSAGE_IDS:
            return kind, message
        return None

    def _finish_ticket(self, ticket: str, handle: CgroupHandle | None) -> None:
        try:
            with _exclusive_lock():
                record = _load_record(ticket)
                if record["state"] != "retiring":
                    return
                snapshot = json.loads(_canonical_json(record))
            _assert_initial_user_namespace()
            profile = _load_profile(check_hashes=True)
            _assert_fixed_unit(profile, check_hashes=True)
            self._check_profile_public_key(profile)
            retirement = self._retirement_kind(snapshot, handle)
            if retirement is None:
                return
            if (
                not snapshot["commandStarted"]
                and not snapshot["timedOut"]
                and not snapshot["cancelled"]
                and not (snapshot.get("doneReceived") is True and snapshot.get("parentExit") == 127)
            ):
                with _exclusive_lock():
                    record = _load_record(ticket)
                    if record["state"] == "retiring":
                        record["state"] = "unknown"
                        record["unknownReason"] = "command launch outcome is ambiguous and remains fenced"
                        _write_record(record)
                        _cleanup_input_async(record)
                return
            input_integrity = _safe_input_tree(snapshot["inputPath"], snapshot["reference"]["inputSnapshotID"])
            output = snapshot["output"]
            if _output_units(output) > snapshot["reference"]["maxOutputChars"]:
                raise UnknownState("bounded verifier output is invalid")
            output_digest = hashlib.sha256(output.encode("utf-8", errors="strict")).hexdigest()
            with _exclusive_lock():
                record = _load_record(ticket)
                if (
                    record["state"] != "retiring"
                    or not _same_reference(record["reference"], snapshot["reference"])
                    or record.get("binding") != snapshot.get("binding")
                    or record.get("output") != output
                ):
                    return
                proof_intent = {
                    "kind": retirement[0],
                    "messageID": retirement[1],
                    "inputIntegrity": input_integrity,
                    "outputSha256": output_digest,
                }
                record["state"] = "proving"
                record["proofIntent"] = proof_intent
                _write_record(record)
                frozen = json.loads(_canonical_json(record))

            parent_exit = frozen.get("parentExit")
            if parent_exit is not None and (
                isinstance(parent_exit, bool) or not isinstance(parent_exit, int) or not -255 <= parent_exit <= 255
            ):
                raise UnknownState("parent exit status is invalid")
            receipt_value: dict[str, Any] = {
                "schema": RECEIPT_SCHEMA,
                "reference": frozen["reference"],
                "binding": frozen["binding"],
                "retirement": {"kind": retirement[0]},
                "result": {
                    "parentExit": parent_exit,
                    "timedOut": frozen["timedOut"],
                    "cancelled": frozen["cancelled"],
                    "inputIntegrity": input_integrity,
                    "outputSha256": output_digest,
                },
            }
            if retirement[1] is not None:
                receipt_value["retirement"]["messageID"] = retirement[1]
            receipt, signature = _sign_receipt(receipt_value, profile)
            _assert_initial_user_namespace()
            profile = _load_profile(check_hashes=True)
            _assert_fixed_unit(profile, check_hashes=True)
            self._check_profile_public_key(profile)
            if self._retirement_kind(frozen, handle) is None:
                raise UnknownState("native invocation changed during receipt signing")
            result = {
                "profile": "linux-single-use",
                "parentExit": parent_exit,
                "timedOut": frozen["timedOut"],
                "cancelled": frozen["cancelled"],
                "isolationEstablished": True,
                "domainState": "empty",
                "integrity": input_integrity,
                "output": output,
                "proof": {
                    "reference": frozen["reference"],
                    "evidence": "authenticated Linux gate retirement",
                    "receipt": receipt,
                    "signature": signature,
                },
            }
            with _exclusive_lock():
                record = _load_record(ticket)
                if (
                    record["state"] != "proving"
                    or record.get("proofIntent") != proof_intent
                    or not _same_reference(record["reference"], frozen["reference"])
                    or record.get("binding") != frozen["binding"]
                    or record.get("output") != output
                    or record.get("parentExit") != parent_exit
                    or record.get("timedOut") is not frozen["timedOut"]
                    or record.get("cancelled") is not frozen["cancelled"]
                ):
                    raise UnknownState("durable ticket changed during receipt signing")
                record.pop("proofIntent", None)
                record.pop("unknownReason", None)
                record["state"] = "terminal"
                record["result"] = result
                record["retiredAt"] = int(time.time() * 1000)
                _write_record(record)
                _cleanup_input_async(record)
        except (GateError, UnknownState, OSError, ValueError, subprocess.SubprocessError):
            with contextlib.suppress(Exception):
                with _exclusive_lock():
                    record = _load_record(ticket)
                    if record["state"] in {"retiring", "proving"}:
                        record.pop("proofIntent", None)
                        record["state"] = "unknown"
                        record["unknownReason"] = "native retirement proof could not be authenticated"
                        record.pop("result", None)
                        _write_record(record)

    def _check_profile_public_key(self, profile: dict[str, Any]) -> None:
        if not isinstance(profile.get("publicKeyPem"), str) or "BEGIN PUBLIC KEY" not in profile["publicKeyPem"]:
            raise GateError("root profile public key is invalid")
        _check_signing_key(profile)

    def inspect(self, value: Any) -> dict[str, Any]:
        with _exclusive_lock():
            reference, record = self._check_request_reference(value)
            if _boot_id() != reference["bootID"]:
                return self._unknown(record, "reference belongs to a different boot")
            state = record["state"]
            if state == "terminal":
                try:
                    profile = _load_profile(check_hashes=True)
                    _verify_stored_receipt(record, profile)
                except (GateError, UnknownState, OSError, ValueError, subprocess.SubprocessError):
                    return self._unknown(record, "stored retirement receipt is no longer authenticated")
                return {"ok": True, "state": "terminal", "result": record["result"]}
            if state in {"bound", "running", "retiring", "unknown"} and isinstance(record.get("binding"), dict):
                binding = record["binding"]
                try:
                    properties = _unit_status()
                    if (
                        properties.get("ActiveState") in {"active", "activating", "reloading", "deactivating"}
                        and properties.get("InvocationID") == binding.get("systemdInvocationID")
                        and properties.get("ControlGroup") == binding.get("cgroupPath")
                    ):
                        handle = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
                        try:
                            if _cgroup_populated(handle) == 1:
                                return {"ok": True, "state": "running"}
                        finally:
                            handle.close()
                except (GateError, UnknownState, OSError):
                    pass
                return self._unknown(record, record.get("unknownReason", "native invocation is not proven terminal"))
            if state == "prepared":
                if int(time.time() * 1000) >= reference["deadlineAt"]:
                    return self._unknown(record, "prepared ticket expired before activation")
                return self._unknown(record, "ticket has not been started")
            return self._unknown(record, record.get("unknownReason", "native gate state is unknown"))

    def cancel(self, value: Any) -> dict[str, Any]:
        reference = validate_reference(value)
        ticket = reference["invocationID"]
        runtime: tuple[socket.socket | None, CgroupHandle | None, threading.Event] | None
        runtime = None
        handle: CgroupHandle | None = None
        with _exclusive_lock():
            _reference, record = self._check_request_reference(reference)
            if _boot_id() != reference["bootID"]:
                return self._unknown(record, "reference belongs to a different boot")
            if record["state"] == "terminal":
                try:
                    profile = _load_profile(check_hashes=True)
                    _verify_stored_receipt(record, profile)
                except (GateError, UnknownState, OSError, ValueError, subprocess.SubprocessError):
                    return self._unknown(record, "stored retirement receipt is no longer authenticated")
                return {"ok": True, "state": "terminal", "result": record["result"]}
            if record["state"] == "prepared":
                _cancel_prepared_locked(record, "prepared ticket cancelled before native activation")
                return self._unknown(record, record["unknownReason"])
            if record["state"] == "launching":
                record["cancelRequested"] = True
                record["cancelled"] = True
                if int(time.time() * 1000) >= reference["deadlineAt"]:
                    record["timedOut"] = True
                record["unknownReason"] = "cancellation awaits an authenticated runner binding"
                _write_record(record)
                return self._unknown(record, record["unknownReason"])
            if record["state"] == "proving":
                return self._unknown(record, "authenticated retirement receipt is being finalized")
            if record["state"] not in {"bound", "running", "retiring", "unknown"} or not isinstance(record.get("binding"), dict):
                return self._unknown(record, "ticket has no authenticated running invocation")
            try:
                binding = record["binding"]
                if binding.get("unit") != UNIT or binding.get("bootID") != _boot_id():
                    raise UnknownState("bound invocation identity is stale")
                properties = _unit_status(timeout=0.25)
                if properties.get("LoadState") != "loaded" or properties.get("FragmentPath") != f"/etc/systemd/system/{UNIT}":
                    raise UnknownState("fixed verifier unit is no longer loaded from its root manifest")
                if properties.get("ActiveState") in {"active", "activating", "reloading", "deactivating"} and (
                    properties.get("InvocationID") != binding.get("systemdInvocationID")
                    or properties.get("ControlGroup") != binding.get("cgroupPath")
                ):
                    raise UnknownState("fixed unit now names a different invocation")
                with self._runtime_lock:
                    runtime = self._runtime.get(ticket)
                handle = runtime[1] if runtime is not None else None
                if handle is None:
                    if properties.get("ActiveState") in {"active", "activating", "reloading", "deactivating"}:
                        handle = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
                    else:
                        try:
                            handle = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
                        except UnknownState as exc:
                            if "absent" not in str(exc) and "deleted" not in str(exc):
                                raise
                            handle = None
                record["state"] = "retiring"
                record["cancelled"] = True
                record["retireReason"] = "cancel"
                _write_record(record)
                self._stop_exact_locked(record, handle)
            except ManagerTimeout:
                if runtime is None and handle is not None:
                    handle.close()
                return self._unknown(record, "systemd cancellation exceeded its bounded request budget")
            except (GateError, UnknownState, OSError):
                record["state"] = "unknown"
                record["unknownReason"] = "exact bound invocation could not be cancelled safely"
                _write_record(record)
                if runtime is None and handle is not None:
                    handle.close()
                return self._unknown(record, record["unknownReason"])
        if runtime is None:
            with _exclusive_lock():
                current = _load_record(ticket)
            if current["state"] == "retiring" and self._start_retirement_monitor(ticket, handle):
                handle = None
            if handle is not None:
                handle.close()
        with _exclusive_lock():
            current = _load_record(ticket)
            return self._unknown(current, current.get("unknownReason", "cancellation retirement is unproven"))

    def _recover_all(self) -> None:
        with _exclusive_lock():
            _assert_initial_user_namespace()
            records = self._read_all_records()
            _cleanup_orphan_directories(records)
            for record in records:
                state = record["state"]
                if state == "prepared" and int(time.time() * 1000) >= record["reference"]["deadlineAt"]:
                    _cancel_prepared_locked(record, "prepared ticket expired before activation", timed_out=True, cancelled=False)
                    continue
                if state == "launching":
                    record["state"] = "unknown"
                    record["unknownReason"] = "broker restarted during unbound launch; invocation was not adopted"
                    _write_record(record)
                    _cleanup_input_async(record)
                    continue
                if state == "proving":
                    record["state"] = "retiring"
                    record.pop("proofIntent", None)
                    _write_record(record)
                    state = "retiring"
                if state not in {"bound", "running", "retiring", "unknown"} or not isinstance(record.get("binding"), dict):
                    continue
                binding = record.get("binding")
                if not isinstance(binding, dict) or binding.get("unit") != UNIT or binding.get("bootID") != _boot_id():
                    record["state"] = "unknown"
                    record["unknownReason"] = "bound invocation identity is unavailable after restart"
                    _write_record(record)
                    continue
                handle: CgroupHandle | None = None
                try:
                    properties = _unit_status()
                    active = properties.get("ActiveState") in {"active", "activating", "reloading", "deactivating"}
                    if active and (
                        properties.get("InvocationID") != binding.get("systemdInvocationID")
                        or properties.get("ControlGroup") != binding.get("cgroupPath")
                    ):
                        raise UnknownState("systemd now exposes a different invocation")
                    if active:
                        handle = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
                    else:
                        try:
                            handle = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
                        except UnknownState as exc:
                            if "absent" not in str(exc) and "deleted" not in str(exc):
                                raise
                    record["state"] = "retiring"
                    record.setdefault("parentExit", None)
                    record.setdefault("output", "")
                    if int(time.time() * 1000) >= record["reference"]["deadlineAt"] and record.get("released"):
                        record["timedOut"] = True
                        if not record.get("cancelled"):
                            record["retireReason"] = "deadline"
                    elif record.get("cancelled"):
                        record["retireReason"] = "cancel"
                    else:
                        record.setdefault("retireReason", "broker-recovery")
                    _write_record(record)
                    self._stop_exact_locked(record, handle)
                except (GateError, UnknownState, OSError):
                    record["state"] = "unknown"
                    record["unknownReason"] = "bound crash recovery could not authenticate the exact native domain"
                    _write_record(record)
                finally:
                    if handle is not None:
                        handle.close()

    def _start_recovery_monitors(self) -> None:
        with _exclusive_lock():
            records = self._read_all_records()
        for record in records:
            if record["state"] != "retiring" or not isinstance(record.get("binding"), dict):
                continue
            binding = record["binding"]
            handle: CgroupHandle | None = None
            try:
                handle = _open_bound_cgroup(binding["cgroupPath"], binding["device"], binding["inode"])
            except UnknownState as exc:
                if "absent" not in str(exc) and "deleted" not in str(exc):
                    with _exclusive_lock():
                        current = _load_record(record["ticket"])
                        if current["state"] == "retiring":
                            current["state"] = "unknown"
                            current["unknownReason"] = "recovery refused a replacement or unbound cgroup"
                            _write_record(current)
                    continue
            if not self._start_retirement_monitor(record["ticket"], handle) and handle is not None:
                handle.close()

    def _make_listener(self, path: str, mode: int, group_id: int = 0) -> socket.socket:
        parent = os.path.dirname(path)
        _safe_path(parent, expected_type=stat.S_IFDIR)
        try:
            old = os.lstat(path)
        except FileNotFoundError:
            old = None
        if old is not None:
            if not stat.S_ISSOCK(old.st_mode) or old.st_uid != 0:
                raise GateError("existing verifier socket path is unsafe")
            os.unlink(path)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        os.chmod(path, mode)
        os.chown(path, 0, group_id)
        listener.listen(32)
        return listener

    def serve_forever(self) -> None:
        _assert_initial_user_namespace()
        _check_state_dirs()
        self._recover_all()
        self._start_recovery_monitors()
        profile = _load_profile(check_hashes=True)
        verifier = pwd.getpwuid(profile["verifierUID"])
        self._server_socket = self._make_listener(CONTROL_SOCKET, 0o666)
        self._runner_socket = self._make_listener(RUNNER_SOCKET, 0o660, verifier.pw_gid)
        while True:
            assert self._server_socket is not None
            connection, _ = self._server_socket.accept()
            threading.Thread(target=self._handle_client, args=(connection,), daemon=True).start()

    def _handle_client(self, connection: socket.socket) -> None:
        try:
            _pid, uid, _gid = _peer_credentials(connection)
            _assert_initial_user_namespace()
            profile = _load_profile(check_hashes=False)
            if uid != profile["controllerUID"]:
                return
            connection.settimeout(90)
            request = _recv_frame(connection, 90, limit=MAX_CONTROL_BYTES)
            if request.get("protocol") != PROTOCOL or not isinstance(request.get("op"), str):
                raise GateError("unsupported control protocol")
            op = request["op"]
            if op == "preflight" and set(request) == {"protocol", "op"}:
                response = self.preflight()
            elif op == "prepare" and set(request) == {"protocol", "op", "request"}:
                response = self.prepare(request["request"])
            elif op in {"start", "inspect", "cancel"} and set(request) == {"protocol", "op", "reference"}:
                response = getattr(self, op)(request["reference"])
            else:
                raise GateError("unsupported control request")
            _send_frame(connection, response)
        except (GateError, ValueError, UnknownState, OSError, TimeoutError, EOFError, UnicodeError, subprocess.SubprocessError) as exc:
            message = str(exc) if isinstance(exc, GateError) else "request could not be authenticated"
            with contextlib.suppress(OSError):
                _send_frame(connection, {"ok": False, "error": message[:256]})
        finally:
            with contextlib.suppress(OSError):
                connection.close()


def main() -> int:
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        print("otter-verifier gate requires Linux root", file=sys.stderr)
        return 1
    try:
        gate = LinuxVerifierGate()
        gate.serve_forever()
    except (GateError, OSError, UnknownState) as exc:
        print(f"otter-verifier gate stopped: {str(exc)[:256]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
