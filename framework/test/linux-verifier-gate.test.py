"""Pure input/reference validation for the Linux verifier gate.

These tests exercise parsing, shape checks and crypto transport with ephemeral
test keys. They do not establish native ownership or retirement authority.
"""

from __future__ import annotations

import base64
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
        "unit": "lca-verifier.service",
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
        with tempfile.TemporaryDirectory(prefix="lca-test-crypto-") as directory:
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
