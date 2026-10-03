#!/usr/bin/env python3
"""Pinned SkillOpt adapter for the bounded LCA supervisor pipe.

The command intentionally has no data, path, or subprocess arguments on the
model-facing pipe. The supervisor owns prompts, scoring, host execution, and
all qualification; this process supplies only train/selection rollouts to the
real pinned ReflACT trainer.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
from importlib.util import find_spec
import json
import logging
import math
import os
import re
import site
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SOURCE_LOCK_RELATIVE = "scripts/skillopt-source-lock.json"
SOURCE_LOCK_PATH = ROOT / SOURCE_LOCK_RELATIVE
MANIFEST_RELATIVE_NAME = "protocol.json"
PRIVATE_RUNTIME_PROOF_NAME = "runtime-proof.json"
PRIVATE_RUNTIME_PROOF_SCHEMA = "skillopt.private-runtime-proof.v1"
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
MAX_FRAGMENT_BYTES = 1200
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


class RolloutTransport:
    """One-request-at-a-time, bounded JSONL supervisor transport."""

    def __init__(self, reader: BinaryIO, writer: BinaryIO, manifest: RunManifest) -> None:
        self.reader = reader
        self.writer = writer
        self.manifest = manifest
        self.sequence = 0
        self.calls: list[tuple[str, str, int, str]] = []
        self.pair_call_counts: dict[tuple[str, str, int], int] = {}
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
        count = self.pair_call_counts.get(key, 0) + 1
        max_calls = 1 if case.split == "train" else 2
        if count > max_calls or self.sequence >= min(MAX_ROLLOUT_REQUESTS, self.manifest.max_rollout_requests):
            raise RunnerError("rollout_budget_exhausted")

        self.sequence += 1
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
        encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        if len(encoded) > PIPE_REQUEST_MAX_BYTES:
            raise RunnerError("request_oversized")
        try:
            remaining = memoryview(encoded)
            while remaining:
                written = self.writer.write(remaining)
                if type(written) is not int or written <= 0:
                    raise RunnerError("pipe_write_failed")
                remaining = remaining[written:]
            self.writer.flush()
        except RunnerError:
            raise
        except (OSError, ValueError, TypeError):
            raise RunnerError("pipe_write_failed") from None

        try:
            line = self.reader.readline(PIPE_RESPONSE_MAX_BYTES + 1)
        except (OSError, ValueError):
            raise RunnerError("pipe_read_failed") from None
        if not line:
            raise RunnerError("pipe_eof")
        if len(line) > PIPE_RESPONSE_MAX_BYTES or not line.endswith(b"\n") or line.endswith(b"\r\n"):
            raise RunnerError("response_oversized" if len(line) > PIPE_RESPONSE_MAX_BYTES else "response_invalid")
        response = _decode_json(line[:-1], "response_invalid")
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
            response["result"], {"id", "hard", "soft", "conversation"}, "response_invalid"
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

        self.pair_call_counts[key] = count
        self.calls.append((case.split, case.case_id, case.replicate, hashlib.sha256(fragment.encode("utf-8")).hexdigest()))
        return RolloutResult(hard=hard, conversation=conversation, assistant_count=assistant_count)


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


def _read_skill(path: Path) -> str:
    raw = _bounded_regular_file(path, MAX_FRAGMENT_BYTES, "candidate_invalid")
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise RunnerError("candidate_invalid") from None


def _write_result(output_root: Path, result: dict[str, Any]) -> None:
    path = output_root / "skillopt-result.json"
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
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
) -> None:
    _write_result(
        output_root,
        {
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
        },
    )


def _prepare_output_root(manifest_dir: Path) -> Path:
    output_root = manifest_dir / "skillopt-output"
    if output_root.exists() or output_root.is_symlink():
        raise RunnerError("output_not_fresh")
    try:
        output_root.mkdir(mode=0o700)
    except OSError:
        raise RunnerError("output_path_invalid") from None
    return output_root.resolve(strict=True)


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
    runtime_proof = verify_runtime(args.source_lock)
    source_lock_sha256 = runtime_proof["sourceLockSha256"]
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
    except ImportError:
        raise RunnerError("upstream_import_unavailable") from None

    pipe_writer = _launch_pipe_writer()
    transport = RolloutTransport(sys.stdin.buffer, pipe_writer, manifest)
    _loader_type, adapter_type = make_adapter_classes(manifest, transport, output_root)
    adapter = adapter_type()
    train_count = len(manifest.train)
    selection_count = len(manifest.selection)
    cfg = _trainer_config(manifest, output_root, optimizer_model, target_model)
    _assert_source_lock_digest(source_lock_sha256)

    _stderr_event("optimize_started")
    capture = _CaptureUpstreamOutput()
    try:
        with capture:
            summary = ReflACTTrainer(cfg, adapter).train()
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

        candidate = _read_skill(output_root / "steps" / "step_0001" / "candidate_skill.md")
        best = _read_skill(output_root / "best_skill.md")
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
        _assert_source_lock_digest(source_lock_sha256)
        _write_result(output_root, result)
    except RunnerError as error:
        _write_failure_result(output_root, manifest, error.code, capture.diagnostics())
        raise
    except Exception:
        _write_failure_result(output_root, manifest, "trainer_internal_error", capture.diagnostics())
        raise RunnerError("trainer_internal_error") from None
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

    optimize_parser = commands.add_parser("optimize", add_help=True)
    optimize_parser.add_argument("--source-lock", required=True)
    optimize_parser.add_argument("--manifest", required=True)
    optimize_parser.add_argument("--optimizer-base-url", required=True)
    optimize_parser.add_argument("--target-base-url", required=True)
    optimize_parser.add_argument("--optimizer-model", required=True)
    optimize_parser.add_argument("--target-model", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _build_parser().parse_args(argv)
        if args.command == "verify-runtime":
            proof = verify_runtime(args.source_lock)
            sys.stdout.write(json.dumps(proof, separators=(",", ":")) + "\n")
            return 0
        status, _result = optimize(args)
        return 0 if status in {"optimized", "development_only"} else 4
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
