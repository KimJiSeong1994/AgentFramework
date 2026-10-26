"""Scratch-only native primitives; these do not establish role containment."""
import errno
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest


@unittest.skipUnless(sys.platform in ("darwin", "linux"), "native promotion supports Darwin and Linux")
class NativeProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="skillopt-native-tests-")
        cls.root = Path(cls.scratch.name).resolve(strict=True)
        cls.helper = cls.root / "helper"
        source = Path(__file__).resolve().parents[1] / "framework/src/skillopt/native.c"
        compiler = os.environ.get("CC", "cc")
        subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", str(source), "-o", str(cls.helper)], check=True, capture_output=True)
        cls.fault_helper = cls.root / "fault-helper"
        subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", "-DSKILLOPT_TEST_FAULTS=1", str(source), "-o", str(cls.fault_helper)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def probe(self, command, *args):
        result = subprocess.run([str(self.helper), command, *map(str, args)], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.stderr, "")
        code = int(result.stdout.strip())
        self.assertEqual(result.returncode, 1 if code else 0)
        return code

    def test_protocol_identifies_native_platform(self):
        result = subprocess.run([str(self.helper), "protocol"], capture_output=True, text=True, timeout=5, check=True)
        self.assertEqual(result.stderr, "")
        packet = json.loads(result.stdout)
        self.assertEqual(packet, {"protocol": "skillopt-promotion.v3", "platform": "darwin" if sys.platform == "darwin" else "linux"})

    @unittest.skipUnless(sys.platform == "linux", "Linux mount identity parser")
    def test_ext_family_magic_requires_the_exact_ext4_mount_identity(self):
        source = Path(__file__).resolve().parents[1] / "framework/src/skillopt/native.c"
        harness = self.root / "mount-parser.c"
        harness.write_text(
            "#define main helper_entrypoint\n#include "
            + json.dumps(str(source), ensure_ascii=False)
            + '\n#undef main\nint main(void) {\n'
            '  if (mount_line_ext4("42 1 0:1 / / rw - ext4 /dev/vda rw\\n", 42) != 1) return 1;\n'
            '  if (mount_line_ext4("42 1 0:1 / / rw - ext2 /dev/vda rw\\n", 42) != -1) return 2;\n'
            '  if (mount_line_ext4("42 1 0:1 / / rw - ext3 /dev/ext4 rw\\n", 42) != -1) return 3;\n'
            '  if (mount_line_ext4("43 1 0:1 / / rw - ext4 /dev/vda rw\\n", 42) != 0) return 4;\n'
            '  if (mount_line_ext4("42 1 0:1 / / rw - ext4evil /dev/vda rw\\n", 42) != -1) return 5;\n'
            '  if (mount_line_ext4("42 malformed\\n", 42) != -1) return 6;\n'
            '  return 0;\n}\n',
            encoding="utf-8",
        )
        executable = self.root / "mount-parser"
        subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", str(harness), "-o", str(executable)],
                       check=True, capture_output=True)
        subprocess.run([str(executable)], check=True, capture_output=True, timeout=5)

    def test_clock_sample_uses_validated_suspend_inclusive_native_clock(self):
        result = subprocess.run([str(self.helper), "clock"], capture_output=True, text=True, timeout=5, check=True)
        self.assertEqual(result.stderr, "")
        packet = json.loads(result.stdout)
        self.assertEqual(set(packet), {"protocol", "platform", "bootId", "continuousNanoseconds", "wallMilliseconds"})
        self.assertEqual(packet["protocol"], "skillopt-promotion.v3")
        self.assertEqual(packet["platform"], "darwin" if sys.platform == "darwin" else "linux")
        self.assertEqual(len(packet["bootId"]), 36)
        self.assertRegex(packet["bootId"], r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        for key in ("continuousNanoseconds", "wallMilliseconds"):
            self.assertRegex(packet[key], r"^(0|[1-9][0-9]{0,19})$")
            self.assertTrue(packet[key].isascii() and packet[key].isdigit())
            self.assertEqual(packet[key], str(int(packet[key])))
            self.assertLessEqual(int(packet[key]), (1 << 64) - 1)
        self.assertGreater(int(packet["continuousNanoseconds"]), 0)
        self.assertLess(abs(int(packet["wallMilliseconds"]) - time.time_ns() // 1_000_000), 10_000)

    def test_owned_scratch_probe_exchanges_flushes_and_removes_its_files(self):
        before = set(self.root.iterdir())
        directory = self.root.stat()
        result = subprocess.run([str(self.helper), "probe", str(self.root), str(directory.st_dev), str(directory.st_ino)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")
        self.assertEqual(set(self.root.iterdir()), before)

    @unittest.skipUnless(sys.platform == "linux", "Linux-only unsupported filesystem check")
    def test_linux_refuses_tmpfs_scratch_without_creating_probe_files(self):
        mount_type = None
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            fields = line.split()
            if len(fields) > 6 and fields[4] == "/dev/shm" and "-" in fields:
                separator = fields.index("-")
                if separator + 1 < len(fields):
                    mount_type = fields[separator + 1]
        if mount_type != "tmpfs":
            self.skipTest("host has no /dev/shm tmpfs mount")
        with tempfile.TemporaryDirectory(prefix="skillopt-native-tmpfs-", dir="/dev/shm") as temporary:
            root = Path(temporary).resolve(strict=True)
            before = set(root.iterdir())
            directory = root.stat()
            result = subprocess.run([str(self.helper), "probe", str(root), str(directory.st_dev), str(directory.st_ino)],
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr.strip(), "unsupported-filesystem")
            self.assertEqual(set(root.iterdir()), before)

    def test_read_discards_content_and_write_does_not_modify(self):
        path = self.root / "content"
        path.write_bytes(b"private sentinel")
        before = path.stat()
        self.assertEqual(self.probe("probe-read", path), 0)
        self.assertEqual(self.probe("probe-write", path), 0)
        self.assertEqual(path.read_bytes(), b"private sentinel")
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)

    def test_missing_write_does_not_create(self):
        path = self.root / "absent"
        self.assertEqual(self.probe("probe-write", path), errno.ENOENT)
        self.assertFalse(path.exists())

    def test_symlinks_are_not_followed(self):
        path = self.root / "regular"
        path.write_bytes(b"unchanged")
        link = self.root / "link"
        link.symlink_to(path)
        self.assertEqual(self.probe("probe-read", link), errno.ELOOP)
        self.assertEqual(self.probe("probe-write", link), errno.ELOOP)
        self.assertEqual(path.read_bytes(), b"unchanged")

    def test_parent_directory_symlinks_are_not_followed(self):
        real_directory = self.root / "real-directory"
        real_directory.mkdir()
        alias = self.root / "directory-link"
        alias.symlink_to(real_directory, target_is_directory=True)
        directory = real_directory.stat()
        result = subprocess.run([str(self.helper), "probe", str(alias), str(directory.st_dev), str(directory.st_ino)],
                                capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "unsafe-directory")
        self.assertEqual(list(real_directory.iterdir()), [])

    def test_fifo_write_does_not_hang(self):
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        self.assertEqual(self.probe("probe-write", fifo), errno.ENXIO)

    def test_literal_ipv4_and_ipv6_connect_send_no_bytes(self):
        for family, host in [(socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")]:
            with self.subTest(host=host), socket.socket(family, socket.SOCK_STREAM) as listener:
                listener.bind((host, 0))
                listener.listen(1)
                listener.settimeout(2)
                self.assertEqual(self.probe("probe-connect", host, listener.getsockname()[1]), 0)
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(2)
                    self.assertEqual(connection.recv(1), b"")

    def test_hostnames_and_invalid_ports_are_rejected(self):
        for host, port in [("localhost", "80"), ("127.0.0.1", "0"), ("127.0.0.1", "65536"), ("127.0.0.1", "+80")]:
            with self.subTest(host=host, port=port):
                self.assertEqual(self.probe("probe-connect", host, port), errno.EINVAL)

    def exercise_displaced_unlink(self, content, release=True):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root = Path(temporary)
            retention = root / "retention"
            barriers = root / "barriers"
            retention.mkdir(mode=0o700)
            barriers.mkdir(mode=0o700)
            target, stage = root / "SKILL.md", root / "candidate"
            target.write_bytes(b"original")
            stage.write_bytes(b"candidate")
            directory, old, candidate, destination = root.stat(), target.stat(), stage.stat(), retention.stat()
            args = [str(self.fault_helper), "exchange", str(root), str(directory.st_dev), str(directory.st_ino),
                    target.name, str(old.st_dev), str(old.st_ino), stage.name, str(candidate.st_dev), str(candidate.st_ino),
                    str(retention), str(destination.st_dev), str(destination.st_ino), "displaced.bin"]
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, env=dict(os.environ, SKILLOPT_TEST_BARRIERS=str(barriers)))
            def wait_boundary(name):
                deadline = time.monotonic() + 5
                while not (barriers / f"{name}.ready").exists():
                    self.assertIsNone(process.poll())
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.005)
            try:
                wait_boundary("before-swap")
                target.rename(root / "moved-original")
                target.write_bytes(content)
                (barriers / "before-swap.release").touch()
                wait_boundary("post-open")
                stage.unlink()
                (barriers / "post-open.release").touch()
                self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                packet = json.loads(process.stdout.readline())
                self.assertEqual(packet["protocol"], "skillopt-promotion.v3")
                self.assertEqual(packet["platform"], "darwin" if sys.platform == "darwin" else "linux")
                self.assertTrue(packet["exchangeOccurred"])
                self.assertEqual(target.read_bytes(), b"candidate")
                self.assertEqual((root / "moved-original").read_bytes(), b"original")
                if len(content) <= 16384:
                    self.assertEqual(packet["status"], "RACE_CAPTURED")
                    self.assertEqual((retention / packet["capture"]["name"]).read_bytes(), content)
                    self.assertEqual(process.wait(timeout=5), 0)
                else:
                    self.assertEqual(packet["status"], "RACE_HELD")
                    self.assertIsNone(packet["capture"])
                    self.assertIsNone(process.poll())
                    if release:
                        with (retention / "recovery.json").open("x") as record:
                            json.dump({"state": "RECOVERY_REQUIRED"}, record)
                            record.flush()
                            os.fsync(record.fileno())
                        directory_fd = os.open(retention, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            os.fsync(directory_fd)
                        finally:
                            os.close(directory_fd)
                        process.stdin.write("RELEASE\n")
                        process.stdin.flush()
                        self.assertEqual(process.wait(timeout=5), 1)
                    else:
                        process.stdin.close()
                        time.sleep(0.05)
                        self.assertIsNone(process.poll(), "EOF must not acknowledge recovery")
                self.assertFalse(stage.exists())
            finally:
                if process.poll() is None:
                    process.kill()  # Only this synthetic, test-owned held inode.
                process.wait(timeout=5)
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()

    def test_displaced_third_survives_unlink_during_native_handoff(self):
        self.exercise_displaced_unlink(b"raced-in user content")

    def test_oversized_displaced_inode_is_held_until_recovery_ack(self):
        self.exercise_displaced_unlink(b"x" * 16385)

    def test_eof_does_not_release_uncaptured_displaced_inode(self):
        self.exercise_displaced_unlink(b"x" * 16385, release=False)


if __name__ == "__main__":
    unittest.main()
