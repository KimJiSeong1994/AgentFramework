from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import logging
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "skillopt_runner", ROOT / "scripts" / "skillopt_runner.py"
)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def manifest(mode: str = "experiment") -> dict:
    if mode == "development":
        train = [{"caseId": "dev-train-001", "replicate": 0}]
        selection = [{"caseId": "dev-selection-001", "replicate": 0}]
    else:
        train = [
            {"caseId": f"train-{index:02d}", "replicate": 0}
            for index in range(24)
        ]
        selection = [
            {"caseId": f"selection-{family:02d}", "replicate": replicate}
            for family in range(16)
            for replicate in range(3)
        ]
    return {
        "schema": "skillopt.adapter-manifest.v1",
        "runId": "run-20261003",
        "mode": mode,
        "originalSkillSha256": "a" * 64,
        "sourceLockSha256": "b" * 64,
        "train": train,
        "selection": selection,
    }


def encode_response(response: dict) -> bytes:
    return json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n"


DEFAULT_NATIVE_OPTIMIZER_TEXT = (
    '{"patch":{"edits":[]},"edits":[],"selected_indices":[]}'
)


def native_optimizer_text_with_size(size: int) -> str:
    prefix = '{"patch":{"edits":[]},"padding":"'
    suffix = '"}'
    padding_size = size - len(prefix.encode("utf-8")) - len(suffix.encode("utf-8"))
    if padding_size < 0:
        raise ValueError("requested native text size is too small")
    return prefix + ("x" * padding_size) + suffix


def native_response(
    request_id: str = "run-20261003:optimizer:1",
    run_id: str = "run-20261003",
    **overrides,
) -> dict:
    response = {
        "schema": "skillopt.native-optimizer-response.v1",
        "runId": run_id,
        "requestId": request_id,
        "role": "optimizer",
        "phase": "train",
        "ok": True,
        "text": DEFAULT_NATIVE_OPTIMIZER_TEXT,
        "usage": {"inputTokens": 17, "outputTokens": 9},
    }
    response.update(overrides)
    return response


class ChunkedWriter:
    def __init__(self, chunk_size: int = 7) -> None:
        self.chunk_size = chunk_size
        self.data = bytearray()
        self.flush_count = 0

    def write(self, value) -> int:
        chunk = bytes(value[: self.chunk_size])
        self.data.extend(chunk)
        return len(chunk)

    def flush(self) -> None:
        self.flush_count += 1


class FragmentedReader:
    def __init__(self, value: bytes, chunk_size: int = 5) -> None:
        self.data = bytearray(value)
        self.chunk_size = chunk_size

    def readline(self, size: int = -1) -> bytes:
        if not self.data:
            return b""
        limit = self.chunk_size if size < 0 else min(self.chunk_size, size)
        chunk = bytes(self.data[:limit])
        del self.data[:limit]
        return chunk


class ManifestContractTests(unittest.TestCase):
    def test_full_manifest_is_24_disjoint_train_and_16_by_3_selection(self) -> None:
        raw = json.dumps(manifest(), separators=(",", ":")).encode("utf-8")
        parsed = runner.validate_manifest(
            json.loads(raw), raw, "b" * 64
        )
        self.assertEqual(parsed.mode, "experiment")
        self.assertEqual(len(parsed.train), 24)
        self.assertEqual(len(parsed.selection), 48)
        self.assertEqual(parsed.max_rollout_requests, 120)
        self.assertFalse(
            {case.case_id for case in parsed.train}
            & {case.case_id for case in parsed.selection}
        )

    def test_development_manifest_is_a_separate_one_case_slice(self) -> None:
        raw = json.dumps(manifest("development"), separators=(",", ":")).encode("utf-8")
        parsed = runner.validate_manifest(
            json.loads(raw), raw, "b" * 64
        )
        self.assertEqual(parsed.mode, "development")
        self.assertEqual((len(parsed.train), len(parsed.selection)), (1, 1))
        self.assertEqual(parsed.max_rollout_requests, 3)

    def test_manifest_rejects_unknown_fields_paths_and_hidden_splits(self) -> None:
        for mutate in (
            lambda value: value.update({"goldPath": "/private/gold.json"}),
            lambda value: value.update({"test": []}),
            lambda value: value["train"][0].update({"prompt": "planted"}),
        ):
            value = manifest()
            mutate(value)
            with self.subTest(value=value.keys()):
                with self.assertRaises(runner.RunnerError):
                    raw = json.dumps(value).encode("utf-8")
                    runner.validate_manifest(json.loads(raw), raw, "b" * 64)

    def test_manifest_rejects_replicate_and_family_leakage(self) -> None:
        value = manifest()
        value["selection"][1]["replicate"] = 0
        raw = json.dumps(value).encode("utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "protocol_invalid"):
            runner.validate_manifest(json.loads(raw), raw, "b" * 64)

        value = manifest()
        value["selection"][0]["caseId"] = value["train"][0]["caseId"]
        raw = json.dumps(value).encode("utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "protocol_invalid"):
            runner.validate_manifest(json.loads(raw), raw, "b" * 64)

    def test_manifest_binds_the_final_source_lock_digest(self) -> None:
        raw = json.dumps(manifest()).encode("utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "protocol_invalid"):
            runner.validate_manifest(json.loads(raw), raw, "c" * 64)

    def test_manifest_rejects_duplicate_json_keys(self) -> None:
        raw = b'{"schema":"skillopt.adapter-manifest.v1","schema":"other"}'
        with self.assertRaisesRegex(runner.RunnerError, "protocol_invalid"):
            runner._decode_json(raw, "protocol_invalid")


class RuntimeLockTests(unittest.TestCase):
    def test_locked_runtime_proof_matches_this_interpreter(self) -> None:
        proof = runner.verify_runtime("scripts/skillopt-source-lock.json")
        self.assertTrue(proof["ok"])
        self.assertEqual(
            proof["importManifestSha256"],
            runner.EXPECTED_SOURCE["importManifest"]["sha256"],
        )

    def test_dependency_lock_must_be_explicitly_verified(self) -> None:
        document = copy.deepcopy(runner.EXPECTED_SOURCE)
        document["dependencyLock"] = {
            "path": runner.DEPENDENCY_LOCK_PATH,
            "sha256": None,
            "verified": False,
        }
        document["runtimeProof"] = {
            "schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA,
            "sha256": None,
            "verified": False,
        }
        with self.assertRaisesRegex(runner.RunnerError, "dependency_lock_unverified"):
            runner._validate_lock_document(document)

    def test_upstream_lock_does_not_allow_source_drift(self) -> None:
        document = copy.deepcopy(runner.EXPECTED_SOURCE)
        document["dependencyLock"] = {
            "path": runner.DEPENDENCY_LOCK_PATH,
            "sha256": "c" * 64,
            "verified": True,
        }
        document["runtimeProof"] = {
            "schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA,
            "sha256": "d" * 64,
            "verified": True,
        }
        document["upstream"]["commit"] = "0" * 40
        with self.assertRaisesRegex(runner.RunnerError, "source_lock_mismatch"):
            runner._validate_lock_document(document)

    def test_source_lock_runtime_binding_requires_exact_three_field_schema(self) -> None:
        document = copy.deepcopy(runner.EXPECTED_SOURCE)
        document["dependencyLock"] = {
            "path": runner.DEPENDENCY_LOCK_PATH,
            "sha256": "c" * 64,
            "verified": True,
        }
        document["runtimeProof"] = {
            "schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA,
            "sha256": "d" * 64,
            "verified": True,
        }
        self.assertEqual(runner._validate_lock_document(document)[0], document["dependencyLock"])

        for malformed in (
            {"schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA, "sha256": "d" * 64, "verified": True, "venvRoot": "/leak"},
            {"schema": "skillopt.runtime-proof.v1", "sha256": "d" * 64, "verified": True},
            {"schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA, "sha256": None, "verified": False},
        ):
            value = copy.deepcopy(document)
            value["runtimeProof"] = malformed
            with self.subTest(runtimeProof=malformed), self.assertRaises(runner.RunnerError):
                runner._validate_lock_document(value)

    def test_private_proof_schema_fields_identity_and_hash_are_bound(self) -> None:
        private = {
            "schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA,
            "verified": True,
            "venvRoot": "/state/venv",
            "pythonRealpath": "/state/venv/bin/python",
            "pythonVersion": "3.13.2",
            "pythonSha256": "a" * 64,
            "dependencyLockSha256": "b" * 64,
            "upstreamCommit": runner.EXPECTED_SOURCE["upstream"]["commit"],
            "importManifestSha256": runner.EXPECTED_SOURCE["importManifest"]["sha256"],
        }
        raw = json.dumps(private, separators=(",", ":")).encode("utf-8")
        expected = {
            "venvRoot": private["venvRoot"],
            "pythonRealpath": private["pythonRealpath"],
            "pythonVersion": private["pythonVersion"],
            "pythonSha256": private["pythonSha256"],
            "dependencyLockSha256": private["dependencyLockSha256"],
            "upstreamCommit": private["upstreamCommit"],
            "importManifestSha256": private["importManifestSha256"],
        }
        digest = hashlib.sha256(raw).hexdigest()
        parsed, actual_digest = runner._validate_private_runtime_proof(raw, digest, expected)
        self.assertEqual(parsed, private)
        self.assertEqual(actual_digest, digest)

        drifted = dict(private, pythonRealpath="/another/python")
        drifted_raw = json.dumps(drifted, separators=(",", ":")).encode("utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "runtime_proof_mismatch"):
            runner._validate_private_runtime_proof(
                drifted_raw, hashlib.sha256(drifted_raw).hexdigest(), expected
            )
        with self.assertRaisesRegex(runner.RunnerError, "runtime_proof_mismatch"):
            runner._validate_private_runtime_proof(raw, "0" * 64, expected)

        unknown_field = dict(private, unreviewed="field")
        unknown_raw = json.dumps(unknown_field).encode("utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "runtime_proof_invalid"):
            runner._validate_private_runtime_proof(
                unknown_raw,
                hashlib.sha256(unknown_raw).hexdigest(),
                expected,
            )

    def test_private_proof_lives_next_to_the_venv_and_public_proof_has_no_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_root = Path(temp_dir) / "skillopt" / "runtime" / runner.EXPECTED_SOURCE["upstream"]["commit"]
            venv = state_root / "venv"
            venv.mkdir(parents=True)
            self.assertEqual(
                runner._private_runtime_proof_path(venv),
                state_root.resolve(strict=True) / runner.PRIVATE_RUNTIME_PROOF_NAME,
            )

        public = runner._public_runtime_proof(
            source_lock_sha256="a" * 64,
            runtime_proof_sha256="b" * 64,
            dependency_lock_sha256="c" * 64,
            python_version="3.13.2",
            python_sha256="d" * 64,
            license_sha256=runner.EXPECTED_SOURCE["license"]["sha256"],
            import_manifest_sha256=runner.EXPECTED_SOURCE["importManifest"]["sha256"],
        )
        serialized = json.dumps(public)
        self.assertFalse({"venvRoot", "pythonRealpath", "runtimeProofPath"} & set(public))
        self.assertNotIn("/private/", serialized)

    def test_bounded_reader_rejects_fifo_without_blocking_open(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            fifo = Path(temp_dir) / "runtime-proof.json"
            os.mkfifo(fifo)
            with self.assertRaisesRegex(runner.RunnerError, "runtime_proof_unverified"):
                runner._bounded_regular_file(fifo, 16 * 1024, "runtime_proof_unverified")

    def test_bounded_reader_rejects_hard_links_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            original = Path(temp_dir) / "source-lock.json"
            original.write_text("{}", encoding="utf-8")
            hard_link = Path(temp_dir) / "hard-link.json"
            os.link(original, hard_link)
            symlink = Path(temp_dir) / "symlink.json"
            symlink.symlink_to(original)
            for path in (hard_link, symlink):
                with self.subTest(path=path.name), self.assertRaisesRegex(
                    runner.RunnerError, "source_lock_invalid"
                ):
                    runner._bounded_regular_file(path, 1024, "source_lock_invalid")


class PipeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = runner.RunManifest(
            run_id="run-20261003",
            mode="development",
            source_lock_sha256="b" * 64,
            original_skill_sha256="a" * 64,
            train=(runner.Case("dev-train-001", 0, "train"),),
            selection=(runner.Case("dev-selection-001", 0, "selection"),),
            sha256="e" * 64,
        )

    def _transport(self, response: bytes) -> tuple[runner.RolloutTransport, io.BytesIO]:
        output = io.BytesIO()
        transport = runner.RolloutTransport(io.BytesIO(response), output, self.manifest)
        return transport, output

    def test_pipe_request_has_only_seven_fixed_fields(self) -> None:
        transport, output = self._transport(
            encode_response(
                {
                    "schema": "skillopt.rollout-response.v1",
                    "runId": self.manifest.run_id,
                    "requestId": f"{self.manifest.run_id}:1",
                    "ok": False,
                    "errorCode": "host_failed",
                }
            )
        )
        with self.assertRaisesRegex(runner.RunnerError, "supervisor_host_failed"):
            transport.request(self.manifest.train[0], "")
        request = json.loads(output.getvalue().decode("utf-8"))
        self.assertEqual(
            set(request),
            {"schema", "runId", "requestId", "split", "caseId", "replicate", "fragment"},
        )
        self.assertEqual(request["split"], "train")
        self.assertNotIn("path", request)
        self.assertNotIn("command", request)

    def test_pipe_rejects_wrong_run_id_and_request_id(self) -> None:
        for field, value, expected in (
            ("runId", "another-run", "response_run_id_mismatch"),
            ("requestId", "run-20261003:2", "response_id_mismatch"),
        ):
            response = {
                "schema": "skillopt.rollout-response.v1",
                "runId": self.manifest.run_id,
                "requestId": f"{self.manifest.run_id}:1",
                "ok": False,
                "errorCode": "host_failed",
            }
            response[field] = value
            transport, _output = self._transport(encode_response(response))
            with self.subTest(field=field), self.assertRaisesRegex(runner.RunnerError, expected):
                transport.request(self.manifest.train[0], "")

    def test_pipe_rejects_unknown_supervisor_error_codes(self) -> None:
        transport, _output = self._transport(
            encode_response(
                {
                    "schema": "skillopt.rollout-response.v1",
                    "runId": self.manifest.run_id,
                    "requestId": f"{self.manifest.run_id}:1",
                    "ok": False,
                    "errorCode": "some_new_error",
                }
            )
        )
        with self.assertRaisesRegex(runner.RunnerError, "supervisor_error_code_invalid"):
            transport.request(self.manifest.train[0], "")

    def test_pipe_rejects_bad_scores_and_unbounded_fragments(self) -> None:
        for hard, soft in ((0, 0.25), (True, 1.0)):
            invalid_score = {
                "schema": "skillopt.rollout-response.v1",
                "runId": self.manifest.run_id,
                "requestId": f"{self.manifest.run_id}:1",
                "ok": True,
                "result": {
                    "id": self.manifest.train[0].case_id,
                    "hard": hard,
                    "soft": soft,
                    "conversation": [
                        {"role": "user", "content": "q"},
                        {"role": "assistant", "content": "a"},
                    ],
                },
            }
            transport, _output = self._transport(encode_response(invalid_score))
            with self.subTest(hard=hard, soft=soft), self.assertRaisesRegex(
                runner.RunnerError, "score_invalid"
            ):
                transport.request(self.manifest.train[0], "")

        transport, output = self._transport(b"")
        with self.assertRaisesRegex(runner.RunnerError, "fragment_oversized"):
            transport.request(self.manifest.train[0], "x" * (runner.MAX_FRAGMENT_BYTES + 1))
        self.assertEqual(output.getvalue(), b"")

    def test_pipe_rejects_oversized_and_malformed_responses(self) -> None:
        for response in (b"{" + b"x" * runner.PIPE_RESPONSE_MAX_BYTES + b"\n", b"not-json\n"):
            transport, _output = self._transport(response)
            with self.subTest(size=len(response)), self.assertRaises(runner.RunnerError):
                transport.request(self.manifest.train[0], "")

    def test_pipe_rejects_unadmitted_splits_before_emitting(self) -> None:
        transport, output = self._transport(b"")
        with self.assertRaisesRegex(runner.RunnerError, "unexpected_split"):
            transport.request(runner.Case("test-case", 0, "valid_unseen"), "")
        self.assertEqual(output.getvalue(), b"")


class NativeAdapterFragmentTests(unittest.TestCase):
    def setUp(self) -> None:
        manifest_value = manifest("development")
        raw = json.dumps(manifest_value, separators=(",", ":")).encode("utf-8")
        self.protocol = runner.validate_manifest(
            manifest_value, raw, "b" * 64
        )

    def _adapter(
        self,
        output_root: Path,
        transport: runner.RolloutTransport,
        *,
        native: bool = True,
    ):
        class BaseDataLoader:
            def setup(self, cfg: dict) -> None:
                del cfg

        class BatchSpec:
            def __init__(self, **values: Any) -> None:
                self.__dict__.update(values)

        class EnvAdapter:
            def setup(self, cfg: dict) -> None:
                del cfg

        with mock.patch.object(
            runner,
            "_load_upstream_types",
            return_value=(BaseDataLoader, BatchSpec, EnvAdapter),
        ):
            _loader_type, adapter_type = runner.make_adapter_classes(
                self.protocol,
                transport,
                output_root,
                native=native,
            )
        return adapter_type()

    def _response(self) -> bytes:
        return encode_response(
            {
                "schema": "skillopt.rollout-response.v1",
                "runId": self.protocol.run_id,
                "requestId": f"{self.protocol.run_id}:1",
                "ok": True,
                "result": {
                    "id": self.protocol.train[0].case_id,
                    "hard": 1,
                    "soft": 1.0,
                    "conversation": [
                        {"role": "user", "content": "q"},
                        {"role": "assistant", "content": "a"},
                    ],
                },
            }
        )

    def test_real_append_wrapper_is_canonical_across_rollout_and_candidate_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_root = root / "skillopt-output"
            output_root.mkdir(mode=0o700)
            wire = io.BytesIO()
            transport = runner.RolloutTransport(
                io.BytesIO(self._response()), wire, self.protocol
            )
            adapter = self._adapter(output_root, transport)
            upstream_text = "\n\napproved one-line fragment\n"
            canonical = "approved one-line fragment"
            adapter.rollout(
                [
                    {
                        "id": self.protocol.train[0].item_id,
                        "case_id": self.protocol.train[0].case_id,
                        "replicate": self.protocol.train[0].replicate,
                        "split": "train",
                        "task_type": "wiki-skillopt",
                    }
                ],
                upstream_text,
                str(output_root / "train"),
            )

            request = json.loads(wire.getvalue().decode("utf-8"))
            expected_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
            self.assertEqual(request["fragment"], canonical)
            self.assertEqual(transport.calls[0][3], expected_hash)

            candidate_path = output_root / "candidate_skill.md"
            best_path = output_root / "best_skill.md"
            candidate_path.write_bytes(upstream_text.encode("utf-8"))
            best_path.write_bytes(upstream_text.encode("utf-8"))
            candidate = runner._read_skill(candidate_path, native=True)
            best = runner._read_skill(best_path, native=True)
            result = {
                "candidateFragment": candidate,
                "candidateFragmentSha256": runner._sha256_bytes(candidate),
                "bestFragment": best,
                "bestFragmentSha256": runner._sha256_bytes(best),
            }
            self.assertEqual(result["candidateFragment"], request["fragment"])
            self.assertEqual(result["candidateFragmentSha256"], expected_hash)
            self.assertEqual(result["bestFragment"], request["fragment"])
            self.assertEqual(result["bestFragmentSha256"], expected_hash)
            self.assertEqual(runner._read_skill(candidate_path), upstream_text)

            legacy_wire = io.BytesIO()
            legacy_transport = runner.RolloutTransport(
                io.BytesIO(self._response()), legacy_wire, self.protocol
            )
            legacy_adapter = self._adapter(
                output_root, legacy_transport, native=False
            )
            legacy_adapter.rollout(
                [
                    {
                        "id": self.protocol.train[0].item_id,
                        "case_id": self.protocol.train[0].case_id,
                        "replicate": self.protocol.train[0].replicate,
                        "split": "train",
                        "task_type": "wiki-skillopt",
                    }
                ],
                upstream_text,
                str(output_root / "legacy"),
            )
            legacy_request = json.loads(legacy_wire.getvalue().decode("utf-8"))
            self.assertEqual(legacy_request["fragment"], upstream_text)

    def test_native_adapter_bounds_raw_bytes_and_rejects_malformed_unicode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_root = root / "skillopt-output"
            output_root.mkdir(mode=0o700)
            wire = io.BytesIO()
            transport = runner.RolloutTransport(
                io.BytesIO(self._response()), wire, self.protocol
            )
            adapter = self._adapter(output_root, transport)
            item = {
                "id": self.protocol.train[0].item_id,
                "case_id": self.protocol.train[0].case_id,
                "replicate": self.protocol.train[0].replicate,
                "split": "train",
                "task_type": "wiki-skillopt",
            }

            wrapped_content = ("é" * ((runner.MAX_FRAGMENT_BYTES - 4) // 2)) + "x"
            exact_limit = "\n\n" + wrapped_content + "\n"
            self.assertEqual(
                len(exact_limit.encode("utf-8")), runner.MAX_FRAGMENT_BYTES
            )
            adapter.rollout(
                [item], exact_limit, str(output_root / "exact-limit")
            )
            emitted_at_limit = wire.getvalue()
            self.assertTrue(emitted_at_limit)
            self.assertEqual(transport.sequence, 1)
            request = json.loads(emitted_at_limit.decode("utf-8"))
            self.assertEqual(request["fragment"], wrapped_content)
            self.assertEqual(
                transport.calls[0][3],
                hashlib.sha256(wrapped_content.encode("utf-8")).hexdigest(),
            )

            one_byte_over = exact_limit[:-1] + "x\n"
            self.assertEqual(
                len(one_byte_over.encode("utf-8")), runner.MAX_FRAGMENT_BYTES + 1
            )
            with self.assertRaisesRegex(runner.RunnerError, "fragment_oversized"):
                adapter.rollout(
                    [item], one_byte_over, str(output_root / "oversized")
                )
            self.assertEqual(wire.getvalue(), emitted_at_limit)
            self.assertEqual(transport.sequence, 1)

            with self.assertRaisesRegex(runner.RunnerError, "fragment_invalid"):
                adapter.rollout(
                    [item], "\ud800", str(output_root / "malformed")
                )
            self.assertEqual(wire.getvalue(), emitted_at_limit)
            self.assertEqual(transport.sequence, 1)

    def test_native_canonicalization_preserves_inner_multiline_controls_and_secrets(self) -> None:
        content = "first paragraph\n\nsecond\x01 paragraph PRIVATE_SECRET_SENTINEL"
        wrapped = "\n\n" + content + "\n"
        canonical = runner._canonicalize_native_adapter_fragment(
            wrapped,
            invalid_code="fragment_invalid",
            oversized_code="fragment_oversized",
        )
        self.assertEqual(canonical, content)
        self.assertIn("\n\n", canonical)
        self.assertIn("\x01", canonical)
        self.assertIn("PRIVATE_SECRET_SENTINEL", canonical)
        self.assertEqual(
            runner._canonicalize_native_adapter_fragment(
                "\n\nfirst\n\nsecond\n",
                invalid_code="fragment_invalid",
                oversized_code="fragment_oversized",
            ),
            "first\n\nsecond",
        )
        for unwrapped in (
            "\n",
            "\n\n",
            "\nfragment\n",
            " fragment ",
            "\n\nfragment",
            "fragment\n",
        ):
            with self.subTest(unwrapped=repr(unwrapped)):
                self.assertEqual(
                    runner._canonicalize_native_adapter_fragment(
                        unwrapped,
                        invalid_code="fragment_invalid",
                        oversized_code="fragment_oversized",
                    ),
                    unwrapped,
                )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_root = root / "skillopt-output"
            output_root.mkdir(mode=0o700)
            wire = io.BytesIO()
            transport = runner.RolloutTransport(
                io.BytesIO(self._response()), wire, self.protocol
            )
            adapter = self._adapter(output_root, transport)
            adapter.rollout(
                [
                    {
                        "id": self.protocol.train[0].item_id,
                        "case_id": self.protocol.train[0].case_id,
                        "replicate": self.protocol.train[0].replicate,
                        "split": "train",
                        "task_type": "wiki-skillopt",
                    }
                ],
                wrapped,
                str(output_root / "multiline"),
            )
            request = json.loads(wire.getvalue().decode("utf-8"))
            self.assertEqual(request["fragment"], content)
            self.assertEqual(
                transport.calls[0][3],
                hashlib.sha256(content.encode("utf-8")).hexdigest(),
            )

    def test_native_candidate_read_retains_raw_bound_and_rejects_malformed_unicode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "candidate.md"
            path.write_bytes(b"\n\n" + b"x" * runner.MAX_FRAGMENT_BYTES + b"\n")
            with self.assertRaisesRegex(runner.RunnerError, "candidate_invalid"):
                runner._read_skill(path, native=True)
            path.write_bytes(b"\xff")
            with self.assertRaisesRegex(runner.RunnerError, "candidate_invalid"):
                runner._read_skill(path, native=True)


class NativeOptimizerProtocolTests(unittest.TestCase):
    """Mocked IPC tests only; these cases never invoke a model or CLI broker."""

    def setUp(self) -> None:
        self.run_id = "run-20261003"

    def _client(self, response: bytes, writer=None, reader=None):
        writer = writer or io.BytesIO()
        reader = reader or io.BytesIO(response)
        channel = runner.JsonlChannel(reader, writer)
        return runner.NativeOptimizerClient(channel, self.run_id), writer

    def test_native_request_has_exact_data_only_shape_and_returns_usage(self) -> None:
        client, output = self._client(encode_response(native_response()))
        text, usage = client.call(
            "system prompt",
            "user payload",
            max_completion_tokens=runner.MAX_NATIVE_COMPLETION_TOKENS,
            retries=3,
            stage="analyst",
        )
        request = json.loads(output.getvalue().decode("utf-8"))
        self.assertEqual(
            set(request),
            {
                "schema",
                "runId",
                "requestId",
                "role",
                "phase",
                "stage",
                "maxCompletionTokens",
                "messages",
            },
        )
        self.assertEqual(request["schema"], "skillopt.native-optimizer-request.v1")
        self.assertEqual(request["requestId"], f"{self.run_id}:optimizer:1")
        self.assertEqual((request["role"], request["phase"], request["stage"]), ("optimizer", "train", "analyst"))
        self.assertEqual(request["maxCompletionTokens"], runner.MAX_NATIVE_COMPLETION_TOKENS)
        self.assertEqual(
            request["messages"],
            [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": "user payload"},
            ],
        )
        self.assertEqual(
            (text, usage),
            (
                DEFAULT_NATIVE_OPTIMIZER_TEXT,
                {"inputTokens": 17, "outputTokens": 9},
            ),
        )
        self.assertNotIn("command", request)
        self.assertNotIn("endpoint", request)
        self.assertNotIn("tools", request)
        self.assertNotIn("image", request)
        self.assertEqual(
            runner._native_optimizer_provenance(client),
            {
                "optimizerBackend": "native_ipc",
                "nativeOptimizer": {
                    "schema": "skillopt.native-optimizer-provenance.v1",
                    "requests": 1,
                    "usage": {
                        "status": "reported",
                        "reportedRequests": 1,
                        "unknownRequests": 0,
                        "reportedCostSemantics": "vendor_estimate_not_billing_proof",
                        "observations": [
                            {
                                "requestId": f"{self.run_id}:optimizer:1",
                                "usage": {"inputTokens": 17, "outputTokens": 9},
                            }
                        ],
                    },
                },
            },
        )

        boundary_client, _boundary_output = self._client(
            encode_response(
                native_response(
                    text=native_optimizer_text_with_size(runner.NATIVE_TEXT_MAX_BYTES)
                )
            )
        )
        boundary_text, _boundary_usage = boundary_client.call("s", "u", stage="analyst")
        self.assertEqual(len(boundary_text.encode("utf-8")), runner.NATIVE_TEXT_MAX_BYTES)

        minimum_client, minimum_output = self._client(encode_response(native_response()))
        minimum_client.call("s", "u", max_completion_tokens=1, stage="analyst")
        minimum_request = json.loads(minimum_output.getvalue().decode("utf-8"))
        self.assertEqual(minimum_request["maxCompletionTokens"], 1)

    def test_native_optimizer_output_accepts_stage_forms_without_rewriting_text(self) -> None:
        analyst_text = (
            ' \n{"patch":{"reasoning":"retain","edits":['
            '{"op":"append","content":"# 안정","support_count":24,'
            '"source_type":"failure","merge_level":1000000,'
            '"update_origin":"analyst","extension":{"confidence":0.75}}'
            ',{"op":"insert_after","target":"Heading","content":"detail"},'
            '{"op":"replace","target":"old","content":"new"},'
            '{"op":"delete","target":"obsolete"},'
            + '{"op":"not-retained","content":"'
            + "x" * (runner.MAX_FRAGMENT_BYTES + 1)
            + '"}]} ,"source_type":"failure","batch_size":24,'
            + '"failure_summary":[{"failure_type":"timeout","count":24,'
            + '"description":"bounded","extra":{"source":"fixture"}}],'
            + '"success_patterns":["generic extension"],"metadata":{"note":"보존"}} \t'
        )
        merge_text = (
            '{"reasoning":"merged","edits":[{"op":"append",'
            '"content":"# Merged","support_count":24,"source_type":"success",'
            '"merge_level":1000000,"vendor":{"rank":1}}],'
            '"metadata":{"merge_group":"failure-first"}}'
        )
        ranking_text = (
            ' \n```json\n{"selected_indices":[0,0,1],"reasoning":"priority",'
            '"vendor":{"trace":"kept"}}\n```\t '
        )
        backtick_fence_text = (
            '```json\n{"patch":{"edits":[{"op":"append",'
            '"content":"inline ```code``` and `quoted`"}]}}\n```'
        )
        for stage, text in (
            ("analyst", analyst_text),
            ("merge", merge_text),
            ("ranking", ranking_text),
            ("analyst", backtick_fence_text),
        ):
            with self.subTest(stage=stage):
                client, _output = self._client(encode_response(native_response(text=text)))
                returned, _usage = client.call("system", "user", stage=stage)
                self.assertEqual(returned, text)
                self.assertEqual(returned.encode("utf-8"), text.encode("utf-8"))

    def test_native_optimizer_output_rejects_ambiguous_and_unsafe_shapes_stickily(self) -> None:
        too_many_nodes: Any = 0
        for _ in range(4):
            too_many_nodes = [too_many_nodes] * 4
        deep_value = "0"
        for _ in range(runner.NATIVE_OPTIMIZER_MAX_JSON_DEPTH):
            deep_value = f"[{deep_value}]"
        bad_texts = (
            '{"patch":{"edits":[]}} {"patch":{"edits":[]}}',
            '{"patch":{"edits":[]}} trailing prose',
            '```json\n{"patch":{"edits":[]}}\n``` trailing prose',
            '{"patch":{"edits":[]},"note":"```json {} ```"}',
            '{"patch":{"edits":[]},"note":"```json [] ```"}',
            '{"patch":{"edits":[]},"note":"```json 7 ```"}',
            '{"patch":{"edits":[]},"patch":{"edits":[]}}',
            '{"patch":{"edits":[]},"score":NaN}',
            '{"patch":{"edits":[]},"score":1e9999}',
            '{"patch":{"edits":[]},"batch_size":"25"}',
            '{"patch":{"edits":[{"op":"append","support_count":25}]}}',
            '{"patch":{"edits":[]},"failure_summary":[{"count":"25"}]}',
            '{"patch":{"edits":[]},"deep":' + deep_value + '}',
            json.dumps(
                {"patch": {"edits": []}, "tree": too_many_nodes},
                separators=(",", ":"),
            ),
            json.dumps(
                {
                    "patch": {
                        "edits": [
                            {
                                "op": "append",
                                "content": "x" * (runner.MAX_FRAGMENT_BYTES + 1),
                            }
                        ]
                    }
                },
                separators=(",", ":"),
            ),
        )
        for text in bad_texts:
            client, output = self._client(encode_response(native_response(text=text)))
            with self.subTest(text_prefix=text[:48]), self.assertRaisesRegex(
                runner.RunnerError, "native_optimizer_output_shape_invalid"
            ):
                client.call("system", "user", stage="analyst")
            self.assertEqual(client.failed_code, "native_optimizer_output_shape_invalid")
            self.assertEqual(client.requests, 1)
            self.assertEqual(client.unknown_usage_requests, 1)
            self.assertEqual(output.getvalue().count(b"\n"), 1)

        client, output = self._client(
            encode_response(native_response(text=bad_texts[3]))
        )
        with self.assertRaisesRegex(
            runner.RunnerError, "native_optimizer_output_shape_invalid"
        ):
            client.call("system", "user", stage="analyst")
        with self.assertRaisesRegex(
            runner.RunnerError, "native_optimizer_output_shape_invalid"
        ):
            client.call("system", "user", stage="merge")
        self.assertEqual(client.requests, 1)
        self.assertEqual(output.getvalue().count(b"\n"), 1)

        merge_client, merge_output = self._client(
            encode_response(
                native_response(
                    text='{"edits":[{"op":"append","support_count":25}]}'
                )
            )
        )
        with self.assertRaisesRegex(
            runner.RunnerError, "native_optimizer_output_shape_invalid"
        ):
            merge_client.call("system", "user", stage="merge")
        self.assertEqual(merge_client.requests, 1)
        self.assertEqual(merge_output.getvalue().count(b"\n"), 1)

        small_batch_text = '{"patch":{"edits":[]},"batch_size":2}'
        small_batch_output = io.BytesIO()
        small_batch_client = runner.NativeOptimizerClient(
            runner.JsonlChannel(
                io.BytesIO(
                    encode_response(native_response(text=small_batch_text))
                ),
                small_batch_output,
            ),
            self.run_id,
            max_batch_size=1,
        )
        with self.assertRaisesRegex(
            runner.RunnerError, "native_optimizer_output_shape_invalid"
        ):
            small_batch_client.call("system", "user", stage="analyst")
        self.assertEqual(small_batch_client.requests, 1)

    def test_native_optimizer_output_rejects_oversized_pretty_serialization(self) -> None:
        info: dict[str, Any] = {f"leaf_{index}": 0 for index in range(15)}
        for _ in range(6):
            info = {**{f"key_{index}": 0 for index in range(15)}, "next": info}
        value = {"selected_indices": [0], "reasoning": "", "info": info}
        empty_text = json.dumps(value, separators=(",", ":"))
        value["reasoning"] = "x" * (
            runner.NATIVE_TEXT_MAX_BYTES - len(empty_text.encode("utf-8"))
        )
        text = json.dumps(value, separators=(",", ":"))
        self.assertEqual(len(text.encode("utf-8")), runner.NATIVE_TEXT_MAX_BYTES)
        self.assertGreater(
            runner._native_optimizer_json_size(value),
            runner.NATIVE_RANKING_OBJECT_MAX_BYTES,
        )
        client, _output = self._client(encode_response(native_response(text=text)))
        with self.assertRaisesRegex(
            runner.RunnerError, "native_optimizer_output_shape_invalid"
        ):
            client.call("system", "user", stage="ranking")
        self.assertEqual(client.requests, 1)

    def test_native_optimizer_rank_bounds_exact_derived_edits_at_1200_bytes(self) -> None:
        edits = [
            {
                "op": "append",
                "content": "x" * runner.MAX_FRAGMENT_BYTES,
                "support_count": 24,
                "merge_level": 10_000,
            }
            for _ in range(5)
        ]
        merge_text = json.dumps(
            {"reasoning": "source reasoning", "edits": edits},
            separators=(",", ":"),
        )
        ranking_text = '{"selected_indices":[0,1,2,3,4,4],"reasoning":"top four"}'
        response = b"".join(
            encode_response(
                native_response(
                    request_id=f"{self.run_id}:optimizer:{index}",
                    text=text,
                )
            )
            for index, text in ((1, merge_text), (2, ranking_text))
        )
        client, output = self._client(response)
        self.assertEqual(client.call("system", "merge prompt", stage="merge")[0], merge_text)
        self.assertEqual(
            client.call("system", "rank prompt", stage="ranking")[0],
            ranking_text,
        )
        self.assertEqual(client.requests, 2)
        self.assertEqual(output.getvalue().count(b"\n"), 2)

    def test_native_result_limit_is_checked_before_open_and_legacy_is_unchanged(self) -> None:
        result = {"payload": "x" * runner.NATIVE_RESULT_MAX_BYTES}
        with tempfile.TemporaryDirectory() as temporary:
            output_root = Path(temporary)
            result_path = output_root / "skillopt-result.json"
            with mock.patch.object(Path, "open", autospec=True) as open_path:
                with self.assertRaisesRegex(runner.RunnerError, "native_result_oversized"):
                    runner._write_result(output_root, result, native=True)
                open_path.assert_not_called()
            self.assertFalse(result_path.exists())

            runner._write_result(output_root, result)
            self.assertTrue(result_path.is_file())
            self.assertGreater(
                result_path.stat().st_size,
                runner.NATIVE_RESULT_MAX_BYTES,
            )

    def test_native_output_root_limit_precedes_creation_without_changing_legacy(self) -> None:
        long_manifest_dir = Path(
            "/" + ("m" * runner.NATIVE_OUTPUT_ROOT_PATH_MAX_BYTES)
        )
        with (
            mock.patch.object(Path, "exists", autospec=True) as exists,
            mock.patch.object(Path, "is_symlink", autospec=True) as is_symlink,
        ):
            with self.assertRaisesRegex(
                runner.RunnerError,
                "native_output_root_oversized",
            ):
                runner._prepare_output_root(long_manifest_dir, native=True)
            exists.assert_not_called()
            is_symlink.assert_not_called()

        with tempfile.TemporaryDirectory() as temporary:
            manifest_dir = Path(temporary)
            output_root = manifest_dir / "skillopt-output"
            overlong_canonical_path = Path(
                "/" + ("x" * runner.NATIVE_OUTPUT_ROOT_PATH_MAX_BYTES)
            )
            with mock.patch.object(
                Path,
                "resolve",
                autospec=True,
                return_value=overlong_canonical_path,
            ):
                with self.assertRaisesRegex(
                    runner.RunnerError,
                    "native_output_root_oversized",
                ):
                    runner._prepare_output_root(manifest_dir, native=True)
            self.assertFalse(output_root.exists())

            legacy_output_root = runner._prepare_output_root(manifest_dir)
            self.assertEqual(legacy_output_root, output_root.resolve(strict=True))

    def test_native_output_root_requires_utf8_default_before_filesystem_access(self) -> None:
        class EncodingProbe:
            def __init__(self, encoding: str) -> None:
                self.encoding = encoding
                self.closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.closed = True

        for encoding in ("latin-1", "utf-16"):
            with self.subTest(encoding=encoding):
                probe = EncodingProbe(encoding)
                text_wrapper = mock.Mock(return_value=probe)
                with (
                    mock.patch.object(runner.io, "TextIOWrapper", text_wrapper),
                    mock.patch.object(Path, "exists", autospec=True) as exists,
                    mock.patch.object(Path, "is_symlink", autospec=True) as is_symlink,
                    mock.patch.object(Path, "mkdir", autospec=True) as mkdir,
                    mock.patch.object(Path, "resolve", autospec=True) as resolve,
                ):
                    with self.assertRaisesRegex(
                        runner.RunnerError,
                        "native_output_encoding_unverified",
                    ):
                        runner._prepare_output_root(Path("native-output"), native=True)
                self.assertTrue(probe.closed)
                text_wrapper.assert_called_once()
                self.assertIsInstance(text_wrapper.call_args.args[0], io.BytesIO)
                self.assertIsNone(text_wrapper.call_args.kwargs["encoding"])
                exists.assert_not_called()
                is_symlink.assert_not_called()
                mkdir.assert_not_called()
                resolve.assert_not_called()

    def test_native_output_root_accepts_utf8_alias_and_closes_probe(self) -> None:
        class EncodingProbe:
            encoding = "UTF8"

            def __init__(self) -> None:
                self.closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.closed = True

        probe = EncodingProbe()
        with tempfile.TemporaryDirectory() as temporary:
            manifest_dir = Path(temporary)
            with mock.patch.object(
                runner.io,
                "TextIOWrapper",
                return_value=probe,
            ) as text_wrapper:
                output_root = runner._prepare_output_root(manifest_dir, native=True)
            self.assertEqual(output_root, (manifest_dir / "skillopt-output").resolve(strict=True))
            self.assertTrue(output_root.is_dir())
            self.assertTrue(probe.closed)
            text_wrapper.assert_called_once()
            self.assertIsInstance(text_wrapper.call_args.args[0], io.BytesIO)
            self.assertIsNone(text_wrapper.call_args.kwargs["encoding"])

    def test_native_output_root_encoding_inspection_failure_is_closed_and_fail_closed(self) -> None:
        class EncodingProbe:
            encoding = "UTF-8"

            def __init__(self) -> None:
                self.closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.closed = True

        probe = EncodingProbe()
        with (
            mock.patch.object(
                runner.io,
                "TextIOWrapper",
                return_value=probe,
            ) as text_wrapper,
            mock.patch.object(
                runner.codecs,
                "lookup",
                side_effect=RuntimeError("private inspection detail"),
            ),
            mock.patch.object(Path, "exists", autospec=True) as exists,
            mock.patch.object(Path, "is_symlink", autospec=True) as is_symlink,
            mock.patch.object(Path, "mkdir", autospec=True) as mkdir,
            mock.patch.object(Path, "resolve", autospec=True) as resolve,
        ):
            with self.assertRaisesRegex(
                runner.RunnerError,
                "native_output_encoding_unverified",
            ) as raised:
                runner._prepare_output_root(Path("native-output"), native=True)
        self.assertNotIn("private inspection detail", str(raised.exception))
        self.assertTrue(probe.closed)
        text_wrapper.assert_called_once()
        self.assertIsInstance(text_wrapper.call_args.args[0], io.BytesIO)
        self.assertIsNone(text_wrapper.call_args.kwargs["encoding"])
        exists.assert_not_called()
        is_symlink.assert_not_called()
        mkdir.assert_not_called()
        resolve.assert_not_called()

    def test_legacy_output_root_does_not_inspect_or_require_default_encoding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest_dir = Path(temporary)
            with mock.patch.object(
                runner,
                "_require_native_default_text_encoding",
                side_effect=runner.RunnerError("native_output_encoding_unverified"),
            ) as encoding_guard:
                output_root = runner._prepare_output_root(manifest_dir)
            self.assertEqual(output_root, (manifest_dir / "skillopt-output").resolve(strict=True))
            self.assertTrue(output_root.is_dir())
            encoding_guard.assert_not_called()

    def test_native_usage_null_stays_unknown_not_zero(self) -> None:
        client, _output = self._client(encode_response(native_response(usage=None)))
        _text, usage = client.call("s", "u", stage="ranking")
        self.assertIsNone(usage)
        self.assertEqual(
            client.usage_provenance(),
            {
                "status": "unknown",
                "reportedRequests": 0,
                "unknownRequests": 1,
                "reportedCostSemantics": "vendor_estimate_not_billing_proof",
                "observations": [
                    {"requestId": f"{self.run_id}:optimizer:1", "usage": None}
                ],
            },
        )

    def test_native_usage_preserves_partial_fields_and_reported_zero_values(self) -> None:
        usage = {
            "inputTokens": 0,
            "cachedInputTokens": 0,
            "cacheCreationTokens": 0,
            "reportedCostUsd": 0.0,
        }
        client, _output = self._client(encode_response(native_response(usage=usage)))
        _text, observed = client.call("s", "u", stage="analyst")
        self.assertEqual(observed, usage)
        self.assertNotIn("outputTokens", observed)
        provenance = client.usage_provenance()
        self.assertEqual(provenance["status"], "reported")
        self.assertEqual(
            provenance["observations"],
            [{"requestId": f"{self.run_id}:optimizer:1", "usage": usage}],
        )
        self.assertEqual(provenance["observations"][0]["usage"]["inputTokens"], 0)
        self.assertEqual(provenance["observations"][0]["usage"]["cacheCreationTokens"], 0)
        self.assertEqual(provenance["observations"][0]["usage"]["reportedCostUsd"], 0.0)

    def test_partial_and_missing_usage_calls_remain_separately_observable(self) -> None:
        first = native_response(
            usage={"cachedInputTokens": 8, "reportedCostUsd": 0.004}
        )
        second = native_response(
            request_id=f"{self.run_id}:optimizer:2",
            usage=None,
        )
        client, _output = self._client(encode_response(first) + encode_response(second))
        client.call("s", "u", stage="analyst")
        client.call("s", "u", stage="merge")
        provenance = client.usage_provenance()
        self.assertEqual(provenance["status"], "unknown")
        self.assertEqual(provenance["reportedRequests"], 1)
        self.assertEqual(provenance["unknownRequests"], 1)
        self.assertEqual(
            provenance["observations"],
            [
                {
                    "requestId": f"{self.run_id}:optimizer:1",
                    "usage": {"cachedInputTokens": 8, "reportedCostUsd": 0.004},
                },
                {"requestId": f"{self.run_id}:optimizer:2", "usage": None},
            ],
        )

    def test_native_response_rejects_extra_fields_and_wrong_ids(self) -> None:
        cases = (
            ({"unexpected": "field"}, "native_response_invalid"),
            ({"runId": "other-run"}, "native_response_run_id_mismatch"),
            ({"requestId": f"{self.run_id}:optimizer:2"}, "native_response_id_mismatch"),
            ({"role": "target"}, "native_response_invalid"),
            ({"phase": "final"}, "native_response_invalid"),
            ({"text": "x" * (runner.NATIVE_TEXT_MAX_BYTES + 1)}, "native_response_oversized"),
            ({"usage": {"promptTokens": 1, "completionTokens": 2}}, "native_usage_invalid"),
            ({"usage": {"inputTokens": True, "outputTokens": 2}}, "native_usage_invalid"),
            ({"usage": {}}, "native_usage_invalid"),
            ({"usage": {"inputTokens": None}}, "native_usage_invalid"),
            ({"usage": {"reportedCostUsd": "0.001"}}, "native_usage_invalid"),
            ({"usage": {"reportedCostUsd": -0.001}}, "native_usage_invalid"),
            ({"toolCalls": []}, "native_response_invalid"),
            ({"image": "data"}, "native_response_invalid"),
        )
        for changes, code in cases:
            response = native_response()
            response.update(changes)
            client, output = self._client(encode_response(response))
            with self.subTest(changes=changes), self.assertRaisesRegex(runner.RunnerError, code):
                client.call("s", "u", stage="analyst")
            self.assertEqual(client.requests, 1)
            self.assertEqual(output.getvalue().count(b"\n"), 1)

        nonfinite_cost = encode_response(
            native_response(usage={"reportedCostUsd": 0.0})
        ).replace(b'"reportedCostUsd":0.0', b'"reportedCostUsd":1e9999')
        client, output = self._client(nonfinite_cost)
        with self.assertRaisesRegex(runner.RunnerError, "native_usage_invalid"):
            client.call("s", "u", stage="analyst")
        self.assertEqual(output.getvalue().count(b"\n"), 1)

    def test_native_error_enum_is_fixed_and_not_retried(self) -> None:
        response = native_response(
            ok=False,
            errorCode="model_unavailable",
        )
        del response["text"]
        del response["usage"]
        client, output = self._client(encode_response(response))
        with self.assertRaisesRegex(runner.RunnerError, "native_model_unavailable"):
            client.call("s", "u", retries=5, stage="merge")
        self.assertEqual(client.requests, 1)
        self.assertEqual(output.getvalue().count(b"\n"), 1)
        with self.assertRaisesRegex(runner.RunnerError, "native_model_unavailable"):
            client.call("s", "u", retries=5, stage="merge")
        self.assertEqual(output.getvalue().count(b"\n"), 1)

        response["errorCode"] = "unrecognized"
        invalid_client, invalid_output = self._client(encode_response(response))
        with self.assertRaisesRegex(runner.RunnerError, "native_error_code_invalid"):
            invalid_client.call("s", "u", stage="analyst")
        self.assertEqual(invalid_output.getvalue().count(b"\n"), 1)

    def test_native_truncated_response_and_eof_are_terminal_without_retry(self) -> None:
        for response, code in ((b"", "pipe_eof"), (b"{\"schema\":", "response_invalid")):
            client, output = self._client(response)
            with self.subTest(response=response), self.assertRaisesRegex(runner.RunnerError, code):
                client.call("s", "u", stage="analyst")
            self.assertEqual(client.requests, 1)
            self.assertEqual(output.getvalue().count(b"\n"), 1)

        duplicate_key_response = (
            b'{"schema":"skillopt.native-optimizer-response.v1",'
            b'"schema":"skillopt.native-optimizer-response.v1"}\n'
        )
        client, output = self._client(duplicate_key_response)
        with self.assertRaisesRegex(runner.RunnerError, "native_response_invalid"):
            client.call("s", "u", stage="analyst")
        self.assertEqual(output.getvalue().count(b"\n"), 1)

    def test_native_response_frame_cap_is_enforced(self) -> None:
        response = native_response()
        response["padding"] = "x" * runner.NATIVE_RESPONSE_MAX_BYTES
        client, output = self._client(encode_response(response))
        with self.assertRaisesRegex(runner.RunnerError, "response_oversized"):
            client.call("s", "u", stage="analyst")
        self.assertEqual(client.requests, 1)
        self.assertEqual(output.getvalue().count(b"\n"), 1)

    def test_native_prompt_stage_completion_and_budget_caps(self) -> None:
        for kwargs in (
            {"stage": "arbitrary"},
            {"stage": "rewrite"},
            {"stage": "optimizer"},
            {"max_completion_tokens": 0},
            {"max_completion_tokens": True},
            {"max_completion_tokens": runner.MAX_NATIVE_COMPLETION_TOKENS + 1},
            {"reasoning_effort": "high"},
            {"timeout": 3},
        ):
            client, output = self._client(b"")
            with self.subTest(kwargs=kwargs), self.assertRaises(runner.RunnerError):
                client.call("s", "u", **kwargs)
            self.assertEqual(output.getvalue(), b"")

        client, output = self._client(b"")
        with self.assertRaisesRegex(runner.RunnerError, "native_optimizer_request_oversized"):
            client.call("s" * (runner.NATIVE_PROMPT_MAX_BYTES + 1), "", stage="analyst")
        self.assertEqual(output.getvalue(), b"")

        client, output = self._client(b"")
        escaped_prompt = "\x00" * (runner.NATIVE_PROMPT_MAX_BYTES // 2)
        with self.assertRaisesRegex(runner.RunnerError, "native_optimizer_request_oversized"):
            client.call(escaped_prompt, escaped_prompt, stage="analyst")
        self.assertEqual(output.getvalue(), b"")
        self.assertEqual(client.requests, 0)

        client, _output = self._client(encode_response(native_response()))
        system = "s" * (runner.NATIVE_PROMPT_MAX_BYTES // 2)
        user = "u" * (runner.NATIVE_PROMPT_MAX_BYTES - len(system))
        client.call(system, user, stage="analyst")
        self.assertEqual(len(system.encode("utf-8")) + len(user.encode("utf-8")), runner.NATIVE_PROMPT_MAX_BYTES)

        client, output = self._client(encode_response(native_response()))
        client.requests = runner.MAX_NATIVE_OPTIMIZER_REQUESTS
        with self.assertRaisesRegex(runner.RunnerError, "native_request_budget_exhausted"):
            client.call("s", "u", stage="analyst")
        self.assertEqual(output.getvalue(), b"")

    def test_native_jsonl_handles_fragmented_reads_and_partial_writes(self) -> None:
        writer = ChunkedWriter(chunk_size=3)
        reader = FragmentedReader(encode_response(native_response()), chunk_size=2)
        client, _writer = self._client(b"", writer=writer, reader=reader)
        text, _usage = client.call("system", "user", stage="analyst")
        self.assertEqual(text, DEFAULT_NATIVE_OPTIMIZER_TEXT)
        self.assertEqual(writer.flush_count, 1)
        self.assertEqual(bytes(writer.data).count(b"\n"), 1)

    def test_concurrent_native_calls_share_one_locked_request_response_channel(self) -> None:
        responses = b"".join(
            encode_response(
                native_response(
                    request_id=f"{self.run_id}:optimizer:{index}",
                    text=(
                        '{"patch":{"edits":[]},'
                        f'"response":"response-{index}"'
                        "}"
                    ),
                )
            )
            for index in (1, 2)
        )
        writer = ChunkedWriter(chunk_size=4)
        client, _writer = self._client(responses, writer=writer)
        errors: list[BaseException] = []

        def invoke(index: int) -> None:
            try:
                client.call("system", f"user-{index}", stage="analyst")
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=invoke, args=(index,)) for index in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        requests = [json.loads(line) for line in bytes(writer.data).splitlines()]
        self.assertEqual(errors, [])
        self.assertEqual([request["requestId"] for request in requests], [
            f"{self.run_id}:optimizer:1",
            f"{self.run_id}:optimizer:2",
        ])

    def test_native_and_rollout_calls_share_one_framed_channel(self) -> None:
        manifest_value = {
            "schema": "skillopt.adapter-manifest.v1",
            "runId": self.run_id,
            "mode": "development",
            "originalSkillSha256": "a" * 64,
            "sourceLockSha256": "b" * 64,
            "train": [{"caseId": "dev-train-001", "replicate": 0}],
            "selection": [{"caseId": "dev-selection-001", "replicate": 0}],
        }
        manifest_bytes = json.dumps(manifest_value).encode("utf-8")
        protocol = runner.validate_manifest(
            manifest_value,
            manifest_bytes,
            "b" * 64,
        )
        rollout_response = {
            "schema": "skillopt.rollout-response.v1",
            "runId": self.run_id,
            "requestId": f"{self.run_id}:1",
            "ok": True,
            "result": {
                "id": "dev-train-001",
                "hard": 1,
                "soft": 1.0,
                "conversation": [
                    {"role": "user", "content": "q"},
                    {"role": "assistant", "content": "a"},
                ],
            },
        }
        reader = io.BytesIO(
            encode_response(native_response()) + encode_response(rollout_response)
        )
        writer = ChunkedWriter(chunk_size=5)
        channel = runner.JsonlChannel(reader, writer)
        client = runner.NativeOptimizerClient(channel, self.run_id)
        rollout = runner.RolloutTransport(reader, writer, protocol, channel=channel)
        client.call("system", "user", stage="analyst")
        result = rollout.request(protocol.train[0], "fragment")
        requests = [json.loads(line) for line in bytes(writer.data).splitlines()]
        self.assertEqual(result.hard, 1)
        self.assertEqual(
            [request["schema"] for request in requests],
            [
                "skillopt.native-optimizer-request.v1",
                "skillopt.rollout-request.v1",
            ],
        )

    def test_duplicate_reply_is_consumed_once_then_poisoned(self) -> None:
        duplicate = encode_response(native_response()) * 2
        client, output = self._client(duplicate)
        client.call("s", "u", stage="analyst")
        with self.assertRaisesRegex(runner.RunnerError, "native_response_id_mismatch"):
            client.call("s", "u", stage="merge")
        with self.assertRaisesRegex(runner.RunnerError, "native_response_id_mismatch"):
            client.call("s", "u", stage="ranking")
        self.assertEqual(client.requests, 2)
        self.assertEqual(output.getvalue().count(b"\n"), 2)

    def test_native_facade_ignores_upstream_retry_count_and_blocks_other_entrypoints(self) -> None:
        calls = {"provider": 0}

        def pinned_chat_optimizer(
            system: str,
            user: str,
            max_completion_tokens: int = 16384,
            retries: int = 5,
            stage: str = "optimizer",
            reasoning_effort: str | None = None,
            timeout: int | None = None,
        ) -> tuple[str, dict]:
            del system, user, max_completion_tokens, retries, stage, reasoning_effort, timeout
            calls["provider"] += 1
            raise AssertionError("direct provider function must not run")

        pinned_chat_optimizer.__module__ = "skillopt.model"
        model = types.SimpleNamespace(chat_optimizer=pinned_chat_optimizer)
        for name in (
            "chat_optimizer_messages",
            "chat_target",
            "chat_target_messages",
            "chat_messages_with_deployment",
            "chat_with_deployment",
        ):
            setattr(model, name, pinned_chat_optimizer)
        client, output = self._client(encode_response(native_response()))
        with mock.patch.object(runner, "_load_pinned_model_facade", return_value=model):
            installed_client, facade = runner._install_native_optimizer_facade(
                client.channel,
                self.run_id,
            )
            text, _usage = facade("s", "u", retries=3, stage="analyst")
            with self.assertRaisesRegex(runner.RunnerError, "native_model_entrypoint_rejected"):
                model.chat_target("s", "u")
        self.assertIs(installed_client.channel, client.channel)
        self.assertEqual(text, DEFAULT_NATIVE_OPTIMIZER_TEXT)
        self.assertEqual(installed_client.requests, 1)
        self.assertEqual(output.getvalue().count(b"\n"), 1)
        self.assertEqual(calls["provider"], 0)
        self.assertEqual(installed_client.failed_code, "native_model_entrypoint_rejected")

    def test_native_facade_rejects_premature_consumers_and_signature_drift(self) -> None:
        module_name = "skillopt.optimizer.rewrite"
        premature = types.ModuleType(module_name)
        with mock.patch.dict(sys.modules, {module_name: premature}):
            with mock.patch.object(runner, "_load_pinned_model_facade") as load_model:
                with self.assertRaisesRegex(runner.RunnerError, "upstream_consumer_imported_early"):
                    runner._install_native_optimizer_facade(runner.JsonlChannel(io.BytesIO(), io.BytesIO()), self.run_id)
                load_model.assert_not_called()

        def wrong_signature(system: str, user: str) -> tuple[str, dict]:
            return system + user, {}

        with self.assertRaisesRegex(runner.RunnerError, "upstream_model_signature_mismatch"):
            runner._check_chat_optimizer_signature(wrong_signature)

    def test_native_facade_rejects_unexpected_model_module_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_root = Path(temp_dir) / "skillopt"
            model_dir = package_root / "model"
            model_dir.mkdir(parents=True)
            expected_entry = model_dir / "__init__.py"
            expected_entry.write_text("", encoding="utf-8")
            unexpected_entry = package_root / "model.py"
            unexpected_entry.write_text("", encoding="utf-8")
            package_spec = types.SimpleNamespace(
                submodule_search_locations=[str(package_root)]
            )
            model_spec = types.SimpleNamespace(
                origin=str(unexpected_entry),
                submodule_search_locations=[str(model_dir)],
            )
            with mock.patch.object(
                runner,
                "find_spec",
                side_effect=[package_spec, model_spec],
            ), mock.patch.object(runner.importlib, "import_module") as import_module:
                with self.assertRaisesRegex(
                    runner.RunnerError,
                    "upstream_model_entrypoint_unverified",
                ):
                    runner._load_pinned_model_facade()
                import_module.assert_not_called()

    def test_native_cli_requires_only_manifest_and_source_lock(self) -> None:
        args = runner._build_parser().parse_args(
            [
                "optimize-native",
                "--source-lock",
                "scripts/skillopt-source-lock.json",
                "--manifest",
                "/private/run/protocol.json",
                "--runtime-proof",
                "/private/state/native-runtime.json",
                "--runtime-proof-sha256",
                "c" * 64,
            ]
        )
        self.assertEqual(args.command, "optimize-native")
        self.assertEqual(args.source_lock, "scripts/skillopt-source-lock.json")
        self.assertEqual(args.manifest, "/private/run/protocol.json")
        self.assertEqual(args.runtime_proof, "/private/state/native-runtime.json")
        self.assertEqual(args.runtime_proof_sha256, "c" * 64)
        self.assertFalse(hasattr(args, "optimizer_base_url"))
        self.assertFalse(hasattr(args, "optimizer_model"))
        local_args = runner._build_parser().parse_args(
            [
                "optimize",
                "--source-lock",
                "scripts/skillopt-source-lock.json",
                "--manifest",
                "/private/run/protocol.json",
                "--optimizer-base-url",
                "http://127.0.0.1:49101/v1",
                "--target-base-url",
                "http://127.0.0.1:49102/v1",
                "--optimizer-model",
                "local-opt",
                "--target-model",
                "local-target",
            ]
        )
        self.assertEqual(local_args.command, "optimize")
        self.assertEqual(local_args.optimizer_model, "local-opt")
        with self.assertRaisesRegex(runner.RunnerError, "cli_invalid"):
            runner._build_parser().parse_args(
                [
                    "optimize-native",
                    "--source-lock",
                    "lock.json",
                    "--manifest",
                    "/private/run/protocol.json",
                    "--runtime-proof",
                    "/private/state/native-runtime.json",
                    "--runtime-proof-sha256",
                    "c" * 64,
                    "--optimizer-base-url",
                    "http://127.0.0.1:1/v1",
                ]
            )

        with self.assertRaisesRegex(runner.RunnerError, "cli_invalid"):
            runner._build_parser().parse_args(
                [
                    "optimize-native",
                    "--source-lock",
                    "scripts/skillopt-source-lock.json",
                    "--manifest",
                    "/private/run/protocol.json",
                ]
            )

    def test_native_runtime_cli_requires_explicit_path_and_exact_hash(self) -> None:
        args = runner._build_parser().parse_args(
            [
                "verify-native-runtime",
                "--source-lock",
                "scripts/skillopt-source-lock.json",
                "--runtime-proof",
                "/private/state/native-runtime.json",
                "--runtime-proof-sha256",
                "d" * 64,
            ]
        )
        self.assertEqual(args.command, "verify-native-runtime")
        self.assertEqual(args.runtime_proof_sha256, "d" * 64)
        attest_args = runner._build_parser().parse_args(
            ["attest-native-runtime", "--source-lock", "scripts/skillopt-source-lock.json"]
        )
        self.assertEqual(attest_args.command, "attest-native-runtime")
        with self.assertRaisesRegex(runner.RunnerError, "cli_invalid"):
            runner._build_parser().parse_args(
                [
                    "verify-native-runtime",
                    "--source-lock",
                    "scripts/skillopt-source-lock.json",
                    "--runtime-proof",
                    "/private/state/native-runtime.json",
                ]
            )

    def test_native_runtime_attestation_reader_rejects_old_or_modified_proofs(self) -> None:
        unsupported_account = not hasattr(os, "getuid") or os.getuid() == 0
        old_proof = {
            "schema": runner.PRIVATE_RUNTIME_PROOF_SCHEMA,
            "verified": True,
            "venvRoot": "/venv",
            "pythonRealpath": "/venv/bin/python",
            "pythonVersion": "3.13.2",
            "pythonSha256": "a" * 64,
            "dependencyLockSha256": "b" * 64,
            "upstreamCommit": runner.EXPECTED_SOURCE["upstream"]["commit"],
            "importManifestSha256": runner.EXPECTED_SOURCE["importManifest"]["sha256"],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            proof_path = Path(temp_dir).resolve(strict=True) / "native-runtime.json"
            raw = (json.dumps(old_proof, separators=(",", ":")) + "\n").encode("utf-8")
            proof_path.write_bytes(raw)
            proof_path.chmod(0o600)
            digest = hashlib.sha256(raw).hexdigest()
            if unsupported_account:
                with self.assertRaisesRegex(
                    runner.RunnerError,
                    "native_runtime_unsupported_platform",
                ):
                    runner._read_native_runtime_attestation(str(proof_path), digest)
                return
            with self.assertRaisesRegex(runner.RunnerError, "native_runtime_proof_invalid"):
                runner._read_native_runtime_attestation(str(proof_path), digest)
            with self.assertRaisesRegex(runner.RunnerError, "native_runtime_proof_hash_mismatch"):
                runner._read_native_runtime_attestation(str(proof_path), "0" * 64)

            fabricated_native_proof = {
                "schema": runner.NATIVE_RUNTIME_PROOF_SCHEMA,
                "claim": runner.NATIVE_RUNTIME_PROOF_CLAIM,
                "verified": True,
                "wheelOriginStatus": "unobserved",
            }
            raw = (
                json.dumps(fabricated_native_proof, separators=(",", ":")) + "\n"
            ).encode("utf-8")
            proof_path.write_bytes(raw)
            proof_path.chmod(0o600)
            digest = hashlib.sha256(raw).hexdigest()
            with self.assertRaisesRegex(runner.RunnerError, "native_runtime_proof_invalid"):
                runner._read_native_runtime_attestation(str(proof_path), digest)

    def test_locked_dependency_version_parser_reads_pinned_package_set(self) -> None:
        raw = runner._bounded_regular_file(
            ROOT / runner.DEPENDENCY_LOCK_PATH,
            runner.DEPENDENCY_LOCK_MAX_BYTES,
            "dependency_lock_invalid",
        )
        dependencies = runner._locked_dependency_versions(raw)
        self.assertIn("openai", dependencies)
        self.assertEqual(dependencies["openai"], ("openai", "3.24.0"))

    def test_native_sys_path_records_missing_zip_then_detects_appearance_and_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve(strict=True)
            missing_zip = root / "python313.zip"
            with mock.patch.object(sys, "path", [str(missing_zip)]):
                missing = runner._native_sys_path_state()
            self.assertEqual(
                missing,
                [{"path": str(missing_zip), "state": "missing"}],
            )

            missing_zip.write_bytes(b"first runtime archive")
            with mock.patch.object(sys, "path", [str(missing_zip)]):
                first = runner._native_sys_path_state()
            self.assertEqual(first[0]["state"], "file")
            self.assertEqual(first[0]["sha256"], hashlib.sha256(b"first runtime archive").hexdigest())

            missing_zip.write_bytes(b"changed runtime archive")
            with mock.patch.object(sys, "path", [str(missing_zip)]):
                changed = runner._native_sys_path_state()
            self.assertNotEqual(first, changed)

    def test_native_interpreter_requires_no_site_and_no_bytecode_startup_flags(self) -> None:
        flag_cases = (
            types.SimpleNamespace(
                isolated=1,
                no_user_site=1,
                ignore_environment=1,
                no_site=0,
                dont_write_bytecode=1,
            ),
            types.SimpleNamespace(
                isolated=1,
                no_user_site=1,
                ignore_environment=1,
                no_site=1,
                dont_write_bytecode=0,
            ),
        )
        for flags in flag_cases:
            with self.subTest(flags=flags), mock.patch.object(
                runner.sys,
                "flags",
                flags,
            ), mock.patch.object(
                runner.sys,
                "dont_write_bytecode",
                True,
            ), mock.patch.object(
                runner.os,
                "getuid",
                return_value=1000,
            ):
                with mock.patch.dict(
                    runner.os.environ,
                    {"SKILLOPT_PYTHON": str(Path(sys.executable).resolve(strict=True))},
                    clear=True,
                ):
                    with self.assertRaisesRegex(
                        runner.RunnerError,
                        "native_interpreter_unverified",
                    ):
                        runner._verify_native_interpreter()

    def test_native_attestation_is_live_runtime_only_and_binds_exact_bytes(self) -> None:
        configured_python = os.environ.get("SKILLOPT_PYTHON", "")
        python_path = Path(configured_python)
        self.assertTrue(configured_python, "native runtime requires SKILLOPT_PYTHON")
        self.assertTrue(python_path.is_absolute(), "native runtime interpreter path must be absolute")
        self.assertTrue(python_path.is_file(), "configured native runtime interpreter is missing")
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir).resolve(strict=True)
            private_home = temp_root / "home"
            private_tmp = temp_root / "tmp"
            private_cache = temp_root / "cache"
            output_root = temp_root / "output"
            for private_path in (private_home, private_tmp, private_cache, output_root):
                private_path.mkdir(mode=0o700)
            for private_path in (temp_root, private_home, private_tmp, private_cache, output_root):
                self.assertEqual(
                    stat.S_IMODE(private_path.stat().st_mode) & 0o077,
                    0,
                    str(private_path),
                )
            runner_path = (ROOT / "scripts" / "skillopt_runner.py").resolve(strict=True)
            source_venv = python_path.parent.parent.resolve(strict=True)

            # Synthetic test fixture only: this copied uv-created venv has a
            # known bootstrap .pth hook that production deliberately rejects.
            # Remove only that exact one-line hook and its paired module from
            # this disposable copy; never mutate the source installation or
            # treat this fixture as evidence that it is native-ready.
            source_site_packages_candidates = list(
                source_venv.glob("lib/python*/site-packages")
            )
            self.assertEqual(len(source_site_packages_candidates), 1)
            source_site_packages = source_site_packages_candidates[0]
            source_skillopt_package = source_site_packages / "skillopt"
            self.assertTrue(source_skillopt_package.is_dir())
            source_pth = source_site_packages / "_virtualenv.pth"
            source_virtualenv_module = source_site_packages / "_virtualenv.py"

            def snapshot_original_runtime() -> dict[str, str]:
                paths = {
                    python_path,
                    source_pth,
                    source_virtualenv_module,
                    *source_skillopt_package.rglob("*"),
                    *source_site_packages.rglob("*.pyc"),
                }
                return {
                    str(path.relative_to(source_venv)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in sorted(paths)
                    if path.is_file()
                }

            original_runtime_snapshot = snapshot_original_runtime()
            self.assertTrue(original_runtime_snapshot)

            copied_venv_parent = temp_root / "private"
            copied_venv_parent.mkdir(mode=0o700)
            for component in (
                "skillopt",
                "runtime",
                runner.EXPECTED_SOURCE["upstream"]["commit"],
            ):
                copied_venv_parent = copied_venv_parent / component
                copied_venv_parent.mkdir(mode=0o700)
            copied_venv = copied_venv_parent / "venv"
            shutil.copytree(source_venv, copied_venv, symlinks=False)
            copied_venv = copied_venv.resolve(strict=True)
            copied_python = (copied_venv / "bin" / python_path.name).resolve(strict=True)
            self.assertTrue(copied_python.is_file())
            self.assertFalse(copied_python.is_symlink())
            copied_python.chmod(0o700)

            copied_site_packages = copied_venv / source_site_packages.relative_to(source_venv)
            copied_pth = copied_site_packages / "_virtualenv.pth"
            copied_virtualenv_module = copied_site_packages / "_virtualenv.py"
            for path in (source_pth, source_virtualenv_module, copied_pth, copied_virtualenv_module):
                self.assertFalse(path.is_symlink(), str(path))
                self.assertTrue(
                    stat.S_ISREG(path.stat(follow_symlinks=False).st_mode),
                    str(path),
                )
            expected_bootstrap_bytes = {
                b"import _virtualenv",
                b"import _virtualenv\n",
                b"import _virtualenv\r\n",
            }
            source_pth_bytes = source_pth.read_bytes()
            source_virtualenv_module_bytes = source_virtualenv_module.read_bytes()
            self.assertIn(source_pth_bytes, expected_bootstrap_bytes)
            self.assertEqual(copied_pth.read_bytes(), source_pth_bytes)
            self.assertEqual(copied_virtualenv_module.read_bytes(), source_virtualenv_module_bytes)
            bootstrap_removal_receipt: list[str] = []
            copied_pth.unlink()
            bootstrap_removal_receipt.append("_virtualenv.pth")
            copied_virtualenv_module.unlink()
            bootstrap_removal_receipt.append("_virtualenv.py")
            self.assertEqual(
                bootstrap_removal_receipt,
                ["_virtualenv.pth", "_virtualenv.py"],
            )
            self.assertFalse(copied_pth.exists())
            self.assertFalse(copied_virtualenv_module.exists())
            self.assertEqual(source_pth.read_bytes(), source_pth_bytes)
            self.assertEqual(source_virtualenv_module.read_bytes(), source_virtualenv_module_bytes)

            proof_path = (copied_venv.parent / "native-runtime-proof.json").resolve(
                strict=False
            )
            environment = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(private_home),
                "TMPDIR": str(private_tmp),
                "XDG_CACHE_HOME": str(private_cache),
                "SKILLOPT_PYTHON": str(copied_python),
            }
            poisoned_pyc_code = """
import importlib.util, marshal, struct, sys
from pathlib import Path
runner_path = Path(sys.argv[1])
temp_root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("native_pyc_runner", runner_path)
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)
source_root = temp_root / "pyc-source"
output_root = temp_root / "pyc-output"
source_root.mkdir(mode=0o700)
output_root.mkdir(mode=0o700)
source = source_root / "fixture_module.py"
source.write_text("value = 1\\n", encoding="utf-8")
cache = Path(importlib.util.cache_from_source(str(source)))
cache.parent.mkdir(mode=0o700)
poison = compile("value = 0\\n", str(source), "exec")
cache.write_bytes(
    importlib.util.MAGIC_NUMBER
    + struct.pack("<III", 0, int(source.stat().st_mtime), source.stat().st_size)
    + marshal.dumps(poison)
)
sys.path.insert(0, str(source_root))
import fixture_module
assert fixture_module.value == 0
del sys.modules["fixture_module"]
cache_root = runner._prepare_native_import_cache(output_root)
import fixture_module
assert fixture_module.value == 1
assert list(cache_root.iterdir()) == []
print("fresh-source")
"""
            pyc_check = subprocess.run(
                [
                    str(copied_python),
                    "-I",
                    "-S",
                    "-B",
                    "-c",
                    poisoned_pyc_code,
                    str(runner_path),
                    str(temp_root),
                ],
                capture_output=True,
                check=False,
                env=environment,
                cwd=temp_root,
                timeout=60,
                text=True,
            )
            self.assertEqual(pyc_check.returncode, 0, pyc_check.stderr)
            self.assertEqual(pyc_check.stdout.strip(), "fresh-source")
            attested = subprocess.run(
                [
                    str(copied_python),
                    "-I",
                    "-S",
                    "-B",
                    str(runner_path),
                    "attest-native-runtime",
                    "--source-lock",
                    str((ROOT / runner.SOURCE_LOCK_RELATIVE).resolve(strict=True)),
                ],
                capture_output=True,
                check=False,
                env=environment,
                cwd=temp_root,
                timeout=180,
            )
            self.assertEqual(
                attested.returncode,
                0,
                attested.stderr.decode("utf-8", errors="replace"),
            )
            self.assertEqual(attested.stdout.count(b"\n"), 1)
            proof = json.loads(attested.stdout)
            self.assertEqual(proof["schema"], runner.NATIVE_RUNTIME_PROOF_SCHEMA)
            self.assertEqual(proof["claim"], runner.NATIVE_RUNTIME_PROOF_CLAIM)
            self.assertEqual(proof["wheelOriginStatus"], "unobserved")
            self.assertNotIn("verified", proof)
            self.assertTrue(proof["interpreter"]["noSite"])
            self.assertEqual(proof["interpreter"]["dontWriteBytecodeFlag"], 1)
            self.assertTrue(proof["interpreter"]["dontWriteBytecode"])
            self.assertEqual(
                proof["startupSecurity"]["sitePackageSearchPathAdded"],
                False,
            )
            self.assertFalse(proof["startupSecurity"]["pthProcessed"])
            self.assertFalse(proof["startupSecurity"]["sitecustomizeLoaded"])
            digest = hashlib.sha256(attested.stdout).hexdigest()
            proof_path.write_bytes(attested.stdout)
            proof_path.chmod(0o600)
            verified = subprocess.run(
                [
                    str(copied_python),
                    "-I",
                    "-S",
                    "-B",
                    str(runner_path),
                    "verify-native-runtime",
                    "--source-lock",
                    str((ROOT / runner.SOURCE_LOCK_RELATIVE).resolve(strict=True)),
                    "--runtime-proof",
                    str(proof_path),
                    "--runtime-proof-sha256",
                    digest,
                ],
                capture_output=True,
                check=False,
                env=environment,
                cwd=temp_root,
                timeout=180,
            )
            self.assertEqual(
                verified.returncode,
                0,
                verified.stderr.decode("utf-8", errors="replace"),
            )
            self.assertEqual(verified.stdout.count(b"\n"), 1)
            receipt = json.loads(verified.stdout)
            self.assertEqual(receipt["nativeRuntimeProofSha256"], digest)
            self.assertEqual(receipt["wheelOriginStatus"], "unobserved")

            # The v1 proof is bound to the installed interpreter identity and cannot
            # authenticate this relocated copy. Exercise its fail-closed behavior under
            # the verified no-site child instead of treating native proof as v1 proof.
            compatibility_code = """
import importlib.util, json, sys
from pathlib import Path
runner_path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("runner_compat", runner_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
receipt = module.verify_native_runtime(sys.argv[2], sys.argv[3], sys.argv[4])
assert receipt["nativeRuntimeProofSha256"] == sys.argv[4]
native_proof, verified_digest = module._read_native_runtime_attestation(
    sys.argv[3], sys.argv[4]
)
assert verified_digest == receipt["nativeRuntimeProofSha256"]
module._activate_verified_native_site_packages(native_proof)
module._prepare_native_import_cache(Path(sys.argv[5]))
source_lock = Path(sys.argv[2])
assert source_lock.is_absolute()
try:
    module.verify_runtime(str(source_lock))
except module.RunnerError as error:
    assert error.code == "interpreter_unverified", error.code
else:
    raise AssertionError("legacy v1 verifier accepted the native-only private copy")
print("legacy-v1-rejected-native-copy")
model = module._load_pinned_model_facade()
module._check_chat_optimizer_signature(model.chat_optimizer)
print("facade-signature-compatible")
manifest = json.loads(sys.argv[6])
raw = json.dumps(manifest).encode("utf-8")
parsed = module.validate_manifest(json.loads(raw), raw, "b" * 64)
BaseDataLoader, BatchSpec, EnvAdapter = module._load_upstream_types()
adapter_output = Path(sys.argv[5]) / "adapter-output"
adapter_output.mkdir(mode=0o700)
loader_type, adapter_type = module.make_adapter_classes(
    parsed, None, adapter_output
)
loader = loader_type()
adapter = adapter_type()
assert isinstance(loader, BaseDataLoader)
assert isinstance(adapter, EnvAdapter)
assert isinstance(loader.build_train_batch(24, 1), BatchSpec)
assert loader.build_eval_batch(48, "valid_seen", 1).split == "selection"
for split in ("valid_unseen", "test"):
    try:
        loader.build_eval_batch(48, split, 1)
    except module.RunnerError as error:
        assert error.code == "unexpected_split", error.code
    else:
        raise AssertionError("adapter accepted unsupported split: " + split)
print("upstream-interface-compatible")
"""
            with self.subTest(phase="verified_private_facade_signature"):
                compatible = subprocess.run(
                    [
                        str(copied_python),
                        "-I",
                        "-S",
                        "-B",
                        "-c",
                        compatibility_code,
                        str(runner_path),
                        str((ROOT / runner.SOURCE_LOCK_RELATIVE).resolve(strict=True)),
                        str(proof_path),
                        digest,
                        str(output_root),
                        json.dumps(manifest()),
                    ],
                    capture_output=True,
                    check=False,
                    env=environment,
                    cwd=temp_root,
                    timeout=180,
                    text=True,
                )
            self.assertEqual(compatible.returncode, 0, compatible.stderr)
            compatibility_phases = compatible.stdout.splitlines()
            for phase in (
                "legacy-v1-rejected-native-copy",
                "facade-signature-compatible",
                "upstream-interface-compatible",
            ):
                with self.subTest(phase=phase):
                    self.assertIn(phase, compatibility_phases)
            private_pycache_roots = list(output_root.glob("native-pycache-*"))
            self.assertEqual(len(private_pycache_roots), 1)
            self.assertEqual(
                stat.S_IMODE(private_pycache_roots[0].stat().st_mode) & 0o077,
                0,
            )

            startup_prefix = proof["interpreter"]["startupPrefix"]
            startup_base_prefix = proof["interpreter"]["startupBasePrefix"]
            self.assertEqual(proof["interpreter"]["venvRoot"], str(copied_venv))
            self.assertIn(startup_prefix, {str(copied_venv), startup_base_prefix})
            if proof["interpreter"]["version"].startswith("3.13."):
                self.assertEqual(startup_prefix, startup_base_prefix)
                self.assertNotEqual(startup_prefix, str(copied_venv))

            unsafe_venv = temp_root / "unsafe-symlink-venv"
            unsafe_bin = unsafe_venv / "bin"
            unsafe_bin.mkdir(parents=True)
            # Keep startup valid so the attester, not missing stdlib discovery,
            # rejects the symlinked interpreter.
            shutil.copy2(copied_venv / "pyvenv.cfg", unsafe_venv / "pyvenv.cfg")
            unsafe_python = unsafe_bin / "python"
            unsafe_python.symlink_to(copied_python)
            unsafe_environment = {**environment, "SKILLOPT_PYTHON": str(unsafe_python)}
            unsafe_symlink = subprocess.run(
                [
                    str(unsafe_python),
                    "-I",
                    "-S",
                    "-B",
                    str(runner_path),
                    "attest-native-runtime",
                    "--source-lock",
                    str((ROOT / runner.SOURCE_LOCK_RELATIVE).resolve(strict=True)),
                ],
                capture_output=True,
                check=False,
                env=unsafe_environment,
                cwd=temp_root,
                timeout=180,
            )
            self.assertEqual(unsafe_symlink.returncode, 2)
            self.assertIn(
                b"error_code=native_interpreter_unverified",
                unsafe_symlink.stderr,
            )
            self.assertEqual(unsafe_symlink.stdout, b"")

            site_packages = Path(proof["sitePackages"]["roots"][0])
            marker = temp_root / "pth-executed"
            marker_pth = site_packages / "native-test-marker.pth"
            marker_pth.write_text(
                "import pathlib; pathlib.Path(" + repr(str(marker)) + ").write_text('executed')\n",
                encoding="utf-8",
            )
            rejected_pth = subprocess.run(
                [
                    str(copied_python),
                    "-I",
                    "-S",
                    "-B",
                    str(runner_path),
                    "attest-native-runtime",
                    "--source-lock",
                    str((ROOT / runner.SOURCE_LOCK_RELATIVE).resolve(strict=True)),
                ],
                capture_output=True,
                check=False,
                env=environment,
                cwd=temp_root,
                timeout=180,
            )
            self.assertEqual(rejected_pth.returncode, 2)
            self.assertIn(
                b"error_code=native_site_packages_unverified",
                rejected_pth.stderr,
            )
            self.assertFalse(marker.exists())

            marker_pth.unlink()
            original_mode = copied_venv.stat(follow_symlinks=False).st_mode & 0o777
            copied_venv.chmod(0o777)
            unsafe_copy = subprocess.run(
                [
                    str(copied_python),
                    "-I",
                    "-S",
                    "-B",
                    str(runner_path),
                    "attest-native-runtime",
                    "--source-lock",
                    str((ROOT / runner.SOURCE_LOCK_RELATIVE).resolve(strict=True)),
                ],
                capture_output=True,
                check=False,
                env=environment,
                cwd=temp_root,
                timeout=180,
            )
            copied_venv.chmod(original_mode)
            self.assertEqual(unsafe_copy.returncode, 2)
            self.assertIn(b"error_code=native_interpreter_unverified", unsafe_copy.stderr)
            self.assertEqual(unsafe_copy.stdout, b"")
            self.assertEqual(snapshot_original_runtime(), original_runtime_snapshot)


class BackendAndConversationTests(unittest.TestCase):
    def test_meter_port_aliases_have_one_canonical_identity(self) -> None:
        for host in ("127.0.0.1", "[::1]"):
            with self.subTest(host=host):
                canonical = runner._validate_meter_url(f"http://{host}:49301/v1")
                self.assertEqual(
                    runner._validate_meter_url(f"http://{host}:049301/v1"),
                    canonical,
                )
                self.assertNotEqual(
                    runner._validate_meter_url(f"http://{host}:49302/v1"),
                    canonical,
                )

    def test_backend_accepts_only_distinct_literal_loopback_meters(self) -> None:
        self.assertEqual(
            runner._validate_meter_url("http://127.0.0.1:49301/v1"),
            "http://127.0.0.1:49301/v1",
        )
        for value in (
            "https://127.0.0.1:49301/v1",
            "http://localhost:49301/v1",
            "http://10.0.0.1:49301/v1",
            "http://127.0.0.1:49301/v1?to=https://remote.invalid",
            "http://user:password@127.0.0.1:49301/v1",
        ):
            with self.subTest(value=value), self.assertRaisesRegex(
                runner.RunnerError, "local_backend_required"
            ):
                runner._validate_meter_url(value)

    def test_conversation_rejects_unknown_fields_roles_and_oversize(self) -> None:
        with self.assertRaisesRegex(runner.RunnerError, "response_invalid"):
            runner._validate_conversation(
                [
                    {"role": "user", "content": "q", "gold": "hidden"},
                    {"role": "assistant", "content": "a"},
                ]
            )
        with self.assertRaisesRegex(runner.RunnerError, "response_invalid"):
            runner._validate_conversation(
                [
                    {"role": "controller", "content": "q"},
                    {"role": "assistant", "content": "a"},
                ]
            )
        with self.assertRaisesRegex(runner.RunnerError, "response_oversized"):
            runner._validate_conversation(
                [
                    {"role": "user", "content": "x" * (runner.MAX_MESSAGE_BYTES + 1)},
                    {"role": "assistant", "content": "a"},
                ]
            )

    def test_upstream_diagnostics_are_bounded_and_never_export_raw_text(self) -> None:
        capture = runner._CaptureUpstreamOutput()
        capture.stdout_capture.write(
            "[STEP 1/1 done] epoch=1 action=reject current=0.5 best=0.5 dt=1s\n"
            "prompt body /Users/private/credential.txt"
        )
        capture.stderr_capture.write("Traceback (most recent call last):\nsecret-token")
        diagnostics = capture.diagnostics()
        serialized = json.dumps(diagnostics)
        self.assertIn("trainer_step", serialized)
        self.assertEqual(diagnostics["errorMarkers"], 1)
        self.assertNotIn("prompt body", serialized)
        self.assertNotIn("credential.txt", serialized)
        self.assertNotIn("secret-token", serialized)

    def test_upstream_log_capture_keeps_only_sanitized_metadata(self) -> None:
        capture = runner._SanitizedLogCapture()
        record = logging.LogRecord(
            name="skillopt.model.backend",
            level=logging.ERROR,
            pathname="/private/path.py",
            lineno=10,
            msg="secret model prompt",
            args=(),
            exc_info=None,
        )
        capture.emit(record)
        self.assertEqual(capture.error_count, 1)
        self.assertEqual(capture.logger_names, ["skillopt.model.backend"])
        self.assertNotIn("secret model prompt", json.dumps(capture.logger_names))

    def test_fixed_trainer_config_uses_the_manifest_size_and_never_tests(self) -> None:
        raw = json.dumps(manifest()).encode("utf-8")
        parsed = runner.validate_manifest(json.loads(raw), raw, "b" * 64)
        config = runner._trainer_config(
            parsed, Path("/private/run/skillopt-output"), "local-opt", "local-target"
        )
        self.assertEqual((config["num_epochs"], config["batch_size"], config["accumulation"]), (1, 24, 1))
        self.assertEqual(config["sel_env_num"], 48)
        self.assertEqual(config["merge_batch_size"], 24)
        self.assertTrue(config["use_gate"])
        self.assertFalse(config["eval_test"])
        self.assertEqual(config["test_env_num"], 0)
        self.assertFalse(config["use_slow_update"])
        self.assertFalse(config["use_meta_skill"])
        self.assertFalse(config["use_semantic_density"])
        self.assertEqual(config["skill_init"], "/private/run/skillopt-output/empty-initial-skill.md")


class NativeRuntimeAcceptanceCliTests(unittest.TestCase):
    @staticmethod
    def _args() -> list[str]:
        return [
            "verify-native-acceptance",
            "--source-lock", "/synthetic/source-lock.json",
            "--runtime-proof", "/synthetic/private/native-runtime-proof.json",
            "--runtime-proof-sha256", "d" * 64,
        ]

    @staticmethod
    def _synthetic_verification() -> dict[str, Any]:
        return {
            "schema": "skillopt.native-runtime-verification.v1",
            "ok": True,
            "claim": "verified_against_observed_local_runtime_pin",
            "nativeRuntimeProofSha256": "d" * 64,
            "sourceLockSha256": "a" * 64,
            "dependencyLockSha256": "b" * 64,
            "upstreamCommit": "c" * 40,
            "upstreamVersion": "0.2.0",
            "importManifestSha256": "e" * 64,
            "licenseSha256": "f" * 64,
            "installedDependencyFingerprintSha256": "1" * 64,
            "pythonVersion": "3.13.2",
            "pythonSha256": "2" * 64,
            "platform": "synthetic-darwin-arm64",
            "wheelOriginStatus": "unobserved",
        }

    @staticmethod
    def _run_cli(args: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        original_write = runner.os.write

        def capture_write(fd: int, data: bytes) -> int:
            if fd == 2:
                stderr.write(data.decode("ascii"))
                return len(data)
            return original_write(fd, data)

        with mock.patch.object(runner.sys, "stdout", stdout), mock.patch.object(
            runner.sys, "stderr", stderr
        ), mock.patch.object(runner.os, "write", side_effect=capture_write):
            code = runner.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_native_success_receipt_keeps_other_acceptance_scopes_unverified(self) -> None:
        verification = self._synthetic_verification()
        with mock.patch.object(
            runner, "verify_native_runtime", return_value=verification
        ) as native_verify, mock.patch.object(
            runner, "verify_runtime", side_effect=AssertionError("legacy verifier called")
        ) as legacy_verify, mock.patch.object(
            runner, "attest_native_runtime", side_effect=AssertionError("attester called")
        ) as attest:
            code, stdout, stderr = self._run_cli(self._args())

        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(stdout.count("\n"), 1)
        self.assertLessEqual(
            len(stdout.encode("utf-8")),
            runner.NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES,
        )
        native_verify.assert_called_once_with(
            "/synthetic/source-lock.json",
            "/synthetic/private/native-runtime-proof.json",
            "d" * 64,
        )
        legacy_verify.assert_not_called()
        attest.assert_not_called()

        receipt = json.loads(stdout)
        self.assertEqual(receipt["schema"], "skillopt.native-runtime-acceptance.v1")
        self.assertEqual(
            receipt["nativeRuntime"],
            {"status": "verified", "verification": verification},
        )
        self.assertEqual(
            receipt["legacyRuntime"], {"status": "not_run", "verified": False}
        )
        self.assertEqual(receipt["containment"], {"status": "not_evaluated"})
        self.assertEqual(receipt["modelQualification"], {"status": "not_evaluated"})
        self.assertEqual(receipt["release"], {"authorized": False})
        self.assertEqual(receipt["production"], {"authorized": False})
        self.assertNotIn("READY", stdout)

    def test_receipt_serialized_byte_limit_accepts_exact_bound_and_rejects_one_less(self) -> None:
        verification = self._synthetic_verification()
        expected_receipt = {
            "schema": "skillopt.native-runtime-acceptance.v1",
            "nativeRuntime": {"status": "verified", "verification": verification},
            "legacyRuntime": {"status": "not_run", "verified": False},
            "containment": {"status": "not_evaluated"},
            "modelQualification": {"status": "not_evaluated"},
            "release": {"authorized": False},
            "production": {"authorized": False},
        }
        exact_limit = len(
            json.dumps(expected_receipt, separators=(",", ":")).encode("utf-8")
        ) + 1
        original_limit = runner.NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES

        with mock.patch.object(
            runner, "verify_native_runtime", return_value=verification
        ) as native_verify:
            with mock.patch.object(
                runner,
                "NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES",
                exact_limit,
            ):
                accepted_code, accepted_stdout, accepted_stderr = self._run_cli(
                    self._args()
                )
            self.assertEqual(accepted_code, 0)
            self.assertEqual(accepted_stderr, "")
            self.assertEqual(len(accepted_stdout.encode("utf-8")), exact_limit)

            with mock.patch.object(
                runner,
                "NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES",
                exact_limit - 1,
            ):
                refused_code, refused_stdout, refused_stderr = self._run_cli(
                    self._args()
                )
            self.assertEqual(refused_code, 2)
            self.assertEqual(refused_stdout, "")
            self.assertIn("native_runtime_acceptance_receipt_oversized", refused_stderr)

        self.assertEqual(runner.NATIVE_RUNTIME_ACCEPTANCE_RECEIPT_MAX_BYTES, original_limit)
        self.assertEqual(native_verify.call_count, 2)

    def test_native_proof_refusal_emits_no_receipt_and_never_falls_back(self) -> None:
        with mock.patch.object(
            runner,
            "verify_native_runtime",
            side_effect=runner.RunnerError("native_runtime_proof_mismatch"),
        ) as native_verify, mock.patch.object(
            runner, "verify_runtime", side_effect=AssertionError("legacy verifier called")
        ) as legacy_verify, mock.patch.object(
            runner, "attest_native_runtime", side_effect=AssertionError("attester called")
        ) as attest:
            code, stdout, stderr = self._run_cli(self._args())

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("native_runtime_proof_mismatch", stderr)
        native_verify.assert_called_once()
        legacy_verify.assert_not_called()
        attest.assert_not_called()

    def test_acceptance_cli_rejects_missing_and_malformed_pins(self) -> None:
        missing_pin_args = self._args()[:-2]
        with mock.patch.object(runner, "verify_native_runtime") as native_verify:
            code, stdout, stderr = self._run_cli(missing_pin_args)
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("cli_invalid", stderr)
        native_verify.assert_not_called()

        malformed_pin_args = self._args()
        malformed_pin_args[-1] = "not-a-sha256-pin"
        with mock.patch.object(
            runner, "verify_runtime", side_effect=AssertionError("legacy verifier called")
        ) as legacy_verify, mock.patch.object(
            runner, "attest_native_runtime", side_effect=AssertionError("attester called")
        ) as attest:
            code, stdout, stderr = self._run_cli(malformed_pin_args)
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("native_runtime_proof_hash_invalid", stderr)
        legacy_verify.assert_not_called()
        attest.assert_not_called()


class OptimizerExitPolicyTests(unittest.TestCase):
    @staticmethod
    def _native_args() -> list[str]:
        return [
            "optimize-native",
            "--source-lock", "/unused/source-lock.json",
            "--manifest", "/unused/manifest.json",
            "--runtime-proof", "/unused/runtime-proof.json",
            "--runtime-proof-sha256", "a" * 64,
        ]

    @staticmethod
    def _legacy_args() -> list[str]:
        return [
            "optimize",
            "--source-lock", "/unused/source-lock.json",
            "--manifest", "/unused/manifest.json",
            "--optimizer-base-url", "http://127.0.0.1:1/v1",
            "--target-base-url", "http://127.0.0.1:2/v1",
            "--optimizer-model", "optimizer",
            "--target-model", "target",
        ]

    def test_native_completed_no_improvement_is_a_clean_worker_exit(self) -> None:
        with mock.patch.object(
            runner, "optimize_native", return_value=("no_improvement", {})
        ):
            self.assertEqual(runner.main(self._native_args()), 0)

    def test_legacy_no_improvement_exit_code_is_unchanged(self) -> None:
        with mock.patch.object(
            runner, "optimize", return_value=("no_improvement", {})
        ):
            self.assertEqual(runner.main(self._legacy_args()), 4)

    def test_native_incomplete_and_unknown_statuses_remain_nonzero(self) -> None:
        for status in ("incomplete", "unknown"):
            with self.subTest(status=status), mock.patch.object(
                runner, "optimize_native", return_value=(status, {})
            ):
                self.assertEqual(runner.main(self._native_args()), 4)


if __name__ == "__main__":
    unittest.main()
