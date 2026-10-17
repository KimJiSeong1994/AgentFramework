"""Pure input/reference validation for the Linux verifier gate.

These tests exercise parsing, shape checks and crypto transport with ephemeral
test keys. They do not establish native ownership or retirement authority.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / "scripts" / "linux-verifier"))

import gate  # noqa: E402
import install  # noqa: E402
import runner  # noqa: E402


def make_tar(entries: list[tuple[str, bytes, int]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for name, content, mode in entries:
            info = tarfile.TarInfo(name)
            info.mode = mode
            if name.endswith("/"):
                info.type = tarfile.DIRTYPE
                info.size = 0
                archive.addfile(info)
            else:
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def make_reference() -> dict[str, object]:
    tree = "a" * 40
    return {
        "kind": "verifier",
        "executionID": "execution-1",
        "profile": "linux-single-use",
        "invocationID": "0123456789abcdef0123456789abcdef",
        "inputSnapshotID": tree,
        "inputDigest": hashlib.sha256(tree.encode("ascii")).hexdigest(),
        "deadlineAt": 1_900_000_000_000,
        "maxOutputChars": 256,
        "unit": "otter-verifier.service",
        "bootID": "d2c6325f-8c1b-4633-9669-b881d0c2b364",
    }


class ReferenceValidationTests(unittest.TestCase):
    def test_accepts_only_immutable_linux_ticket_fields(self) -> None:
        value = make_reference()
        self.assertEqual(gate.validate_reference(value), value)

    def test_rejects_native_binding_fields_and_mismatched_digest(self) -> None:
        value = make_reference()
        value["cgroupInode"] = 123  # type: ignore[index]
        with self.assertRaises(ValueError):
            gate.validate_reference(value)
        value = make_reference()
        value["inputDigest"] = "0" * 64  # type: ignore[index]
        with self.assertRaises(ValueError):
            gate.validate_reference(value)

    def test_rejects_boolean_integer_fields_and_nonfixed_unit(self) -> None:
        value = make_reference()
        value["maxOutputChars"] = True  # type: ignore[index]
        with self.assertRaises(ValueError):
            gate.validate_reference(value)
        value = make_reference()
        value["unit"] = "foreign.service"  # type: ignore[index]
        with self.assertRaises(ValueError):
            gate.validate_reference(value)

    def test_prepare_preserves_command_and_informational_cwd_exactly(self) -> None:
        tree = "b" * 40
        command = "  printf '%s' 'value with spaces'  "
        cwd = "/original/worktree/with spaces"
        value = {
            "executionID": "execution-2",
            "profile": "linux-single-use",
            "command": command,
            "cwd": cwd,
            "inputSnapshotID": tree,
            "inputDigest": hashlib.sha256(tree.encode("ascii")).hexdigest(),
            "deadlineAt": 1_600_000_060_000,
            "maxOutputChars": 128,
            "inputArchive": base64.b64encode(make_tar([("file.txt", b"body", 0o644)])).decode("ascii"),
        }
        normalized = gate.validate_prepare_request(value, now_ms=1_600_000_000_000)
        self.assertEqual(normalized["command"], command)
        self.assertEqual(normalized["cwd"], cwd)
        self.assertEqual(normalized["archive"], base64.b64decode(value["inputArchive"]))

    def test_prepare_rejects_expired_deadline_bad_digest_and_unbounded_output(self) -> None:
        tree = "c" * 40
        base = {
            "executionID": "execution-3",
            "profile": "linux-single-use",
            "command": "true",
            "cwd": "/repo",
            "inputSnapshotID": tree,
            "inputDigest": hashlib.sha256(tree.encode("ascii")).hexdigest(),
            "deadlineAt": 2_000,
            "maxOutputChars": 128,
            "inputArchive": base64.b64encode(make_tar([("file.txt", b"body", 0o644)])).decode("ascii"),
        }
        with self.assertRaises(ValueError):
            gate.validate_prepare_request(base, now_ms=2_000)
        altered = dict(base, deadlineAt=4_000, inputDigest="0" * 64)
        with self.assertRaises(ValueError):
            gate.validate_prepare_request(altered, now_ms=1_000)
        altered = dict(base, deadlineAt=4_000, maxOutputChars=gate.MAX_OUTPUT_CHARS + 1)
        with self.assertRaises(ValueError):
            gate.validate_prepare_request(altered, now_ms=1_000)

    def test_prepare_rejects_deadlines_beyond_the_fixed_runtime_cap(self) -> None:
        tree = "d" * 40
        now = 1_600_000_000_000
        value = {
            "executionID": "execution-runtime-cap",
            "profile": "linux-single-use",
            "command": "true",
            "cwd": "/repo",
            "inputSnapshotID": tree,
            "inputDigest": hashlib.sha256(tree.encode("ascii")).hexdigest(),
            "deadlineAt": now + gate.MAX_RUNTIME_MS + 1,
            "maxOutputChars": 128,
            "inputArchive": base64.b64encode(make_tar([("file.txt", b"body", 0o644)])).decode("ascii"),
        }
        with self.assertRaisesRegex(ValueError, "120-second"):
            gate.validate_prepare_request(value, now_ms=now)
        value["deadlineAt"] = now + gate.MAX_RUNTIME_MS
        self.assertEqual(
            gate.validate_prepare_request(value, now_ms=now)["deadlineAt"],
            now + gate.MAX_RUNTIME_MS,
        )


class ArchiveValidationTests(unittest.TestCase):
    def test_closes_the_archive_stream_on_success_and_both_error_paths(self) -> None:
        for archive, valid in [
            (make_tar([("file", b"body", 0o644)]), True),
            (make_tar([("../escape", b"body", 0o644)]), False),
            (b"not a tar archive", False),
        ]:
            with self.subTest(valid=valid, size=len(archive)):
                stream = tempfile.SpooledTemporaryFile(max_size=1)
                with patch.object(gate.tempfile, "SpooledTemporaryFile", return_value=stream):
                    if valid:
                        self.assertEqual(len(gate.parse_input_archive(archive)), 1)
                    else:
                        with self.assertRaises(ValueError):
                            gate.parse_input_archive(archive)
                self.assertTrue(stream.closed)

    def test_accepts_bounded_regular_files_and_directories(self) -> None:
        archive = make_tar([("src/", b"", 0o755), ("src/run.py", b"print(1)\n", 0o755)])
        entries = gate.parse_input_archive(archive)
        self.assertEqual([(entry.path, entry.kind, entry.mode, entry.content) for entry in entries], [
            (b"src", "directory", 0o040000, b""),
            (b"src/run.py", "file", 0o100755, b"print(1)\n"),
        ])

    def test_rejects_traversal_symlink_hardlink_special_and_duplicates(self) -> None:
        traversal = make_tar([("../escape", b"x", 0o644)])
        with self.assertRaises(ValueError):
            gate.parse_input_archive(traversal)

        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            link = tarfile.TarInfo("link")
            link.type = tarfile.SYMTYPE
            link.linkname = "target"
            archive.addfile(link)
        with self.assertRaises(ValueError):
            gate.parse_input_archive(output.getvalue())

        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            link = tarfile.TarInfo("hardlink")
            link.type = tarfile.LNKTYPE
            link.linkname = "target"
            archive.addfile(link)
        with self.assertRaises(ValueError):
            gate.parse_input_archive(output.getvalue())

        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            special = tarfile.TarInfo("fifo")
            special.type = tarfile.FIFOTYPE
            archive.addfile(special)
        with self.assertRaises(ValueError):
            gate.parse_input_archive(output.getvalue())

        duplicate = make_tar([("same", b"a", 0o644), ("same", b"b", 0o644)])
        with self.assertRaises(ValueError):
            gate.parse_input_archive(duplicate)

    def test_rejects_unsupported_pax_metadata_and_trailing_data(self) -> None:
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
            info = tarfile.TarInfo("file")
            info.pax_headers = {"GNU.sparse.size": "1"}
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaises(ValueError):
            gate.parse_input_archive(output.getvalue())

        malformed = make_tar([("file", b"x", 0o644)]) + b"not-zero"
        with self.assertRaises(ValueError):
            gate.parse_input_archive(malformed)


class JournalCorrelationTests(unittest.TestCase):
    def test_uses_compact_boot_selector_and_rejects_uncorrelated_events(self) -> None:
        binding = {"bootID": make_reference()["bootID"], "systemdInvocationID": "c" * 32}
        compact_boot = binding["bootID"].replace("-", "")
        event = {
            "_PID": "1", "_UID": "0", "_BOOT_ID": compact_boot,
            "UNIT": gate.UNIT, "INVOCATION_ID": binding["systemdInvocationID"],
            "MESSAGE_ID": gate.DEACTIVATED_MESSAGE_ID,
        }
        with patch.object(gate.os.path, "isfile", return_value=True):
            with patch.object(gate.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(event).encode(), stderr=b"",
            )) as run:
                self.assertEqual(gate._journal_retirement(binding), gate.DEACTIVATED_MESSAGE_ID)
                self.assertIn(f"--boot={compact_boot}", run.call_args.args[0])
            for field in event:
                with self.subTest(field=field):
                    forged = {**event, field: "uncorrelated"}
                    with patch.object(gate.subprocess, "run", return_value=subprocess.CompletedProcess(
                        [], 0, stdout=json.dumps(forged).encode(), stderr=b"",
                    )):
                        self.assertIsNone(gate._journal_retirement(binding))


class AdmissionHealthTests(unittest.TestCase):
    CURRENT_BOOT = "d2c6325f-8c1b-4633-9669-b881d0c2b364"

    def _record(
        self,
        directory: str,
        index: int,
        *,
        state: str = "prepared",
        archive_bytes: int = 1,
        deadline_at: int = 1_900_000_000_000,
        binding_boot: str | None = None,
    ) -> dict[str, object]:
        binding = {"bootID": binding_boot} if binding_boot is not None else None
        return {
            "state": state,
            "archiveBytes": archive_bytes,
            "inputPath": os.path.join(directory, f"missing-input-{index}"),
            "reference": {"executionID": f"existing-{index}", "deadlineAt": deadline_at},
            "binding": binding,
        }

    def _health(self, records: list[dict[str, object]], directory: str, *, now_ms: int | None = None) -> dict[str, object]:
        patches = [
            patch.object(gate, "STATE_DIR", directory),
            patch.object(gate, "QUARANTINE_PATH", os.path.join(directory, "quarantine.json")),
            patch.object(gate, "_boot_id", return_value=self.CURRENT_BOOT),
            patch.object(gate, "_journal_health", return_value={
                "persistentEffective": True, "persistentEntry": True, "readable": True,
            }),
        ]
        if now_ms is not None:
            patches.append(patch.object(gate.time, "time", return_value=now_ms / 1000))
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            return gate._admission_health({"bootEpoch": self.CURRENT_BOOT}, records)

    def test_capacity_health_reports_fifteen_and_sixteen_tickets_and_byte_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fifteen = [self._record(directory, index) for index in range(15)]
            sixteen = [self._record(directory, index) for index in range(16)]
            health_15 = self._health(fifteen, directory)
            health_16 = self._health(sixteen, directory)
            self.assertEqual((health_15["pendingTickets"], health_15["pendingBytes"]), (15, 15))
            self.assertTrue(health_15["capacityAvailable"])
            self.assertEqual(health_16["pendingTickets"], 16)
            self.assertFalse(health_16["capacityAvailable"])
            self.assertFalse(health_16["quarantineRequired"])

            one_byte_left = [self._record(directory, 20, archive_bytes=gate.MAX_PENDING_ARCHIVE_BYTES - 1)]
            at_byte_cap = [self._record(directory, 21, archive_bytes=gate.MAX_PENDING_ARCHIVE_BYTES)]
            self.assertTrue(self._health(one_byte_left, directory)["capacityAvailable"])
            self.assertFalse(self._health(at_byte_cap, directory)["capacityAvailable"])

    def test_epoch_mismatch_with_zero_records_latches_permanently(self) -> None:
        old_boot = "01234567-89ab-cdef-0123-456789abcdef"
        with tempfile.TemporaryDirectory() as directory:
            latch = os.path.join(directory, "quarantine.json")
            with patch.object(gate, "STATE_DIR", directory), \
                    patch.object(gate, "QUARANTINE_PATH", latch), \
                    patch.object(gate, "_boot_id", return_value=self.CURRENT_BOOT), \
                    patch.object(gate, "_journal_health", return_value={
                        "persistentEffective": True, "persistentEntry": True, "readable": True,
                    }), \
                    patch.object(gate.os, "fchown"):
                first = gate._admission_health({"bootEpoch": old_boot}, [])
                before = Path(latch).read_bytes()
                self.assertFalse(first["bootEpochMatch"])
                self.assertEqual(first["unknownBound"], 0)
                self.assertTrue(first["quarantineRequired"])
                self.assertTrue(first["latched"])
                self.assertIn("boot-epoch", first["reasons"])
                self.assertEqual(Path(latch).stat().st_mode & 0o777, 0o600)

                with patch.object(gate, "_create_quarantine_latch", side_effect=AssertionError("latch rewrite")):
                    restored = gate._admission_health({"bootEpoch": self.CURRENT_BOOT}, [])
                self.assertTrue(restored["bootEpochMatch"])
                self.assertTrue(restored["latched"])
                self.assertTrue(restored["quarantineRequired"])
                self.assertIn("latched", restored["reasons"])
                self.assertEqual(Path(latch).read_bytes(), before)

    def test_current_boot_active_staleness_uses_strict_deadline_plus_grace(self) -> None:
        now_ms = 1_700_000_000_000
        with tempfile.TemporaryDirectory() as directory, patch.object(gate.os, "fchown"):
            at_threshold = self._record(
                directory, 0, state="running", deadline_at=now_ms - 120_000, binding_boot=self.CURRENT_BOOT,
            )
            stale = self._record(
                directory, 1, state="retiring", deadline_at=now_ms - 120_001, binding_boot=self.CURRENT_BOOT,
            )
            fresh = self._health([at_threshold], directory, now_ms=now_ms)
            stale_health = self._health([stale], directory, now_ms=now_ms)
            self.assertEqual(fresh["staleActive"], 0)
            self.assertNotIn("stale-active", fresh["reasons"])
            self.assertEqual(stale_health["staleActive"], 1)
            self.assertIn("stale-active", stale_health["reasons"])
            self.assertTrue(stale_health["quarantineRequired"])

    def test_journal_failures_refuse_but_do_not_create_quarantine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(gate, "STATE_DIR", directory), \
                    patch.object(gate, "QUARANTINE_PATH", os.path.join(directory, "quarantine.json")), \
                    patch.object(gate, "_boot_id", return_value=self.CURRENT_BOOT), \
                    patch.object(gate, "_journal_health", return_value={
                        "persistentEffective": False, "persistentEntry": False, "readable": False,
                    }):
                health = gate._admission_health({"bootEpoch": self.CURRENT_BOOT}, [])
            self.assertEqual(health["reasons"], ["journal-persistence", "journal-entry", "journal-readable"])
            self.assertFalse(health["quarantineRequired"])
            self.assertFalse(health["latched"])
            self.assertFalse(os.path.lexists(os.path.join(directory, "quarantine.json")))


class JournalAdmissionTests(unittest.TestCase):
    BOOT_ID = "d2c6325f-8c1b-4633-9669-b881d0c2b364"

    def test_effective_storage_uses_only_last_journal_setting_from_installed_dropin(self) -> None:
        valid = """# /usr/lib/systemd/journald.conf
[Other]
Storage=volatile
[Journal]
Storage=volatile
# /etc/systemd/journald.conf.d/otter-verifier.conf
[Journal]
Storage=persistent
"""
        self.assertTrue(gate._journal_storage_is_persistent(valid))
        self.assertFalse(gate._journal_storage_is_persistent(valid + "# /etc/systemd/journald.conf.d/90-override.conf\n[Journal]\nStorage=volatile\n"))
        self.assertFalse(gate._journal_storage_is_persistent(valid + "# /etc/systemd/journald.conf.d/90-override.conf\n[Journal]\nStorage=persistent\n"))
        self.assertTrue(gate._journal_storage_is_persistent(valid + "# /etc/systemd/journald.conf.d/90-override.conf\n[Other]\nStorage=volatile\n"))
        self.assertFalse(gate._journal_storage_is_persistent(
            "# /etc/systemd/journald.conf.d/otter-verifier.conf\n[Journal]\nStorage=volatile\n"
        ))
        self.assertFalse(gate._journal_storage_is_persistent(
            "# /etc/systemd/journald.conf\n[Journal]\nStorage=persistent\n"
        ))
        self.assertFalse(gate._journal_storage_is_persistent(
            "# /etc/systemd/journald.conf.d/otter-verifier.conf\n[Journal]\nStorage=\n"
        ))

    def test_persistent_and_default_queries_require_current_boot_pid_one_json(self) -> None:
        boot = "d2c6325f-8c1b-4633-9669-b881d0c2b364"
        compact = boot.replace("-", "")
        entry = json.dumps({"_PID": "1", "_BOOT_ID": compact}).encode("utf-8") + b"\n"
        with patch.object(gate, "_bounded_command_output", return_value=entry) as run:
            self.assertTrue(gate._journal_has_current_pid1_entry(boot, "/var/log/journal/0123456789abcdef0123456789abcdef"))
            arguments = run.call_args.args[0]
            self.assertIn("--directory=/var/log/journal/0123456789abcdef0123456789abcdef", arguments)
            self.assertIn(f"--boot={compact}", arguments)
            self.assertIn("_PID=1", arguments)
        with patch.object(gate, "_bounded_command_output", return_value=b""):
            self.assertFalse(gate._journal_has_current_pid1_entry(boot, None))
        with patch.object(gate, "_bounded_command_output", return_value=entry.replace(compact.encode(), b"0" * 32)):
            self.assertFalse(gate._journal_has_current_pid1_entry(boot, None))

    def _health_with_journald_probes(self, status: bytes | None, entry: bytes | None) -> dict[str, bool]:
        def command_output(arguments: list[str], **_kwargs: object) -> bytes | None:
            return status if arguments[0] == gate.SYSTEMCTL else entry

        with patch.object(gate, "_persistent_journal_directory", return_value="/var/log/journal/test"), \
                patch.object(gate, "_journal_config_is_persistent", return_value=True), \
                patch.object(gate, "_bounded_command_output", side_effect=command_output) as run:
            health = gate._journal_health(self.BOOT_ID)
        systemd_call = next(call for call in run.call_args_list if call.args[0][0] == gate.SYSTEMCTL)
        self.assertEqual(systemd_call.args[0], [
            gate.SYSTEMCTL, "show", "--no-pager", "--property=ActiveState,SubState", "systemd-journald.service",
        ])
        self.assertEqual(systemd_call.kwargs, {"timeout": 5, "max_bytes": 16 * 1024})
        return health

    def test_readable_requires_active_running_journald_and_existing_pid1_entry(self) -> None:
        compact = self.BOOT_ID.replace("-", "")
        entry = json.dumps({"_PID": "1", "_BOOT_ID": compact}).encode("utf-8") + b"\n"
        healthy = self._health_with_journald_probes(b"ActiveState=active\nSubState=running\n", entry)
        self.assertTrue(healthy["persistentEntry"])
        self.assertTrue(healthy["readable"])

        stopped = self._health_with_journald_probes(b"ActiveState=inactive\nSubState=dead\n", entry)
        self.assertTrue(stopped["persistentEntry"])
        self.assertFalse(stopped["readable"])

        malformed = self._health_with_journald_probes(
            b"ActiveState=active\nActiveState=inactive\nSubState=running\n", entry,
        )
        self.assertFalse(malformed["readable"])
        unavailable = self._health_with_journald_probes(None, entry)
        self.assertFalse(unavailable["readable"])

        unreadable = self._health_with_journald_probes(b"ActiveState=active\nSubState=running\n", None)
        self.assertFalse(unreadable["persistentEntry"])
        self.assertFalse(unreadable["readable"])


class PrepareCapacityTests(unittest.TestCase):
    def _prepare_with_records(self, existing_bytes: list[int]) -> dict[str, object]:
        now_ms = int(time.time() * 1000)
        with tempfile.TemporaryDirectory() as directory:
            input_dir = os.path.join(directory, "inputs")
            records_dir = os.path.join(directory, "records")
            os.mkdir(input_dir)
            os.mkdir(records_dir)
            records = [
                {
                    "state": "prepared",
                    "archiveBytes": archive_bytes,
                    "inputPath": os.path.join(input_dir, f"missing-{index}"),
                    "reference": {"executionID": f"old-{index}", "deadlineAt": now_ms + 60_000},
                    "binding": None,
                }
                for index, archive_bytes in enumerate(existing_bytes)
            ]
            fields = {
                "archive": b"x",
                "inputSnapshotID": "a" * 40,
                "inputDigest": hashlib.sha256(("a" * 40).encode()).hexdigest(),
                "executionID": "new-execution",
                "deadlineAt": now_ms + 60_000,
                "maxOutputChars": 128,
                "command": "true",
                "cwd": "/repo",
            }
            boot = AdmissionHealthTests.CURRENT_BOOT
            with patch.object(gate, "INPUT_DIR", input_dir), \
                    patch.object(gate, "RECORD_DIR", records_dir), \
                    patch.object(gate, "STATE_DIR", directory), \
                    patch.object(gate, "QUARANTINE_PATH", os.path.join(directory, "quarantine.json")), \
                    patch.object(gate, "validate_prepare_request", return_value=fields), \
                    patch.object(gate, "parse_input_archive", return_value=[]), \
                    patch.object(gate, "_assert_initial_user_namespace"), \
                    patch.object(gate, "_check_state_dirs"), \
                    patch.object(gate, "_load_profile", return_value={"bootEpoch": boot}), \
                    patch.object(gate, "_check_signing_key"), \
                    patch.object(gate, "_boot_id", return_value=boot), \
                    patch.object(gate, "_journal_health", return_value={
                        "persistentEffective": True, "persistentEntry": True, "readable": True,
                    }), \
                    patch.object(gate, "_read_admission_records", return_value=records), \
                    patch.object(gate, "_write_archive"), \
                    patch.object(gate, "_tree_from_entries", return_value=(os.path.join(directory, "repo"), "a" * 40)), \
                    patch.object(gate, "_write_record"), \
                    patch.object(gate, "_exclusive_lock", gate.contextlib.nullcontext), \
                    patch.object(gate.LinuxVerifierGate, "_read_all_records", return_value=records):
                return gate.LinuxVerifierGate().prepare({})

    def test_prepare_reserves_ticket_and_byte_capacity_at_exact_boundaries(self) -> None:
        self.assertTrue(self._prepare_with_records([1] * 15)["ok"])
        with self.assertRaisesRegex(gate.GateError, "capacity"):
            self._prepare_with_records([1] * 16)
        self.assertTrue(self._prepare_with_records([gate.MAX_PENDING_ARCHIVE_BYTES - 1])["ok"])
        with self.assertRaisesRegex(gate.GateError, "capacity"):
            self._prepare_with_records([gate.MAX_PENDING_ARCHIVE_BYTES])


class StartAdmissionTests(unittest.TestCase):
    def test_start_at_full_capacity_does_not_charge_the_ticket_again(self) -> None:
        now_ms = int(time.time() * 1000)
        boot = AdmissionHealthTests.CURRENT_BOOT
        reference = make_reference()
        reference["bootID"] = boot
        reference["deadlineAt"] = now_ms + 60_000
        ticket = reference["invocationID"]
        with tempfile.TemporaryDirectory() as directory:
            input_dir = os.path.join(directory, "inputs")
            records_dir = os.path.join(directory, "records")
            os.mkdir(input_dir)
            os.mkdir(records_dir)
            record: dict[str, object] = {
                "state": "prepared",
                "reference": reference,
                "inputPath": os.path.join(input_dir, ticket),
                "archiveBytes": 1,
                "binding": None,
                "output": "",
                "parentExit": None,
                "timedOut": False,
                "cancelled": False,
            }
            records: list[dict[str, object]] = [record]
            records.extend(
                {
                    "state": "prepared",
                    "reference": {"executionID": f"existing-{index}", "deadlineAt": now_ms + 60_000},
                    "inputPath": os.path.join(input_dir, f"missing-{index}"),
                    "archiveBytes": 1,
                    "binding": None,
                }
                for index in range(15)
            )
            authority = gate.LinuxVerifierGate()
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(gate, "INPUT_DIR", input_dir))
                stack.enter_context(patch.object(gate, "RECORD_DIR", records_dir))
                stack.enter_context(patch.object(gate, "STATE_DIR", directory))
                stack.enter_context(patch.object(gate, "CURRENT_INPUT", os.path.join(directory, "current")))
                stack.enter_context(patch.object(gate, "QUARANTINE_PATH", os.path.join(directory, "quarantine.json")))
                stack.enter_context(patch.object(gate, "_activation_lock", gate.contextlib.nullcontext))
                stack.enter_context(patch.object(gate, "_exclusive_lock", gate.contextlib.nullcontext))
                stack.enter_context(patch.object(gate, "_assert_initial_user_namespace"))
                stack.enter_context(patch.object(gate, "_load_profile", return_value={"bootEpoch": boot}))
                stack.enter_context(patch.object(gate, "_read_admission_records", return_value=records))
                stack.enter_context(patch.object(gate, "_journal_health", return_value={
                    "persistentEffective": True, "persistentEntry": True, "readable": True,
                }))
                stack.enter_context(patch.object(gate, "_boot_id", return_value=boot))
                stack.enter_context(patch.object(gate, "_check_signing_key"))
                stack.enter_context(patch.object(authority, "_check_request_reference", return_value=(reference, record)))
                stack.enter_context(patch.object(authority, "_assert_unit_inactive", return_value={"InvocationID": ""}))
                stack.enter_context(patch.object(gate, "_safe_input_tree", return_value="unchanged"))
                stack.enter_context(patch.object(gate, "_write_record"))
                stack.enter_context(patch.object(gate, "_load_record", return_value=record))
                systemctl = stack.enter_context(patch.object(gate, "_systemctl"))
                stack.enter_context(patch.object(
                    authority, "_accept_runner",
                    side_effect=gate.UnknownState("test stops after activation"),
                ))
                response = authority.start(reference)
            self.assertEqual(response["state"], "unknown")
            systemctl.assert_any_call(["start", gate.UNIT], timeout=20)

    def test_start_health_refusal_uses_prepared_no_launch_cancel(self) -> None:
        reference = make_reference()
        reference["deadlineAt"] = int(time.time() * 1000) + 60_000
        record: dict[str, object] = {
            "state": "prepared",
            "reference": reference,
            "inputPath": "/unused/input",
            "archiveBytes": 1,
            "output": "",
            "parentExit": None,
            "timedOut": False,
            "cancelled": False,
        }
        authority = gate.LinuxVerifierGate()
        health = gate._empty_admission_health()
        health["reasons"] = ["journal-persistence"]
        with patch.object(gate, "_activation_lock", gate.contextlib.nullcontext), \
                patch.object(gate, "_exclusive_lock", gate.contextlib.nullcontext), \
                patch.object(gate, "_assert_initial_user_namespace"), \
                patch.object(authority, "_check_request_reference", return_value=(reference, record)), \
                patch.object(gate, "_load_profile", return_value={"bootEpoch": reference["bootID"]}), \
                patch.object(gate, "_read_admission_records", return_value=[record]), \
                patch.object(gate, "_admission_health", return_value=health), \
                patch.object(gate, "_cancel_prepared_locked") as cancel, \
                patch.object(gate, "_systemctl") as systemctl:
            response = authority.start(reference)
        self.assertEqual(response["state"], "unknown")
        cancel.assert_called_once_with(record, "Linux admission health refused: journal-persistence", cancelled=False)
        systemctl.assert_not_called()


class RecoveryAdmissionTests(unittest.TestCase):
    def test_prior_boot_recovery_baseline_is_preserved_by_admission_health(self) -> None:
        current_boot = AdmissionHealthTests.CURRENT_BOOT
        previous_boot = "01234567-89ab-cdef-0123-456789abcdef"
        reference = make_reference()
        reference["bootID"] = previous_boot
        record: dict[str, object] = {
            "state": "running",
            "reference": reference,
            "binding": {"unit": gate.UNIT, "bootID": previous_boot},
            "inputPath": "/preserved/old-boot-input",
            "archiveBytes": 1,
        }
        authority = gate.LinuxVerifierGate()
        with tempfile.TemporaryDirectory() as directory:
            record_file = os.path.join(directory, "record.json")
            latch_file = os.path.join(directory, "quarantine.json")
            Path(latch_file).write_bytes(b"permanent quarantine latch\n")
            latch_bytes = Path(latch_file).read_bytes()

            def persist(value: dict[str, object]) -> None:
                Path(record_file).write_text(json.dumps(value, sort_keys=True), encoding="utf-8")

            with patch.object(gate, "STATE_DIR", directory), \
                    patch.object(gate, "QUARANTINE_PATH", os.path.join(directory, "quarantine.json")), \
                    patch.object(gate, "_exclusive_lock", gate.contextlib.nullcontext), \
                    patch.object(gate, "_assert_initial_user_namespace"), \
                    patch.object(authority, "_read_all_records", return_value=[record]), \
                    patch.object(gate, "_cleanup_orphan_directories"), \
                    patch.object(gate, "_boot_id", return_value=current_boot), \
                    patch.object(gate, "_write_record", side_effect=persist), \
                    patch.object(gate, "_journal_health", return_value={
                        "persistentEffective": True, "persistentEntry": True, "readable": True,
                    }), \
                    patch.object(gate.os, "fchown"):
                authority._recover_all()
                recovered_bytes = Path(record_file).read_bytes()
                recovered = json.loads(recovered_bytes)
                self.assertEqual(recovered["state"], "unknown")
                self.assertEqual(recovered["inputPath"], "/preserved/old-boot-input")
                self.assertEqual(recovered["binding"], {"unit": gate.UNIT, "bootID": previous_boot})
                self.assertEqual(recovered["reference"], reference)

                health = gate._admission_health({"bootEpoch": current_boot}, [record])
                self.assertEqual(health["unknownBound"], 1)
                self.assertTrue(health["quarantineRequired"])
                self.assertEqual(Path(record_file).read_bytes(), recovered_bytes)
                self.assertEqual(Path(latch_file).read_bytes(), latch_bytes)


class ProfileEpochTests(unittest.TestCase):
    def test_root_profile_accepts_old_but_canonical_boot_epoch_for_recovery(self) -> None:
        old_boot = "01234567-89ab-cdef-0123-456789abcdef"
        profile = {
            "schema": gate.PROFILE_SCHEMA,
            "bootEpoch": old_boot,
            "unit": gate.UNIT,
            "qualified": False,
            "controllerUID": 1000,
            "verifierUID": 1001,
            "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nkey\n",
            "files": {path: "a" * 64 for path in gate.REQUIRED_PROFILE_FILES},
        }
        controller = Mock(pw_uid=1000, pw_gid=1000, pw_name="controller", pw_shell="/bin/bash")
        verifier = Mock(pw_uid=1001, pw_gid=1001, pw_name="otter-verifier", pw_shell="/usr/sbin/nologin")
        with patch.object(gate, "_safe_path"), \
                patch.object(gate, "_read_secure_file", return_value=json.dumps(profile).encode("utf-8")), \
                patch.object(gate, "_check_profile_files"), \
                patch.object(gate.pwd, "getpwuid", side_effect=[controller, verifier]), \
                patch.object(gate.os, "getgrouplist", side_effect=[[1001], [1000]]), \
                patch.object(gate, "_boot_id", side_effect=AssertionError("profile load compared the boot epoch")):
            loaded = gate._load_profile()
        self.assertEqual(loaded["bootEpoch"], old_boot)
        self.assertIn(gate.JOURNALD_DROPIN, gate.REQUIRED_PROFILE_FILES)
        self.assertEqual(install.JOURNALD_DROPIN, gate.JOURNALD_DROPIN)


class InstallerAdmissionTests(unittest.TestCase):
    def test_dropin_is_hashed_and_existing_dropin_or_latch_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            helper_dir = os.path.join(directory, "helper")
            systemd_dir = os.path.join(directory, "systemd")
            polkit_dir = os.path.join(directory, "polkit")
            sudoers_dir = os.path.join(directory, "sudoers")
            journald_dir = os.path.join(directory, "journald")
            journal_path = os.path.join(journald_dir, "otter-verifier.conf")
            for path in (helper_dir, systemd_dir, polkit_dir, sudoers_dir, journald_dir):
                os.mkdir(path)
            source_paths = (
                os.path.join(helper_dir, "gate.py"),
                os.path.join(helper_dir, "runner.py"),
                os.path.join(helper_dir, "client.py"),
                os.path.join(systemd_dir, install.UNIT),
                os.path.join(systemd_dir, install.GATE_UNIT),
                os.path.join(systemd_dir, install.SLICE_UNIT),
                os.path.join(polkit_dir, "90-otter-verifier.rules"),
                os.path.join(sudoers_dir, "00-otter-verifier-deny"),
                journal_path,
            )
            for path in source_paths:
                Path(path).write_bytes(b"fixed installation input\n")
            with patch.object(install, "HELPER_DIR", helper_dir), \
                    patch.object(install, "SYSTEMD_DIR", systemd_dir), \
                    patch.object(install, "POLKIT_RULE", os.path.join(polkit_dir, "90-otter-verifier.rules")), \
                    patch.object(install, "SUDOERS_DROPIN", os.path.join(sudoers_dir, "00-otter-verifier-deny")), \
                    patch.object(install, "JOURNALD_DROPIN", journal_path):
                hashes = install._profile_files()
            self.assertEqual(hashes[journal_path], hashlib.sha256(b"fixed installation input\n").hexdigest())

        controller = Mock(pw_uid=1000)
        with patch.object(install, "_require_root_and_linux"), \
                patch.object(install, "_boot_epoch", return_value=AdmissionHealthTests.CURRENT_BOOT), \
                patch.object(install.pwd, "getpwnam", return_value=controller), \
                patch.object(install, "_ensure_no_existing", side_effect=RuntimeError("stop after paths")) as ensure:
            with self.assertRaisesRegex(RuntimeError, "stop after paths"):
                install.install("controller")
        existing_paths = ensure.call_args.args[0]
        self.assertIn(install.JOURNALD_DROPIN, existing_paths)
        self.assertIn(install.QUARANTINE_PATH, existing_paths)
        self.assertEqual(install.JOURNALD_DROPIN_CONTENT, "[Journal]\nStorage=persistent\n")


class OutputBoundsTests(unittest.TestCase):
    def test_utf16_bounds_preserve_a_prefix_without_split_codepoints(self) -> None:
        text = "𐐀A"
        self.assertEqual(gate._output_units(text), 3)
        self.assertEqual(runner._take_output(text, 1), ("", 0))
        self.assertEqual(runner._take_output(text, 2), ("𐐀", 0))
        self.assertEqual(runner._take_output(text, 4), (text, 1))
        with self.assertRaises(UnicodeEncodeError):
            runner._take_output("\ud800", 2)


class LifecycleContractTests(unittest.TestCase):
    def test_output_does_not_retire_the_runner_before_its_acknowledged_exit(self) -> None:
        reference = make_reference()
        ticket = reference["invocationID"]
        record = {"state": "running", "reference": reference, "output": "", "parentExit": None}
        connection, handle = Mock(), Mock()
        finished = threading.Event()
        authority = gate.LinuxVerifierGate.__new__(gate.LinuxVerifierGate)
        authority._runtime_lock = threading.Lock()
        authority._runtime = {ticket: (connection, handle, finished)}
        persisted = []

        def acknowledge(_connection, event):
            self.assertEqual(persisted[-1]["parentExit"], 0)
            self.assertTrue(persisted[-1]["doneReceived"])
            self.assertEqual(event, {"protocol": gate.PROTOCOL, "type": "child-exit-ack", "ticket": ticket})

        def end_monitor_without_proof(_ticket, _handle):
            record["state"] = "unknown"

        with patch.object(gate, "_exclusive_lock", gate.contextlib.nullcontext), \
                patch.object(gate, "_load_record", return_value=record), \
                patch.object(gate, "_write_record", side_effect=lambda value: persisted.append(dict(value))), \
                patch.object(gate, "_recv_frame", side_effect=[
                    {"protocol": gate.PROTOCOL, "ticket": ticket, "type": "output", "text": "still running\n"},
                    {"protocol": gate.PROTOCOL, "ticket": ticket, "type": "child-exit", "parentExit": 0},
                    EOFError(),
                ]), \
                patch.object(gate, "_send_frame", side_effect=acknowledge) as send, \
                patch.object(authority, "_stop_exact_locked"), \
                patch.object(authority, "_finish_ticket", side_effect=end_monitor_without_proof):
            authority._watch_runner(ticket)
        self.assertEqual(record["output"], "still running\n")
        self.assertEqual(record["parentExit"], 0)
        self.assertEqual(record["retireReason"], "completed")
        self.assertEqual(record["state"], "unknown")
        send.assert_called_once()
        self.assertTrue(finished.is_set())
        connection.close.assert_called_once()
        handle.close.assert_called_once()

    def test_workload_unit_uses_cgroup_exit_and_fixed_resource_caps(self) -> None:
        unit = install.VERIFIER_UNIT_CONTENT
        self.assertIn("ExitType=cgroup", unit)
        self.assertNotIn("RemainAfterExit=yes", unit)
        self.assertIn("RuntimeMaxSec=120s", unit)
        self.assertIn("MemoryMax=512M", unit)
        self.assertIn("TasksMax=128", unit)
        masked_paths = next(line for line in unit.splitlines() if line.startswith("InaccessiblePaths=")).split("=", 1)[1].split()
        self.assertNotIn("-/run/systemd", masked_paths)
        self.assertTrue({"-/run/systemd/private", "-/run/dbus", "-/run/user"}.issubset(masked_paths))
        for property_name in ("RemainAfterExit", "MemoryMax", "TasksMax", "RuntimeMaxUSec"):
            self.assertIn(property_name, gate.SYSTEMD_PROPERTIES)

    def test_cgroup_kill_writes_through_the_held_directory_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            kill_path = os.path.join(directory, "cgroup.kill")
            with open(kill_path, "wb"):
                pass
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            events_fd = os.open(os.devnull, os.O_RDONLY)
            identity = os.fstat(directory_fd)
            handle = gate.CgroupHandle(directory_fd, events_fd, identity.st_dev, identity.st_ino)
            try:
                gate._request_cgroup_kill(handle)
                with open(kill_path, "rb") as source:
                    self.assertEqual(source.read(), b"1\n")
            finally:
                handle.close()

    def test_empty_cgroup_is_not_deletion_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events_path = os.path.join(directory, "cgroup.events")
            with open(events_path, "wb") as output:
                output.write(b"populated 0\n")
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            events_fd = os.open(events_path, os.O_RDONLY)
            identity = os.fstat(directory_fd)
            handle = gate.CgroupHandle(directory_fd, events_fd, identity.st_dev, identity.st_ino)
            binding = {"device": identity.st_dev, "inode": identity.st_ino}
            try:
                self.assertFalse(gate._held_cgroup_deleted(handle, binding))
                with patch.object(gate, "_cgroup_populated", side_effect=gate.UnknownState("native cgroup events file was deleted")):
                    self.assertTrue(gate._held_cgroup_deleted(handle, binding))
                self.assertEqual(gate.RETIREMENT_MESSAGE_IDS, {
                    "9d1aaa27d60140bd96365438aad20286",
                    "7ad2d189f7e94e70a38c781354912448",
                    "d9b373ed55a64feb8242e02dbe79a49c",
                })
            finally:
                handle.close()

    def test_retirement_requires_deleted_domain_and_bound_pid1_journal_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events_path = os.path.join(directory, "cgroup.events")
            with open(events_path, "wb") as output:
                output.write(b"populated 0\n")
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            events_fd = os.open(events_path, os.O_RDONLY)
            identity = os.fstat(directory_fd)
            handle = gate.CgroupHandle(directory_fd, events_fd, identity.st_dev, identity.st_ino)
            binding = {
                "unit": gate.UNIT,
                "bootID": "d2c6325f-8c1b-4633-9669-b881d0c2b364",
                "systemdInvocationID": "0123456789abcdef0123456789abcdef",
                "mainPID": 123,
                "startTimeTicks": 456,
                "cgroupPath": gate.CGROUP_PATH,
                "device": identity.st_dev,
                "inode": identity.st_ino,
            }
            record = {"binding": binding}
            properties = {
                "ActiveState": "inactive",
                "InvocationID": binding["systemdInvocationID"],
                "ControlGroup": binding["cgroupPath"],
            }
            authority = gate.LinuxVerifierGate()
            try:
                with patch.object(gate, "_boot_id", return_value=binding["bootID"]), \
                        patch.object(gate, "_unit_status", return_value=properties), \
                        patch.object(gate, "_journal_retirement", return_value=gate.STOP_MESSAGE_ID):
                    self.assertIsNone(authority._retirement_kind(record, handle))
                with patch.object(gate, "_boot_id", return_value=binding["bootID"]), \
                        patch.object(gate, "_unit_status", return_value=properties), \
                        patch.object(gate, "_cgroup_populated", side_effect=gate.UnknownState("native cgroup events file was deleted")), \
                        patch.object(gate, "_journal_retirement", return_value=gate.FAILED_MESSAGE_ID):
                    self.assertEqual(
                        authority._retirement_kind(record, handle),
                        ("held-deleted-journal", gate.FAILED_MESSAGE_ID),
                    )
                with patch.object(gate, "_boot_id", return_value=binding["bootID"]), \
                        patch.object(gate, "_unit_status", return_value=properties), \
                        patch.object(authority, "_bound_cgroup_path_is_absent", return_value=True), \
                        patch.object(gate, "_journal_retirement", return_value=gate.DEACTIVATED_MESSAGE_ID):
                    self.assertEqual(
                        authority._retirement_kind(record, None),
                        ("recovered-journal", gate.DEACTIVATED_MESSAGE_ID),
                    )
                with patch.object(gate, "_boot_id", return_value=binding["bootID"]), \
                        patch.object(gate, "_unit_status", return_value=properties), \
                        patch.object(authority, "_bound_cgroup_path_is_absent", return_value=True), \
                        patch.object(gate, "_journal_retirement", return_value="exit-only"):
                    self.assertIsNone(authority._retirement_kind(record, None))
            finally:
                handle.close()

    def test_runner_waits_for_ack_after_reporting_durable_child_exit(self) -> None:
        runner_connection, gate_connection = socket.socketpair()
        completed = threading.Event()
        errors: list[BaseException] = []

        def report() -> None:
            try:
                runner._report_child_exit(runner_connection, "0" * 32, 7)
            except BaseException as exc:
                errors.append(exc)
            finally:
                completed.set()

        thread = threading.Thread(target=report)
        thread.start()
        try:
            self.assertEqual(gate._recv_frame(gate_connection, 2), {
                "protocol": gate.PROTOCOL,
                "type": "child-exit",
                "ticket": "0" * 32,
                "parentExit": 7,
            })
            self.assertFalse(completed.wait(0.02))
            gate._send_frame(gate_connection, {
                "protocol": gate.PROTOCOL,
                "type": "child-exit-ack",
                "ticket": "0" * 32,
            })
            self.assertTrue(completed.wait(2))
            self.assertEqual(errors, [])
        finally:
            runner_connection.close()
            gate_connection.close()
            thread.join(timeout=2)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux OpenSSL transport regression")
class CryptoTransportTests(unittest.TestCase):
    def test_trusted_runner_disables_dumpability_in_its_own_process(self) -> None:
        code = (
            f"import sys,ctypes; sys.path.insert(0,{str(REPOSITORY / 'scripts' / 'linux-verifier')!r}); "
            "import runner; runner._protect_control_channel(); "
            "libc=ctypes.CDLL(None); assert libc.prctl(3,0,0,0,0)==0"
        )
        subprocess.run([sys.executable, "-c", code], check=True, capture_output=True)

    def test_regular_file_signing_and_verification_reject_tampering(self) -> None:
        # Bypass privilege predicates ONLY in this isolated crypto unit test.
        # This ephemeral key is never installed or accepted by native admission.
        with tempfile.TemporaryDirectory(prefix="otter-test-crypto-") as directory:
            key = Path(directory) / "test-private.pem"
            subprocess.run([gate.OPENSSL, "genpkey", "-algorithm", "ED25519", "-out", str(key)],
                           check=True, capture_output=True)
            key.chmod(0o600)
            public_key = subprocess.check_output([gate.OPENSSL, "pkey", "-in", str(key), "-pubout"]).decode("ascii")
            profile = {"publicKeyPem": public_key}
            with patch.object(gate, "SIGNING_KEY", str(key)), patch.object(gate, "GIT_TMP_DIR", directory), \
                    patch.object(gate, "_check_signing_key"), patch.object(gate, "_check_profile_files"), \
                    patch.object(gate, "_validate_terminal_record"):
                receipt, signature = gate._sign_receipt({"testOnly": "crypto transport"}, profile)
                record = {"result": {"proof": {"receipt": receipt, "signature": signature}}}
                gate._verify_stored_receipt(record, profile)
                record["result"]["proof"]["receipt"] += " "
                with self.assertRaises(gate.GateError):
                    gate._verify_stored_receipt(record, profile)


if __name__ == "__main__":
    unittest.main()
