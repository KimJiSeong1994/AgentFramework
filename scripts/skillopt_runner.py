#!/usr/bin/env python3
"""Pinned SkillOpt adapter for the bounded Otter supervisor pipe.

The runner sends only fixed JSON data over one bounded pipe: train/selection
rollouts and, in native mode, pinned SkillOpt optimizer messages. It has no
native provider credentials or URLs and does not spawn provider CLIs or call
provider APIs. The supervisor owns native provider access, scoring, host
execution, and all qualification; optimization uses the pinned ReflACT trainer.
"""
from __future__ import annotations

import argparse
import codecs
import hashlib
import importlib
import importlib.machinery
import importlib.metadata
import inspect
from importlib.util import find_spec
import io
import json
import logging
import math
import os
import platform
import re
import site
import stat
import sys
import sysconfig
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, get_type_hints
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SOURCE_LOCK_RELATIVE = "scripts/skillopt-source-lock.json"
SOURCE_LOCK_PATH = ROOT / SOURCE_LOCK_RELATIVE
MANIFEST_RELATIVE_NAME = "protocol.json"
PRIVATE_RUNTIME_PROOF_NAME = "runtime-proof.json"
PRIVATE_RUNTIME_PROOF_SCHEMA = "skillopt.private-runtime-proof.v1"
NATIVE_RUNTIME_PROOF_SCHEMA = "skillopt.native-runtime-proof.v1"
NATIVE_RUNTIME_PROOF_CLAIM = "observed_local_runtime_pin"
EXPECTED_SOURCE = {
    "schema": "skillopt.source-lock.v1",
    "upstream": {
        "repository": "https://github.com/microsoft/SkillOpt.git",
        "commit": "fa4ca184573e42ec11472959dd57422381418096",
        "version": "0.2.0",
    },
    "license": {
        "path": "LICENSE",
        "spdx": "MIT",
        "sha256": "9515a04280cf50ce154eb3ab8fa375c7cc5e6b45ea5cb23b7ff3830737020c15",
    },
    "importManifest": {
        "algorithm": "sorted-path-nul-sha256-nul-size-v1",
        "package": "skillopt",
        "includeExtensions": [".md", ".py"],
        "files": 141,
        "bytes": 963171,
        "sha256": "342138966970886a70fa9092b93018cfad8d7b33708f81897d6ec32fc14b2441",
    },
}
DEPENDENCY_LOCK_PATH = "scripts/skillopt-requirements.lock"
DEPENDENCY_LOCK_MAX_BYTES = 2 * 1024 * 1024
INTERPRETER_MAX_BYTES = 64 * 1024 * 1024
SOURCE_LOCK_MAX_BYTES = 64 * 1024
MANIFEST_MAX_BYTES = 64 * 1024
PIPE_REQUEST_MAX_BYTES = 96 * 1024
PIPE_RESPONSE_MAX_BYTES = 512 * 1024
NATIVE_PROMPT_MAX_BYTES = 96 * 1024
NATIVE_REQUEST_MAX_BYTES = 512 * 1024
NATIVE_RESPONSE_MAX_BYTES = 256 * 1024
NATIVE_TEXT_MAX_BYTES = 32 * 1024
MAX_NATIVE_OPTIMIZER_REQUESTS = 40
MAX_NATIVE_COMPLETION_TOKENS = 16384
NATIVE_RUNTIME_PROOF_MAX_BYTES = 256 * 1024
NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES = 16 * 1024
NATIVE_RUNTIME_FILE_MAX_BYTES = 512 * 1024 * 1024
NATIVE_RUNTIME_TOTAL_FILES_MAX = 100_000
NATIVE_RUNTIME_TOTAL_BYTES_MAX = 4 * 1024 * 1024 * 1024
NATIVE_OPTIMIZER_STAGES = frozenset({"analyst", "merge", "ranking"})
NATIVE_USAGE_TOKEN_FIELDS = frozenset(
    {
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheCreationTokens",
    }
)
NATIVE_USAGE_FIELDS = NATIVE_USAGE_TOKEN_FIELDS | {"reportedCostUsd"}
NATIVE_OPTIMIZER_ERROR_CODES = frozenset(
    {
        "broker_unavailable",
        "cancelled",
        "capability_unavailable",
        "host_failed",
        "isolation_failed",
        "model_unavailable",
        "protocol_invalid",
        "request_budget_exhausted",
        "time_budget_exhausted",
    }
)
NATIVE_OPTIMIZER_CONSUMER_PREFIXES = (
    "skillopt.engine",
    "skillopt.gradient",
    "skillopt.optimizer",
)
NATIVE_REJECTED_MODEL_ENTRYPOINTS = (
    "chat_optimizer_messages",
    "chat_target",
    "chat_target_messages",
    "chat_messages_with_deployment",
    "chat_with_deployment",
)
MAX_FRAGMENT_BYTES = 1200
# Native-only per-object normal-form caps; these are not aggregate reservations.
NATIVE_OUTPUT_ROOT_PATH_MAX_BYTES = 4 * 1024
NATIVE_RESULT_MAX_BYTES = 32 * 1024
NATIVE_OPTIMIZER_MAX_JSON_DEPTH = 8
NATIVE_OPTIMIZER_MAX_JSON_NODES = 256
NATIVE_OPTIMIZER_MAX_CONTAINER_ITEMS = 32
NATIVE_OPTIMIZER_MAX_STRING_BYTES = NATIVE_TEXT_MAX_BYTES
NATIVE_ANALYST_BATCH_MAX = 24
NATIVE_ANALYST_EDIT_BUDGET = 4
NATIVE_FAILURE_SUMMARY_MAX_ITEMS = 24
NATIVE_ANALYST_OBJECT_MAX_BYTES = 48 * 1024
NATIVE_ANALYST_PATCH_MAX_BYTES = 32 * 1024
NATIVE_ANALYST_NORMALIZED_PATCH_MAX_BYTES = 34 * 1024
NATIVE_ANALYST_FALLBACK_PATCH_MAX_BYTES = 72 * 1024
NATIVE_MERGE_PATCH_MAX_BYTES = 64 * 1024
NATIVE_MERGE_PROJECTED_PATCH_MAX_BYTES = 66 * 1024
NATIVE_RANKING_OBJECT_MAX_BYTES = 32 * 1024
NATIVE_RANKED_PATCH_MAX_BYTES = 104 * 1024
# Four selected edits can each add at most one 1200-byte fragment plus the
# pinned append separator/newline bytes to the configured empty initial skill.
NATIVE_CANDIDATE_SKILL_MAX_BYTES = NATIVE_ANALYST_EDIT_BUDGET * (
    MAX_FRAGMENT_BYTES + 3
)
MAX_CONVERSATION_BYTES = 256 * 1024
MAX_MESSAGE_BYTES = 64 * 1024
MAX_MESSAGES = 128
MAX_ROLLOUT_REQUESTS = 120
UPSTREAM_CAPTURE_MAX_BYTES = 128 * 1024
LOCAL_METER_API_KEY = "skillopt-local"
SUPERVISOR_ERROR_CODES = frozenset(
    {
        "invalid_case",
        "invalid_fragment",
        "protocol_invalid",
        "capability_unavailable",
        "isolation_failed",
        "host_failed",
        "witness_mismatch",
        "score_invalid",
        "request_budget_exhausted",
        "time_budget_exhausted",
        "artifact_budget_exhausted",
        "cancelled",
    }
)
CASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
REQUEST_ID_RE = re.compile(r"[A-Za-z0-9:_-]{1,160}\Z")
MODEL_RE = re.compile(r"[A-Za-z0-9._:/-]{1,128}\Z")
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})


class RunnerError(Exception):
    """An error with a fixed, non-sensitive diagnostic code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Case:
    case_id: str
    replicate: int
    split: str

    @property
    def item_id(self) -> str:
        return f"{self.case_id}--r{self.replicate}"


@dataclass(frozen=True)
class RunManifest:
    run_id: str
    mode: str
    source_lock_sha256: str
    original_skill_sha256: str
    train: tuple[Case, ...]
    selection: tuple[Case, ...]
    sha256: str

    @property
    def max_rollout_requests(self) -> int:
        return len(self.train) + 2 * len(self.selection)


def _require_object(value: Any, keys: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise RunnerError(code)
    return value


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite JSON value")


def _decode_json(data: bytes, code: str) -> Any:
    try:
        text = data.decode("utf-8", errors="strict")
        if "\x00" in text:
            raise ValueError("NUL")
        return json.loads(
            text,
            object_pairs_hook=_json_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError, RecursionError):
        raise RunnerError(code) from None


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _bounded_regular_file(path: Path, limit: int, code: str) -> bytes:
    fd: int | None = None
    try:
        if not hasattr(os, "O_NOFOLLOW"):
            raise RunnerError(code)
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | os.O_NOFOLLOW
        fd = os.open(path, flags)
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > limit
        ):
            raise RunnerError(code)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 64 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
        named = os.stat(path, follow_symlinks=False)
        stable_fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        if (
            len(data) > limit
            or len(data) != before.st_size
            or not stat.S_ISREG(after.st_mode)
            or not stat.S_ISREG(named.st_mode)
            or after.st_nlink != 1
            or any(getattr(before, field) != getattr(after, field) for field in stable_fields)
            or any(getattr(after, field) != getattr(named, field) for field in stable_fields)
        ):
            raise RunnerError(code)
        return data
    except RunnerError:
        raise
    except OSError:
        raise RunnerError(code) from None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _project_lock_path(value: str) -> Path:
    if not isinstance(value, str) or not value:
        raise RunnerError("source_lock_invalid")
    supplied = Path(value)
    if supplied.is_absolute():
        candidate = supplied
    else:
        candidate = ROOT / supplied
    try:
        if candidate.resolve(strict=True) != SOURCE_LOCK_PATH.resolve(strict=True):
            raise RunnerError("source_lock_invalid")
    except OSError:
        raise RunnerError("source_lock_invalid") from None
    if SOURCE_LOCK_PATH.is_symlink():
        raise RunnerError("source_lock_invalid")
    return SOURCE_LOCK_PATH


def _validate_lock_document(lock: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(lock, dict) or set(lock) != {
        "schema",
        "upstream",
        "license",
        "importManifest",
        "dependencyLock",
        "runtimeProof",
    }:
        raise RunnerError("source_lock_invalid")
    for key, expected in EXPECTED_SOURCE.items():
        if lock.get(key) != expected:
            raise RunnerError("source_lock_mismatch")

    dependency = _require_object(
        lock.get("dependencyLock"), {"path", "sha256", "verified"}, "source_lock_invalid"
    )
    if dependency.get("path") != DEPENDENCY_LOCK_PATH:
        raise RunnerError("source_lock_mismatch")
    if dependency.get("verified") is not True or not _is_sha256(dependency.get("sha256")):
        raise RunnerError("dependency_lock_unverified")

    proof = _require_object(
        lock.get("runtimeProof"),
        {"schema", "sha256", "verified"},
        "source_lock_invalid",
    )
    if (
        proof.get("schema") != PRIVATE_RUNTIME_PROOF_SCHEMA
        or proof.get("verified") is not True
        or not _is_sha256(proof.get("sha256"))
    ):
        raise RunnerError("runtime_proof_unverified")
    return dependency, proof


def _load_source_lock(
    source_lock_arg: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    lock_path = _project_lock_path(source_lock_arg)
    raw = _bounded_regular_file(lock_path, SOURCE_LOCK_MAX_BYTES, "source_lock_invalid")
    lock = _decode_json(raw, "source_lock_invalid")
    dependency, proof = _validate_lock_document(lock)
    return lock, dependency, proof, hashlib.sha256(raw).hexdigest()


def _manifest_digest(package_root: Path) -> tuple[str, int, int]:
    try:
        if package_root.is_symlink() or not package_root.is_dir():
            raise RunnerError("import_tree_mismatch")
        rows: list[tuple[str, str, int]] = []
        total_bytes = 0
        for path in package_root.rglob("*"):
            if path.is_symlink():
                raise RunnerError("import_tree_mismatch")
            if not path.is_file() or path.suffix not in {".py", ".md"}:
                continue
            if "__pycache__" in path.parts:
                continue
            if len(rows) >= EXPECTED_SOURCE["importManifest"]["files"]:
                raise RunnerError("import_tree_mismatch")
            remaining_bytes = EXPECTED_SOURCE["importManifest"]["bytes"] - total_bytes
            data = _bounded_regular_file(path, remaining_bytes, "import_tree_mismatch")
            relative = path.relative_to(package_root.parent).as_posix()
            rows.append((relative, hashlib.sha256(data).hexdigest(), len(data)))
            total_bytes += len(data)
        rows.sort(key=lambda row: row[0])
        canonical = "".join(f"{name}\0{digest}\0{size}\n" for name, digest, size in rows)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return digest, len(rows), total_bytes
    except RunnerError:
        raise
    except (OSError, ValueError):
        raise RunnerError("import_tree_mismatch") from None


def _installed_license_sha256(distribution: importlib.metadata.Distribution) -> str:
    files = distribution.files
    if not files:
        raise RunnerError("source_license_unverified")
    candidates = [
        file
        for file in files
        if str(file).replace("\\", "/").lower().endswith(".dist-info/licenses/license")
    ]
    if len(candidates) != 1:
        raise RunnerError("source_license_unverified")
    try:
        path = Path(distribution.locate_file(candidates[0]))
        if path.is_symlink() or not path.is_file():
            raise RunnerError("source_license_unverified")
        raw = _bounded_regular_file(path, 64 * 1024, "source_license_unverified")
        return hashlib.sha256(raw).hexdigest()
    except RunnerError:
        raise
    except OSError:
        raise RunnerError("source_license_unverified") from None


def _private_runtime_proof_path(venv_root: Path) -> Path:
    try:
        resolved_venv = venv_root.resolve(strict=True)
    except OSError:
        raise RunnerError("runtime_proof_unverified") from None
    if not resolved_venv.is_absolute() or resolved_venv == resolved_venv.parent:
        raise RunnerError("runtime_proof_unverified")
    return resolved_venv.parent / PRIVATE_RUNTIME_PROOF_NAME


def _validate_private_runtime_proof(
    raw: bytes,
    expected_sha256: str,
    expected_fields: dict[str, str],
) -> tuple[dict[str, Any], str]:
    digest = hashlib.sha256(raw).hexdigest()
    if not _is_sha256(expected_sha256) or digest != expected_sha256:
        raise RunnerError("runtime_proof_mismatch")
    proof = _require_object(
        _decode_json(raw, "runtime_proof_invalid"),
        {
            "schema",
            "verified",
            "venvRoot",
            "pythonRealpath",
            "pythonVersion",
            "pythonSha256",
            "dependencyLockSha256",
            "upstreamCommit",
            "importManifestSha256",
        },
        "runtime_proof_invalid",
    )
    if (
        proof.get("schema") != PRIVATE_RUNTIME_PROOF_SCHEMA
        or proof.get("verified") is not True
        or not isinstance(proof.get("venvRoot"), str)
        or not Path(proof["venvRoot"]).is_absolute()
        or not isinstance(proof.get("pythonRealpath"), str)
        or not Path(proof["pythonRealpath"]).is_absolute()
        or not isinstance(proof.get("pythonVersion"), str)
        or re.fullmatch(r"\d+\.\d+\.\d+", proof["pythonVersion"]) is None
        or not _is_sha256(proof.get("pythonSha256"))
        or not _is_sha256(proof.get("dependencyLockSha256"))
        or not _is_sha256(proof.get("importManifestSha256"))
        or proof.get("upstreamCommit") != EXPECTED_SOURCE["upstream"]["commit"]
    ):
        raise RunnerError("runtime_proof_invalid")
    if any(proof.get(key) != value for key, value in expected_fields.items()):
        raise RunnerError("runtime_proof_mismatch")
    return proof, digest


def _public_runtime_proof(
    source_lock_sha256: str,
    runtime_proof_sha256: str,
    dependency_lock_sha256: str,
    python_version: str,
    python_sha256: str,
    license_sha256: str,
    import_manifest_sha256: str,
) -> dict[str, Any]:
    return {
        "schema": "skillopt.runtime-proof.v1",
        "ok": True,
        "upstreamCommit": EXPECTED_SOURCE["upstream"]["commit"],
        "upstreamVersion": EXPECTED_SOURCE["upstream"]["version"],
        "sourceLockSha256": source_lock_sha256,
        "runtimeProofSha256": runtime_proof_sha256,
        "licenseSha256": license_sha256,
        "importManifestSha256": import_manifest_sha256,
        "dependencyLockSha256": dependency_lock_sha256,
        "pythonVersion": python_version,
        "pythonSha256": python_sha256,
    }


def verify_runtime(source_lock_arg: str) -> dict[str, Any]:
    _lock, dependency, proof, source_lock_digest = _load_source_lock(source_lock_arg)

    dependency_path = ROOT / dependency["path"]
    dependency_bytes = _bounded_regular_file(
        dependency_path, DEPENDENCY_LOCK_MAX_BYTES, "dependency_lock_unverified"
    )
    dependency_digest = hashlib.sha256(dependency_bytes).hexdigest()
    if dependency_digest != dependency["sha256"]:
        raise RunnerError("dependency_lock_mismatch")

    configured_python = os.environ.get("SKILLOPT_PYTHON", "")
    configured_python_path = Path(configured_python)
    expected_venv_suffix = (
        "skillopt",
        "runtime",
        EXPECTED_SOURCE["upstream"]["commit"],
        "venv",
        "bin",
        "python",
    )
    if (
        not configured_python
        or not configured_python_path.is_absolute()
        or configured_python_path.parts[-len(expected_venv_suffix) :] != expected_venv_suffix
    ):
        raise RunnerError("interpreter_unverified")
    try:
        actual_python = Path(sys.executable).resolve(strict=True)
        prefix = Path(sys.prefix).resolve(strict=True)
        expected_venv = configured_python_path.parent.parent.resolve(strict=True)
        python_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        python_sha256 = hashlib.sha256(
            _bounded_regular_file(actual_python, INTERPRETER_MAX_BYTES, "interpreter_unverified")
        ).hexdigest()
        if (
            Path(configured_python).resolve(strict=True) != actual_python
            or expected_venv != prefix
            or prefix == Path(sys.base_prefix).resolve(strict=True)
            or site.ENABLE_USER_SITE is not False
            or sys.flags.isolated != 1
            or os.environ.get("PYTHONPATH")
            or os.environ.get("PYTHONHOME")
        ):
            raise RunnerError("interpreter_unverified")
    except RunnerError:
        raise
    except (OSError, ValueError):
        raise RunnerError("interpreter_unverified") from None

    runtime_proof_path = _private_runtime_proof_path(prefix)
    runtime_proof_raw = _bounded_regular_file(
        runtime_proof_path, 16 * 1024, "runtime_proof_unverified"
    )
    private_proof, runtime_proof_digest = _validate_private_runtime_proof(
        runtime_proof_raw,
        proof["sha256"],
        {
            "venvRoot": str(prefix),
            "pythonRealpath": str(actual_python),
            "pythonVersion": python_version,
            "pythonSha256": python_sha256,
            "dependencyLockSha256": dependency_digest,
            "upstreamCommit": EXPECTED_SOURCE["upstream"]["commit"],
            "importManifestSha256": EXPECTED_SOURCE["importManifest"]["sha256"],
        },
    )

    try:
        spec = find_spec("skillopt")
        distribution = importlib.metadata.distribution("skillopt")
    except (ImportError, importlib.metadata.PackageNotFoundError, ValueError):
        raise RunnerError("upstream_import_unavailable") from None
    if (
        spec is None
        or not isinstance(spec.origin, str)
        or not spec.submodule_search_locations
        or len(spec.submodule_search_locations) != 1
        or distribution.version != EXPECTED_SOURCE["upstream"]["version"]
    ):
        raise RunnerError("upstream_version_mismatch")
    try:
        prefix = Path(sys.prefix).resolve(strict=True)
        package_root = Path(next(iter(spec.submodule_search_locations)))
        spec_origin = Path(spec.origin)
        if package_root.is_symlink() or spec_origin.is_symlink():
            raise RunnerError("upstream_import_unverified")
        package_root = package_root.resolve(strict=True)
        spec_origin = spec_origin.resolve(strict=True)
        package_root.relative_to(prefix)
        spec_origin.relative_to(package_root)
        Path(distribution.locate_file("")).resolve(strict=True).relative_to(prefix)
    except (AttributeError, OSError, ValueError):
        raise RunnerError("upstream_import_unverified") from None

    digest, count, byte_count = _manifest_digest(package_root)
    expected_manifest = EXPECTED_SOURCE["importManifest"]
    if digest != expected_manifest["sha256"] or count != expected_manifest["files"] or byte_count != expected_manifest["bytes"]:
        raise RunnerError("import_tree_mismatch")
    license_digest = _installed_license_sha256(distribution)
    if license_digest != EXPECTED_SOURCE["license"]["sha256"]:
        raise RunnerError("source_license_mismatch")
    package_entry = [
        file
        for file in distribution.files or ()
        if str(file).replace("\\", "/") == "skillopt/__init__.py"
    ]
    try:
        package_entry_matches = (
            len(package_entry) == 1
            and Path(distribution.locate_file(package_entry[0])).resolve(strict=True)
            == spec_origin
        )
    except (OSError, ValueError):
        package_entry_matches = False
    if not package_entry_matches:
        raise RunnerError("upstream_import_unverified")

    try:
        skillopt = importlib.import_module("skillopt")
    except ImportError:
        raise RunnerError("upstream_import_unavailable") from None
    try:
        imported_origin = Path(skillopt.__file__).resolve(strict=True)
    except (AttributeError, OSError, TypeError, ValueError):
        raise RunnerError("upstream_import_unverified") from None
    if (
        imported_origin != spec_origin
        or getattr(skillopt, "__version__", None) != EXPECTED_SOURCE["upstream"]["version"]
    ):
        raise RunnerError("upstream_import_unverified")

    if digest != private_proof["importManifestSha256"]:
        raise RunnerError("runtime_proof_mismatch")

    _assert_source_lock_digest(source_lock_digest)
    return _public_runtime_proof(
        source_lock_sha256=source_lock_digest,
        runtime_proof_sha256=runtime_proof_digest,
        dependency_lock_sha256=dependency_digest,
        python_version=python_version,
        python_sha256=python_sha256,
        license_sha256=license_digest,
        import_manifest_sha256=digest,
    )


def _normalize_distribution_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _locked_dependency_versions(raw: bytes) -> dict[str, tuple[str, str]]:
    try:
        lines = raw.decode("utf-8", errors="strict").splitlines()
    except UnicodeDecodeError:
        raise RunnerError("dependency_lock_invalid") from None
    locked: dict[str, tuple[str, str]] = {}
    current: tuple[str, str, str] | None = None
    hashes: list[str] = []

    def finish() -> None:
        nonlocal current, hashes
        if current is None or not hashes:
            raise RunnerError("dependency_lock_invalid")
        name, version, normalized = current
        if normalized in locked:
            raise RunnerError("dependency_lock_invalid")
        locked[normalized] = (name, version)
        current = None
        hashes = []

    for raw_line in lines:
        if not raw_line.strip():
            if current is not None:
                raise RunnerError("dependency_lock_invalid")
            continue
        line = raw_line.strip()
        continuation = line.endswith("\\")
        content = line[:-1].rstrip() if continuation else line
        if raw_line[:1].isspace():
            if current is None or not re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", content):
                raise RunnerError("dependency_lock_invalid")
            hashes.append(content.removeprefix("--hash=sha256:"))
            if not continuation:
                finish()
            continue
        if current is not None:
            raise RunnerError("dependency_lock_invalid")
        match = re.fullmatch(
            r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)",
            content,
        )
        if match is None or not continuation:
            raise RunnerError("dependency_lock_invalid")
        name, version = match.groups()
        current = (name, version, _normalize_distribution_name(name))
    if current is not None:
        raise RunnerError("dependency_lock_invalid")
    if not locked:
        raise RunnerError("dependency_lock_invalid")
    return locked


def _owned_directory(path: Path, expected_uid: int, code: str) -> os.stat_result:
    try:
        if path.is_symlink():
            raise RunnerError(code)
        info = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != expected_uid
            or info.st_mode & 0o022
        ):
            raise RunnerError(code)
        return info
    except RunnerError:
        raise
    except OSError:
        raise RunnerError(code) from None


def _owned_file_digest(
    path: Path,
    expected_uid: int,
    max_bytes: int,
    code: str,
) -> tuple[str, int]:
    fd: int | None = None
    try:
        if not hasattr(os, "O_NOFOLLOW"):
            raise RunnerError(code)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | os.O_NOFOLLOW)
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or before.st_size > max_bytes
        ):
            raise RunnerError(code)
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, max_bytes - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise RunnerError(code)
            digest.update(chunk)
        after = os.fstat(fd)
        named = os.stat(path, follow_symlinks=False)
        stable_fields = (
            "st_dev",
            "st_ino",
            "st_mode",
            "st_uid",
            "st_nlink",
            "st_size",
            "st_mtime_ns",
            "st_ctime_ns",
        )
        if (
            size != before.st_size
            or not stat.S_ISREG(after.st_mode)
            or not stat.S_ISREG(named.st_mode)
            or after.st_uid != expected_uid
            or any(getattr(before, field) != getattr(after, field) for field in stable_fields)
            or any(getattr(after, field) != getattr(named, field) for field in stable_fields)
        ):
            raise RunnerError(code)
        return digest.hexdigest(), size
    except RunnerError:
        raise
    except OSError:
        raise RunnerError(code) from None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _read_native_venv_configuration(
    venv_root: Path,
    uid: int,
) -> tuple[dict[str, str], str]:
    _owned_directory(venv_root, uid, "native_interpreter_unverified")
    config_path = venv_root / "pyvenv.cfg"
    digest, size = _owned_file_digest(
        config_path,
        uid,
        64 * 1024,
        "native_interpreter_unverified",
    )
    raw = _bounded_regular_file(
        config_path,
        64 * 1024,
        "native_interpreter_unverified",
    )
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
        raise RunnerError("native_interpreter_unverified")
    try:
        lines = raw.decode("utf-8", errors="strict").splitlines()
    except UnicodeDecodeError:
        raise RunnerError("native_interpreter_unverified") from None
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise RunnerError("native_interpreter_unverified")
        key, value = (part.strip() for part in stripped.split("=", 1))
        if (
            not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", key)
            or not value
            or key in values
        ):
            raise RunnerError("native_interpreter_unverified")
        values[key] = value
    required = {"home", "include-system-site-packages"}
    if not required.issubset(values):
        raise RunnerError("native_interpreter_unverified")
    if values["include-system-site-packages"].lower() != "false":
        raise RunnerError("native_interpreter_unverified")
    if values.get("implementation", platform.python_implementation()) != platform.python_implementation():
        raise RunnerError("native_interpreter_unverified")
    actual_version = (
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    )
    configured_version = values.get("version_info", values.get("version"))
    if configured_version != actual_version or (
        "version" in values and values["version"] != actual_version
    ):
        raise RunnerError("native_interpreter_unverified")
    home = Path(values["home"])
    if not home.is_absolute():
        raise RunnerError("native_interpreter_unverified")
    try:
        resolved_home = home.resolve(strict=True)
        if not resolved_home.is_dir():
            raise RunnerError("native_interpreter_unverified")
        values["home"] = str(resolved_home)
    except RunnerError:
        raise
    except (OSError, RuntimeError):
        raise RunnerError("native_interpreter_unverified") from None
    return values, digest


def _native_sys_path_state() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for value in sys.path:
        if not isinstance(value, str) or not value:
            raise RunnerError("native_sys_path_unverified")
        candidate = Path(value)
        if not candidate.is_absolute():
            raise RunnerError("native_sys_path_unverified")
        try:
            canonical = candidate.resolve(strict=False)
            info = canonical.stat(follow_symlinks=False)
        except FileNotFoundError:
            entries.append({"path": str(candidate.resolve(strict=False)), "state": "missing"})
            continue
        except (OSError, RuntimeError):
            raise RunnerError("native_sys_path_unverified") from None
        if stat.S_ISDIR(info.st_mode):
            entries.append({"path": str(canonical), "state": "directory"})
        elif stat.S_ISREG(info.st_mode):
            if info.st_size > INTERPRETER_MAX_BYTES:
                raise RunnerError("native_sys_path_oversized")
            fd: int | None = None
            try:
                fd = os.open(canonical, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | os.O_NOFOLLOW)
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_size > INTERPRETER_MAX_BYTES:
                    raise RunnerError("native_sys_path_unverified")
                digest = hashlib.sha256()
                size = 0
                while True:
                    chunk = os.read(fd, min(64 * 1024, INTERPRETER_MAX_BYTES - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > INTERPRETER_MAX_BYTES:
                        raise RunnerError("native_sys_path_oversized")
                    digest.update(chunk)
                after = os.fstat(fd)
                named = canonical.stat(follow_symlinks=False)
                if (
                    size != before.st_size
                    or any(
                        getattr(before, field) != getattr(after, field)
                        for field in ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
                    )
                    or any(
                        getattr(after, field) != getattr(named, field)
                        for field in ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
                    )
                ):
                    raise RunnerError("native_sys_path_unverified")
            except RunnerError:
                raise
            except OSError:
                raise RunnerError("native_sys_path_unverified") from None
            finally:
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            entries.append(
                {
                    "path": str(canonical),
                    "state": "file",
                    "sha256": digest.hexdigest(),
                    "bytes": size,
                }
            )
        else:
            raise RunnerError("native_sys_path_unverified")
    return entries


def _verify_native_interpreter() -> dict[str, Any]:
    if not hasattr(os, "getuid"):
        raise RunnerError("native_runtime_unsupported_platform")
    uid = os.getuid()
    configured_value = os.environ.get("SKILLOPT_PYTHON", "")
    configured_path = Path(configured_value)
    try:
        startup_prefix = Path(sys.prefix).resolve(strict=True)
        base_prefix = Path(sys.base_prefix).resolve(strict=True)
        actual_executable = Path(sys.executable).resolve(strict=True)
        if (
            not configured_value
            or not configured_path.is_absolute()
            or str(configured_path) != os.path.normpath(configured_value)
            or sys.flags.isolated != 1
            or sys.flags.no_user_site != 1
            or sys.flags.ignore_environment != 1
            or sys.flags.no_site != 1
            or sys.flags.dont_write_bytecode != 1
            or not sys.dont_write_bytecode
            or "sitecustomize" in sys.modules
            or "usercustomize" in sys.modules
            or os.environ.get("PYTHONPATH")
            or os.environ.get("PYTHONHOME")
        ):
            raise RunnerError("native_interpreter_unverified")
        if uid == 0:
            raise RunnerError("native_interpreter_unverified")
        if configured_path.name not in {
            "python",
            "python3",
            f"python{sys.version_info.major}.{sys.version_info.minor}",
        }:
            raise RunnerError("native_interpreter_unverified")
        prefix = configured_path.parent.parent.resolve(strict=True)
        if configured_path.parent.parent != prefix:
            raise RunnerError("native_interpreter_unverified")
        configured_path.relative_to(prefix)
        actual_executable.relative_to(prefix)
        if actual_executable != configured_path.resolve(strict=True):
            raise RunnerError("native_interpreter_unverified")
        prefix_info = _owned_directory(prefix, uid, "native_interpreter_unverified")
        executable_info = actual_executable.stat(follow_symlinks=False)
        configured_info = configured_path.lstat()
        if (
            not stat.S_ISREG(executable_info.st_mode)
            or executable_info.st_uid != uid
            or executable_info.st_mode & 0o022
            or not executable_info.st_mode & 0o111
            or configured_info.st_uid != uid
            or not (
                stat.S_ISREG(configured_info.st_mode)
                or stat.S_ISLNK(configured_info.st_mode)
            )
            or (
                stat.S_ISREG(configured_info.st_mode)
                and not configured_info.st_mode & 0o111
            )
        ):
            raise RunnerError("native_interpreter_unverified")
        bin_dir = configured_path.parent
        _owned_directory(bin_dir, uid, "native_interpreter_unverified")
        python_sha256, _python_bytes = _owned_file_digest(
            actual_executable,
            uid,
            INTERPRETER_MAX_BYTES,
            "native_interpreter_unverified",
        )
        venv_config, pyvenv_cfg_sha256 = _read_native_venv_configuration(prefix, uid)
        configured_base_home = Path(venv_config["home"])
        if base_prefix not in {configured_base_home, configured_base_home.parent}:
            raise RunnerError("native_interpreter_unverified")
        sys_path_state = _native_sys_path_state()
        if startup_prefix not in {prefix, base_prefix}:
            raise RunnerError("native_interpreter_unverified")
        return {
            "configuredPath": str(configured_path),
            "realpath": str(actual_executable),
            "sha256": python_sha256,
            "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "venvRoot": str(prefix),
            "venvHome": venv_config["home"],
            "venvConfiguration": venv_config,
            "basePrefix": str(base_prefix),
            "startupPrefix": str(startup_prefix),
            "startupBasePrefix": str(base_prefix),
            "startupPrefixIsVenv": startup_prefix == prefix,
            "venvOwnerUid": prefix_info.st_uid,
            "venvMode": stat.S_IMODE(prefix_info.st_mode),
            "interpreterOwnerUid": executable_info.st_uid,
            "interpreterMode": stat.S_IMODE(executable_info.st_mode),
            "configuredEntryKind": (
                "symlink"
                if stat.S_ISLNK(configured_info.st_mode)
                else "regular"
            ),
            "binMode": stat.S_IMODE(bin_dir.stat(follow_symlinks=False).st_mode),
            "pyvenvConfigSha256": pyvenv_cfg_sha256,
            "uid": uid,
            "platform": sys.platform,
            "osName": os.name,
            "machine": platform.machine(),
            "implementation": platform.python_implementation(),
            "cacheTag": sys.implementation.cache_tag,
            "sysconfigPlatform": sysconfig.get_platform(),
            "isolated": True,
            "noUserSite": sys.flags.no_user_site == 1,
            "ignoreEnvironment": sys.flags.ignore_environment == 1,
            "noSite": True,
            "userSiteEnabled": site.ENABLE_USER_SITE is True,
            "siteEnableUserSite": site.ENABLE_USER_SITE,
            "dontWriteBytecodeFlag": sys.flags.dont_write_bytecode,
            "dontWriteBytecode": sys.dont_write_bytecode,
            "pythonPathAbsent": True,
            "pythonHomeAbsent": True,
            "sysPath": sys_path_state,
        }
    except RunnerError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise RunnerError("native_interpreter_unverified") from None


def _native_site_packages_path(prefix: Path, uid: int) -> Path:
    try:
        variables = dict(sysconfig.get_config_vars())
        version_short = f"{sys.version_info.major}.{sys.version_info.minor}"
        variables.update(
            {
                "base": str(prefix),
                "platbase": str(prefix),
                "installed_base": str(prefix),
                "installed_platbase": str(prefix),
                "prefix": str(prefix),
                "exec_prefix": str(prefix),
                "py_version_short": version_short,
                "platlibdir": getattr(sys, "platlibdir", "lib"),
            }
        )
        raw_path = Path(sysconfig.get_path("purelib", vars=variables))
        if not raw_path.is_absolute():
            raise RunnerError("native_site_packages_unverified")
        site_packages = raw_path.resolve(strict=True)
        if Path(os.path.abspath(raw_path)) != site_packages:
            raise RunnerError("native_site_packages_unverified")
        site_packages.relative_to(prefix)
        cursor = prefix
        _owned_directory(cursor, uid, "native_site_packages_unverified")
        for part in site_packages.relative_to(prefix).parts:
            cursor = cursor / part
            _owned_directory(cursor, uid, "native_site_packages_unverified")
        if any(
            Path(value).resolve(strict=False) == site_packages
            for value in sys.path
            if isinstance(value, str) and Path(value).is_absolute()
        ):
            raise RunnerError("native_site_packages_unverified")
        return site_packages
    except RunnerError:
        raise
    except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
        raise RunnerError("native_site_packages_unverified") from None


def _preflight_native_site_packages(
    prefix: Path,
    site_packages: Path,
    uid: int,
) -> dict[str, tuple[str, int]]:
    inventory: dict[str, tuple[str, int]] = {}
    total_bytes = 0
    for path in [site_packages, *sorted(site_packages.rglob("*"))]:
        if path.is_symlink():
            raise RunnerError("native_site_packages_unverified")
        try:
            info = path.stat(follow_symlinks=False)
        except (OSError, RuntimeError, ValueError):
            raise RunnerError("native_site_packages_unverified") from None
        if stat.S_ISDIR(info.st_mode):
            _owned_directory(path, uid, "native_site_packages_unverified")
            continue
        if not stat.S_ISREG(info.st_mode):
            raise RunnerError("native_site_packages_unverified")
        relative = path.resolve(strict=True).relative_to(prefix).as_posix()
        if relative in inventory or len(inventory) >= NATIVE_RUNTIME_TOTAL_FILES_MAX:
            raise RunnerError("native_dependencies_oversized")
        digest, size = _owned_file_digest(
            path,
            uid,
            min(
                NATIVE_RUNTIME_FILE_MAX_BYTES,
                NATIVE_RUNTIME_TOTAL_BYTES_MAX - total_bytes,
            ),
            "native_site_packages_unverified",
        )
        inventory[relative] = (digest, size)
        total_bytes += size
        if total_bytes > NATIVE_RUNTIME_TOTAL_BYTES_MAX:
            raise RunnerError("native_dependencies_oversized")
    return inventory


def _native_distributions(site_packages: Path) -> list[Any]:
    try:
        distributions = list(
            importlib.metadata.distributions(path=[str(site_packages)])
        )
    except (ImportError, OSError, ValueError):
        raise RunnerError("native_dependencies_unverified") from None
    if not distributions:
        raise RunnerError("native_dependencies_unverified")
    return distributions


def _installed_dependency_fingerprints(
    prefix: Path,
    site_packages: Path,
    locked: dict[str, tuple[str, str]],
    uid: int,
    distributions: list[Any],
    inventory: dict[str, tuple[str, int]],
) -> tuple[list[dict[str, Any]], str, set[str]]:
    rows: list[dict[str, Any]] = []
    installed_names: set[str] = set()
    seen_files: set[str] = set()
    total_files = 0
    total_bytes = 0
    site_root = site_packages.relative_to(prefix).as_posix()
    for distribution in distributions:
        name = distribution.metadata.get("Name")
        version = distribution.version
        if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
            raise RunnerError("native_dependencies_unverified")
        normalized_name = _normalize_distribution_name(name)
        if normalized_name in installed_names:
            raise RunnerError("native_dependencies_unverified")
        installed_names.add(normalized_name)
        try:
            raw_distribution_root = Path(distribution.locate_file(""))
            distribution_root = raw_distribution_root.resolve(strict=True)
            if Path(os.path.abspath(raw_distribution_root)) != distribution_root:
                raise RunnerError("native_dependencies_unverified")
            distribution_root.relative_to(prefix)
        except (AttributeError, OSError, ValueError):
            raise RunnerError("native_dependencies_unverified") from None
        files = distribution.files
        if not files:
            raise RunnerError("native_dependencies_unverified")
        file_rows: list[tuple[str, str, int]] = []
        for file in files:
            if total_files >= NATIVE_RUNTIME_TOTAL_FILES_MAX:
                raise RunnerError("native_dependencies_oversized")
            try:
                path = Path(distribution.locate_file(file))
                if path.is_symlink():
                    raise RunnerError("native_dependencies_unverified")
                resolved = path.resolve(strict=True)
                if Path(os.path.abspath(path)) != resolved:
                    raise RunnerError("native_dependencies_unverified")
                relative = resolved.relative_to(prefix).as_posix()
                if relative in seen_files:
                    raise RunnerError("native_dependencies_unverified")
                if not relative.startswith(site_root + "/") and not (
                    relative.startswith("bin/") or relative.startswith("Scripts/")
                ):
                    raise RunnerError("native_dependencies_unverified")
                cursor = prefix
                for part in Path(relative).parts[:-1]:
                    cursor = cursor / part
                    _owned_directory(cursor, uid, "native_dependencies_unverified")
                if cursor == prefix:
                    _owned_directory(cursor, uid, "native_dependencies_unverified")
                if relative in inventory:
                    digest, size = inventory[relative]
                else:
                    digest, size = _owned_file_digest(
                        resolved,
                        uid,
                        min(
                            NATIVE_RUNTIME_FILE_MAX_BYTES,
                            NATIVE_RUNTIME_TOTAL_BYTES_MAX - total_bytes,
                        ),
                        "native_dependencies_unverified",
                    )
            except RunnerError:
                raise
            except (OSError, ValueError, TypeError):
                raise RunnerError("native_dependencies_unverified") from None
            seen_files.add(relative)
            total_files += 1
            total_bytes += size
            if total_bytes > NATIVE_RUNTIME_TOTAL_BYTES_MAX:
                raise RunnerError("native_dependencies_oversized")
            file_rows.append((relative, digest, size))
        file_rows.sort()
        content = json.dumps(
            file_rows,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        rows.append(
            {
                "name": name,
                "normalizedName": normalized_name,
                "version": version,
                "files": len(file_rows),
                "bytes": sum(row[2] for row in file_rows),
                "outsideSitePackagesFiles": sum(
                    1
                    for path, _digest, _size in file_rows
                    if not path.startswith(site_root + "/")
                ),
                "contentSha256": hashlib.sha256(content).hexdigest(),
            }
        )
    for normalized_name, (locked_name, locked_version) in locked.items():
        matching = next(
            (row for row in rows if row["normalizedName"] == normalized_name),
            None,
        )
        if matching is None or matching["version"] != locked_version:
            raise RunnerError("native_dependency_version_mismatch")
    rows.sort(key=lambda row: row["normalizedName"])
    encoded_rows = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return rows, hashlib.sha256(encoded_rows).hexdigest(), seen_files


def _validate_site_packages_inventory(
    prefix: Path,
    site_packages: Path,
    distribution_files: set[str],
    inventory: dict[str, tuple[str, int]],
) -> tuple[list[str], dict[str, Any]]:
    bytecode_rows: list[tuple[str, str, int]] = []
    bytecode_bytes = 0
    site_packages_rel = site_packages.relative_to(prefix).as_posix()
    for relative, (digest, size) in inventory.items():
        path = Path(relative)
        if "__pycache__" in path.parts:
            if len(bytecode_rows) >= NATIVE_RUNTIME_TOTAL_FILES_MAX:
                raise RunnerError("native_dependencies_oversized")
            bytecode_rows.append((relative, digest, size))
            bytecode_bytes += size
            continue
        if relative not in distribution_files:
            raise RunnerError("native_site_packages_unverified")
    site_distribution_files = {
        relative
        for relative in distribution_files
        if relative.startswith(site_packages_rel + "/")
    }
    site_inventory_files = {
        relative
        for relative in inventory
        if "__pycache__" not in Path(relative).parts
    }
    if site_distribution_files != site_inventory_files:
        raise RunnerError("native_site_packages_unverified")
    inventory_roots = [str(site_packages)]
    bytecode_rows.sort()
    bytecode_bytes_encoded = json.dumps(
        bytecode_rows,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return inventory_roots, {
        "root": site_packages_rel,
        "files": len(bytecode_rows),
        "bytes": bytecode_bytes,
        "contentSha256": hashlib.sha256(bytecode_bytes_encoded).hexdigest(),
    }


def _observe_native_runtime(source_lock_arg: str) -> dict[str, Any]:
    _lock, dependency, _old_runtime_proof, source_lock_digest = _load_source_lock(
        source_lock_arg
    )
    dependency_path = ROOT / dependency["path"]
    dependency_bytes = _bounded_regular_file(
        dependency_path,
        DEPENDENCY_LOCK_MAX_BYTES,
        "dependency_lock_unverified",
    )
    dependency_digest = hashlib.sha256(dependency_bytes).hexdigest()
    if dependency_digest != dependency["sha256"]:
        raise RunnerError("dependency_lock_mismatch")
    locked_dependencies = _locked_dependency_versions(dependency_bytes)
    interpreter = _verify_native_interpreter()
    prefix = Path(interpreter["venvRoot"])
    site_packages_root = _native_site_packages_path(prefix, interpreter["uid"])
    site_inventory = _preflight_native_site_packages(
        prefix,
        site_packages_root,
        interpreter["uid"],
    )
    distributions = _native_distributions(site_packages_root)
    installed, installed_fingerprint, distribution_files = _installed_dependency_fingerprints(
        prefix,
        site_packages_root,
        locked_dependencies,
        interpreter["uid"],
        distributions,
        site_inventory,
    )
    site_packages, site_packages_bytecode = _validate_site_packages_inventory(
        prefix,
        site_packages_root,
        distribution_files,
        site_inventory,
    )
    installed_fingerprint = hashlib.sha256(
        json.dumps(
            {
                "distributionContentSha256": installed_fingerprint,
                "sitePackagesBytecode": site_packages_bytecode,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    try:
        spec = importlib.machinery.PathFinder.find_spec(
            "skillopt",
            [str(site_packages_root)],
        )
        distribution = next(
            item
            for item in distributions
            if _normalize_distribution_name(item.metadata.get("Name", ""))
            == "skillopt"
        )
        if (
            spec is None
            or not isinstance(spec.origin, str)
            or not spec.submodule_search_locations
            or len(spec.submodule_search_locations) != 1
            or distribution.version != EXPECTED_SOURCE["upstream"]["version"]
        ):
            raise RunnerError("native_upstream_unverified")
        package_root = Path(next(iter(spec.submodule_search_locations)))
        spec_origin = Path(spec.origin)
        if package_root.is_symlink() or spec_origin.is_symlink():
            raise RunnerError("native_upstream_unverified")
        package_root = package_root.resolve(strict=True)
        spec_origin = spec_origin.resolve(strict=True)
        package_root.relative_to(prefix)
        spec_origin.relative_to(package_root)
        Path(distribution.locate_file("")).resolve(strict=True).relative_to(prefix)
    except RunnerError:
        raise
    except (ImportError, OSError, StopIteration, ValueError):
        raise RunnerError("native_upstream_unverified") from None

    import_digest, import_count, import_bytes = _manifest_digest(package_root)
    expected_manifest = EXPECTED_SOURCE["importManifest"]
    if (
        import_digest != expected_manifest["sha256"]
        or import_count != expected_manifest["files"]
        or import_bytes != expected_manifest["bytes"]
    ):
        raise RunnerError("import_tree_mismatch")
    license_digest = _installed_license_sha256(distribution)
    if license_digest != EXPECTED_SOURCE["license"]["sha256"]:
        raise RunnerError("source_license_mismatch")
    package_entries = [
        file
        for file in distribution.files or ()
        if str(file).replace("\\", "/") == "skillopt/__init__.py"
    ]
    try:
        if (
            len(package_entries) != 1
            or Path(distribution.locate_file(package_entries[0])).resolve(strict=True)
            != spec_origin
        ):
            raise RunnerError("native_upstream_unverified")
    except (OSError, ValueError):
        raise RunnerError("native_upstream_unverified") from None
    _assert_source_lock_digest(source_lock_digest)
    return {
        "schema": NATIVE_RUNTIME_PROOF_SCHEMA,
        "claim": NATIVE_RUNTIME_PROOF_CLAIM,
        "sourceLockSha256": source_lock_digest,
        "dependencyLockSha256": dependency_digest,
        "upstreamCommit": EXPECTED_SOURCE["upstream"]["commit"],
        "upstreamVersion": EXPECTED_SOURCE["upstream"]["version"],
        "importManifestSha256": import_digest,
        "importManifestFiles": import_count,
        "importManifestBytes": import_bytes,
        "licenseSha256": license_digest,
        "interpreter": interpreter,
        "lockedDependencies": [
            {"name": name, "version": version}
            for _normalized, (name, version) in sorted(locked_dependencies.items())
        ],
        "installedDistributions": installed,
        "installedDependencyFingerprintSha256": installed_fingerprint,
        "sitePackages": {
            "roots": site_packages,
            "bytecode": site_packages_bytecode,
        },
        "startupSecurity": {
            "isolated": interpreter["isolated"],
            "noSite": interpreter["noSite"],
            "dontWriteBytecode": interpreter["dontWriteBytecode"],
            "sitePackageSearchPathAdded": False,
            "pthProcessed": False,
            "sitecustomizeLoaded": "sitecustomize" in sys.modules,
        },
        "wheelOriginStatus": "unobserved",
    }


def attest_native_runtime(source_lock_arg: str) -> dict[str, Any]:
    """Describe only the actual local runtime observed by this isolated process."""
    attestation = _observe_native_runtime(source_lock_arg)
    encoded = json.dumps(
        attestation,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    if len(encoded) > NATIVE_RUNTIME_PROOF_MAX_BYTES:
        raise RunnerError("native_runtime_proof_oversized")
    return attestation


def _read_native_runtime_attestation(
    proof_path_arg: str,
    expected_sha256: str,
) -> tuple[dict[str, Any], str]:
    if not _is_sha256(expected_sha256):
        raise RunnerError("native_runtime_proof_hash_invalid")
    proof_path = Path(proof_path_arg)
    if not proof_path.is_absolute() or str(proof_path) != os.path.normpath(proof_path_arg):
        raise RunnerError("native_runtime_proof_path_invalid")
    try:
        resolved_path = proof_path.resolve(strict=True)
        if str(resolved_path) != proof_path_arg:
            raise RunnerError("native_runtime_proof_path_invalid")
        if not hasattr(os, "getuid"):
            raise RunnerError("native_runtime_unsupported_platform")
        uid = os.getuid()
        if uid == 0:
            raise RunnerError("native_runtime_unsupported_platform")
        parent = proof_path.parent
        parent_info = _owned_directory(parent, uid, "native_runtime_proof_unverified")
        if parent_info.st_mode & 0o077:
            raise RunnerError("native_runtime_proof_unverified")
        fd = os.open(
            proof_path,
            os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | os.O_NOFOLLOW,
        )
    except RunnerError:
        raise
    except OSError:
        raise RunnerError("native_runtime_proof_unverified") from None
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != uid
            or before.st_nlink != 1
            or before.st_mode & 0o077
            or before.st_mode & 0o111
            or not before.st_mode & 0o400
            or before.st_size > NATIVE_RUNTIME_PROOF_MAX_BYTES
        ):
            raise RunnerError("native_runtime_proof_unverified")
        chunks: list[bytes] = []
        remaining = NATIVE_RUNTIME_PROOF_MAX_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(fd)
        named = os.stat(proof_path, follow_symlinks=False)
        parent_after = os.stat(parent, follow_symlinks=False)
        if (
            len(raw) > NATIVE_RUNTIME_PROOF_MAX_BYTES
            or len(raw) != before.st_size
            or any(
                getattr(before, field) != getattr(after, field)
                for field in ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
            )
            or any(
                getattr(after, field) != getattr(named, field)
                for field in ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
            )
            or any(
                getattr(parent_info, field) != getattr(parent_after, field)
                for field in ("st_dev", "st_ino", "st_mode", "st_uid")
            )
        ):
            raise RunnerError("native_runtime_proof_unverified")
    except RunnerError:
        raise
    except OSError:
        raise RunnerError("native_runtime_proof_unverified") from None
    finally:
        os.close(fd)

    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected_sha256:
        raise RunnerError("native_runtime_proof_hash_mismatch")
    proof = _decode_json(raw, "native_runtime_proof_invalid")
    if not isinstance(proof, dict) or proof.get("schema") != NATIVE_RUNTIME_PROOF_SCHEMA:
        raise RunnerError("native_runtime_proof_invalid")
    if (
        proof.get("claim") != NATIVE_RUNTIME_PROOF_CLAIM
        or proof.get("wheelOriginStatus") != "unobserved"
        or "verified" in proof
        or "runtimeProofSha256" in proof
    ):
        raise RunnerError("native_runtime_proof_invalid")
    canonical = json.dumps(
        proof,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    if raw != canonical:
        raise RunnerError("native_runtime_proof_invalid")
    return proof, digest


def _verified_native_runtime_attestation(
    source_lock_arg: str,
    proof_path_arg: str,
    expected_sha256: str,
) -> tuple[dict[str, Any], str]:
    proof, digest = _read_native_runtime_attestation(proof_path_arg, expected_sha256)
    actual = _observe_native_runtime(source_lock_arg)
    if proof != actual:
        raise RunnerError("native_runtime_proof_mismatch")
    return actual, digest


def verify_native_runtime(
    source_lock_arg: str,
    proof_path_arg: str,
    expected_sha256: str,
) -> dict[str, Any]:
    actual, digest = _verified_native_runtime_attestation(
        source_lock_arg,
        proof_path_arg,
        expected_sha256,
    )
    return {
        "schema": "skillopt.native-runtime-verification.v1",
        "ok": True,
        "claim": "verified_against_observed_local_runtime_pin",
        "nativeRuntimeProofSha256": digest,
        "sourceLockSha256": actual["sourceLockSha256"],
        "dependencyLockSha256": actual["dependencyLockSha256"],
        "upstreamCommit": actual["upstreamCommit"],
        "upstreamVersion": actual["upstreamVersion"],
        "importManifestSha256": actual["importManifestSha256"],
        "licenseSha256": actual["licenseSha256"],
        "installedDependencyFingerprintSha256": actual[
            "installedDependencyFingerprintSha256"
        ],
        "pythonVersion": actual["interpreter"]["version"],
        "pythonSha256": actual["interpreter"]["sha256"],
        "platform": actual["interpreter"]["platform"],
        "wheelOriginStatus": actual["wheelOriginStatus"],
    }


def verify_native_acceptance(
    source_lock_arg: str,
    proof_path_arg: str,
    expected_sha256: str,
) -> dict[str, Any]:
    """Classify only the existing native runtime verifier's successful result."""
    verification = verify_native_runtime(
        source_lock_arg,
        proof_path_arg,
        expected_sha256,
    )
    receipt = {
        "schema": "skillopt.native-runtime-acceptance.v1",
        "nativeRuntime": {
            "status": "verified",
            # This is the verifier's bounded summary, not the input proof document.
            "verification": verification,
        },
        "legacyRuntime": {"status": "not_run", "verified": False},
        "containment": {"status": "not_evaluated"},
        "modelQualification": {"status": "not_evaluated"},
        "release": {"authorized": False},
        "production": {"authorized": False},
    }
    encoded = json.dumps(receipt, separators=(",", ":")).encode("utf-8")
    if len(encoded) + 1 > NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES:
        raise RunnerError("native_runtime_acceptance_receipt_oversized")
    return receipt


def _activate_verified_native_site_packages(proof: dict[str, Any]) -> None:
    if (
        sys.flags.isolated != 1
        or sys.flags.no_user_site != 1
        or sys.flags.ignore_environment != 1
        or sys.flags.no_site != 1
        or sys.flags.dont_write_bytecode != 1
        or not sys.dont_write_bytecode
    ):
        raise RunnerError("native_interpreter_unverified")
    interpreter = proof.get("interpreter")
    site_packages = proof.get("sitePackages")
    roots = site_packages.get("roots") if isinstance(site_packages, dict) else None
    if (
        not isinstance(interpreter, dict)
        or not isinstance(interpreter.get("venvRoot"), str)
        or not isinstance(roots, list)
        or len(roots) != 1
        or not isinstance(roots[0], str)
    ):
        raise RunnerError("native_runtime_proof_invalid")
    expected = _native_site_packages_path(
        Path(interpreter["venvRoot"]),
        os.getuid(),
    )
    if str(expected) != roots[0]:
        raise RunnerError("native_runtime_proof_mismatch")
    if any(
        isinstance(entry, str) and Path(entry).resolve(strict=False) == expected
        for entry in sys.path
    ):
        raise RunnerError("native_site_packages_unverified")
    sys.path.append(str(expected))


def _prepare_native_import_cache(output_root: Path) -> Path:
    if (
        sys.flags.isolated != 1
        or sys.flags.no_user_site != 1
        or sys.flags.ignore_environment != 1
        or sys.flags.no_site != 1
        or sys.flags.dont_write_bytecode != 1
        or not sys.dont_write_bytecode
        or sys.pycache_prefix is not None
        or not hasattr(os, "getuid")
    ):
        raise RunnerError("native_interpreter_unverified")
    uid = os.getuid()
    _owned_directory(output_root, uid, "native_pycache_unverified")
    try:
        cache_root = Path(
            tempfile.mkdtemp(prefix="native-pycache-", dir=str(output_root))
        )
        cache_info = _owned_directory(cache_root, uid, "native_pycache_unverified")
        if stat.S_IMODE(cache_info.st_mode) & 0o077 or any(cache_root.iterdir()):
            raise RunnerError("native_pycache_unverified")
        sys.pycache_prefix = str(cache_root)
        if sys.pycache_prefix != str(cache_root):
            raise RunnerError("native_pycache_unverified")
        return cache_root
    except RunnerError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise RunnerError("native_pycache_unverified") from None


def _validate_meter_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in LOOPBACK_HOSTS
            or parsed.port is None
            or not 1 <= parsed.port <= 65535
            or parsed.path != "/v1"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise RunnerError("local_backend_required")
        host = "[::1]" if parsed.hostname == "::1" else parsed.hostname
        return f"http://{host}:{parsed.port}/v1"
    except RunnerError:
        raise
    except ValueError:
        raise RunnerError("local_backend_required") from None


def _validate_model_name(value: str) -> str:
    if not isinstance(value, str) or MODEL_RE.fullmatch(value) is None:
        raise RunnerError("model_name_invalid")
    return value


def _validate_case_id(value: Any) -> str:
    if not isinstance(value, str) or CASE_ID_RE.fullmatch(value) is None:
        raise RunnerError("protocol_invalid")
    return value


def _manifest_case_rows(value: Any, split: str, count: int) -> tuple[Case, ...]:
    if not isinstance(value, list) or len(value) != count:
        raise RunnerError("protocol_invalid")
    cases: list[Case] = []
    for row in value:
        case = _require_object(row, {"caseId", "replicate"}, "protocol_invalid")
        case_id = _validate_case_id(case["caseId"])
        replicate = case["replicate"]
        if type(replicate) is not int or replicate not in {0, 1, 2}:
            raise RunnerError("protocol_invalid")
        cases.append(Case(case_id=case_id, replicate=replicate, split=split))
    return tuple(cases)


def validate_manifest(raw: Any, raw_bytes: bytes, source_lock_sha256: str) -> RunManifest:
    manifest = _require_object(
        raw,
        {
            "schema",
            "runId",
            "mode",
            "originalSkillSha256",
            "sourceLockSha256",
            "train",
            "selection",
        },
        "protocol_invalid",
    )
    if manifest.get("schema") != "skillopt.adapter-manifest.v1":
        raise RunnerError("protocol_invalid")
    run_id = manifest.get("runId")
    if not isinstance(run_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,96}", run_id) is None:
        raise RunnerError("protocol_invalid")
    mode = manifest.get("mode")
    if not isinstance(mode, str) or mode not in {"development", "experiment"}:
        raise RunnerError("protocol_invalid")
    original_skill_sha256 = manifest.get("originalSkillSha256")
    manifest_source_lock_sha256 = manifest.get("sourceLockSha256")
    if (
        not _is_sha256(original_skill_sha256)
        or not _is_sha256(manifest_source_lock_sha256)
        or manifest_source_lock_sha256 != source_lock_sha256
    ):
        raise RunnerError("protocol_invalid")

    train_count, selection_count = (1, 1) if mode == "development" else (24, 48)
    train = _manifest_case_rows(manifest["train"], "train", train_count)
    selection = _manifest_case_rows(manifest["selection"], "selection", selection_count)

    train_ids = [case.case_id for case in train]
    selection_ids = {case.case_id for case in selection}
    expected_train_count = 1 if mode == "development" else 24
    expected_selection_ids = 1 if mode == "development" else 16
    if (
        len(set(train_ids)) != expected_train_count
        or len(selection_ids) != expected_selection_ids
        or set(train_ids) & selection_ids
    ):
        raise RunnerError("protocol_invalid")
    if any(case.replicate != 0 for case in train):
        raise RunnerError("protocol_invalid")
    selection_replicates: dict[str, set[int]] = {case_id: set() for case_id in selection_ids}
    for case in selection:
        if case.replicate in selection_replicates[case.case_id]:
            raise RunnerError("protocol_invalid")
        selection_replicates[case.case_id].add(case.replicate)
    required_replicates = {0} if mode == "development" else {0, 1, 2}
    if any(replicates != required_replicates for replicates in selection_replicates.values()):
        raise RunnerError("protocol_invalid")

    return RunManifest(
        run_id=run_id,
        mode=mode,
        source_lock_sha256=manifest_source_lock_sha256,
        original_skill_sha256=original_skill_sha256,
        train=train,
        selection=selection,
        sha256=hashlib.sha256(raw_bytes).hexdigest(),
    )


def load_manifest(manifest_arg: str, source_lock_sha256: str) -> RunManifest:
    manifest_path = Path(manifest_arg)
    if (
        not manifest_path.is_absolute()
        or manifest_path.name != MANIFEST_RELATIVE_NAME
        or manifest_path.is_symlink()
        or manifest_path.parent.is_symlink()
        or not manifest_path.parent.is_dir()
    ):
        raise RunnerError("protocol_invalid")
    raw = _bounded_regular_file(manifest_path, MANIFEST_MAX_BYTES, "protocol_invalid")
    return validate_manifest(_decode_json(raw, "protocol_invalid"), raw, source_lock_sha256)


def _validate_conversation(value: Any) -> tuple[list[dict[str, str]], int]:
    if not isinstance(value, list) or not value or len(value) > MAX_MESSAGES:
        raise RunnerError("response_invalid")
    normalized: list[dict[str, str]] = []
    roles: set[str] = set()
    assistant_count = 0
    for row in value:
        message = _require_object(row, {"role", "content"}, "response_invalid")
        role = message["role"]
        content = message["content"]
        if (
            not isinstance(role, str)
            or role not in {"system", "user", "assistant", "tool"}
            or not isinstance(content, str)
        ):
            raise RunnerError("response_invalid")
        try:
            content_size = len(content.encode("utf-8", errors="strict"))
        except UnicodeEncodeError:
            raise RunnerError("response_invalid") from None
        if content_size > MAX_MESSAGE_BYTES:
            raise RunnerError("response_oversized")
        roles.add(role)
        assistant_count += role == "assistant"
        normalized.append({"role": role, "content": content})
    try:
        serialized_size = len(
            json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8", errors="strict")
        )
    except (UnicodeEncodeError, TypeError):
        raise RunnerError("response_invalid") from None
    if serialized_size > MAX_CONVERSATION_BYTES:
        raise RunnerError("response_oversized")
    if not {"user", "assistant"}.issubset(roles):
        raise RunnerError("response_invalid")
    return normalized, assistant_count


@dataclass(frozen=True)
class RolloutResult:
    hard: int
    conversation: list[dict[str, str]]
    assistant_count: int


class JsonlChannel:
    """Serialize one bounded JSONL request/reply at a time on shared stdio."""

    def __init__(self, reader: BinaryIO, writer: BinaryIO) -> None:
        self.reader = reader
        self.writer = writer
        self.lock = threading.Lock()
        self.failed_code: str | None = None

    def _read_frame(self, max_bytes: int) -> bytes:
        frame = bytearray()
        while len(frame) <= max_bytes:
            try:
                chunk = self.reader.readline(max_bytes - len(frame) + 1)
            except (OSError, ValueError):
                raise RunnerError("pipe_read_failed") from None
            if not isinstance(chunk, bytes):
                raise RunnerError("pipe_read_failed")
            if not chunk:
                raise RunnerError("pipe_eof" if not frame else "response_invalid")
            newline = chunk.find(b"\n")
            if newline >= 0 and newline != len(chunk) - 1:
                raise RunnerError("response_invalid")
            frame.extend(chunk)
            if len(frame) > max_bytes:
                raise RunnerError("response_oversized")
            if newline >= 0:
                if frame.endswith(b"\r\n"):
                    raise RunnerError("response_invalid")
                return bytes(frame[:-1])
        raise RunnerError("response_oversized")

    @staticmethod
    def encode_request(
        request: dict[str, Any],
        request_limit: int,
        request_error_code: str = "request_invalid",
        oversized_request_error_code: str = "request_oversized",
    ) -> bytes:
        try:
            encoded = json.dumps(
                request, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8", errors="strict") + b"\n"
        except (TypeError, ValueError, UnicodeEncodeError):
            raise RunnerError(request_error_code) from None
        if len(encoded) > request_limit:
            raise RunnerError(oversized_request_error_code)
        return encoded

    def exchange(
        self,
        request: dict[str, Any],
        request_limit: int,
        response_limit: int,
        validate_response: Callable[[bytes], Any],
        request_error_code: str = "request_invalid",
        oversized_request_error_code: str = "request_oversized",
    ) -> Any:
        encoded = self.encode_request(
            request,
            request_limit,
            request_error_code,
            oversized_request_error_code,
        )
        return self.exchange_encoded(encoded, response_limit, validate_response)

    def exchange_encoded(
        self,
        encoded: bytes,
        response_limit: int,
        validate_response: Callable[[bytes], Any],
    ) -> Any:
        if not isinstance(encoded, bytes) or not encoded.endswith(b"\n"):
            raise RunnerError("request_invalid")
        with self.lock:
            if self.failed_code is not None:
                raise RunnerError(self.failed_code)
            try:
                remaining = memoryview(encoded)
                while remaining:
                    written = self.writer.write(remaining)
                    if (
                        type(written) is not int
                        or written <= 0
                        or written > len(remaining)
                    ):
                        raise RunnerError("pipe_write_failed")
                    remaining = remaining[written:]
                self.writer.flush()
            except RunnerError as error:
                self.failed_code = error.code
                raise
            except (OSError, ValueError, TypeError):
                self.failed_code = "pipe_write_failed"
                raise RunnerError("pipe_write_failed") from None

            try:
                raw_response = self._read_frame(response_limit)
                return validate_response(raw_response)
            except RunnerError as error:
                self.failed_code = error.code
                raise
            except Exception:
                self.failed_code = "response_invalid"
                raise RunnerError("response_invalid") from None


class RolloutTransport:
    """One-request-at-a-time, bounded JSONL supervisor transport."""

    def __init__(
        self,
        reader: BinaryIO,
        writer: BinaryIO,
        manifest: RunManifest,
        channel: JsonlChannel | None = None,
    ) -> None:
        self.channel = channel or JsonlChannel(reader, writer)
        self.manifest = manifest
        self.sequence = 0
        self.calls: list[tuple[str, str, int, str]] = []
        self.pair_call_counts: dict[tuple[str, str, int], int] = {}
        self.state_lock = threading.Lock()
        self.allowed_cases = {
            (case.split, case.case_id, case.replicate)
            for case in (*manifest.train, *manifest.selection)
        }

    def request(self, case: Case, fragment: str) -> RolloutResult:
        if case.split not in {"train", "selection"}:
            raise RunnerError("unexpected_split")
        if (case.split, case.case_id, case.replicate) not in self.allowed_cases:
            raise RunnerError("invalid_case")
        if not isinstance(fragment, str):
            raise RunnerError("fragment_invalid")
        try:
            fragment_size = len(fragment.encode("utf-8", errors="strict"))
        except UnicodeEncodeError:
            raise RunnerError("fragment_invalid") from None
        if fragment_size > MAX_FRAGMENT_BYTES:
            raise RunnerError("fragment_oversized")
        key = (case.split, case.case_id, case.replicate)
        with self.state_lock:
            count = self.pair_call_counts.get(key, 0) + 1
            max_calls = 1 if case.split == "train" else 2
            if count > max_calls or self.sequence >= min(
                MAX_ROLLOUT_REQUESTS, self.manifest.max_rollout_requests
            ):
                raise RunnerError("rollout_budget_exhausted")
            self.sequence += 1
            self.pair_call_counts[key] = count
            request_id = f"{self.manifest.run_id}:{self.sequence}"
            if REQUEST_ID_RE.fullmatch(request_id) is None:
                raise RunnerError("protocol_invalid")
        request = {
            "schema": "skillopt.rollout-request.v1",
            "runId": self.manifest.run_id,
            "requestId": request_id,
            "split": case.split,
            "caseId": case.case_id,
            "replicate": case.replicate,
            "fragment": fragment,
        }

        def validate_response(raw_response: bytes) -> RolloutResult:
            response = _decode_json(raw_response, "response_invalid")
            if not isinstance(response, dict) or response.get("schema") != "skillopt.rollout-response.v1":
                raise RunnerError("response_invalid")
            if response.get("runId") != self.manifest.run_id:
                raise RunnerError("response_run_id_mismatch")
            if response.get("requestId") != request_id:
                raise RunnerError("response_id_mismatch")
            if response.get("ok") is False:
                error = _require_object(
                    response,
                    {"schema", "runId", "requestId", "ok", "errorCode"},
                    "response_invalid",
                )
                if (
                    not isinstance(error.get("errorCode"), str)
                    or error["errorCode"] not in SUPERVISOR_ERROR_CODES
                ):
                    raise RunnerError("supervisor_error_code_invalid")
                raise RunnerError(f"supervisor_{error['errorCode']}")
            response = _require_object(
                response,
                {"schema", "runId", "requestId", "ok", "result"},
                "response_invalid",
            )
            if response["ok"] is not True:
                raise RunnerError("response_invalid")
            result = _require_object(
                response["result"],
                {"id", "hard", "soft", "conversation"},
                "response_invalid",
            )
            if result["id"] != case.case_id:
                raise RunnerError("response_case_mismatch")
            hard_raw = result["hard"]
            if type(hard_raw) is not int or hard_raw not in {0, 1}:
                raise RunnerError("score_invalid")
            soft_raw = result["soft"]
            if type(soft_raw) not in {int, float} or not math.isfinite(float(soft_raw)):
                raise RunnerError("score_invalid")
            hard = int(hard_raw)
            if float(soft_raw) != float(hard):
                raise RunnerError("score_invalid")
            conversation, assistant_count = _validate_conversation(result["conversation"])
            return RolloutResult(
                hard=hard,
                conversation=conversation,
                assistant_count=assistant_count,
            )

        result = self.channel.exchange(
            request,
            PIPE_REQUEST_MAX_BYTES,
            PIPE_RESPONSE_MAX_BYTES,
            validate_response,
        )
        fragment_hash = hashlib.sha256(fragment.encode("utf-8")).hexdigest()
        with self.state_lock:
            self.calls.append((case.split, case.case_id, case.replicate, fragment_hash))
        return result


_NATIVE_EDIT_OPERATIONS = frozenset(
    {"append", "insert_after", "replace", "delete"}
)
_NATIVE_SOURCE_TYPES = frozenset({"failure", "success"})


def _native_optimizer_json_size(value: Any) -> int:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
    ).encode("utf-8", errors="strict")
    return len(encoded)


def _native_parse_optimizer_object(text: str) -> dict[str, Any]:
    fence = re.fullmatch(
        r"\s*```json[ \t]*(?:\r?\n)?(.*?)\r?\n?```[ \t]*\s*",
        text,
        re.DOTALL,
    )
    if re.match(r"\s*```", text):
        if fence is None:
            raise ValueError("invalid JSON fence")
        source = fence.group(1)
    else:
        source = text

    def parse_finite_float(raw: str) -> float:
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError("non-finite number")
        return value

    value = json.loads(
        source,
        object_pairs_hook=_json_object,
        parse_constant=_reject_json_constant,
        parse_float=parse_finite_float,
    )
    if not isinstance(value, dict):
        raise ValueError("optimizer output must be an object")
    _native_reject_upstream_fence_disagreement(text, value)
    return value


def _native_json_values_equal(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            _native_json_values_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _native_json_values_equal(a, b) for a, b in zip(left, right)
        )
    return left == right


def _native_reject_upstream_fence_disagreement(
    text: str,
    native_value: dict[str, Any],
) -> None:
    """Reject a first JSON fence that pinned ``extract_json`` would select.

    The pinned parser searches for a JSON fence before a complete bare object.
    A fence embedded in otherwise valid JSON can therefore make it return a
    different value. Native admission is intentionally stricter: preserve the
    original text, but reject that ambiguity before returning it upstream.
    """
    match = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
    if match is None:
        return
    try:
        upstream_fence_value = json.loads(match.group(1))
    except json.JSONDecodeError:
        return
    if not _native_json_values_equal(upstream_fence_value, native_value):
        raise ValueError("upstream JSON fence selects a different value")


def _native_validate_optimizer_tree(value: Any) -> None:
    nodes = 0

    def visit(item: Any, depth: int) -> None:
        nonlocal nodes
        if depth > NATIVE_OPTIMIZER_MAX_JSON_DEPTH:
            raise ValueError("optimizer JSON too deep")
        nodes += 1
        if nodes > NATIVE_OPTIMIZER_MAX_JSON_NODES:
            raise ValueError("optimizer JSON has too many nodes")
        if isinstance(item, dict):
            if len(item) > NATIVE_OPTIMIZER_MAX_CONTAINER_ITEMS:
                raise ValueError("optimizer object too large")
            for key, child in item.items():
                nodes += 1
                if nodes > NATIVE_OPTIMIZER_MAX_JSON_NODES:
                    raise ValueError("optimizer JSON has too many nodes")
                if (
                    len(key.encode("utf-8", errors="strict"))
                    > NATIVE_OPTIMIZER_MAX_STRING_BYTES
                ):
                    raise ValueError("optimizer key too large")
                visit(child, depth + 1)
        elif isinstance(item, list):
            if len(item) > NATIVE_OPTIMIZER_MAX_CONTAINER_ITEMS:
                raise ValueError("optimizer array too large")
            for child in item:
                visit(child, depth + 1)
        elif isinstance(item, str):
            if (
                len(item.encode("utf-8", errors="strict"))
                > NATIVE_OPTIMIZER_MAX_STRING_BYTES
            ):
                raise ValueError("optimizer string too large")
        elif type(item) is float and not math.isfinite(item):
            raise ValueError("non-finite number")
        elif item is None or type(item) in {bool, int, float}:
            return
        else:
            raise ValueError("unsupported optimizer JSON value")

    visit(value, 0)


def _native_validate_edit(edit: Any, max_batch_size: int) -> None:
    if not isinstance(edit, dict):
        raise ValueError("edit must be an object")
    operation = edit.get("op")
    if type(operation) is not str or operation not in _NATIVE_EDIT_OPERATIONS:
        raise ValueError("edit operation invalid")
    for name in ("content", "target"):
        if name not in edit:
            continue
        value = edit[name]
        if type(value) is not str:
            raise ValueError("edit text invalid")
        if len(value.encode("utf-8", errors="strict")) > MAX_FRAGMENT_BYTES:
            raise ValueError("edit text too large")
    if "support_count" in edit:
        value = edit["support_count"]
        if value is not None and (
            type(value) is not int or not 0 <= value <= max_batch_size
        ):
            raise ValueError("edit support count invalid")
    if "source_type" in edit:
        value = edit["source_type"]
        if value is not None and (
            type(value) is not str or value not in _NATIVE_SOURCE_TYPES
        ):
            raise ValueError("edit source type invalid")
    if "merge_level" in edit:
        value = edit["merge_level"]
        if value is not None and type(value) is not int:
            raise ValueError("edit merge level invalid")
    for name in ("update_origin", "update_target"):
        if name in edit and type(edit[name]) is not str:
            raise ValueError("edit update metadata invalid")


def _native_validate_patch_fields(patch: dict[str, Any]) -> list[Any]:
    reasoning = patch.get("reasoning")
    if "reasoning" in patch and type(reasoning) is not str:
        raise ValueError("patch reasoning invalid")
    ranking_details = patch.get("ranking_details")
    if "ranking_details" in patch and ranking_details is not None and not isinstance(
        ranking_details, dict
    ):
        raise ValueError("patch ranking details invalid")
    edits = patch.get("edits")
    if not isinstance(edits, list):
        raise ValueError("patch edits invalid")
    if len(edits) > NATIVE_OPTIMIZER_MAX_CONTAINER_ITEMS:
        raise ValueError("patch edits too large")
    return edits


def _native_analyst_support_count(
    outer: dict[str, Any],
    max_batch_size: int,
) -> int:
    try:
        batch_size = int(outer.get("batch_size", 0) or 0)
    except (OverflowError, TypeError, ValueError):
        raise ValueError("analyst batch size invalid") from None
    support_count = max(batch_size, 1)
    if support_count > max_batch_size:
        raise ValueError("analyst support count too large")
    return support_count


def _native_validate_failure_summary(
    outer: dict[str, Any],
    max_batch_size: int,
) -> None:
    if "failure_summary" not in outer:
        return
    entries = outer["failure_summary"]
    max_entries = min(max_batch_size, NATIVE_FAILURE_SUMMARY_MAX_ITEMS)
    if not isinstance(entries, list) or len(entries) > max_entries:
        raise ValueError("failure summary invalid")
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("failure summary entry invalid")
        for name in ("failure_type", "description"):
            if name in entry and type(entry[name]) is not str:
                raise ValueError("failure summary text invalid")
        try:
            count = int(entry.get("count", 0))
        except (OverflowError, TypeError, ValueError):
            raise ValueError("failure summary count invalid") from None
        if not 0 <= count <= max_batch_size:
            raise ValueError("failure summary count out of range")


def _native_candidate_growth_bound(edits: list[dict[str, Any]]) -> None:
    if len(edits) > NATIVE_ANALYST_EDIT_BUDGET:
        raise ValueError("candidate edit budget exceeded")
    maximum = sum(
        len(edit.get("content", "").encode("utf-8", errors="strict")) + 3
        for edit in edits
    )
    if maximum > NATIVE_CANDIDATE_SKILL_MAX_BYTES:
        raise ValueError("candidate skill bound exceeded")


def _native_validate_optimizer_output(
    text: str,
    stage: str,
    analyst_patches: list[dict[str, Any]],
    merged_patch: dict[str, Any] | None,
    max_batch_size: int,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    value = _native_parse_optimizer_object(text)
    _native_validate_optimizer_tree(value)

    if stage == "analyst":
        patch = value.get("patch")
        if not isinstance(patch, dict):
            raise ValueError("analyst patch invalid")
        edits = _native_validate_patch_fields(patch)
        for edit in edits[:NATIVE_ANALYST_EDIT_BUDGET]:
            _native_validate_edit(edit, max_batch_size)
        _native_validate_failure_summary(value, max_batch_size)
        support_count = _native_analyst_support_count(value, max_batch_size)

        # Reflect overwrites source_type and truncates edits before persisting.
        persisted_patch = dict(patch)
        persisted_patch["edits"] = edits[:NATIVE_ANALYST_EDIT_BUDGET]
        persisted_outer = dict(value)
        persisted_outer["patch"] = persisted_patch
        persisted_outer["source_type"] = "failure"
        if _native_optimizer_json_size(persisted_patch) > NATIVE_ANALYST_PATCH_MAX_BYTES:
            raise ValueError("analyst patch serialization too large")
        if _native_optimizer_json_size(persisted_outer) > NATIVE_ANALYST_OBJECT_MAX_BYTES:
            raise ValueError("analyst object serialization too large")

        # Trainer adds provenance and the bounded minibatch support to each
        # retained edit. Measure that exact derived patch before it can reach
        # aggregate/fallback writers.
        normalized_edits: list[dict[str, Any]] = []
        for edit in persisted_patch["edits"]:
            normalized = dict(edit)
            normalized.setdefault("source_type", "failure")
            normalized.setdefault("support_count", support_count)
            normalized_edits.append(normalized)
        normalized_patch = dict(persisted_patch)
        normalized_patch["edits"] = normalized_edits
        if (
            _native_optimizer_json_size(normalized_patch)
            > NATIVE_ANALYST_NORMALIZED_PATCH_MAX_BYTES
        ):
            raise ValueError("normalized analyst patch serialization too large")

        # The current trainer emits at most one failure and one success batch.
        # Preflight the exact concatenation fallback once both are available;
        # the per-patch bound covers the first result before the second exists.
        if analyst_patches:
            fallback_edits: list[dict[str, Any]] = []
            for prior in analyst_patches[:1]:
                fallback_edits.extend(prior.get("edits", []))
            fallback_edits.extend(normalized_edits)
            fallback_patch = {
                "reasoning": "fallback: failure first, then success",
                "edits": fallback_edits,
            }
            if (
                _native_optimizer_json_size(fallback_patch)
                > NATIVE_ANALYST_FALLBACK_PATCH_MAX_BYTES
            ):
                raise ValueError("analyst fallback serialization too large")
        return value, normalized_patch

    if stage == "merge":
        edits = _native_validate_patch_fields(value)
        for edit in edits:
            _native_validate_edit(edit, max_batch_size)
        if _native_optimizer_json_size(value) > NATIVE_MERGE_PATCH_MAX_BYTES:
            raise ValueError("merge patch serialization too large")

        # _merge_batch may add/overwrite this source-derived level on every
        # edit. Its active level starts at one; model-provided merge_level is
        # otherwise retained as the source's typed integer extension.
        projected_edits = []
        for edit in edits:
            projected = dict(edit)
            projected["merge_level"] = 1
            projected_edits.append(projected)
        projected_patch = dict(value)
        projected_patch["edits"] = projected_edits
        if (
            _native_optimizer_json_size(projected_patch)
            > NATIVE_MERGE_PROJECTED_PATCH_MAX_BYTES
        ):
            raise ValueError("projected merge patch serialization too large")
        ranked_edits = edits[:NATIVE_ANALYST_EDIT_BUDGET]
        _native_candidate_growth_bound(ranked_edits)
        ranked_fallback = {
            "reasoning": value.get("reasoning", "")
            + f" [fallback truncated {len(edits)}->{NATIVE_ANALYST_EDIT_BUDGET} edits]",
            "edits": ranked_edits,
        }
        if (
            _native_optimizer_json_size(ranked_fallback)
            > NATIVE_RANKED_PATCH_MAX_BYTES
        ):
            raise ValueError("rank fallback serialization too large")
        return value, None

    if stage == "ranking":
        indices = value.get("selected_indices")
        if not isinstance(indices, list):
            raise ValueError("ranking indices invalid")
        if len(indices) > NATIVE_OPTIMIZER_MAX_CONTAINER_ITEMS:
            raise ValueError("ranking indices too large")
        if "reasoning" in value and type(value["reasoning"]) is not str:
            raise ValueError("ranking reasoning invalid")
        if (
            _native_optimizer_json_size(value)
            > NATIVE_RANKING_OBJECT_MAX_BYTES
        ):
            raise ValueError("ranking serialization too large")

        merged_edits: list[dict[str, Any]] = []
        merged_reasoning = ""
        if merged_patch is not None:
            merged_edits = _native_validate_patch_fields(merged_patch)
            merged_reasoning = merged_patch.get("reasoning", "")
        selected: list[dict[str, Any]] = []
        seen: set[int] = set()
        for index in indices:
            if type(index) is not int:
                raise ValueError("ranking index type invalid")
            limit = (
                len(merged_edits)
                if merged_patch is not None
                else NATIVE_OPTIMIZER_MAX_CONTAINER_ITEMS
            )
            if not 0 <= index < limit:
                raise ValueError("ranking index out of range")
            if index not in seen:
                if merged_patch is not None:
                    selected.append(merged_edits[index])
                seen.add(index)
            if len(selected) >= NATIVE_ANALYST_EDIT_BUDGET:
                break

        if merged_patch is not None:
            if selected:
                ranked_patch = {
                    "reasoning": merged_reasoning
                    + f" [optimizer-ranked: selected {len(selected)}/{len(merged_edits)} edits]",
                    "edits": selected,
                    "ranking_details": value,
                }
            else:
                ranked_patch = {
                    "reasoning": merged_reasoning
                    + f" [fallback truncated {len(merged_edits)}->{NATIVE_ANALYST_EDIT_BUDGET} edits]",
                    "edits": merged_edits[:NATIVE_ANALYST_EDIT_BUDGET],
                }
            _native_candidate_growth_bound(ranked_patch["edits"])
            if (
                _native_optimizer_json_size(ranked_patch)
                > NATIVE_RANKED_PATCH_MAX_BYTES
            ):
                raise ValueError("ranked patch serialization too large")
        return value, None

    raise ValueError("optimizer stage invalid")


class NativeOptimizerClient:
    """One-use native optimizer requests on the shared supervisor JSONL pipe."""

    def __init__(
        self,
        channel: JsonlChannel,
        run_id: str,
        max_batch_size: int = NATIVE_ANALYST_BATCH_MAX,
    ) -> None:
        if (
            type(max_batch_size) is not int
            or not 1 <= max_batch_size <= NATIVE_ANALYST_BATCH_MAX
        ):
            raise RunnerError("native_optimizer_request_invalid")
        self.channel = channel
        self.run_id = run_id
        self.max_batch_size = max_batch_size
        self.lock = threading.Lock()
        self.requests = 0
        self.reported_usage_requests = 0
        self.unknown_usage_requests = 0
        self.usage_observations: list[dict[str, Any]] = []
        self.failed_code: str | None = None
        self._analyst_patches: list[dict[str, Any]] = []
        self._merged_patch: dict[str, Any] | None = None

    def fail(self, code: str) -> RunnerError:
        if self.failed_code is None:
            self.failed_code = code
        return RunnerError(self.failed_code)

    def call(
        self,
        system: str,
        user: str,
        max_completion_tokens: int = 16384,
        retries: int = 5,
        stage: str = "optimizer",
        reasoning_effort: str | None = None,
        timeout: int | None = None,
    ) -> tuple[str, dict[str, int | float] | None]:
        with self.lock:
            if self.failed_code is not None:
                raise RunnerError(self.failed_code)
            if (
                type(system) is not str
                or type(user) is not str
                or type(max_completion_tokens) is not int
                or not 1 <= max_completion_tokens <= MAX_NATIVE_COMPLETION_TOKENS
                or type(retries) is not int
                or retries < 0
                or type(stage) is not str
                or stage not in NATIVE_OPTIMIZER_STAGES
                or reasoning_effort is not None
                or timeout is not None
            ):
                raise self.fail("native_optimizer_request_invalid")
            try:
                prompt_size = len(system.encode("utf-8", errors="strict")) + len(
                    user.encode("utf-8", errors="strict")
                )
            except UnicodeEncodeError:
                raise self.fail("native_optimizer_request_invalid") from None
            if prompt_size > NATIVE_PROMPT_MAX_BYTES:
                raise self.fail("native_optimizer_request_oversized")
            if self.requests >= MAX_NATIVE_OPTIMIZER_REQUESTS:
                raise self.fail("native_request_budget_exhausted")

            request_number = self.requests + 1
            request_id = f"{self.run_id}:optimizer:{request_number}"
            if REQUEST_ID_RE.fullmatch(request_id) is None:
                raise self.fail("native_optimizer_request_invalid")
            request = {
                "schema": "skillopt.native-optimizer-request.v1",
                "runId": self.run_id,
                "requestId": request_id,
                "role": "optimizer",
                "phase": "train",
                "stage": stage,
                "maxCompletionTokens": max_completion_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }

            try:
                encoded_request = self.channel.encode_request(
                    request,
                    NATIVE_REQUEST_MAX_BYTES,
                    request_error_code="native_optimizer_request_invalid",
                    oversized_request_error_code="native_optimizer_request_oversized",
                )
            except RunnerError as error:
                self.failed_code = error.code
                raise
            self.requests = request_number
            self.unknown_usage_requests += 1

            def validate_response(
                raw_response: bytes,
            ) -> tuple[str, dict[str, int | float] | None]:
                response = _decode_json(raw_response, "native_response_invalid")
                if not isinstance(response, dict):
                    raise RunnerError("native_response_invalid")
                if response.get("schema") != "skillopt.native-optimizer-response.v1":
                    raise RunnerError("native_response_invalid")
                if response.get("runId") != self.run_id:
                    raise RunnerError("native_response_run_id_mismatch")
                if response.get("requestId") != request_id:
                    raise RunnerError("native_response_id_mismatch")
                if response.get("role") != "optimizer" or response.get("phase") != "train":
                    raise RunnerError("native_response_invalid")
                response_base = {
                    "schema",
                    "runId",
                    "requestId",
                    "role",
                    "phase",
                    "ok",
                }
                if response.get("ok") is False:
                    error = _require_object(
                        response,
                        response_base | {"errorCode"},
                        "native_response_invalid",
                    )
                    error_code = error["errorCode"]
                    if (
                        not isinstance(error_code, str)
                        or error_code not in NATIVE_OPTIMIZER_ERROR_CODES
                    ):
                        raise RunnerError("native_error_code_invalid")
                    raise RunnerError(f"native_{error_code}")
                success = _require_object(
                    response,
                    response_base | {"text", "usage"},
                    "native_response_invalid",
                )
                if success["ok"] is not True or not isinstance(success["text"], str):
                    raise RunnerError("native_response_invalid")
                try:
                    text_size = len(success["text"].encode("utf-8", errors="strict"))
                except UnicodeEncodeError:
                    raise RunnerError("native_response_invalid") from None
                if text_size > NATIVE_TEXT_MAX_BYTES:
                    raise RunnerError("native_response_oversized")

                usage = success["usage"]
                if usage is not None:
                    if (
                        not isinstance(usage, dict)
                        or not usage
                        or not set(usage).issubset(NATIVE_USAGE_FIELDS)
                    ):
                        raise RunnerError("native_usage_invalid")
                    normalized_usage: dict[str, int | float] = {}
                    for name, value in usage.items():
                        if name in NATIVE_USAGE_TOKEN_FIELDS:
                            if type(value) is not int or value < 0 or value > 1_000_000_000:
                                raise RunnerError("native_usage_invalid")
                        elif (
                            name == "reportedCostUsd"
                            and type(value) not in {int, float}
                        ):
                            raise RunnerError("native_usage_invalid")
                        elif name == "reportedCostUsd":
                            try:
                                valid_cost = math.isfinite(value) and value >= 0
                            except (OverflowError, TypeError, ValueError):
                                valid_cost = False
                            if not valid_cost:
                                raise RunnerError("native_usage_invalid")
                        normalized_usage[name] = value
                    usage = normalized_usage
                return success["text"], usage

            self.usage_observations.append(
                {"requestId": request_id, "usage": None}
            )
            try:
                text, usage = self.channel.exchange_encoded(
                    encoded_request,
                    NATIVE_RESPONSE_MAX_BYTES,
                    validate_response,
                )
            except RunnerError as error:
                self.failed_code = error.code
                raise
            try:
                parsed, normalized_analyst_patch = _native_validate_optimizer_output(
                    text,
                    stage,
                    self._analyst_patches,
                    self._merged_patch,
                    self.max_batch_size,
                )
            except (OverflowError, RecursionError, TypeError, UnicodeError, ValueError):
                raise self.fail("native_optimizer_output_shape_invalid") from None

            if stage == "analyst" and normalized_analyst_patch is not None:
                if len(self._analyst_patches) < 2:
                    self._analyst_patches.append(normalized_analyst_patch)
            elif stage == "merge":
                self._merged_patch = parsed
            if usage is None:
                return text, None
            self.usage_observations[-1]["usage"] = usage
            self.unknown_usage_requests -= 1
            self.reported_usage_requests += 1
            return text, usage

    def usage_provenance(self) -> dict[str, Any]:
        return {
            "status": (
                "reported"
                if self.requests > 0 and self.unknown_usage_requests == 0
                else "unknown"
            ),
            "reportedRequests": self.reported_usage_requests,
            "unknownRequests": self.unknown_usage_requests,
            "reportedCostSemantics": "vendor_estimate_not_billing_proof",
            "observations": self.usage_observations,
        }


def _check_chat_optimizer_signature(chat_optimizer: Any) -> None:
    expected = (
        ("system", inspect.Parameter.empty),
        ("user", inspect.Parameter.empty),
        ("max_completion_tokens", 16384),
        ("retries", 5),
        ("stage", "optimizer"),
        ("reasoning_effort", None),
        ("timeout", None),
    )
    try:
        signature = inspect.signature(chat_optimizer)
        type_hints = get_type_hints(chat_optimizer)
    except (TypeError, ValueError, NameError):
        raise RunnerError("upstream_model_signature_mismatch") from None
    parameters = tuple(signature.parameters.values())
    expected_types = (
        str,
        str,
        int,
        int,
        str,
        str | None,
        int | None,
    )
    if (
        len(parameters) != len(expected)
        or any(
            parameter.name != name
            or parameter.kind is not inspect.Parameter.POSITIONAL_OR_KEYWORD
            or parameter.default != default
            for parameter, (name, default) in zip(parameters, expected)
        )
        or tuple(type_hints.get(name) for name, _default in expected) != expected_types
        or type_hints.get("return") != tuple[str, dict]
    ):
        raise RunnerError("upstream_model_signature_mismatch")


def _assert_no_native_optimizer_consumers_loaded() -> None:
    loaded = sorted(
        module_name
        for module_name in sys.modules
        if any(
            module_name == prefix or module_name.startswith(f"{prefix}.")
            for prefix in NATIVE_OPTIMIZER_CONSUMER_PREFIXES
        )
    )
    if loaded:
        raise RunnerError("upstream_consumer_imported_early")


def _load_pinned_model_facade():
    try:
        package_spec = find_spec("skillopt")
        model_spec = find_spec("skillopt.model")
        if (
            package_spec is None
            or not package_spec.submodule_search_locations
            or len(package_spec.submodule_search_locations) != 1
            or model_spec is None
            or not model_spec.origin
            or not model_spec.submodule_search_locations
            or len(model_spec.submodule_search_locations) != 1
        ):
            raise RunnerError("upstream_model_entrypoint_unverified")
        package_root = Path(next(iter(package_spec.submodule_search_locations)))
        expected_entry = package_root / "model" / "__init__.py"
        model_package_root = Path(next(iter(model_spec.submodule_search_locations)))
        model_entry = Path(model_spec.origin)
        if (
            package_root.is_symlink()
            or model_package_root.is_symlink()
            or expected_entry.is_symlink()
            or model_entry.is_symlink()
            or model_package_root.resolve(strict=True)
            != expected_entry.parent.resolve(strict=True)
            or model_entry.resolve(strict=True) != expected_entry.resolve(strict=True)
        ):
            raise RunnerError("upstream_model_entrypoint_unverified")
        model = importlib.import_module("skillopt.model")
        if Path(model.__file__).resolve(strict=True) != expected_entry.resolve(strict=True):
            raise RunnerError("upstream_model_entrypoint_unverified")
        return model
    except RunnerError:
        raise
    except (ImportError, OSError, TypeError, ValueError):
        raise RunnerError("upstream_model_entrypoint_unverified") from None


def _install_native_optimizer_facade(
    channel: JsonlChannel,
    run_id: str,
    max_batch_size: int = NATIVE_ANALYST_BATCH_MAX,
) -> tuple[NativeOptimizerClient, Callable[..., Any]]:
    _assert_no_native_optimizer_consumers_loaded()
    model = _load_pinned_model_facade()
    _assert_no_native_optimizer_consumers_loaded()
    original = getattr(model, "chat_optimizer", None)
    if getattr(original, "__module__", None) != "skillopt.model":
        raise RunnerError("upstream_model_entrypoint_unverified")
    _check_chat_optimizer_signature(original)
    client = NativeOptimizerClient(channel, run_id, max_batch_size=max_batch_size)

    def native_chat_optimizer(
        system: str,
        user: str,
        max_completion_tokens: int = 16384,
        retries: int = 5,
        stage: str = "optimizer",
        reasoning_effort: str | None = None,
        timeout: int | None = None,
    ) -> tuple[str, dict[str, int | float] | None]:
        return client.call(
            system=system,
            user=user,
            max_completion_tokens=max_completion_tokens,
            retries=retries,
            stage=stage,
            reasoning_effort=reasoning_effort,
            timeout=timeout,
        )

    def reject_other_model_entrypoint(*_args: Any, **_kwargs: Any) -> Any:
        raise client.fail("native_model_entrypoint_rejected")

    model.chat_optimizer = native_chat_optimizer
    for entrypoint in NATIVE_REJECTED_MODEL_ENTRYPOINTS:
        if not callable(getattr(model, entrypoint, None)):
            raise RunnerError("upstream_model_entrypoint_unverified")
        setattr(model, entrypoint, reject_other_model_entrypoint)
    return client, native_chat_optimizer


def _assert_native_consumer_bindings(facade: Callable[..., Any]) -> None:
    model = sys.modules.get("skillopt.model")
    if model is None or getattr(model, "chat_optimizer", None) is not facade:
        raise RunnerError("upstream_consumer_binding_mismatch")
    rejected = {
        name: getattr(model, name, None)
        for name in NATIVE_REJECTED_MODEL_ENTRYPOINTS
    }
    for module_name, module in tuple(sys.modules.items()):
        if not any(
            module_name == prefix or module_name.startswith(f"{prefix}.")
            for prefix in NATIVE_OPTIMIZER_CONSUMER_PREFIXES
        ):
            continue
        if (
            hasattr(module, "chat_optimizer")
            and getattr(module, "chat_optimizer") is not facade
        ):
            raise RunnerError("upstream_consumer_binding_mismatch")
        for name, rejected_facade in rejected.items():
            if hasattr(module, name) and getattr(module, name) is not rejected_facade:
                raise RunnerError("upstream_consumer_binding_mismatch")


def _load_upstream_types() -> tuple[type, type, type]:
    try:
        from skillopt.datasets.base import BaseDataLoader, BatchSpec
        from skillopt.envs.base import EnvAdapter
    except ImportError:
        raise RunnerError("upstream_import_unavailable") from None
    return BaseDataLoader, BatchSpec, EnvAdapter


def make_adapter_classes(
    protocol: RunManifest,
    transport: RolloutTransport,
    output_root: Path,
    *,
    native: bool = False,
) -> tuple[type, type]:
    BaseDataLoader, BatchSpec, EnvAdapter = _load_upstream_types()

    class ProtocolDataLoader(BaseDataLoader):
        def __init__(self) -> None:
            self._train = protocol.train
            self._selection = protocol.selection

        def get_train_size(self) -> int:
            return len(self._train)

        @staticmethod
        def _payload(cases: tuple[Case, ...]) -> list[dict[str, Any]]:
            return [
                {
                    "id": case.item_id,
                    "case_id": case.case_id,
                    "replicate": case.replicate,
                    "split": case.split,
                    "task_type": "wiki-skillopt",
                }
                for case in cases
            ]

        def build_train_batch(self, batch_size: int, seed: int, **kwargs: Any):
            del kwargs
            if batch_size != len(self._train):
                raise RunnerError("train_batch_mismatch")
            return BatchSpec(
                phase="train",
                split="train",
                seed=seed,
                batch_size=len(self._train),
                payload=self._payload(self._train),
            )

        def build_eval_batch(self, env_num: int, split: str, seed: int, **kwargs: Any):
            del kwargs
            if split != "valid_seen":
                raise RunnerError("unexpected_split")
            if env_num != len(self._selection):
                raise RunnerError("selection_batch_mismatch")
            return BatchSpec(
                phase="eval",
                split="selection",
                seed=seed,
                batch_size=len(self._selection),
                payload=self._payload(self._selection),
            )

    class SupervisorEnvAdapter(EnvAdapter):
        def __init__(self) -> None:
            self.dataloader = ProtocolDataLoader()
            self.analyst_workers = 1
            self.failure_only = False
            self.minibatch_size = len(protocol.train)
            self.edit_budget = 4
            self.workers = 1
            self.reflection_patch_count = 0
            self.reflection_edit_count = 0
            self.output_root = output_root.resolve()

        def setup(self, cfg: dict) -> None:
            super().setup(cfg)
            self.dataloader.setup(cfg)

        def get_dataloader(self):
            return self.dataloader

        def build_env_from_batch(self, batch: Any, **kwargs: Any):
            del kwargs
            if batch.split not in {"train", "selection"}:
                raise RunnerError("unexpected_split")
            return list(batch.payload or [])

        def build_train_env(self, batch_size: int, seed: int, **kwargs: Any):
            batch = self.dataloader.build_train_batch(batch_size=batch_size, seed=seed, **kwargs)
            return self.build_env_from_batch(batch)

        def build_eval_env(self, env_num: int, split: str, seed: int, **kwargs: Any):
            batch = self.dataloader.build_eval_batch(env_num=env_num, split=split, seed=seed, **kwargs)
            return self.build_env_from_batch(batch)

        def rollout(self, env_manager: Any, skill_content: str, out_dir: str, **kwargs: Any) -> list[dict]:
            del kwargs
            if native:
                skill_content = _canonicalize_native_adapter_fragment(
                    skill_content,
                    invalid_code="fragment_invalid",
                    oversized_code="fragment_oversized",
                )
            else:
                if not isinstance(skill_content, str):
                    raise RunnerError("fragment_invalid")
                try:
                    if len(skill_content.encode("utf-8", errors="strict")) > MAX_FRAGMENT_BYTES:
                        raise RunnerError("fragment_oversized")
                except UnicodeEncodeError:
                    raise RunnerError("fragment_invalid") from None
            if not isinstance(env_manager, list) or not env_manager:
                raise RunnerError("rollout_batch_invalid")
            try:
                requested_dir = Path(out_dir)
                if not requested_dir.is_absolute():
                    raise RunnerError("output_path_invalid")
                rollout_dir = requested_dir.resolve(strict=False)
                rollout_dir.relative_to(self.output_root)
                if rollout_dir == self.output_root:
                    raise RunnerError("output_path_invalid")
                rollout_dir.mkdir(parents=True, exist_ok=True)
                rollout_dir = rollout_dir.resolve(strict=True)
                rollout_dir.relative_to(self.output_root)
            except (OSError, ValueError):
                raise RunnerError("output_path_invalid") from None

            rows: list[dict] = []
            for item in env_manager:
                item = _require_object(
                    item,
                    {"id", "case_id", "replicate", "split", "task_type"},
                    "rollout_batch_invalid",
                )
                case_id = _validate_case_id(item["case_id"])
                split = item["split"]
                if split not in {"train", "selection"}:
                    raise RunnerError("unexpected_split")
                replicate = item["replicate"]
                if type(replicate) is not int or replicate not in {0, 1, 2}:
                    raise RunnerError("rollout_batch_invalid")
                expected_item_id = f"{case_id}--r{replicate}"
                if item["id"] != expected_item_id:
                    raise RunnerError("rollout_batch_invalid")
                if item["task_type"] != "wiki-skillopt":
                    raise RunnerError("rollout_batch_invalid")
                case = Case(case_id=case_id, replicate=replicate, split=split)
                result = transport.request(case, skill_content)

                prediction_dir = rollout_dir / "predictions"
                case_dir = prediction_dir / expected_item_id
                try:
                    prediction_dir.mkdir(parents=True, exist_ok=True)
                    case_dir.mkdir(parents=True, exist_ok=False)
                    conversation_path = case_dir / "conversation.json"
                    conversation_path.write_text(
                        json.dumps(result.conversation, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8",
                    )
                except FileExistsError:
                    raise RunnerError("trajectory_collision") from None
                except (OSError, UnicodeError):
                    raise RunnerError("trajectory_write_failed") from None

                rows.append(
                    {
                        "id": expected_item_id,
                        "hard": result.hard,
                        "soft": float(result.hard),
                        "task_type": "wiki-skillopt",
                        "n_turns": result.assistant_count,
                        "case_id": case_id,
                        "replicate": replicate,
                    }
                )
            return rows

        def reflect(self, results: list[dict], skill_content: str, out_dir: str, **kwargs: Any):
            patches = super().reflect(results, skill_content, out_dir, **kwargs)
            if not isinstance(patches, list):
                raise RunnerError("reflection_invalid")
            patch_count = 0
            edit_count = 0
            for raw_patch in patches:
                if not isinstance(raw_patch, dict) or not isinstance(raw_patch.get("patch"), dict):
                    continue
                edits = raw_patch["patch"].get("edits")
                if isinstance(edits, list):
                    meaningful = [
                        edit
                        for edit in edits
                        if isinstance(edit, dict)
                        and any(value not in (None, "", [], {}) for value in edit.values())
                    ]
                    if meaningful:
                        patch_count += 1
                        edit_count += len(meaningful)
            if patch_count == 0 or edit_count == 0:
                raise RunnerError("reflection_empty")
            self.reflection_patch_count += patch_count
            self.reflection_edit_count += edit_count
            return patches

        def get_task_types(self) -> list[str]:
            return ["wiki-skillopt"]

    return ProtocolDataLoader, SupervisorEnvAdapter


def _clear_external_model_configuration() -> None:
    prefixes = (
        "OPENAI",
        "AZURE",
        "ANTHROPIC",
        "CLAUDE",
        "CODEX",
        "COPILOT",
        "CURSOR",
        "QWEN",
        "MINIMAX",
        "REFLACT",
        "SKILLOPT_SLEEP",
    )
    proxy_names = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
    for name in list(os.environ):
        upper = name.upper()
        if upper in proxy_names or upper.startswith(prefixes):
            os.environ.pop(name, None)


def _configure_local_backend(
    optimizer_url: str,
    target_url: str,
    optimizer_model: str,
    target_model: str,
) -> None:
    _clear_external_model_configuration()
    try:
        from skillopt.model import configure_openai_compatible
        from skillopt.model.openai_compatible_backend import OPTIMIZER_CONFIG, TARGET_CONFIG
    except ImportError:
        raise RunnerError("upstream_import_unavailable") from None
    configure_openai_compatible(
        optimizer_base_url=optimizer_url,
        optimizer_api_key=LOCAL_METER_API_KEY,
        optimizer_model=optimizer_model,
        target_base_url=target_url,
        target_api_key=LOCAL_METER_API_KEY,
        target_model=target_model,
        temperature=0.0,
        timeout_seconds=180,
        max_tokens=8192,
    )
    if (
        OPTIMIZER_CONFIG.base_url != optimizer_url
        or TARGET_CONFIG.base_url != target_url
        or OPTIMIZER_CONFIG.deployment != optimizer_model
        or TARGET_CONFIG.deployment != target_model
        or OPTIMIZER_CONFIG.api_key != LOCAL_METER_API_KEY
        or TARGET_CONFIG.api_key != LOCAL_METER_API_KEY
    ):
        raise RunnerError("local_backend_configuration_failed")


class _BoundedTextCapture:
    def __init__(self, limit: int = UPSTREAM_CAPTURE_MAX_BYTES) -> None:
        self.limit = limit
        self.data = bytearray()
        self.truncated = False

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            text = str(text)
        room = self.limit - len(self.data)
        if room <= 0:
            self.truncated = self.truncated or bool(text)
            return len(text)
        encoded = text[:room].encode("utf-8", errors="replace")
        if len(encoded) > room:
            self.truncated = True
        self.data.extend(encoded[:room])
        if len(text) > len(text[:room]):
            self.truncated = True
        return len(text)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def get_text(self) -> str:
        return bytes(self.data).decode("utf-8", errors="replace")


class _CaptureUpstreamOutput:
    """Bound and sanitize trainer output without mixing it into the JSONL pipe."""

    def __init__(self) -> None:
        self.stdout_capture = _BoundedTextCapture()
        self.stderr_capture = _BoundedTextCapture()
        self.saved_python_stdout = None
        self.saved_python_stderr = None
        self.root_logger = logging.getLogger()
        self.log_handler = _SanitizedLogCapture()

    def __enter__(self):
        try:
            self.saved_python_stdout = sys.stdout
            self.saved_python_stderr = sys.stderr
            self.saved_stdout = os.dup(1)
            self.saved_stderr = os.dup(2)
            self.null_fd = os.open(os.devnull, os.O_WRONLY)
            os.dup2(self.null_fd, 1)
            os.dup2(self.null_fd, 2)
            self.root_logger.addHandler(self.log_handler)
            sys.stdout = self.stdout_capture
            sys.stderr = self.stderr_capture
            return self
        except OSError:
            self._restore()
            raise RunnerError("stdio_capture_failed") from None

    def _restore(self) -> None:
        if self.log_handler in self.root_logger.handlers:
            self.root_logger.removeHandler(self.log_handler)
        for name, target in (("saved_stdout", 1), ("saved_stderr", 2)):
            fd = getattr(self, name, None)
            if fd is not None:
                try:
                    os.dup2(fd, target)
                except OSError:
                    pass
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, name, None)
        null_fd = getattr(self, "null_fd", None)
        if null_fd is not None:
            try:
                os.close(null_fd)
            except OSError:
                pass
            self.null_fd = None
        if self.saved_python_stdout is not None:
            sys.stdout = self.saved_python_stdout
            self.saved_python_stdout = None
        if self.saved_python_stderr is not None:
            sys.stderr = self.saved_python_stderr
            self.saved_python_stderr = None

    def diagnostics(self) -> dict[str, Any]:
        safe_events: list[dict[str, Any]] = []
        error_markers = 0
        for line in self.stdout_capture.get_text().splitlines():
            match = re.fullmatch(
                r"\s*\[([1-6])/6 done\] failure_patches=(\d+) success_patches=(\d+)\s*",
                line,
            )
            if match and len(safe_events) < 32:
                safe_events.append(
                    {
                        "event": "reflection_batch",
                        "stage": int(match.group(1)),
                        "failurePatches": int(match.group(2)),
                        "successPatches": int(match.group(3)),
                    }
                )
                continue
            match = re.fullmatch(
                r"\s*\[STEP (\d+)/(\d+) done\] epoch=(\d+) action=([a-z_]+) .*",
                line,
            )
            if match and match.group(4) in {
                "accept_new_best",
                "accept",
                "reject",
                "skip_no_patches",
                "skip_no_rewrite",
            } and len(safe_events) < 32:
                safe_events.append(
                    {
                        "event": "trainer_step",
                        "step": int(match.group(1)),
                        "steps": int(match.group(2)),
                        "epoch": int(match.group(3)),
                        "action": match.group(4),
                    }
                )
        for line in self.stderr_capture.get_text().splitlines():
            if line.startswith("Traceback (most recent call last):") or re.match(
                r"^(?:ERROR|Error:|RuntimeError:|ValueError:)", line
            ):
                error_markers += 1
        return {
            "stdoutBytesCaptured": len(self.stdout_capture.data),
            "stderrBytesCaptured": len(self.stderr_capture.data),
            "truncated": self.stdout_capture.truncated or self.stderr_capture.truncated,
            "errorMarkers": error_markers,
            "warningLogs": self.log_handler.warning_count,
            "errorLogs": self.log_handler.error_count,
            "loggers": list(self.log_handler.logger_names),
            "events": safe_events,
        }

    def __exit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback
        self._restore()


class _SanitizedLogCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.warning_count = 0
        self.error_count = 0
        self.logger_names: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno >= logging.ERROR:
            self.error_count += 1
        else:
            self.warning_count += 1
        logger_name = record.name
        if (
            isinstance(logger_name, str)
            and re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", logger_name)
            and logger_name not in self.logger_names
            and len(self.logger_names) < 16
        ):
            self.logger_names.append(logger_name)


def _stderr_event(event: str, **fields: Any) -> None:
    if not re.fullmatch(r"[a-z_]{1,48}", event):
        event = "internal_error"
    safe: list[str] = []
    for name, value in fields.items():
        if not re.fullmatch(r"[a-z_]{1,32}", name):
            continue
        if isinstance(value, bool):
            safe.append(f"{name}={'true' if value else 'false'}")
        elif isinstance(value, int) and value >= 0:
            safe.append(f"{name}={value}")
        elif isinstance(value, str) and re.fullmatch(r"[a-z_]{1,48}", value):
            safe.append(f"{name}={value}")
    suffix = (" " + " ".join(safe)) if safe else ""
    try:
        os.write(2, f"skillopt_runner event={event}{suffix}\n".encode("ascii"))
    except OSError:
        pass


def _sha256_bytes(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="strict")).hexdigest()


def _canonicalize_native_adapter_fragment(
    text: str,
    *,
    invalid_code: str,
    oversized_code: str,
) -> str:
    if not isinstance(text, str):
        raise RunnerError(invalid_code)
    try:
        raw = text.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise RunnerError(invalid_code) from None
    if len(raw) > MAX_FRAGMENT_BYTES:
        raise RunnerError(oversized_code)

    # Pinned upstream skill.append wraps the appended fragment as
    # skill.rstrip() + "\n\n" + content + "\n". Native runs start from an
    # empty skill, so remove only that exact outer wrapper. Preserve every
    # byte inside it: embedded paragraphs, controls, and secrets still reach
    # the strict supervisor boundary unchanged.
    if len(text) >= 3 and text.startswith("\n\n") and text.endswith("\n"):
        return text[2:-1]
    return text


def _assert_source_lock_digest(expected: str) -> None:
    raw = _bounded_regular_file(SOURCE_LOCK_PATH, SOURCE_LOCK_MAX_BYTES, "source_lock_invalid")
    if hashlib.sha256(raw).hexdigest() != expected:
        raise RunnerError("source_lock_drift")


def _read_trainer_history(output_root: Path) -> list[dict[str, Any]]:
    path = output_root / "history.json"
    raw = _bounded_regular_file(path, 1024 * 1024, "trainer_history_invalid")
    value = _decode_json(raw, "trainer_history_invalid")
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RunnerError("trainer_history_invalid")
    return value


def _read_skill(path: Path, *, native: bool = False) -> str:
    raw = _bounded_regular_file(path, MAX_FRAGMENT_BYTES, "candidate_invalid")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise RunnerError("candidate_invalid") from None
    if native:
        return _canonicalize_native_adapter_fragment(
            text,
            invalid_code="candidate_invalid",
            oversized_code="candidate_invalid",
        )
    return text


def _write_result(
    output_root: Path,
    result: dict[str, Any],
    *,
    native: bool = False,
) -> None:
    path = output_root / "skillopt-result.json"
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if native and len(payload) > NATIVE_RESULT_MAX_BYTES:
        raise RunnerError("native_result_oversized")
    try:
        with path.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        raise RunnerError("result_collision") from None
    except OSError:
        raise RunnerError("result_write_failed") from None


def _write_failure_result(
    output_root: Path,
    manifest: RunManifest,
    error_code: str,
    diagnostics: dict[str, Any],
    provenance: dict[str, Any] | None = None,
    *,
    native: bool = False,
) -> None:
    result = {
        "schema": "skillopt.optimizer-result.v1",
        "runId": manifest.run_id,
        "manifestSha256": manifest.sha256,
        "sourceLockSha256": manifest.source_lock_sha256,
        "originalSkillSha256": manifest.original_skill_sha256,
        "upstreamCommit": EXPECTED_SOURCE["upstream"]["commit"],
        "mode": manifest.mode,
        "status": "incomplete",
        "qualification": "not_performed",
        "errorCode": error_code,
        "upstreamDiagnostics": diagnostics,
    }
    if provenance:
        result.update(provenance)
    _write_result(output_root, result, native=native)


def _require_native_output_root_path_limit(path: Path) -> None:
    try:
        path_bytes = str(path).encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise RunnerError("native_output_root_path_invalid") from None
    if len(path_bytes) > NATIVE_OUTPUT_ROOT_PATH_MAX_BYTES:
        raise RunnerError("native_output_root_oversized")


def _require_native_default_text_encoding() -> None:
    try:
        with io.TextIOWrapper(io.BytesIO(), encoding=None) as stream:
            default_encoding = codecs.lookup(stream.encoding).name
    except Exception:
        raise RunnerError("native_output_encoding_unverified") from None
    if default_encoding != "utf-8":
        raise RunnerError("native_output_encoding_unverified")


def _prepare_output_root(manifest_dir: Path, *, native: bool = False) -> Path:
    if native:
        _require_native_default_text_encoding()
    output_root = manifest_dir / "skillopt-output"
    if native:
        _require_native_output_root_path_limit(output_root)
    if output_root.exists() or output_root.is_symlink():
        raise RunnerError("output_not_fresh")
    if native:
        try:
            _require_native_output_root_path_limit(output_root.resolve(strict=False))
        except RunnerError:
            raise
        except (OSError, RuntimeError, ValueError):
            raise RunnerError("output_path_invalid") from None
    try:
        output_root.mkdir(mode=0o700)
    except OSError:
        raise RunnerError("output_path_invalid") from None
    resolved = output_root.resolve(strict=True)
    if native:
        _require_native_output_root_path_limit(resolved)
    return resolved


def _launch_pipe_writer() -> BinaryIO:
    try:
        return os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    except (AttributeError, OSError, ValueError):
        raise RunnerError("stdio_isolation_failed") from None


def _trainer_config(
    manifest: RunManifest,
    output_root: Path,
    optimizer_model: str,
    target_model: str,
) -> dict[str, Any]:
    train_count = len(manifest.train)
    selection_count = len(manifest.selection)
    return {
        "env": "wiki-skillopt",
        "out_root": str(output_root),
        "skill_init": str(output_root / "empty-initial-skill.md"),
        "model_backend": "openai_compatible",
        "optimizer_backend": "openai_compatible",
        "target_backend": "openai_compatible",
        "optimizer_model": optimizer_model,
        "target_model": target_model,
        "reasoning_effort": None,
        "num_epochs": 1,
        "train_size": train_count,
        "batch_size": train_count,
        "accumulation": 1,
        "seed": 20261003,
        "merge_batch_size": max(2, train_count),
        "analyst_workers": 1,
        "failure_only": False,
        "minibatch_size": train_count,
        "edit_budget": 4,
        "min_edit_budget": 2,
        "lr_scheduler": "constant",
        "lr_control_mode": "fixed",
        "skill_update_mode": "patch",
        "longitudinal_pair_policy": "mixed",
        "use_slow_update": False,
        "slow_update_samples": 0,
        "slow_update_gate_with_selection": False,
        "use_meta_skill": False,
        "use_skill_aware_reflection": False,
        "skill_aware_consolidate_threshold": 0,
        "use_gate": True,
        "gate_metric": "hard",
        "gate_mixed_weight": 0.5,
        "use_semantic_density": False,
        "semantic_density_weight": 0.0,
        "leading_words": None,
        "sel_env_num": selection_count,
        "test_env_num": 0,
        "eval_test": False,
    }


def optimize(args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    return _optimize(args, native=False)


def optimize_native(args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    return _optimize(args, native=True)


def _native_optimizer_provenance(client: NativeOptimizerClient) -> dict[str, Any]:
    return {
        "optimizerBackend": "native_ipc",
        "nativeOptimizer": {
            "schema": "skillopt.native-optimizer-provenance.v1",
            "requests": client.requests,
            "usage": client.usage_provenance(),
        },
    }


def _optimize(args: argparse.Namespace, native: bool) -> tuple[str, dict[str, Any]]:
    if native:
        runtime_attestation, proof_digest = _verified_native_runtime_attestation(
            args.source_lock,
            args.runtime_proof,
            args.runtime_proof_sha256,
        )
        runtime_proof = {
            **runtime_attestation,
            "nativeRuntimeProofSha256": proof_digest,
        }
    else:
        runtime_proof = verify_runtime(args.source_lock)
    source_lock_sha256 = runtime_proof["sourceLockSha256"]
    if native:
        _activate_verified_native_site_packages(runtime_proof)
    native_client: NativeOptimizerClient | None = None
    native_facade: Callable[..., Any] | None = None
    if native:
        manifest = load_manifest(args.manifest, source_lock_sha256)
        output_root = _prepare_output_root(Path(args.manifest).parent, native=True)
        _prepare_native_import_cache(output_root)
        _clear_external_model_configuration()
        optimizer_model = "native-ipc"
        target_model = "supervisor-rollout"
        pipe_writer = _launch_pipe_writer()
        channel = JsonlChannel(sys.stdin.buffer, pipe_writer)
        transport = RolloutTransport(
            sys.stdin.buffer,
            pipe_writer,
            manifest,
            channel=channel,
        )
        try:
            native_client, native_facade = _install_native_optimizer_facade(
                channel,
                manifest.run_id,
                max_batch_size=len(manifest.train),
            )
        except Exception:
            pipe_writer.close()
            raise
    else:
        optimizer_url = _validate_meter_url(args.optimizer_base_url)
        target_url = _validate_meter_url(args.target_base_url)
        if optimizer_url == target_url:
            raise RunnerError("role_meter_collision")
        optimizer_model = _validate_model_name(args.optimizer_model)
        target_model = _validate_model_name(args.target_model)
        manifest = load_manifest(args.manifest, source_lock_sha256)
        output_root = _prepare_output_root(Path(args.manifest).parent)
        _configure_local_backend(optimizer_url, target_url, optimizer_model, target_model)

    try:
        from skillopt.engine import ReflACTTrainer
        if native and native_facade is not None:
            _assert_native_consumer_bindings(native_facade)
    except ImportError:
        if native:
            pipe_writer.close()
        raise RunnerError("upstream_import_unavailable") from None
    except Exception:
        if native:
            pipe_writer.close()
        raise

    if not native:
        pipe_writer = _launch_pipe_writer()
        transport = RolloutTransport(sys.stdin.buffer, pipe_writer, manifest)
    try:
        _loader_type, adapter_type = make_adapter_classes(
            manifest, transport, output_root, native=native
        )
        if native and native_facade is not None:
            _assert_native_consumer_bindings(native_facade)
        adapter = adapter_type()
    except Exception:
        pipe_writer.close()
        raise
    train_count = len(manifest.train)
    selection_count = len(manifest.selection)
    cfg = _trainer_config(manifest, output_root, optimizer_model, target_model)
    _assert_source_lock_digest(source_lock_sha256)

    _stderr_event("optimize_started")
    capture = _CaptureUpstreamOutput()
    try:
        with capture:
            summary = ReflACTTrainer(cfg, adapter).train()
        if native_client is not None:
            if native_client.failed_code is not None:
                raise RunnerError(native_client.failed_code)
            if native_facade is not None:
                _assert_native_consumer_bindings(native_facade)
        if not isinstance(summary, dict):
            raise RunnerError("trainer_result_invalid")

        history = _read_trainer_history(output_root)
        step = history[0]
        if step.get("step") != 1 or step.get("action") in {
            "skip_no_patches",
            "skip_no_rewrite",
        }:
            raise RunnerError("reflection_not_applied")
        for key in ("n_patches", "n_edits_merged", "n_edits_ranked"):
            value = step.get(key)
            if type(value) is not int or value <= 0:
                raise RunnerError("reflection_not_applied")
        selection_score = step.get("selection_hard")
        if (
            type(selection_score) not in {int, float}
            or not math.isfinite(float(selection_score))
            or not 0.0 <= float(selection_score) <= 1.0
        ):
            raise RunnerError("candidate_not_validated")

        candidate = _read_skill(
            output_root / "steps" / "step_0001" / "candidate_skill.md",
            native=native,
        )
        best = _read_skill(output_root / "best_skill.md", native=native)
        if not candidate:
            raise RunnerError("candidate_unchanged")
        candidate_hash = _sha256_bytes(candidate)
        candidate_selection_calls = sum(
            1
            for split, _case_id, _replicate, fragment_hash in transport.calls
            if split == "selection" and fragment_hash == candidate_hash
        )
        train_calls = sum(1 for split, *_rest in transport.calls if split == "train")
        selection_calls = sum(1 for split, *_rest in transport.calls if split == "selection")
        expected_requests = train_count + 2 * selection_count
        if (
            train_calls != train_count
            or selection_calls != 2 * selection_count
            or candidate_selection_calls != selection_count
            or transport.sequence != expected_requests
        ):
            raise RunnerError("trainer_schedule_mismatch")

        action = step.get("action")
        if action in {"accept", "accept_new_best"}:
            if _sha256_bytes(best) != candidate_hash:
                raise RunnerError("trainer_result_mismatch")
            upstream_outcome = "accepted"
        elif action == "reject":
            upstream_outcome = "no_improvement"
        else:
            raise RunnerError("trainer_action_invalid")

        mode_status = "development_only" if manifest.mode == "development" else None
        status = mode_status or (
            "optimized" if upstream_outcome == "accepted" else "no_improvement"
        )
        result = {
            "schema": "skillopt.optimizer-result.v1",
            "runId": manifest.run_id,
            "manifestSha256": manifest.sha256,
            "sourceLockSha256": manifest.source_lock_sha256,
            "originalSkillSha256": manifest.original_skill_sha256,
            "upstreamCommit": EXPECTED_SOURCE["upstream"]["commit"],
            "mode": manifest.mode,
            "status": status,
            "upstreamOutcome": upstream_outcome,
            "qualification": "not_performed",
            "candidateFragment": candidate,
            "candidateFragmentSha256": candidate_hash,
            "bestFragment": best,
            "bestFragmentSha256": _sha256_bytes(best),
            "upstreamDiagnostics": capture.diagnostics(),
            "trainer": {
                "epochs": 1,
                "steps": 1,
                "action": action,
                "reflectionPatches": adapter.reflection_patch_count,
                "reflectionEdits": adapter.reflection_edit_count,
                "mergedEdits": step["n_edits_merged"],
                "rankedEdits": step["n_edits_ranked"],
                "selectionHard": float(selection_score),
                "rolloutRequests": transport.sequence,
                "trainRollouts": train_calls,
                "selectionRollouts": selection_calls,
                "candidateSelectionRollouts": candidate_selection_calls,
            },
        }
        if native_client is not None:
            result.update(_native_optimizer_provenance(native_client))
            result["nativeRuntimeProofSha256"] = runtime_proof[
                "nativeRuntimeProofSha256"
            ]
            result["nativeRuntimeProofSchema"] = NATIVE_RUNTIME_PROOF_SCHEMA
        _assert_source_lock_digest(source_lock_sha256)
        _write_result(output_root, result, native=native)
    except RunnerError as error:
        error_code = (
            native_client.failed_code
            if native_client is not None and native_client.failed_code is not None
            else error.code
        )
        provenance = (
            {
                **_native_optimizer_provenance(native_client),
                "nativeRuntimeProofSha256": runtime_proof[
                    "nativeRuntimeProofSha256"
                ],
                "nativeRuntimeProofSchema": NATIVE_RUNTIME_PROOF_SCHEMA,
            }
            if native_client is not None
            else None
        )
        _write_failure_result(
            output_root,
            manifest,
            error_code,
            capture.diagnostics(),
            provenance,
            native=native,
        )
        if error_code != error.code:
            raise RunnerError(error_code) from None
        raise
    except Exception:
        error_code = (
            native_client.failed_code
            if native_client is not None and native_client.failed_code is not None
            else "trainer_internal_error"
        )
        provenance = (
            {
                **_native_optimizer_provenance(native_client),
                "nativeRuntimeProofSha256": runtime_proof[
                    "nativeRuntimeProofSha256"
                ],
                "nativeRuntimeProofSchema": NATIVE_RUNTIME_PROOF_SCHEMA,
            }
            if native_client is not None
            else None
        )
        _write_failure_result(
            output_root,
            manifest,
            error_code,
            capture.diagnostics(),
            provenance,
            native=native,
        )
        raise RunnerError(error_code) from None
    finally:
        pipe_writer.close()

    _stderr_event(
        "optimize_finished",
        outcome=status,
        reflection_edits=adapter.reflection_edit_count,
        candidate_validated=True,
    )
    return status, result


class _NoArgumentEchoParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        raise RunnerError("cli_invalid")


def _build_parser() -> argparse.ArgumentParser:
    parser = _NoArgumentEchoParser(prog="skillopt_runner", add_help=True)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify-runtime", add_help=True)
    verify.add_argument("--source-lock", required=True)

    attest_native = commands.add_parser("attest-native-runtime", add_help=True)
    attest_native.add_argument("--source-lock", required=True)

    verify_native = commands.add_parser("verify-native-runtime", add_help=True)
    verify_native.add_argument("--source-lock", required=True)
    verify_native.add_argument("--runtime-proof", required=True)
    verify_native.add_argument("--runtime-proof-sha256", required=True)

    verify_native_acceptance_parser = commands.add_parser(
        "verify-native-acceptance",
        add_help=True,
    )
    verify_native_acceptance_parser.add_argument("--source-lock", required=True)
    verify_native_acceptance_parser.add_argument("--runtime-proof", required=True)
    verify_native_acceptance_parser.add_argument("--runtime-proof-sha256", required=True)

    optimize_parser = commands.add_parser("optimize", add_help=True)
    optimize_parser.add_argument("--source-lock", required=True)
    optimize_parser.add_argument("--manifest", required=True)
    optimize_parser.add_argument("--optimizer-base-url", required=True)
    optimize_parser.add_argument("--target-base-url", required=True)
    optimize_parser.add_argument("--optimizer-model", required=True)
    optimize_parser.add_argument("--target-model", required=True)

    native_parser = commands.add_parser("optimize-native", add_help=True)
    native_parser.add_argument("--source-lock", required=True)
    native_parser.add_argument("--manifest", required=True)
    native_parser.add_argument("--runtime-proof", required=True)
    native_parser.add_argument("--runtime-proof-sha256", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _build_parser().parse_args(argv)
        if args.command == "verify-runtime":
            proof = verify_runtime(args.source_lock)
            sys.stdout.write(json.dumps(proof, separators=(",", ":")) + "\n")
            return 0
        if args.command == "attest-native-runtime":
            attestation = attest_native_runtime(args.source_lock)
            sys.stdout.write(
                json.dumps(attestation, ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
            return 0
        if args.command == "verify-native-runtime":
            proof = verify_native_runtime(
                args.source_lock,
                args.runtime_proof,
                args.runtime_proof_sha256,
            )
            sys.stdout.write(json.dumps(proof, separators=(",", ":")) + "\n")
            return 0
        if args.command == "verify-native-acceptance":
            receipt = verify_native_acceptance(
                args.source_lock,
                args.runtime_proof,
                args.runtime_proof_sha256,
            )
            sys.stdout.write(json.dumps(receipt, separators=(",", ":")) + "\n")
            return 0
        if args.command == "optimize-native":
            status, _result = optimize_native(args)
        else:
            status, _result = optimize(args)
        completed = status in {"optimized", "development_only"} or (
            args.command == "optimize-native" and status == "no_improvement"
        )
        return 0 if completed else 4
    except RunnerError as error:
        _stderr_event("error", error_code=error.code)
        return 2
    except KeyboardInterrupt:
        _stderr_event("error", error_code="cancelled")
        return 130
    except Exception:
        _stderr_event("error", error_code="internal_error")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
