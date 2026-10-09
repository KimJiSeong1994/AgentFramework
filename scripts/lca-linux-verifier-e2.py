#!/usr/bin/env python3
"""Bounded guest-root qualification of the installed Linux verifier gate.

This probes only the verifier unit and gate protocol; it is not whole-agent or
worker/reviewer containment qualification. Run from the installed Ubuntu guest
as root so the harness can observe the verifier cgroup. Gate requests themselves
are issued as the profile's controller UID. It never edits gate records or kills
persisted PIDs. Run --scenario launch-gap separately and last: success deliberately
leaves the ticket unknown and quarantines this guest without replay or cleanup.
"""
from __future__ import annotations

import argparse
import base64
import errno
import concurrent.futures
import fcntl
from contextlib import closing
import hashlib
import json
import os
import pwd
import re
import shutil
import shlex
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROTOCOL = "lca.linux-verifier.v1"
PROFILE_SCHEMA = "lca.linux-verifier.profile.v2"
RECEIPT_SCHEMA = "lca.linux-verifier.retirement.v1"
PROFILE_PATH = Path("/etc/lca-verifier/profile.json")
CLIENT_PATH = Path("/usr/local/libexec/lca-verifier/client.py")
GATE_PATH = Path("/usr/local/libexec/lca-verifier/gate.py")
RECORD_DIR = Path("/var/lib/lca-verifier/records")
UNIT = "lca-verifier.service"
GATE_UNIT = "lca-verifier-gate.service"
CGROUP_PATH = Path("/sys/fs/cgroup/lca.slice/lca-verifier.service")
GATE_CGROUP_PATH = "/system.slice/lca-verifier-gate.service"
CGROUP_ROOT = Path("/sys/fs/cgroup")
OUTPUT_DIR = Path("/run/lca-verifier-output")
MAX_OUTPUT = 4096
CASE_TIMEOUT_MS = 60_000
CLIENT_TIMEOUT_SECONDS = 25
GATE_RESTART_WAIT_SECONDS = 30
UNIT_RETIRE_WAIT_SECONDS = 15
REPLACEMENT_START_TIMEOUT_SECONDS = 10
RETIREMENT_MESSAGE_IDS = {
    "9d1aaa27d60140bd96365438aad20286",
    "7ad2d189f7e94e70a38c781354912448",
    "d9b373ed55a64feb8242e02dbe79a49c",
}
BOOT_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")



class QualificationFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fail(code: str) -> None:
    raise QualificationFailure(code)


def checked_root_file(path: Path, *, max_bytes: int) -> bytes:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            fail("unsafe-installed-path")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        fail("unsafe-installed-file")
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or
                info.st_nlink != 1):
            fail("unsafe-installed-file")
        if info.st_size <= 0 or info.st_size > max_bytes:
            fail("installed-file-size")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            return stream.read(max_bytes + 1)
    finally:
        os.close(descriptor)


def load_profile() -> tuple[dict[str, Any], str]:
    raw = checked_root_file(PROFILE_PATH, max_bytes=65_536)
    try:
        profile = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("invalid-root-profile")
    if not isinstance(profile, dict) or profile.get("schema") != PROFILE_SCHEMA:
        fail("invalid-root-profile")
    boot_epoch = profile.get("bootEpoch")
    if not isinstance(boot_epoch, str) or not BOOT_RE.fullmatch(boot_epoch):
        fail("invalid-root-profile")
    if profile.get("unit") != UNIT or not isinstance(profile.get("qualified"), bool):
        fail("invalid-root-profile")
    controller_uid = profile.get("controllerUID")
    verifier_uid = profile.get("verifierUID")
    if (not isinstance(controller_uid, int) or isinstance(controller_uid, bool) or controller_uid < 1 or
            not isinstance(verifier_uid, int) or isinstance(verifier_uid, bool) or verifier_uid < 1 or
            controller_uid == verifier_uid):
        fail("invalid-root-profile")
    key = profile.get("publicKeyPem")
    if not isinstance(key, str) or not key.startswith("-----BEGIN PUBLIC KEY-----"):
        fail("invalid-root-profile")
    checked_root_file(CLIENT_PATH, max_bytes=65_536)
    return profile, key


def canonical_receipt_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or not path.parent.is_dir():
        fail("receipt-path-must-be-absolute-with-existing-parent")
    parent = path.parent.resolve(strict=True)
    if parent != path.parent or path.exists() or path.is_symlink():
        fail("receipt-path-must-be-new-and-canonical")
    return path


def write_receipt(path: Path, report: dict[str, Any]) -> None:
    encoded = (json.dumps(report, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)


def client_environment() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C", "LC_ALL": "C"}


def native_call(profile: dict[str, Any], request: dict[str, Any], *, timeout: int = CLIENT_TIMEOUT_SECONDS) -> dict[str, Any]:
    if len(json.dumps(request, separators=(",", ":")).encode("utf-8")) > 4 * 1024 * 1024:
        fail("gate-request-too-large")
    options: dict[str, Any] = {
        "input": json.dumps(request, separators=(",", ":")) + "\n",
        "text": True,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "env": client_environment(),
        "timeout": timeout,
        "check": False,
    }
    if os.geteuid() == 0:
        try:
            account = pwd.getpwuid(profile["controllerUID"])
            groups = os.getgrouplist(account.pw_name, account.pw_gid)
        except (KeyError, OSError):
            fail("controller-account-unavailable")
        options.update(user=profile["controllerUID"], group=account.pw_gid, extra_groups=groups)
    try:
        completed = subprocess.run([sys.executable, str(CLIENT_PATH)], **options)
    except subprocess.TimeoutExpired:
        fail("gate-client-deadline")
    except OSError:
        fail("gate-client-exec-failed")
    if len(completed.stdout.encode("utf-8", errors="replace")) > 1024 * 1024:
        fail("gate-response-too-large")
    try:
        response = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        fail("gate-response-invalid")
    if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
        fail("gate-response-invalid")
    return response


def run_git(cwd: Path, *args: str, output_limit: int = 2 * 1024 * 1024) -> bytes:
    env = {**client_environment(), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TEMPLATE_DIR": ""}
    try:
        completed = subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", *args], cwd=cwd,
                                   env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail("fixture-git-failed")
    if completed.returncode != 0 or len(completed.stdout) > output_limit:
        fail("fixture-git-failed")
    return completed.stdout


def make_git_fixture(root: Path) -> tuple[str, bytes]:
    repo = root / "git-input"
    repo.mkdir(mode=0o700)
    (repo / "fixture.txt").write_text("lca-linux-verifier-e2\n", encoding="utf-8")
    run_git(repo, "init", "--quiet")
    run_git(repo, "config", "user.name", "LCA verifier qualification")
    run_git(repo, "config", "user.email", "verifier-qualification@localhost")
    run_git(repo, "add", "--all")
    tree = run_git(repo, "write-tree").decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", tree):
        fail("fixture-tree-invalid")
    archive = run_git(repo, "archive", "--format=tar", tree)
    if not archive or len(archive) > 1024 * 1024:
        fail("fixture-archive-invalid")
    return tree, archive


def prepare_request(tree: str, archive: bytes, command: str, cwd: Path) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "op": "prepare",
        "request": {
            "executionID": str(uuid.uuid4()),
            "profile": "linux-single-use",
            "command": command,
            "cwd": str(cwd),
            "inputSnapshotID": tree,
            "inputDigest": hashlib.sha256(tree.encode("ascii")).hexdigest(),
            "deadlineAt": int(time.time() * 1000) + CASE_TIMEOUT_MS,
            "maxOutputChars": MAX_OUTPUT,
            "inputArchive": base64.b64encode(archive).decode("ascii"),
        },
    }


def gate_record(reference: dict[str, Any]) -> dict[str, Any]:
    ticket = reference.get("invocationID")
    if not isinstance(ticket, str) or not re.fullmatch(r"[0-9a-f]{32}", ticket):
        fail("invalid-record-reference")
    for directory in (RECORD_DIR.parent, RECORD_DIR):
        try:
            directory_info = directory.lstat()
        except OSError:
            fail("native-record-directory-unavailable")
        if (not stat.S_ISDIR(directory_info.st_mode) or stat.S_ISLNK(directory_info.st_mode) or
                directory_info.st_uid != 0 or directory_info.st_mode & 0o077):
            fail("native-record-directory-untrusted")
    path = RECORD_DIR / f"{ticket}.json"
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        fail("native-record-unavailable")
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or
                info.st_nlink != 1 or info.st_size <= 0 or info.st_size > 2 * 1024 * 1024):
            fail("native-record-permissions-invalid")
        raw = os.read(descriptor, 2 * 1024 * 1024 + 1)
    finally:
        os.close(descriptor)
    if len(raw) > 2 * 1024 * 1024:
        fail("native-record-size-invalid")
    try:
        record = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("native-record-json-invalid")
    if (not isinstance(record, dict) or record.get("schema") != "lca.linux-verifier.record.v1" or
            record.get("ticket") != ticket or record.get("reference") != reference or
            record.get("inputPath") != f"/var/lib/lca-verifier/inputs/{ticket}"):
        fail("native-record-binding-invalid")
    return record


def lock_gate_authority_state(timeout: float = 10.0) -> int:
    path = Path("/var/lib/lca-verifier/authority.lock")
    descriptor = -1
    try:
        parent = path.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or parent.st_uid != 0 or
                parent.st_mode & 0o077):
            fail("native-authority-lock-parent-untrusted")
        descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        info = os.fstat(descriptor)
        path_info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1 or
                (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)):
            os.close(descriptor)
            fail("native-authority-lock-untrusted")
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(descriptor)
                    fail("native-authority-lock-deadline")
                time.sleep(0.025)
        return descriptor
    except OSError:
        if descriptor >= 0:
            os.close(descriptor)
        fail("native-authority-lock-unavailable")


def unlock_gate_authority_state(descriptor: int) -> None:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


@dataclass
class HeldCgroup:
    directory_fd: int
    events_fd: int
    path: str
    device: int
    inode: int

    def close(self) -> None:
        for descriptor in (self.events_fd, self.directory_fd):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _cgroup_components(path: str) -> tuple[str, ...]:
    allowed = {
        "/lca.slice/lca-verifier.service": ("lca.slice", "lca-verifier.service"),
        GATE_CGROUP_PATH: ("system.slice", GATE_UNIT),
    }
    components = allowed.get(path)
    if components is None:
        fail("cgroup-path-outside-fixed-verifier-domains")
    return components


def _open_cgroup_directory(path: str) -> int:
    current = -1
    try:
        current = os.open(CGROUP_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        for component in _cgroup_components(path):
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 dir_fd=current)
            os.close(current)
            current = following
        info = os.fstat(current)
        if not stat.S_ISDIR(info.st_mode):
            fail("native-cgroup-fd-is-not-directory")
        descriptor = current
        current = -1
        return descriptor
    finally:
        if current >= 0:
            os.close(current)


def _current_cgroup_identity(path: str) -> tuple[int, int] | None:
    try:
        descriptor = _open_cgroup_directory(path)
    except OSError as error:
        if error.errno in {errno.ENOENT, errno.ENODEV}:
            return None
        fail("native-cgroup-path-observation-failed")
    try:
        info = os.fstat(descriptor)
        return info.st_dev, info.st_ino
    finally:
        os.close(descriptor)


def _open_held_cgroup(path: str, expected: tuple[int, int] | None = None) -> HeldCgroup:
    directory_fd = -1
    events_fd = -1
    try:
        directory_fd = _open_cgroup_directory(path)
        info = os.fstat(directory_fd)
        identity = (info.st_dev, info.st_ino)
        if expected is not None and identity != expected:
            fail("native-cgroup-device-inode-mismatch")
        events_fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=directory_fd)
        events_info = os.fstat(events_fd)
        if not stat.S_ISREG(events_info.st_mode):
            fail("native-cgroup-events-is-not-regular")
        held = HeldCgroup(directory_fd, events_fd, path, *identity)
        directory_fd = events_fd = -1
        return held
    finally:
        if events_fd >= 0:
            os.close(events_fd)
        if directory_fd >= 0:
            os.close(directory_fd)


def _held_cgroup_population(held: HeldCgroup) -> int | None:
    directory = os.fstat(held.directory_fd)
    if (directory.st_dev, directory.st_ino) != (held.device, held.inode):
        fail("held-native-cgroup-identity-changed")
    try:
        os.lseek(held.events_fd, 0, os.SEEK_SET)
        raw = os.read(held.events_fd, 4096).decode("ascii", errors="strict")
    except OSError as error:
        if error.errno == errno.ENODEV:
            return None
        fail("held-native-cgroup-events-unavailable")
    try:
        fields = dict(line.split(" ", 1) for line in raw.splitlines())
    except ValueError:
        fail("held-native-cgroup-events-invalid")
    if fields.get("populated") not in {"0", "1"}:
        fail("held-native-cgroup-population-unknown")
    return int(fields["populated"])


def _kill_held_cgroup(held: HeldCgroup) -> None:
    directory = os.fstat(held.directory_fd)
    if (directory.st_dev, directory.st_ino) != (held.device, held.inode):
        fail("held-native-cgroup-identity-changed-before-kill")
    if _held_cgroup_population(held) != 1:
        fail("held-native-cgroup-not-populated-before-kill")
    try:
        descriptor = os.open("cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                             dir_fd=held.directory_fd)
    except OSError:
        fail("held-native-cgroup-kill-unavailable")
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode) or os.write(descriptor, b"1\n") != 2:
            fail("held-native-cgroup-kill-failed")
    finally:
        os.close(descriptor)


def _proc_identity(pid: int) -> tuple[str, int]:
    try:
        stat_fd = os.open(f"/proc/{pid}/stat", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            raw_stat = os.read(stat_fd, 16_384).decode("ascii", errors="strict")
        finally:
            os.close(stat_fd)
        cgroup_fd = os.open(f"/proc/{pid}/cgroup", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            raw_cgroup = os.read(cgroup_fd, 16_384).decode("ascii", errors="strict")
        finally:
            os.close(cgroup_fd)
        remainder = raw_stat[raw_stat.rfind(")") + 1:].split()
        if len(remainder) <= 19:
            raise ValueError("short proc stat")
        start_time = int(remainder[19])
        cgroup_path = next(line[3:] for line in raw_cgroup.splitlines() if line.startswith("0::/"))
        if start_time <= 0 or not cgroup_path.startswith("/"):
            raise ValueError("invalid process identity")
        return cgroup_path, start_time
    except (OSError, ValueError, UnicodeError, StopIteration):
        fail("native-process-identity-unavailable")


def _unit_capture(unit: str, path: str, expected_invocation: str | None = None,
                  expected_identity: tuple[int, int] | None = None) -> tuple[HeldCgroup, dict[str, Any]]:
    before = systemd_unit_properties(unit)
    if before["ActiveState"] not in {"active", "activating"} or before["ControlGroup"] != path:
        fail("native-unit-not-active-in-fixed-cgroup")
    invocation = before["InvocationID"]
    main_pid_text = before["MainPID"]
    if (not re.fullmatch(r"[0-9a-f]{32}", invocation) or not main_pid_text.isdecimal() or
            int(main_pid_text) <= 1 or expected_invocation is not None and invocation != expected_invocation):
        fail("native-unit-invocation-invalid")
    main_pid = int(main_pid_text)
    proc_path, start_time = _proc_identity(main_pid)
    if proc_path != path:
        fail("native-unit-main-process-cgroup-mismatch")
    held = _open_held_cgroup(path, expected_identity)
    try:
        after = systemd_unit_properties(unit)
        proc_path_after, start_after = _proc_identity(main_pid)
        if (after["ActiveState"] != before["ActiveState"] or after["MainPID"] != main_pid_text or
                after["InvocationID"] != invocation or after["ControlGroup"] != path or
                proc_path_after != path or start_after != start_time):
            fail("native-unit-identity-changed-during-cgroup-capture")
        identity = {"unit": unit, "systemdInvocationID": invocation, "mainPID": main_pid,
                    "startTimeTicks": start_time, "cgroupPath": path,
                    "device": held.device, "inode": held.inode}
        return held, identity
    except BaseException:
        held.close()
        raise


def _assert_unit_still_matches(unit: str, held: HeldCgroup, identity: dict[str, Any]) -> None:
    properties = systemd_unit_properties(unit)
    current = _current_cgroup_identity(held.path)
    proc_path, start_time = _proc_identity(identity["mainPID"])
    after = systemd_unit_properties(unit)
    if (properties["ActiveState"] not in {"active", "activating"} or
            properties["InvocationID"] != identity["systemdInvocationID"] or
            properties["MainPID"] != str(identity["mainPID"]) or properties["ControlGroup"] != held.path or
            current != (held.device, held.inode) or proc_path != held.path or
            start_time != identity["startTimeTicks"] or after != properties):
        fail("native-unit-identity-changed-before-cgroup-kill")


def _wait_held_empty_or_deleted(held: HeldCgroup, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        population = _held_cgroup_population(held)
        if population is None or population == 0:
            return
        time.sleep(0.025)
    fail("held-native-cgroup-remained-populated-after-kill")


def _wait_unit_removed(unit: str, held: HeldCgroup, identity: dict[str, Any], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        properties = systemd_unit_properties(unit)
        state = properties["ActiveState"]
        if state in {"active", "activating", "reloading", "deactivating"}:
            allowed_invocations = {identity["systemdInvocationID"]}
            allowed_pids = {str(identity["mainPID"])}
            if state == "deactivating":
                allowed_invocations.add("")
                allowed_pids.add("0")
            if (properties["InvocationID"] not in allowed_invocations or
                    properties["MainPID"] not in allowed_pids):
                fail("unexpected-unit-replacement-before-explicit-start")
            time.sleep(0.025)
            continue
        if (properties["ActiveState"] not in {"inactive", "failed"} or properties["MainPID"] != "0" or
                properties["ControlGroup"] not in {"", held.path}):
            time.sleep(0.025)
            continue
        if properties["InvocationID"] not in {"", identity["systemdInvocationID"]}:
            fail("unexpected-unit-invocation-before-explicit-start")
        path_identity = _current_cgroup_identity(held.path)
        held_population = _held_cgroup_population(held)
        if path_identity is None and held_population is None:
            return
        if path_identity not in {None, (held.device, held.inode)}:
            fail("unexpected-cgroup-replacement-before-explicit-start")
        time.sleep(0.025)
    fail("native-unit-and-old-cgroup-removal-deadline")


def _cleanup_owned_unit_by_held_fd(unit: str, held: HeldCgroup, identity: dict[str, Any]) -> None:
    population = _held_cgroup_population(held)
    if population in {None, 0}:
        _wait_unit_removed(unit, held, identity, UNIT_RETIRE_WAIT_SECONDS)
        return
    _assert_unit_still_matches(unit, held, identity)
    _kill_held_cgroup(held)
    _wait_unit_removed(unit, held, identity, UNIT_RETIRE_WAIT_SECONDS)


def _wait_for_record_state(reference: dict[str, Any], state: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            record = gate_record(reference)
        except QualificationFailure:
            time.sleep(0.025)
            continue
        if record.get("state") == state:
            return record
        if record.get("state") == "terminal" and state != "terminal":
            fail("native-record-became-terminal-before-expected-state")
        time.sleep(0.025)
    fail("native-record-state-transition-deadline")


def _systemctl_start_replacement(unit: str) -> None:
    if unit != UNIT:
        fail("systemctl-start-outside-workload-replacement")
    try:
        completed = subprocess.run(["/usr/bin/systemctl", "start", UNIT], env=client_environment(),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=REPLACEMENT_START_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired:
        fail("systemctl-replacement-start-outcome-unknown-lab-quarantined")
    except OSError:
        fail("systemctl-replacement-start-failed")
    if completed.returncode != 0:
        fail("systemctl-replacement-start-failed-lab-quarantined")


def _wait_for_new_unit(unit: str, path: str, previous: dict[str, Any], timeout: float) -> tuple[HeldCgroup, dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        properties = systemd_unit_properties(unit)
        if (properties["ActiveState"] in {"active", "activating"} and
                properties["MainPID"] != str(previous["mainPID"]) and
                properties["InvocationID"] != previous["systemdInvocationID"]):
            try:
                held, identity = _unit_capture(unit, path)
            except QualificationFailure:
                time.sleep(0.025)
                continue
            if identity["mainPID"] != previous["mainPID"] and identity["systemdInvocationID"] != previous["systemdInvocationID"]:
                return held, identity
            held.close()
        time.sleep(0.025)
    fail("normal-systemd-unit-restart-deadline-lab-quarantined")


def _kill_gate_cgroup_and_wait_for_restart(
    expected_launch_reference: dict[str, Any] | None = None,
    captured_gate: tuple[HeldCgroup, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    authority_lock = lock_gate_authority_state()
    old_held: HeldCgroup | None = None
    new_held: HeldCgroup | None = None
    try:
        if expected_launch_reference is not None:
            launch_record = gate_record(expected_launch_reference)
            if (launch_record.get("state") != "launching" or launch_record.get("binding") is not None or
                    launch_record.get("released") is not False or launch_record.get("commandStarted") is not False):
                fail("launch-gap-window-closed-before-broker-crash")
        if captured_gate is None:
            old_held, old_identity = _unit_capture(GATE_UNIT, GATE_CGROUP_PATH)
            _assert_unit_still_matches(GATE_UNIT, old_held, old_identity)
        else:
            old_held, old_identity = captured_gate
        if _held_cgroup_population(old_held) != 1:
            fail("root-gate-cgroup-not-populated-before-crash")
        _kill_held_cgroup(old_held)
        new_held, new_identity = _wait_for_new_unit(
            GATE_UNIT, GATE_CGROUP_PATH, old_identity, GATE_RESTART_WAIT_SECONDS,
        )
        if _held_cgroup_population(new_held) != 1:
            fail("restarted-root-gate-cgroup-not-populated-lab-quarantined")
        return {"oldGate": old_identity, "newGate": new_identity,
                "faultInjection": "SIGKILL through authenticated old broker cgroup.kill FD",
                "restart": "normal systemd on-failure restart"}
    finally:
        if new_held is not None:
            new_held.close()
        if old_held is not None and captured_gate is None:
            old_held.close()
        unlock_gate_authority_state(authority_lock)


def systemd_unit_properties(unit: str) -> dict[str, str]:
    if unit not in {UNIT, GATE_UNIT}:
        fail("systemd-inspection-outside-fixed-units")
    try:
        completed = subprocess.run(
            ["/usr/bin/systemctl", "show", "--property=ActiveState", "--property=SubState",
             "--property=InvocationID", "--property=MainPID", "--property=ControlGroup", unit],
            env=client_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("systemd-identity-observation-failed")
    properties: dict[str, str] = {}
    for line in completed.stdout.decode("ascii", errors="replace").splitlines():
        key, separator, value = line.partition("=")
        if separator:
            properties[key] = value
    expected = {"ActiveState", "SubState", "InvocationID", "MainPID", "ControlGroup"}
    if completed.returncode != 0 or not expected.issubset(properties):
        fail("systemd-identity-observation-failed")
    return properties


def wait_for_terminal(profile: dict[str, Any], reference: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            response = reference_call(profile, "inspect", reference)
        except QualificationFailure:
            time.sleep(0.1)
            continue
        if response.get("ok") is True and response.get("state") == "terminal" and isinstance(response.get("result"), dict):
            return response["result"]
        time.sleep(0.1)
    fail("authenticated-terminal-receipt-timeout")


def require_reference(response: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    if response.get("ok") is not True or not isinstance(response.get("reference"), dict):
        fail("gate-prepare-refused")
    reference = response["reference"]
    body = request["request"]
    if (set(reference) != {"kind", "executionID", "profile", "invocationID", "inputSnapshotID", "inputDigest",
                           "deadlineAt", "maxOutputChars", "unit", "bootID"} or
            reference.get("kind") != "verifier" or reference.get("executionID") != body["executionID"] or
            reference.get("profile") != "linux-single-use" or reference.get("inputSnapshotID") != body["inputSnapshotID"] or
            reference.get("inputDigest") != body["inputDigest"] or reference.get("deadlineAt") != body["deadlineAt"] or
            reference.get("maxOutputChars") != MAX_OUTPUT or reference.get("unit") != UNIT or
            reference.get("bootID") != Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip() or
            not isinstance(reference.get("invocationID"), str) or
            not re.fullmatch(r"[0-9a-f]{32}", reference["invocationID"])):
        fail("gate-reference-mismatch")
    return reference


def reference_call(profile: dict[str, Any], operation: str, reference: dict[str, Any]) -> dict[str, Any]:
    return native_call(profile, {"protocol": PROTOCOL, "op": operation, "reference": reference})


def await_terminal(profile: dict[str, Any], reference: dict[str, Any], first: dict[str, Any] | None = None,
                   deadline: float | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    response = first
    until = deadline if deadline is not None else time.monotonic() + CLIENT_TIMEOUT_SECONDS
    while True:
        if response is None or response.get("state") in {"running", "unknown"}:
            if response is None:
                response = reference_call(profile, "inspect", reference)
            elif response.get("state") in {"running", "unknown"}:
                if time.monotonic() >= until:
                    fail("gate-run-deadline")
                time.sleep(0.05)
                response = reference_call(profile, "inspect", reference)
            continue
        if response.get("ok") is not True or response.get("state") != "terminal" or not isinstance(response.get("result"), dict):
            fail("gate-terminal-result-missing")
        return response, response["result"]


def verify_signed_result(profile_key: str, reference: dict[str, Any], result: dict[str, Any], scratch: Path) -> dict[str, Any]:
    proof = result.get("proof")
    if (not isinstance(proof, dict) or set(proof) != {"reference", "evidence", "receipt", "signature"} or
            proof.get("evidence") != "authenticated Linux gate retirement" or proof.get("reference") != reference):
        fail("native-proof-reference-invalid")
    receipt = proof.get("receipt")
    signature = proof.get("signature")
    if not isinstance(receipt, str) or not isinstance(signature, str):
        fail("native-proof-missing-signature")
    receipt_bytes = receipt.encode("utf-8")
    if len(receipt_bytes) > 16_384:
        fail("native-receipt-too-large")
    try:
        signature_bytes = base64.b64decode(signature, validate=True)
        payload = json.loads(receipt)
    except (ValueError, json.JSONDecodeError):
        fail("native-receipt-invalid")
    if len(signature_bytes) != 64 or base64.b64encode(signature_bytes).decode("ascii") != signature or not isinstance(payload, dict):
        fail("native-signature-invalid")
    if set(payload) != {"schema", "reference", "binding", "retirement", "result"} or payload.get("schema") != RECEIPT_SCHEMA or payload.get("reference") != reference:
        fail("native-receipt-reference-invalid")
    binding = payload.get("binding")
    retirement = payload.get("retirement")
    native_result = payload.get("result")
    if not isinstance(binding, dict) or not isinstance(retirement, dict) or not isinstance(native_result, dict):
        fail("native-receipt-shape-invalid")
    if set(binding) != {"unit", "bootID", "systemdInvocationID", "mainPID", "startTimeTicks", "cgroupPath", "device", "inode"}:
        fail("native-binding-invalid")
    if (binding.get("unit") != UNIT or binding.get("bootID") != reference.get("bootID") or
            not isinstance(binding.get("systemdInvocationID"), str) or
            not re.fullmatch(r"[0-9a-f]{32}", binding["systemdInvocationID"]) or
            type(binding.get("mainPID")) is not int or not 1 < binding["mainPID"] <= 9_007_199_254_740_991 or
            type(binding.get("startTimeTicks")) is not int or not 0 < binding["startTimeTicks"] <= 9_007_199_254_740_991 or
            binding.get("cgroupPath") != f"/lca.slice/{UNIT}" or
            type(binding.get("device")) is not int or not 0 <= binding["device"] <= 9_007_199_254_740_991 or
            type(binding.get("inode")) is not int or not 0 < binding["inode"] <= 9_007_199_254_740_991):
        fail("native-binding-invalid")
    retirement_kind = retirement.get("kind")
    if (retirement_kind not in {"held-deleted-journal", "recovered-journal"} or
            set(retirement) != {"kind", "messageID"} or
            retirement.get("messageID") not in RETIREMENT_MESSAGE_IDS):
        fail("native-retirement-invalid")
    output = result.get("output")
    if (set(native_result) != {"parentExit", "timedOut", "cancelled", "inputIntegrity", "outputSha256"} or
            (native_result.get("parentExit") is not None and
             (type(native_result["parentExit"]) is not int or not -255 <= native_result["parentExit"] <= 255)) or
            type(native_result.get("timedOut")) is not bool or type(native_result.get("cancelled")) is not bool or
            native_result.get("inputIntegrity") not in {"unchanged", "changed", "unknown"} or
            not isinstance(native_result.get("outputSha256"), str) or
            not re.fullmatch(r"[0-9a-f]{64}", native_result["outputSha256"]) or
            not isinstance(output, str) or len(output) > MAX_OUTPUT or
            hashlib.sha256(output.encode("utf-8")).hexdigest() != native_result.get("outputSha256")):
        fail("native-output-digest-invalid")
    if (type(result.get("timedOut")) is not bool or type(result.get("cancelled")) is not bool or
            (result.get("parentExit") is not None and
             (type(result["parentExit"]) is not int or not -255 <= result["parentExit"] <= 255))):
        fail("native-result-binding-invalid")
    for public_field, receipt_field in (("parentExit", "parentExit"), ("timedOut", "timedOut"), ("cancelled", "cancelled")):
        if result.get(public_field) != native_result.get(receipt_field):
            fail("native-result-binding-invalid")
    if (result.get("profile") != "linux-single-use" or result.get("isolationEstablished") is not True or
            result.get("domainState") != "empty" or result.get("integrity") != native_result.get("inputIntegrity")):
        fail("native-integrity-binding-invalid")
    key_file = scratch / "root-profile-public-key.pem"
    receipt_file = scratch / "receipt-to-verify.bin"
    signature_file = scratch / "receipt-signature.bin"
    for path, content in ((key_file, profile_key.encode("ascii")), (receipt_file, receipt_bytes), (signature_file, signature_bytes)):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    try:
        completed = subprocess.run(["/usr/bin/openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(key_file),
                                     "-rawin", "-in", str(receipt_file), "-sigfile", str(signature_file)],
                                   env=client_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail("signature-verifier-unavailable")
    if completed.returncode != 0:
        fail("native-signature-refused")
    return {"receipt": receipt, "signature": signature, "binding": binding, "retirement": retirement,
            "result": native_result}


def wait_for_populated() -> tuple[Path, str]:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            raw = (CGROUP_PATH / "cgroup.events").read_text(encoding="ascii")
            fields = dict(line.split(" ", 1) for line in raw.splitlines())
            if fields.get("populated") == "1":
                return CGROUP_PATH, raw
        except (OSError, ValueError):
            pass
        time.sleep(0.02)
    fail("verifier-cgroup-did-not-populate")


def assert_verifier_idle() -> None:
    try:
        completed = subprocess.run(
            ["/usr/bin/systemctl", "show", "--property=ActiveState", "--property=SubState",
             "--property=InvocationID", "--property=MainPID", "--property=ControlGroup", UNIT],
            env=client_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("verifier-idle-observation-failed")
    properties: dict[str, str] = {}
    for line in completed.stdout.decode("ascii", errors="replace").splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"ActiveState", "SubState", "InvocationID", "MainPID", "ControlGroup"}:
            properties[key] = value
    if (completed.returncode != 0 or set(properties) != {"ActiveState", "SubState", "InvocationID", "MainPID", "ControlGroup"} or
            (properties["ActiveState"], properties["SubState"]) not in {("inactive", "dead"), ("failed", "failed")} or
            properties["MainPID"] != "0" or
            properties["ControlGroup"] not in {"", f"/lca.slice/{UNIT}"}):
        fail("verifier-unit-not-inert")
    try:
        raw = (CGROUP_PATH / "cgroup.events").read_text(encoding="ascii")
    except OSError as error:
        if error.errno in {errno.ENOENT, errno.ENODEV}:
            return
        fail("verifier-cgroup-observation-failed")
    fields = dict(line.split(" ", 1) for line in raw.splitlines())
    if fields.get("populated") != "0":
        fail("verifier-cgroup-not-empty")


def wait_for_marker(path: Path, verifier_uid: int, timeout: float = 8) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                info = os.fstat(descriptor)
                if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == verifier_uid and info.st_size <= 256:
                    value = os.read(descriptor, 257).decode("ascii").strip()
                    if value.isdecimal():
                        return value
            finally:
                os.close(descriptor)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        time.sleep(0.02)
    fail("detached-writer-handshake-missing")


def require_not_accepted_while_populated(profile: dict[str, Any], reference: dict[str, Any], events: str) -> dict[str, Any]:
    if "populated 1" not in events.splitlines():
        fail("writer-domain-not-populated")
    response = reference_call(profile, "inspect", reference)
    if response.get("ok") is not True or response.get("state") != "running" or response.get("result") is not None:
        fail("gate-accepted-populated-domain")
    return response


def run_direct_case(profile: dict[str, Any], key: str, tree: str, archive: bytes, scratch: Path,
                    label: str, command: str, expected_exit: int, expected_output: str) -> tuple[dict[str, Any], dict[str, Any]]:
    assert_verifier_idle()
    case_scratch = scratch / f"case-{label}-{uuid.uuid4().hex}"
    case_scratch.mkdir(mode=0o700)
    prepare = prepare_request(tree, archive, command, case_scratch)
    response = native_call(profile, prepare)
    reference = require_reference(response, prepare)
    started = native_call(profile, {"protocol": PROTOCOL, "op": "start", "reference": reference})
    _, result = await_terminal(profile, reference, started)
    authority_record = gate_record(reference)
    signed = verify_signed_result(key, reference, result, case_scratch)
    if (result.get("profile") != "linux-single-use" or result.get("parentExit") != expected_exit or result.get("timedOut") is not False or
            result.get("cancelled") is not False or result.get("isolationEstablished") is not True or
            result.get("domainState") != "empty" or result.get("integrity") != "unchanged" or result.get("output") != expected_output or
            authority_record.get("commandStarted") is not True or authority_record.get("released") is not True or
            authority_record.get("doneReceived") is not True or authority_record.get("parentExit") != expected_exit):
        fail(f"{label}-result-mismatch")
    return reference, {"parentExit": expected_exit, "timedOut": False, "cancelled": False,
                       "isolationEstablished": True, "domainState": "empty", "integrity": "unchanged",
                       "proof": signed}


def detached_command(marker: str) -> str:
    source = "\n".join((
        "import os, signal, time",
        "pid = os.fork()",
        "if pid:",
        "    os._exit(0)",
        "os.setsid()",
        "pid = os.fork()",
        "if pid:",
        "    os._exit(0)",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        f"path = '/run/lca-verifier-output/{marker}'",
        "with open(path + '.ready', 'x', encoding='ascii') as ready:",
        "    ready.write(str(os.getpid()))",
        "counter = 0",
        "while True:",
        "    with open(path + '.beat', 'w', encoding='ascii') as heartbeat:",
        "        heartbeat.write(str(counter))",
        "    counter += 1",
        "    time.sleep(0.05)",
    ))
    return f"/usr/bin/python3 -c {shlex.quote(source)}"


def run_detached_case(profile: dict[str, Any], key: str, tree: str, archive: bytes, scratch: Path) -> dict[str, Any]:
    assert_verifier_idle()
    token = "lca-e2-" + uuid.uuid4().hex
    command = detached_command(token)
    case_scratch = scratch / f"case-detached-{uuid.uuid4().hex}"
    case_scratch.mkdir(mode=0o700)
    reference: dict[str, Any] | None = None
    retired = False
    try:
        prepare = prepare_request(tree, archive, command, case_scratch)
        prepared = native_call(profile, prepare)
        reference = require_reference(prepared, prepare)
        started = native_call(profile, {"protocol": PROTOCOL, "op": "start", "reference": reference})
        if started.get("ok") is not True or started.get("state") not in {"running", "terminal"}:
            fail("detached-run-not-started")
        try:
            output_info = OUTPUT_DIR.lstat()
        except OSError:
            fail("verifier-output-scratch-unavailable")
        if (not stat.S_ISDIR(output_info.st_mode) or stat.S_ISLNK(output_info.st_mode) or
                output_info.st_uid != profile["verifierUID"] or output_info.st_mode & 0o077):
            fail("verifier-output-scratch-unavailable")
        ready_path = OUTPUT_DIR / f"{token}.ready"
        beat_path = OUTPUT_DIR / f"{token}.beat"
        if started.get("state") == "terminal":
            fail("detached-writer-finished-before-cancel")
        wait_for_marker(ready_path, profile["verifierUID"])
        _, events = wait_for_populated()
        require_not_accepted_while_populated(profile, reference, events)
        cancel = reference_call(profile, "cancel", reference)
        if cancel.get("ok") is not True or cancel.get("state") not in {"running", "terminal", "unknown"}:
            fail("authenticated-gate-cancel-refused")
        _, result = await_terminal(profile, reference, cancel, time.monotonic() + CLIENT_TIMEOUT_SECONDS)
        signed = verify_signed_result(key, reference, result, case_scratch)
        retired = True
        if (result.get("profile") != "linux-single-use" or result.get("cancelled") is not True or
                result.get("isolationEstablished") is not True or result.get("domainState") != "empty"):
            fail("cancel-retirement-not-authenticated")
        assert_verifier_idle()
        try:
            output_after_retirement = OUTPUT_DIR.lstat()
        except FileNotFoundError:
            output_after_retirement = None
        except OSError:
            fail("verifier-output-retirement-observation-failed")
        if output_after_retirement is None:
            output_evidence = "systemd-removed-private-runtime-directory-after-authenticated-retirement"
        else:
            if not stat.S_ISDIR(output_after_retirement.st_mode) or stat.S_ISLNK(output_after_retirement.st_mode):
                fail("verifier-output-retirement-observation-untrusted")
            try:
                after_cancel = wait_for_marker(beat_path, profile["verifierUID"], timeout=2)
            except QualificationFailure:
                fail("detached-writer-output-evidence-missing")
            time.sleep(0.35)
            after_quiet = wait_for_marker(beat_path, profile["verifierUID"], timeout=1)
            if after_cancel != after_quiet:
                fail("detached-writer-wrote-after-retirement")
            output_evidence = "writer-heartbeat-stable-after-authenticated-retirement"
        before_replay_record = gate_record(reference)
        before_replay_unit = systemd_unit_properties(UNIT)
        replay = reference_call(profile, "start", reference)
        if replay.get("ok") is True:
            if replay.get("state") not in {"terminal", "unknown"}:
                fail("replayed-ticket-reactivated")
            if replay.get("state") == "terminal" and replay.get("result") != result:
                fail("replayed-ticket-receipt-changed")
        inspected = reference_call(profile, "inspect", reference)
        if (inspected.get("state") != "terminal" or inspected.get("result") != result or
                gate_record(reference) != before_replay_record or systemd_unit_properties(UNIT) != before_replay_unit):
            fail("replayed-ticket-mutated-native-state")
        assert_verifier_idle()
        return {"reference": reference, "parentExit": result.get("parentExit"), "cancelled": True,
                "isolationEstablished": True, "domainState": "empty", "integrity": result.get("integrity"),
                "descendantRetirementEvidence": output_evidence, "populatedInspection": "running-without-result",
                "replay": "unchanged-record-receipt-and-inactive-native-domain", "proof": signed}
    except Exception:
        if reference is not None and not retired:
            try:
                cancel = reference_call(profile, "cancel", reference)
                await_terminal(profile, reference, cancel, time.monotonic() + CLIENT_TIMEOUT_SECONDS)
            except Exception:
                pass
        raise


def prepare_direct(profile: dict[str, Any], tree: str, archive: bytes, scratch: Path, command: str) -> dict[str, Any]:
    request = prepare_request(tree, archive, command, scratch)
    response = native_call(profile, request)
    if response.get("ok") is not True:
        fail("native-test-case-prepare-refused")
    return require_reference(response, request)


def workload_file_exists(path: Path, verifier_uid: int) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != verifier_uid or
            info.st_nlink != 1 or info.st_size > 256):
        fail("verifier-workload-marker-untrusted")
    return True


def run_namespace_root_guard() -> dict[str, Any]:
    unshare = Path("/usr/bin/unshare")
    if not unshare.is_file():
        return {"status": "blocked", "reason": "unshare-tool-unavailable"}
    probe = (
        "import runpy,sys; gate=runpy.run_path(" + repr(str(GATE_PATH)) + "); "
        "guard=gate['_assert_initial_user_namespace']; "
        "\ntry:\n guard(); print('namespace-accepted'); sys.exit(44)"
        "\nexcept gate['UnknownState']:\n print('namespace-rejected')"
    )
    try:
        completed = subprocess.run([str(unshare), "--user", "--map-root-user", "/usr/bin/python3", "-c", probe],
                                   env=client_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=10, check=False)
    except subprocess.TimeoutExpired:
        fail("namespace-guard-probe-timeout")
    output = completed.stdout.decode("ascii", errors="replace").strip()
    if completed.returncode == 0 and output == "namespace-rejected":
        return {"status": "rejected-remapped-root"}
    if completed.returncode == 44 and output == "namespace-accepted":
        fail("user-namespace-root-accepted-by-native-guard")
    diagnostic = completed.stderr.decode("utf-8", errors="replace").lower()
    if completed.returncode != 0 and any(reason in diagnostic for reason in (
            "operation not permitted", "unshare failed", "not supported", "invalid argument", "no space left")):
        return {"status": "blocked", "reason": "user-namespace-unavailable-in-guest"}
    fail("namespace-guard-probe-failed")


def run_forged_controller_peer(profile: dict[str, Any]) -> dict[str, Any]:
    try:
        account = pwd.getpwuid(profile["verifierUID"])
        groups = os.getgrouplist(account.pw_name, account.pw_gid)
    except (KeyError, OSError):
        fail("verifier-account-unavailable-for-peer-test")
    source = "\n".join((
        "import errno,json,socket,struct,sys",
        "sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); sock.settimeout(3)",
        "body=json.dumps({'protocol':'lca.linux-verifier.v1','op':'preflight'},separators=(',',':')).encode('ascii')",
        "try:",
        " sock.connect('/run/lca-verifier/control.sock')",
        " sock.sendall(struct.pack('!I',len(body))+body)",
        " header=sock.recv(4)",
        " if header: print('FORGED_CONTROLLER_ACCEPTED'); sys.exit(42)",
        "except OSError as error:",
        " if error.errno not in (errno.EACCES,errno.EPERM,errno.EPIPE,errno.ECONNRESET): raise",
        "print('VERIFIER_UID_CONTROL_PEER_REJECTED')",
    ))
    try:
        completed = subprocess.run([sys.executable, "-c", source], cwd="/", user=profile["verifierUID"],
                                   group=account.pw_gid, extra_groups=groups, env=client_environment(),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail("forged-controller-peer-probe-failed")
    if completed.returncode != 0 or completed.stdout.decode("ascii", errors="replace").strip() != "VERIFIER_UID_CONTROL_PEER_REJECTED":
        fail("verifier-uid-forged-controller-peer-accepted")
    return {"verifierUIDControlSocketPeerRejected": True}


def _parallel_request(barrier: threading.Barrier, profile: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    try:
        barrier.wait(timeout=5)
        return native_call(profile, request, timeout=20)
    except Exception:
        return {"ok": False, "error": "parallel request failed"}


def run_concurrent_prepare_start(profile: dict[str, Any], key: str, tree: str, archive: bytes, scratch: Path) -> dict[str, Any]:
    assert_verifier_idle()
    case_scratch = scratch / f"case-concurrent-{uuid.uuid4().hex}"
    case_scratch.mkdir(mode=0o700)
    python = "\n".join((
        "import json,socket,struct",
        "sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); sock.settimeout(2)",
        "sock.connect('/run/lca-verifier/runner.sock')",
        "body=json.dumps({'protocol':'lca.linux-verifier.v1','op':'runner-hello'},separators=(',',':'),sort_keys=True).encode('ascii')",
        "sock.sendall(struct.pack('!I',len(body))+body); sock.close()",
        "print('FORGED_VERIFIER_PEER_CONNECTED')",
        "print('CONCURRENT_BODY_EXECUTED')",
    ))
    command = f"/usr/bin/python3 -c {shlex.quote(python)} && /usr/bin/sleep 3 && /usr/bin/printf 'CONCURRENT_BODY_DONE\\n'"
    request = prepare_request(tree, archive, command, case_scratch)
    barrier = threading.Barrier(2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_parallel_request, barrier, profile, request) for _ in range(2)]
        responses = [future.result(timeout=25) for future in futures]
    successes = [response for response in responses if response.get("ok") is True]
    refusals = [response for response in responses if response.get("ok") is False]
    if len(successes) != 1 or len(refusals) != 1:
        fail("concurrent-prepare-did-not-allocate-exactly-once")
    reference = require_reference(successes[0], request)
    prepared = gate_record(reference)
    if prepared.get("state") != "prepared" or prepared.get("binding") is not None or prepared.get("released") is not False:
        fail("concurrent-prepare-started-before-dispatch")

    barrier = threading.Barrier(2)
    start_request = {"protocol": PROTOCOL, "op": "start", "reference": reference}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_parallel_request, barrier, profile, start_request) for _ in range(2)]
        starts = [future.result(timeout=25) for future in futures]
    states = sorted(str(response.get("state")) for response in starts if response.get("ok") is True)
    if states != ["running", "unknown"]:
        try:
            native_call(profile, {"protocol": PROTOCOL, "op": "cancel", "reference": reference}, timeout=20)
            wait_for_terminal(profile, reference, timeout=20)
        except Exception:
            pass
        fail("concurrent-start-was-not-single-use")
    result = wait_for_terminal(profile, reference, timeout=15)
    signed = verify_signed_result(key, reference, result, case_scratch)
    output = result.get("output")
    if (result.get("parentExit") != 0 or not isinstance(output, str) or
            output.count("FORGED_VERIFIER_PEER_CONNECTED\n") != 1 or output.count("CONCURRENT_BODY_EXECUTED\n") != 1 or
            "CONCURRENT_BODY_DONE\n" not in output):
        fail("concurrent-start-or-forged-peer-result-invalid")
    assert_verifier_idle()
    return {"sameExecutionConcurrentPrepareAllocations": len(successes),
            "concurrentStartStates": states, "commandBodyRuns": output.count("CONCURRENT_BODY_EXECUTED\n"),
            "forgedVerifierUIDRunnerPeerConnected": True,
            "forgedPeerMustBeRejectedBeforeTheNextRunnerHandshake": True,
            "authenticatedResult": {"parentExit": result.get("parentExit"), "retirement": signed["retirement"],
                                    "receipt": signed["receipt"], "signature": signed["signature"]}}


def run_escape_denial(profile: dict[str, Any], key: str, tree: str, archive: bytes, scratch: Path) -> dict[str, Any]:
    assert_verifier_idle()
    case_scratch = scratch / f"case-escape-{uuid.uuid4().hex}"
    case_scratch.mkdir(mode=0o700)
    source = "\n".join((
        "import errno,os,socket,subprocess,sys",
        "for path in ('/sys/fs/cgroup/lca.slice/lca-verifier.service/cgroup.procs','/sys/fs/cgroup/lca.slice/cgroup.procs'):",
        " try: fd=os.open(path,os.O_WRONLY|os.O_CLOEXEC); os.close(fd); print('CGROUP_WRITE_OPEN_ALLOWED'); sys.exit(41)",
        " except OSError: pass",
        "for path in ('/run/systemd/private','/run/dbus/system_bus_socket'):",
        " try:",
        "  sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); sock.settimeout(1); sock.connect(path); sock.close(); print('MANAGER_SOCKET_CONNECTED'); sys.exit(42)",
        " except OSError: pass",
        "try: manager=subprocess.run(['/usr/bin/systemctl','show','--no-pager','lca-verifier-gate.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3,check=False)",
        "except (OSError,subprocess.TimeoutExpired): print('MANAGER_PROBE_UNAVAILABLE'); sys.exit(43)",
        "if manager.returncode == 0: print('MANAGER_API_REACHABLE'); sys.exit(44)",
        "runner_pid=int(os.environ['LCA_E2_RUNNER_PID'])",
        "if runner_pid <= 1: print('RUNNER_IDENTITY_INVALID'); sys.exit(45)",
        "try: os.kill(runner_pid,0)",
        "except OSError: print('RUNNER_IDENTITY_NOT_LIVE'); sys.exit(46)",
        "def denied(path,flags):",
        " try: fd=os.open(path,flags); os.close(fd); return False",
        " except OSError as error: return error.errno in (errno.EACCES,errno.EPERM,errno.ENOENT)",
        "memory_denied=denied(f'/proc/{runner_pid}/mem',os.O_RDONLY|os.O_CLOEXEC)",
        "fd_denied=denied(f'/proc/{runner_pid}/fd',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)",
        "if not memory_denied or not fd_denied: print('SAME_UID_RUNNER_CONTROL_ACCESS_ALLOWED'); sys.exit(47)",
        "print('CGROUP_MANAGER_AND_SAME_UID_RUNNER_ACCESS_DENIED')",
    ))
    command = f"LCA_E2_RUNNER_PID=$PPID /usr/bin/python3 -c {shlex.quote(source)}"
    reference = prepare_direct(profile, tree, archive, case_scratch, command)
    try:
        started = reference_call(profile, "start", reference)
        if started.get("ok") is not True or started.get("state") not in {"running", "terminal"}:
            fail("escape-probe-was-not-dispatched")
        result = wait_for_terminal(profile, reference, timeout=20)
        signed = verify_signed_result(key, reference, result, case_scratch)
        if result.get("parentExit") != 0 or result.get("output") != "CGROUP_MANAGER_AND_SAME_UID_RUNNER_ACCESS_DENIED\n":
            fail("verifier-cgroup-or-manager-escape-not-denied")
        assert_verifier_idle()
        return {"cgroupControllerWriteOpenDenied": True, "systemdAndDbusSocketsUnavailable": True,
                "systemctlManagerRequestDenied": True, "sameUIDRunnerMemoryReadDenied": True,
                "sameUIDRunnerFDEnumerationDenied": True, "authenticatedReceipt": signed["receipt"],
                "signature": signed["signature"]}
    except Exception:
        try:
            cancelled = reference_call(profile, "cancel", reference)
            if cancelled.get("ok") is True and cancelled.get("state") in {"running", "terminal"}:
                wait_for_terminal(profile, reference, timeout=20)
        except Exception:
            pass
        raise


def run_gate_restart_while_bound(profile: dict[str, Any], key: str, tree: str, archive: bytes, scratch: Path) -> dict[str, Any]:
    assert_verifier_idle()
    case_scratch = scratch / f"case-gate-restart-{uuid.uuid4().hex}"
    case_scratch.mkdir(mode=0o700)
    command = "/usr/bin/printf 'BOUND_BEFORE_GATE_RESTART\\n'; /usr/bin/sleep 25"
    reference = prepare_direct(profile, tree, archive, case_scratch, command)
    workload_held: HeldCgroup | None = None
    retired = False
    try:
        started = reference_call(profile, "start", reference)
        if started.get("ok") is not True or started.get("state") != "running":
            fail("bound-restart-invocation-not-running")
        old_record = gate_record(reference)
        binding = old_record.get("binding")
        if old_record.get("state") != "running" or not isinstance(binding, dict) or binding.get("unit") != UNIT or binding.get("bootID") != reference["bootID"]:
            fail("bound-restart-native-binding-missing")
        if not read_cgroup_populated_for_e2():
            fail("bound-restart-cgroup-not-populated")
        authority_lock = lock_gate_authority_state()
        try:
            current_record = gate_record(reference)
            if current_record.get("state") != "running" or current_record.get("binding") != binding:
                fail("bound-restart-authority-changed-before-fault")
            workload_held, workload_identity = _unit_capture(
                UNIT, "/lca.slice/lca-verifier.service", binding.get("systemdInvocationID"),
                (binding.get("device"), binding.get("inode")),
            )
            if (workload_identity["mainPID"] != binding.get("mainPID") or
                    workload_identity["startTimeTicks"] != binding.get("startTimeTicks") or
                    _held_cgroup_population(workload_held) != 1):
                fail("bound-restart-held-workload-identity-mismatch")
        finally:
            unlock_gate_authority_state(authority_lock)
        broker_restart = _kill_gate_cgroup_and_wait_for_restart()
        result = wait_for_terminal(profile, reference, timeout=25)
        signed = verify_signed_result(key, reference, result, case_scratch)
        if result.get("isolationEstablished") is not True or result.get("domainState") != "empty":
            fail("root-gate-restart-retirement-not-authenticated")
        record = gate_record(reference)
        if record.get("state") != "terminal" or not isinstance(record.get("result"), dict):
            fail("root-gate-restart-did-not-persist-terminal-result")
        if record.get("binding") != binding:
            fail("root-gate-restart-adopted-different-workload-binding")
        assert_verifier_idle()
        retired = True
        return {**broker_restart, "gateMainPIDChanged": True, "boundUnitInvocation": binding.get("systemdInvocationID"),
                "nativeCgroupPath": binding.get("cgroupPath"), "nativeCgroupDevice": binding.get("device"),
                "nativeCgroupInode": binding.get("inode"), "retirement": signed["retirement"],
                "authenticatedRecoveryReceipt": signed["receipt"], "signature": signed["signature"]}
    finally:
        if workload_held is not None:
            try:
                if not retired and _held_cgroup_population(workload_held) == 1:
                    _kill_held_cgroup(workload_held)
                    _wait_held_empty_or_deleted(workload_held, UNIT_RETIRE_WAIT_SECONDS)
            finally:
                workload_held.close()


def read_cgroup_populated_for_e2() -> bool:
    try:
        raw = (CGROUP_PATH / "cgroup.events").read_text(encoding="ascii")
        return dict(line.split(" ", 1) for line in raw.splitlines()).get("populated") == "1"
    except (OSError, ValueError):
        return False


def run_stale_identity_does_not_stop_replacement(profile: dict[str, Any], key: str, tree: str,
                                                 archive: bytes, scratch: Path) -> dict[str, Any]:
    assert_verifier_idle()
    case_scratch = scratch / f"case-stale-identity-{uuid.uuid4().hex}"
    case_scratch.mkdir(mode=0o700)
    old_reference = prepare_direct(profile, tree, archive, case_scratch,
                                   "/usr/bin/printf 'OLD_BOUND_INVOCATION\\n'; /usr/bin/sleep 30")
    old_held: HeldCgroup | None = None
    replacement_held: HeldCgroup | None = None
    replacement_identity: dict[str, Any] | None = None
    authority_lock: int | None = None
    lab_quarantined = False
    replacement_cleaned = False
    try:
        old_started = reference_call(profile, "start", old_reference)
        if old_started.get("ok") is not True or old_started.get("state") != "running":
            fail("stale-identity-old-invocation-not-running")
        old_record = gate_record(old_reference)
        old_binding = old_record.get("binding")
        if old_record.get("state") != "running" or not isinstance(old_binding, dict):
            fail("stale-identity-old-binding-missing")
        if not read_cgroup_populated_for_e2():
            fail("stale-identity-old-cgroup-not-populated")

        authority_lock = lock_gate_authority_state()
        try:
            current_record = gate_record(old_reference)
            if current_record.get("state") != "running" or current_record.get("binding") != old_binding:
                fail("stale-identity-old-record-changed-before-replacement")
            old_held, old_identity = _unit_capture(
                UNIT, "/lca.slice/lca-verifier.service", old_binding.get("systemdInvocationID"),
                (old_binding.get("device"), old_binding.get("inode")),
            )
            if (old_identity["mainPID"] != old_binding.get("mainPID") or
                    old_identity["startTimeTicks"] != old_binding.get("startTimeTicks") or
                    _held_cgroup_population(old_held) != 1):
                fail("stale-identity-held-original-binding-mismatch")
            _assert_unit_still_matches(UNIT, old_held, old_identity)
            _kill_held_cgroup(old_held)
            _wait_unit_removed(UNIT, old_held, old_identity, UNIT_RETIRE_WAIT_SECONDS)
            _systemctl_start_replacement(UNIT)
            try:
                replacement_held, replacement_identity = _wait_for_new_unit(
                    UNIT, "/lca.slice/lca-verifier.service", old_identity, 8.0,
                )
            except QualificationFailure:
                lab_quarantined = True
                fail("replacement-started-without-authenticated-held-fd-lab-quarantined")
            if ((replacement_held.device, replacement_held.inode) == (old_held.device, old_held.inode) or
                    _held_cgroup_population(replacement_held) != 1):
                lab_quarantined = True
                fail("replacement-held-cgroup-not-fresh-and-populated-lab-quarantined")
            if gate_record(old_reference).get("state") != "running":
                fail("stale-reference-was-retired-before-replacement-observation")
        finally:
            unlock_gate_authority_state(authority_lock)
            authority_lock = None

        refused = reference_call(profile, "cancel", old_reference)
        after_cancel = systemd_unit_properties(UNIT)
        assert replacement_identity is not None
        if (refused.get("ok") is not True or refused.get("state") != "unknown" or
                isinstance(refused.get("result"), dict) and refused["result"].get("proof") or
                after_cancel.get("ActiveState") not in {"active", "activating"} or
                after_cancel.get("InvocationID") != replacement_identity["systemdInvocationID"] or
                after_cancel.get("MainPID") != str(replacement_identity["mainPID"]) or
                _current_cgroup_identity(replacement_identity["cgroupPath"]) !=
                (replacement_identity["device"], replacement_identity["inode"]) or
                _held_cgroup_population(replacement_held) != 1):
            fail("stale-reference-stopped-or-adopted-replacement")
        old_after = gate_record(old_reference)
        if old_after.get("state") != "unknown" or old_after.get("binding") != old_binding:
            fail("stale-reference-rewrote-old-native-binding")
        lab_quarantined = True
        try:
            _cleanup_owned_unit_by_held_fd(UNIT, replacement_held, replacement_identity)
        except QualificationFailure:
            lab_quarantined = True
            fail("held-fd-replacement-cleanup-failed-lab-quarantined")
        replacement_cleaned = True
        replacement_held.close()
        replacement_held = None
        assert_verifier_idle()
        return {"oldBindingInvocationID": old_binding.get("systemdInvocationID"),
                "replacementInvocationID": replacement_identity["systemdInvocationID"],
                "oldReferenceCancelOutcome": "unknown-without-proof",
                "replacementRemainedActiveDuringOldCancel": True,
                "replacementNotAdopted": True, "replacementCleanup": "held-cgroup-directory-FD",
                "labQuarantined": lab_quarantined}
    finally:
        if replacement_held is not None and replacement_identity is not None:
            if not replacement_cleaned:
                try:
                    _cleanup_owned_unit_by_held_fd(UNIT, replacement_held, replacement_identity)
                except QualificationFailure:
                    lab_quarantined = True
                    fail("held-fd-replacement-cleanup-failed-lab-quarantined")
            replacement_held.close()
        if old_held is not None:
            old_held.close()
        if authority_lock is not None:
            unlock_gate_authority_state(authority_lock)


def run_launch_gap_crash(profile: dict[str, Any], tree: str, archive: bytes, scratch: Path) -> dict[str, Any]:
    assert_verifier_idle()
    for attempt in range(1, 9):
        case_scratch = scratch / f"case-launch-gap-{attempt}-{uuid.uuid4().hex}"
        case_scratch.mkdir(mode=0o700)
        marker = OUTPUT_DIR / f"lca-e2-launch-gap-{uuid.uuid4().hex}.executed"
        command = f"/usr/bin/printf 'BODY_RAN\\n' > {shlex.quote(str(marker))}; /usr/bin/sleep 5"
        request = prepare_request(tree, archive, command, case_scratch)
        prepared = native_call(profile, request)
        if prepared.get("ok") is not True:
            fail("launch-gap-ticket-prepare-refused")
        reference = require_reference(prepared, request)
        prepared_record = gate_record(reference)
        if prepared_record.get("state") != "prepared" or prepared_record.get("binding") is not None:
            fail("launch-gap-ticket-not-prepared")
        start_request = {"protocol": PROTOCOL, "op": "start", "reference": reference}
        broker_held, broker_identity = _unit_capture(GATE_UNIT, GATE_CGROUP_PATH)
        with closing(broker_held), concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            start_future = pool.submit(native_call, profile, start_request, timeout=20)
            deadline = time.monotonic() + 3.0
            observed = False
            while time.monotonic() < deadline:
                record = gate_record(reference)
                if record.get("state") == "launching":
                    observed = True
                    break
                if record.get("state") != "prepared":
                    break
                time.sleep(0.001)
            if not observed:
                try:
                    response = start_future.result(timeout=25)
                except Exception:
                    response = {"ok": False}
                current = gate_record(reference)
                if current.get("state") == "launching":
                    observed = True
                else:
                    if current.get("state") in {"bound", "running", "retiring"}:
                        cancelled = reference_call(profile, "cancel", reference)
                        if cancelled.get("ok") is True and cancelled.get("state") in {"running", "terminal"}:
                            wait_for_terminal(profile, reference, timeout=20)
                        current = gate_record(reference)
                    if current.get("state") == "terminal":
                        assert_verifier_idle()
                        return {"status": "blocked", "reason": "launching-window-not-observed; bounded command ran normally",
                                "attempts": attempt, "labQuarantined": False}
                    if current.get("state") == "unknown":
                        return {"status": "blocked", "reason": "launching-window-not-observed; ticket already unknown",
                                "attempts": attempt, "labQuarantined": True}
                    if response.get("ok") is False:
                        fail("launch-gap-start-failed-before-observable-state")
                    fail("launch-gap-start-left-unexpected-native-state")
            if not observed:
                fail("launch-gap-state-transition-not-observed")

            launching_record = gate_record(reference)
            if launching_record.get("state") != "launching" or launching_record.get("binding") is not None:
                fail("launch-gap-state-lost-before-broker-crash")
            try:
                broker_restart = _kill_gate_cgroup_and_wait_for_restart(
                    reference, (broker_held, broker_identity),
                )
            except QualificationFailure as error:
                if error.code != "launch-gap-window-closed-before-broker-crash":
                    raise
                try:
                    start_future.result(timeout=25)
                except Exception:
                    pass
                current = gate_record(reference)
                if current.get("state") in {"bound", "running", "retiring"}:
                    cancelled = reference_call(profile, "cancel", reference)
                    if cancelled.get("ok") is True and cancelled.get("state") in {"running", "terminal"}:
                        wait_for_terminal(profile, reference, timeout=20)
                    current = gate_record(reference)
                if current.get("state") == "terminal":
                    assert_verifier_idle()
                    return {"status": "blocked", "reason": "launching-window-closed-before-held-gate-fault",
                            "attempts": attempt, "labQuarantined": False}
                if current.get("state") == "unknown":
                    return {"status": "blocked", "reason": "launching-window-closed; ticket is unknown",
                            "attempts": attempt, "labQuarantined": True,
                            "unknownTicket": reference["invocationID"]}
                raise
            try:
                start_future.result(timeout=5)
            except Exception:
                pass
            record = _wait_for_record_state(reference, "unknown", 10.0)
            if (record.get("state") != "unknown" or record.get("binding") is not None or
                    record.get("released") is not False or record.get("commandStarted") is not False or
                    record.get("doneReceived") is True):
                fail("launch-gap-crash-adopted-or-bound-invocation")
            for field in ("ticket", "reference", "command", "cwd", "createdAt", "inputPath", "archiveBytes", "launchIntentAt"):
                if record.get(field) != launching_record.get(field):
                    fail("launch-gap-ownership-record-changed-during-recovery")
            if not isinstance(record.get("unknownReason"), str) or not record["unknownReason"]:
                fail("launch-gap-unknown-state-reason-missing")
            replay = reference_call(profile, "start", reference)
            if replay.get("ok") is not True or replay.get("state") != "unknown" or workload_file_exists(marker, profile["verifierUID"]):
                fail("launch-gap-ticket-replayed-or-body-executed")
            time.sleep(0.5)
            if workload_file_exists(marker, profile["verifierUID"]) or gate_record(reference).get("state") != "unknown":
                fail("launch-gap-body-ran-after-recovery")
            inspect = reference_call(profile, "inspect", reference)
            if (inspect.get("ok") is not True or inspect.get("state") != "unknown" or
                    isinstance(inspect.get("result"), dict) and inspect["result"].get("proof")):
                fail("launch-gap-remained-not-unknown")
            return {**broker_restart, "status": "pass", "brokerKilledDuringDurableLaunchIntent": True,
                    "recordRemainedUnknownWithoutBinding": True, "startReplayRefused": True,
                    "verifierBodyNeverExecuted": True, "labQuarantined": True,
                    "ownershipRecordPreserved": True, "gateMainPIDChanged": True, "attempts": attempt,
                    "unknownTicket": reference["invocationID"]}
    return {"status": "blocked", "reason": "launching-window-not-observed-after-bounded-attempts",
            "attempts": 8, "labQuarantined": False}


def reject_mismatched_reference(profile: dict[str, Any], reference: dict[str, Any]) -> dict[str, Any]:
    forged = dict(reference)
    while forged["invocationID"] == reference["invocationID"]:
        forged["invocationID"] = uuid.uuid4().hex
    response = reference_call(profile, "inspect", forged)
    refused = response.get("ok") is False or (response.get("ok") is True and response.get("state") == "unknown" and not response.get("result"))
    if not refused:
        fail("mismatched-native-reference-accepted")
    old_boot = dict(reference)
    while old_boot["bootID"] == reference["bootID"]:
        old_boot["bootID"] = str(uuid.uuid4())
    boot_response = reference_call(profile, "inspect", old_boot)
    boot_refused = boot_response.get("ok") is False or (
        boot_response.get("ok") is True and boot_response.get("state") == "unknown" and not boot_response.get("result"))
    if not boot_refused:
        fail("stale-boot-reference-accepted")
    return {"mismatchedInvocationRefused": True, "staleBootReferenceRefused": True}


def verify_tamper_refused(profile_key: str, signed: dict[str, Any], scratch: Path) -> dict[str, Any]:
    receipt = signed["receipt"].encode("utf-8")
    tampered = receipt + b" "
    key_file = scratch / "tamper-public-key.pem"
    receipt_file = scratch / "tampered-receipt.bin"
    signature_file = scratch / "tamper-signature.bin"
    writes = ((key_file, profile_key.encode("ascii")), (receipt_file, tampered),
              (signature_file, base64.b64decode(signed["signature"], validate=True)))
    for path, content in writes:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    try:
        completed = subprocess.run(["/usr/bin/openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(key_file),
                                     "-rawin", "-in", str(receipt_file), "-sigfile", str(signature_file)],
                                   env=client_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail("signature-verifier-unavailable")
    if completed.returncode == 0:
        fail("tampered-native-receipt-accepted")
    return {"tamperedReceiptRefused": True}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", help="new absolute secret-free JSON receipt path (default: /tmp/lca-linux-verifier-e2-<id>.json)")
    parser.add_argument("--keep-success-artifacts", action="store_true", help="retain the harness-owned Git fixture after success")
    parser.add_argument("--scenario", choices=("full", "launch-gap"), default="full",
                        help="run all non-quarantining cases, or run launch-gap last in isolation")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    default_receipt = Path(tempfile.gettempdir()) / f"lca-linux-verifier-e2-{uuid.uuid4().hex}.json"
    try:
        receipt_path = canonical_receipt_path(args.receipt) if args.receipt else canonical_receipt_path(str(default_receipt))
    except QualificationFailure as error:
        print(f"lca-linux-verifier-e2: {error.code}", file=sys.stderr)
        return 2
    report: dict[str, Any] = {
        "schema": "lca.linux-verifier.e2.v1",
        "startedAt": utc_now(),
        "scope": "actual fixed Linux verifier gate and single-use native receipt; not whole-agent containment or live-model qualification",
        "qualification": "incomplete",
        "cases": [],
        "failures": [],
        "artifacts": {"receipt": str(receipt_path)},
    }
    scratch: Path | None = None
    preserve = True
    phase = "preflight"
    try:
        if sys.platform != "linux" or not Path("/proc/sys/kernel/random/boot_id").is_file():
            fail("requires-linux-guest")
        if os.geteuid() != 0:
            fail("run-as-guest-root")
        if not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
            fail("requires-cgroup-v2")
        profile, public_key = load_profile()
        systemd = Path("/run/systemd/system")
        if not systemd.is_dir():
            fail("requires-systemd-pid1")
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", boot_id):
            fail("invalid-current-boot-id")
        scratch = Path(tempfile.mkdtemp(prefix="lca-linux-verifier-e2-", dir="/tmp"))
        os.chmod(scratch, 0o700)
        report["artifacts"]["scratch"] = str(scratch)
        preflight = native_call(profile, {"protocol": PROTOCOL, "op": "preflight"})
        if preflight.get("ok") is not True or not isinstance(preflight.get("compatible"), bool) or not isinstance(preflight.get("problems"), list):
            fail("gate-preflight-protocol-invalid")
        report["preflight"] = {"compatible": preflight["compatible"], "problemCount": len(preflight["problems"]),
                                "profileQualified": profile["qualified"]}
        tree, archive = make_git_fixture(scratch)
        report["fixture"] = {"tree": tree, "archiveBytes": len(archive), "bootID": boot_id}

        if args.scenario == "launch-gap":
            phase = "launch-gap-crash"
            report["quarantined"] = True
            report["launchGap"] = run_launch_gap_crash(profile, tree, archive, scratch)
            report["qualification"] = "pass" if report["launchGap"]["status"] == "pass" else "blocked"
            report["quarantined"] = report["launchGap"].get("labQuarantined") is True
            preserve = True
        else:
            phase = "initial-user-namespace-authority"
            namespace = run_namespace_root_guard()
            report["cases"].append({"name": "initial-user-namespace-root-guard", **namespace})

            phase = "verifier-uid-forged-controller-peer"
            forged_control_peer = run_forged_controller_peer(profile)
            report["cases"].append({"name": "verifier-uid-forged-control-peer", **forged_control_peer})

            phase = "concurrent-prepare-start-and-forged-verifier-peer"
            concurrency = run_concurrent_prepare_start(profile, public_key, tree, archive, scratch)
            report["cases"].append({"name": "concurrent-prepare-start-and-verifier-uid-peer", **concurrency})

            phase = "cgroup-and-manager-escape-denial"
            escape = run_escape_denial(profile, public_key, tree, archive, scratch)
            if not concurrency["forgedPeerMustBeRejectedBeforeTheNextRunnerHandshake"]:
                fail("forged-runner-peer-probe-not-observed")
            report["cases"].append({"name": "cgroup-and-manager-escape-denial", **escape,
                                    "forgedVerifierPeerRejectedBeforeNextRunnerHandshake": True})

            phase = "benign-success"
            benign_reference, benign = run_direct_case(profile, public_key, tree, archive, scratch, "benign", "/usr/bin/printf 'LCA_E2_NATIVE_OK\\n'", 0,
                                                        "LCA_E2_NATIVE_OK\n")
            report["cases"].append({"name": "benign-success", "reference": benign_reference,
                                    "result": {key: value for key, value in benign.items() if key != "proof"}, "proof": benign["proof"]})

            phase = "nonzero-result"
            nonzero_reference, nonzero = run_direct_case(profile, public_key, tree, archive, scratch, "nonzero", "/usr/bin/printf 'LCA_E2_NONZERO\\n'; exit 23", 23,
                                                          "LCA_E2_NONZERO\n")
            report["cases"].append({"name": "nonzero-result", "reference": nonzero_reference,
                                    "result": {key: value for key, value in nonzero.items() if key != "proof"}, "proof": nonzero["proof"]})

            phase = "reference-and-receipt-refusal"
            refusal = reject_mismatched_reference(profile, benign_reference)
            refusal.update(verify_tamper_refused(public_key, benign["proof"], scratch))
            report["cases"].append({"name": "forged-and-mismatched-reference-refusal", **refusal})

            phase = "detached-descendant-cancel"
            detached = run_detached_case(profile, public_key, tree, archive, scratch)
            report["cases"].append({"name": "setsid-double-fork-term-ignore", **detached})

            phase = "gate-restart-while-bound"
            gate_restart = run_gate_restart_while_bound(profile, public_key, tree, archive, scratch)
            report["cases"].append({"name": "root-gate-restart-while-bound", **gate_restart})

            phase = "stale-identity-does-not-stop-replacement"
            stale = run_stale_identity_does_not_stop_replacement(profile, public_key, tree, archive, scratch)
            report["cases"].append({"name": "stale-bound-reference-does-not-stop-replacement", **stale})
            report["quarantined"] = stale.get("labQuarantined") is True
            report["qualification"] = "pass"
            report["launchGap"] = {"status": "not-run", "reason": "run separately as the final scenario; an unknown launch record quarantines this lab"}
            preserve = args.keep_success_artifacts
    except QualificationFailure as error:
        report["failures"].append({"phase": phase, "code": error.code})
        if "lab-quarantined" in error.code:
            report["quarantined"] = True
    except Exception as error:  # record a type only; exception strings may include paths or command data
        report["failures"].append({"phase": phase, "code": "unexpected-" + type(error).__name__})
    finally:
        report["finishedAt"] = utc_now()
        if report["failures"]:
            report["qualification"] = "failed"
        if scratch is not None and not preserve:
            try:
                shutil.rmtree(scratch)
                report["artifacts"].pop("scratch", None)
            except OSError:
                report["failures"].append({"phase": "fixture-cleanup", "code": "owned-fixture-cleanup-failed"})
                report["qualification"] = "failed"
        try:
            write_receipt(receipt_path, report)
        except Exception:
            print("lca-linux-verifier-e2: could-not-write-receipt", file=sys.stderr)
            return 1
    print(json.dumps({"qualification": report["qualification"], "receipt": str(receipt_path)}, sort_keys=True))
    return 0 if report["qualification"] == "pass" else 2 if report["qualification"] == "blocked" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
