from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path


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


class UpstreamInterfaceTests(unittest.TestCase):
    def test_loader_and_adapter_use_real_pinned_abstract_interfaces(self) -> None:
        BaseDataLoader, BatchSpec, EnvAdapter = runner._load_upstream_types()
        raw = json.dumps(manifest()).encode("utf-8")
        parsed = runner.validate_manifest(json.loads(raw), raw, "b" * 64)
        with tempfile.TemporaryDirectory() as temp_dir:
            loader_type, adapter_type = runner.make_adapter_classes(
                parsed, None, Path(temp_dir)
            )
            loader = loader_type()
            adapter = adapter_type()
            self.assertIsInstance(loader, BaseDataLoader)
            self.assertIsInstance(adapter, EnvAdapter)
            self.assertIsInstance(loader.build_train_batch(24, 1), BatchSpec)
            self.assertEqual(
                loader.build_eval_batch(48, "valid_seen", 1).split,
                "selection",
            )
            with self.assertRaisesRegex(runner.RunnerError, "unexpected_split"):
                loader.build_eval_batch(48, "valid_unseen", 1)
            with self.assertRaisesRegex(runner.RunnerError, "unexpected_split"):
                loader.build_eval_batch(48, "test", 1)


if __name__ == "__main__":
    unittest.main()
