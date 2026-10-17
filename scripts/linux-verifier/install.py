#!/usr/bin/python3
"""Explicit guest-root installer for the Linux one-shot verifier authority."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any


SERVICE_USER = "otter-verifier"
PROFILE_PATH = "/etc/otter-verifier/profile.json"
PRIVATE_KEY = "/var/lib/otter-verifier/private/signing-key.pem"
HELPER_DIR = "/usr/local/libexec/otter-verifier"
SYSTEMD_DIR = "/etc/systemd/system"
POLKIT_DIR = "/etc/polkit-1/rules.d"
POLKIT_RULE = f"{POLKIT_DIR}/90-otter-verifier.rules"
SUDOERS_DIR = "/etc/sudoers.d"
SUDOERS_DROPIN = f"{SUDOERS_DIR}/00-otter-verifier-deny"
JOURNALD_CONF_DIR = "/etc/systemd/journald.conf.d"
JOURNALD_DROPIN = f"{JOURNALD_CONF_DIR}/otter-verifier.conf"
UNIT = "otter-verifier.service"
GATE_UNIT = "otter-verifier-gate.service"
SLICE_UNIT = "otter.slice"
OPENSSL = "/usr/bin/openssl"
SYSTEMCTL = "/usr/bin/systemctl"
JOURNALCTL = "/usr/bin/journalctl"
QUARANTINE_PATH = "/var/lib/otter-verifier/quarantine.json"
BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id"
BOOT_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
JOURNALD_DROPIN_CONTENT = "[Journal]\nStorage=persistent\n"

VERIFIER_UNIT_CONTENT = """[Unit]
Description=Otter single-use Linux verifier workload
After=local-fs.target otter-verifier-gate.service
Requires=otter.slice
ConditionPathIsSymbolicLink=/var/lib/otter-verifier/current

[Service]
Type=exec
ExitType=cgroup
User=otter-verifier
Group=otter-verifier
Slice=otter.slice
ExecStart=/usr/bin/python3 /usr/local/libexec/otter-verifier/runner.py
WorkingDirectory=/workspace
BindReadOnlyPaths=/var/lib/otter-verifier/current:/workspace
RuntimeDirectory=otter-verifier-output
RuntimeDirectoryMode=0700
ReadWritePaths=/run/otter-verifier-output
KillMode=control-group
Delegate=no
Restart=no
TimeoutStopSec=1s
RuntimeMaxSec=120s
MemoryMax=512M
TasksMax=128
SendSIGKILL=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectControlGroups=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateNetwork=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
LockPersonality=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
SystemCallArchitectures=native
DevicePolicy=closed
InaccessiblePaths=-/etc/systemd -/etc/dbus-1 -/run/systemd/private -/run/dbus -/run/user /run/otter-verifier/control.sock
UMask=0077

[Install]
"""

GATE_UNIT_CONTENT = """[Unit]
Description=Otter root Linux verifier authority
After=local-fs.target systemd-journald.service otter.slice
Wants=systemd-journald.service
Requires=otter.slice

[Service]
Type=exec
User=root
Group=root
ExecStart=/usr/bin/python3 /usr/local/libexec/otter-verifier/gate.py
Restart=on-failure
RestartSec=1s
RuntimeDirectory=otter-verifier
RuntimeDirectoryMode=0755
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
ProtectControlGroups=yes
ReadWritePaths=/var/lib/otter-verifier /run/otter-verifier /sys/fs/cgroup/otter.slice
TimeoutStopSec=10s

[Install]
WantedBy=multi-user.target
"""

SLICE_UNIT_CONTENT = """[Unit]
Description=Otter verifier workload slice
Before=slices.target

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
TasksAccounting=yes
"""

POLKIT_RULE_CONTENT = """polkit.addRule(function(action, subject) {
    if (subject.user === "otter-verifier") {
        return polkit.Result.NO;
    }
});
"""
SUDOERS_CONTENT = "otter-verifier ALL=(ALL:ALL) !ALL\n"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("ascii") + b"\n"


def _require_root_and_linux() -> None:
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        raise RuntimeError("installer requires an explicit Linux guest-root invocation")


def _boot_epoch() -> str:
    try:
        descriptor = os.open(BOOT_ID_PATH, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(descriptor, 128)
        finally:
            os.close(descriptor)
        value = raw.decode("ascii", errors="strict").strip()
    except (OSError, UnicodeError) as exc:
        raise RuntimeError("current Linux boot identity is unavailable") from exc
    if not BOOT_RE.fullmatch(value):
        raise RuntimeError("current Linux boot identity is invalid")
    return value


def _mkdir(path: str, mode: int) -> None:
    os.mkdir(path, mode)
    os.chown(path, 0, 0)
    os.chmod(path, mode)
    parent_fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _require_safe_directory(path: str) -> None:
    if not os.path.isabs(path):
        raise RuntimeError("installation directory is not absolute")
    current = "/"
    for part in (item for item in path.split("/") if item):
        current = os.path.join(current, part)
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("installation path contains an unsafe directory")


def _require_sudoers_dropin_include() -> None:
    path = "/etc/sudoers"
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 1024 * 1024:
            raise RuntimeError("sudoers main file is not a bounded protected regular file")
        raw = bytearray()
        while len(raw) <= info.st_size:
            chunk = os.read(fd, min(64 * 1024, info.st_size + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) != info.st_size:
            raise RuntimeError("sudoers main file changed while reading")
    finally:
        os.close(fd)
    if not re.search(rb"^\s*(?:@includedir|#includedir)\s+/etc/sudoers\.d\s*(?:#.*)?$", bytes(raw), re.MULTILINE):
        raise RuntimeError("sudoers does not include /etc/sudoers.d")


def _ensure_no_existing(paths: list[str]) -> None:
    for path in paths:
        try:
            os.lstat(path)
        except FileNotFoundError:
            continue
        raise RuntimeError("verifier installation path already exists; refusing replacement")


def _write_new(path: str, content: bytes, mode: int) -> None:
    parent = os.path.dirname(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, 0, 0)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(path)
        raise


def _source_bytes(name: str) -> bytes:
    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024:
            raise RuntimeError("verifier helper source is not a bounded regular file")
        chunks = bytearray()
        while len(chunks) <= info.st_size:
            part = os.read(fd, min(1024 * 1024, info.st_size + 1 - len(chunks)))
            if not part:
                break
            chunks.extend(part)
        if len(chunks) != info.st_size:
            raise RuntimeError("verifier helper source changed while reading")
        return bytes(chunks)
    finally:
        os.close(fd)


def _run_fixed(command: list[str], *, timeout: int = 15) -> None:
    try:
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "HOME": "/root", "LANG": "C", "LC_ALL": "C"},
            timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("fixed system setup command failed") from exc
    if result.returncode != 0:
        raise RuntimeError("fixed system setup command failed")


def _create_workload_user(controller: pwd.struct_passwd) -> pwd.struct_passwd:
    try:
        pwd.getpwnam(SERVICE_USER)
    except KeyError:
        pass
    else:
        raise RuntimeError("dedicated verifier account already exists")
    useradd = "/usr/sbin/useradd"
    _run_fixed([useradd, "--system", "--user-group", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", SERVICE_USER])
    verifier = pwd.getpwnam(SERVICE_USER)
    if verifier.pw_uid == controller.pw_uid or verifier.pw_uid == 0:
        raise RuntimeError("controller and verifier account identities must be distinct")
    groups = os.getgrouplist(SERVICE_USER, verifier.pw_gid)
    if len(groups) != 1 or groups[0] != verifier.pw_gid:
        raise RuntimeError("verifier account has unexpected supplementary groups")
    if verifier.pw_gid in os.getgrouplist(controller.pw_name, controller.pw_gid):
        raise RuntimeError("controller must not have access to the runner-only group")
    return verifier


def _generate_signing_key() -> str:
    if not os.path.isfile(OPENSSL):
        raise RuntimeError("OpenSSL is required for Ed25519 receipts")
    fd, temporary = tempfile.mkstemp(prefix=".signing-key-", dir=os.path.dirname(PRIVATE_KEY))
    os.fchmod(fd, 0o600)
    os.close(fd)
    try:
        _run_fixed([OPENSSL, "genpkey", "-algorithm", "ED25519", "-out", temporary], timeout=10)
        os.chown(temporary, 0, 0)
        os.chmod(temporary, 0o600)
        result = subprocess.run(
            [OPENSSL, "pkey", "-in", temporary, "-pubout"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "HOME": "/root", "LANG": "C", "LC_ALL": "C"},
            timeout=5, check=False,
        )
        if result.returncode != 0 or b"BEGIN PUBLIC KEY" not in result.stdout:
            raise RuntimeError("Ed25519 public key generation failed")
        key_fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(key_fd)
        finally:
            os.close(key_fd)
        os.replace(temporary, PRIVATE_KEY)
        parent_fd = os.open(os.path.dirname(PRIVATE_KEY), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        return result.stdout.decode("ascii", errors="strict")
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _copy_helpers() -> None:
    for name in ("gate.py", "runner.py", "client.py"):
        content = _source_bytes(name)
        _write_new(f"{HELPER_DIR}/{name}", content, 0o755)


def _write_units_and_policy() -> None:
    _write_new(f"{SYSTEMD_DIR}/{UNIT}", VERIFIER_UNIT_CONTENT.encode("utf-8"), 0o644)
    _write_new(f"{SYSTEMD_DIR}/{GATE_UNIT}", GATE_UNIT_CONTENT.encode("utf-8"), 0o644)
    _write_new(f"{SYSTEMD_DIR}/{SLICE_UNIT}", SLICE_UNIT_CONTENT.encode("utf-8"), 0o644)
    _write_new(POLKIT_RULE, POLKIT_RULE_CONTENT.encode("utf-8"), 0o644)
    _write_new(SUDOERS_DROPIN, SUDOERS_CONTENT.encode("ascii"), 0o440)
    _write_new(JOURNALD_DROPIN, JOURNALD_DROPIN_CONTENT.encode("ascii"), 0o644)


def _profile_files() -> dict[str, str]:
    paths = (
        f"{HELPER_DIR}/gate.py",
        f"{HELPER_DIR}/runner.py",
        f"{HELPER_DIR}/client.py",
        f"{SYSTEMD_DIR}/{UNIT}",
        f"{SYSTEMD_DIR}/{GATE_UNIT}",
        f"{SYSTEMD_DIR}/{SLICE_UNIT}",
        POLKIT_RULE,
        SUDOERS_DROPIN,
        JOURNALD_DROPIN,
    )
    hashes: dict[str, str] = {}
    for path in paths:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            chunks = bytearray()
            while True:
                part = os.read(fd, 1024 * 1024)
                if not part:
                    break
                chunks.extend(part)
            hashes[path] = hashlib.sha256(chunks).hexdigest()
        finally:
            os.close(fd)
    return hashes


def install(controller_name: str) -> None:
    _require_root_and_linux()
    boot_epoch = _boot_epoch()
    if controller_name in {"root", SERVICE_USER}:
        raise RuntimeError("controller must be a distinct non-root account")
    try:
        controller = pwd.getpwnam(controller_name)
    except KeyError as exc:
        raise RuntimeError("controller account does not exist") from exc
    if controller.pw_uid == 0:
        raise RuntimeError("controller must be a non-root account")
    paths = [
        "/etc/otter-verifier",
        PROFILE_PATH,
        "/var/lib/otter-verifier",
        PRIVATE_KEY,
        HELPER_DIR,
        f"{SYSTEMD_DIR}/{UNIT}",
        f"{SYSTEMD_DIR}/{GATE_UNIT}",
        f"{SYSTEMD_DIR}/{SLICE_UNIT}",
        POLKIT_RULE,
        SUDOERS_DROPIN,
        JOURNALD_DROPIN,
        QUARANTINE_PATH,
    ]
    _ensure_no_existing(paths)
    for directory in ("/etc", "/etc/systemd", "/var", "/var/lib", "/usr", "/usr/local", SYSTEMD_DIR):
        _require_safe_directory(directory)
    if os.path.lexists(JOURNALD_CONF_DIR):
        _require_safe_directory(JOURNALD_CONF_DIR)
    if os.path.lexists("/usr/local/libexec"):
        _require_safe_directory("/usr/local/libexec")
    else:
        _mkdir("/usr/local/libexec", 0o755)
    if os.path.lexists(POLKIT_DIR) and (not os.path.isdir(POLKIT_DIR) or os.path.islink(POLKIT_DIR)):
        raise RuntimeError("polkit rule directory is not a safe directory")
    if os.path.isdir("/etc/polkit-1"):
        _require_safe_directory("/etc/polkit-1")
    if not os.path.isdir(SYSTEMD_DIR) or os.path.islink(SYSTEMD_DIR):
        raise RuntimeError("systemd unit directory is unavailable")
    if os.path.lexists(SUDOERS_DIR) and (not os.path.isdir(SUDOERS_DIR) or os.path.islink(SUDOERS_DIR)):
        raise RuntimeError("sudoers drop-in directory is not a safe directory")
    if os.path.isdir(SUDOERS_DIR):
        _require_safe_directory(SUDOERS_DIR)
    _require_sudoers_dropin_include()
    if not os.path.lexists(JOURNALD_CONF_DIR):
        _mkdir(JOURNALD_CONF_DIR, 0o755)

    verifier = _create_workload_user(controller)
    _mkdir("/etc/otter-verifier", 0o755)
    _mkdir("/var/lib/otter-verifier", 0o700)
    _mkdir("/var/lib/otter-verifier/records", 0o700)
    _mkdir("/var/lib/otter-verifier/inputs", 0o700)
    _mkdir("/var/lib/otter-verifier/private", 0o700)
    _mkdir("/var/lib/otter-verifier/private/git-tmp", 0o700)
    _mkdir(HELPER_DIR, 0o755)
    if not os.path.isdir("/etc/polkit-1"):
        _mkdir("/etc/polkit-1", 0o755)
    if not os.path.isdir(POLKIT_DIR):
        _mkdir(POLKIT_DIR, 0o755)
    if not os.path.isdir(SUDOERS_DIR):
        _mkdir(SUDOERS_DIR, 0o755)
    _copy_helpers()
    public_key = _generate_signing_key()
    _write_units_and_policy()
    _run_fixed(["/usr/sbin/visudo", "-c"])
    profile = {
        "schema": "otter.linux-verifier.profile.v2",
        "bootEpoch": boot_epoch,
        "unit": UNIT,
        "controllerUID": controller.pw_uid,
        "verifierUID": verifier.pw_uid,
        "publicKeyPem": public_key,
        "files": _profile_files(),
        "qualified": False,
    }
    _write_new(PROFILE_PATH, _canonical_json(profile), 0o644)
    _run_fixed([SYSTEMCTL, "daemon-reload"])
    _run_fixed([SYSTEMCTL, "restart", "systemd-journald.service"], timeout=30)
    _run_fixed([JOURNALCTL, "--flush"], timeout=30)
    _run_fixed([SYSTEMCTL, "enable", "--now", GATE_UNIT], timeout=30)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="perform the explicit guest-root installation")
    parser.add_argument("--controller", required=True, help="existing non-root controller account name")
    arguments = parser.parse_args()
    if not arguments.install:
        parser.error("--install is required; installer never runs implicitly")
    try:
        install(arguments.controller)
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as exc:
        print(f"otter-verifier installation failed: {str(exc)[:256]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
