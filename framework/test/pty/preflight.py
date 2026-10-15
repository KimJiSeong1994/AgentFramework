"""Verify actual terminal prerequisites without claiming product qualification."""
import argparse
import fcntl
import hashlib
import json
import os
import platform
import pty
import shutil
import struct
import subprocess
import termios
from pathlib import Path


def preflight():
    master, slave = pty.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        dimensions = struct.unpack("HHHH", fcntl.ioctl(slave, termios.TIOCGWINSZ, bytes(8)))
        before = termios.tcgetattr(slave)
        raw = termios.tcgetattr(slave)
        raw[3] &= ~(termios.ICANON | termios.ECHO)
        termios.tcsetattr(slave, termios.TCSANOW, raw)
        packet = b"\x1b[13;2u"
        os.write(master, packet)
        received = os.read(slave, len(packet))
        termios.tcsetattr(slave, termios.TCSANOW, before)
        assert received == packet, "enhanced protocol bytes changed in PTY transport"
        assert dimensions[:2] == (24, 80)
        after = termios.tcgetattr(slave)
        # Darwin marks pending input for reprocessing after an ICANON change.
        # PENDIN is kernel bookkeeping, not a raw/cooked terminal mode.
        pending_input = getattr(termios, "PENDIN", 0)
        observed_lflag = after[3]
        after[3] &= ~pending_input
        before[3] &= ~pending_input
        assert after == before, "termios not restored"
        versions = {}
        for name, argv in {"bun": ["bun", "--version"], "tmux": ["tmux", "-V"], "ssh": ["ssh", "-V"]}.items():
            if not shutil.which(name):
                raise RuntimeError(f"required prerequisite unavailable: {name}")
            result = subprocess.run(argv, capture_output=True, text=True, check=True)
            versions[name] = (result.stdout + result.stderr).strip()
        return {"platform": platform.platform(), "python": platform.python_version(), "versions": versions,
                "dimensions": {"columns": 80, "rows": 24}, "enhancedPacketHex": received.hex(),
                "termiosRestored": True, "observedLocalFlags": observed_lflag,
                "excludedKernelPendingInputFlag": pending_input,
                "scope": "prerequisites only; no LCA key or workflow qualification"}
    finally:
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    evidence = preflight()
    evidence["harnessSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence))
