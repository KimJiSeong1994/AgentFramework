"""Drive the production LCA TUI and interactive coordinator through real PTYs."""
from __future__ import annotations

import argparse
import codecs
import fcntl
import hashlib
import importlib.util
import json
import os
import platform
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
FRAMEWORK = HERE.parents[1]
FIXTURE = HERE / "interactive-fixture.ts"
WORKFLOW_ID = "wf_pty_fixture"
PLAN_SHA = "c0ffee0000000000000000000000000000000000000000000000000000000000"
DEFAULT_COLUMNS = 100
DEFAULT_ROWS = 30
MAX_OUTPUT = 8 * 1024 * 1024
SKILL_HOME_SCENARIOS = ("skills", "readline-skills", "skill-grants", "skill-restore", "skill-tool-scope", "skill-tool-cancel", "skill-main-write", "workflow-di")
STARTUP_ENV_KEYS = (
    "BUN_OPTIONS", "BUN_CONFIG", "BUN_INSTALL", "NODE_OPTIONS", "NODE_PATH",
    "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
    "LCA_STATE_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME",
)


def load_preflight():
    """Import, but do not modify, the frozen P0 prerequisite probe."""
    spec = importlib.util.spec_from_file_location("lca_pty_preflight", HERE / "preflight.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("could not import existing PTY preflight")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.preflight


def preflight_evidence() -> dict[str, Any]:
    return load_preflight()()


def normalized_termios(value):
    attrs = list(value)
    pending = getattr(termios, "PENDIN", 0)
    attrs[3] &= ~pending
    return attrs


def width(character: str) -> int:
    if unicodedata.combining(character) or character in ("\u200d", "\ufe0f"):
        return 0
    return 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1


class TerminalScreen:
    """Small VT screen model for the CSI cursor/erase operations used by renderFrame."""

    def __init__(self, columns: int, rows: int):
        self.columns = columns
        self.rows = rows
        self.grid = self._blank_grid(columns, rows)
        self.row = 0
        self.column = 0
        self.alt = False
        self.main_state = None
        self.last_alt = None
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.state = "text"
        self.csi = ""
        self.string_esc = False

    @staticmethod
    def _blank_grid(columns: int, rows: int):
        return [[" "] * columns for _ in range(rows)]

    def resize(self, columns: int, rows: int):
        old = self.grid
        self.columns, self.rows = columns, rows
        self.grid = self._blank_grid(columns, rows)
        for y in range(min(rows, len(old))):
            for x in range(min(columns, len(old[y]))):
                self.grid[y][x] = old[y][x]
        self.row = min(self.row, rows - 1)
        self.column = min(self.column, columns - 1)

    def feed(self, data: bytes):
        for character in self.decoder.decode(data):
            self._character(character)

    def _character(self, character: str):
        if self.state == "escape":
            if character == "[":
                self.state = "csi"
                self.csi = ""
            elif character == "]":
                self.state = "string"
                self.string_esc = False
            else:
                self.state = "text"
            return
        if self.state == "csi":
            if "@" <= character <= "~":
                self._csi(self.csi, character)
                self.state = "text"
            elif len(self.csi) < 128:
                self.csi += character
            else:
                self.state = "text"
            return
        if self.state == "string":
            if character == "\x07" or (self.string_esc and character == "\\"):
                self.state = "text"
            self.string_esc = character == "\x1b"
            return
        if character == "\x1b":
            self.state = "escape"
        elif character == "\r":
            self.column = 0
        elif character == "\n":
            self.row = min(self.rows - 1, self.row + 1)
        elif character == "\b":
            self.column = max(0, self.column - 1)
        elif character == "\t":
            self.column = min(self.columns - 1, (self.column // 8 + 1) * 8)
        elif ord(character) >= 32 and ord(character) != 127:
            self._put(character)

    def _put(self, character: str):
        cell_width = width(character)
        if cell_width == 0:
            if self.column:
                self.grid[self.row][self.column - 1] += character
            return
        if self.column >= self.columns:
            self.column = 0
            self.row = min(self.rows - 1, self.row + 1)
        self.grid[self.row][self.column] = character
        self.column += cell_width
        if cell_width == 2 and self.column - 1 < self.columns:
            self.grid[self.row][self.column - 1] = ""

    @staticmethod
    def _numbers(parameters: str):
        clean = parameters.lstrip("?>!")
        if not clean:
            return []
        try:
            return [int(part) if part else 0 for part in clean.split(";")]
        except ValueError:
            return []

    def _csi(self, parameters: str, final: str):
        if final in ("h", "l") and "1049" in parameters:
            if final == "h" and not self.alt:
                self.main_state = (self.grid, self.row, self.column)
                self.grid = self._blank_grid(self.columns, self.rows)
                self.row = self.column = 0
                self.alt = True
            elif final == "l" and self.alt:
                self.last_alt = (self.grid, self.row, self.column, self.columns, self.rows)
                if self.main_state:
                    self.grid, self.row, self.column = self.main_state
                self.main_state = None
                self.alt = False
            return
        values = self._numbers(parameters)
        first = values[0] if values else 0
        if final in ("H", "f"):
            y = values[0] if len(values) > 0 and values[0] else 1
            x = values[1] if len(values) > 1 and values[1] else 1
            self.row = max(0, min(self.rows - 1, y - 1))
            self.column = max(0, min(self.columns - 1, x - 1))
        elif final == "A":
            self.row = max(0, self.row - (first or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (first or 1))
        elif final == "C":
            self.column = min(self.columns - 1, self.column + (first or 1))
        elif final == "D":
            self.column = max(0, self.column - (first or 1))
        elif final == "G":
            self.column = max(0, min(self.columns - 1, (first or 1) - 1))
        elif final == "d":
            self.row = max(0, min(self.rows - 1, (first or 1) - 1))
        elif final == "K":
            mode = first
            if mode == 2:
                self.grid[self.row] = [" "] * self.columns
            elif mode == 1:
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
            else:
                self.grid[self.row][self.column :] = [" "] * (self.columns - self.column)
        elif final == "J":
            if first == 2 or first == 3:
                self.grid = self._blank_grid(self.columns, self.rows)
            elif first == 0:
                self.grid[self.row][self.column :] = [" "] * (self.columns - self.column)
                for y in range(self.row + 1, self.rows):
                    self.grid[y] = [" "] * self.columns
            elif first == 1:
                for y in range(self.row):
                    self.grid[y] = [" "] * self.columns
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)

    @staticmethod
    def _lines(state):
        grid, _row, _column, _columns, _rows = state
        return ["".join(cells).rstrip() for cells in grid]

    def current_lines(self):
        return ["".join(cells).rstrip() for cells in self.grid]

    def snapshot_lines(self):
        if self.alt:
            return self.current_lines()
        if self.last_alt:
            return self._lines(self.last_alt)
        return self.current_lines()

    def current_text(self):
        return "\n".join(self.current_lines())

    def snapshot_text(self):
        return "\n".join(self.snapshot_lines())


ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
SGR_RE = re.compile(r"\x1b\[([0-9;:]*)m")


def plain_text(raw: bytes) -> str:
    return ANSI_RE.sub("", raw.decode("utf-8", "replace"))


class PtySession:
    def __init__(self, scenario: str, temp_root: Path, columns=DEFAULT_COLUMNS, rows=DEFAULT_ROWS, label: str | None = None,
                 extra_env: dict[str, str] | None = None):
        self.scenario = scenario
        self.temp_root = temp_root
        # A relaunch shares durable state/config/home (keyed by scenario) but owns distinct evidence files (keyed by label).
        self.label = label or scenario
        self.extra_env = extra_env or {}
        self.result_path = temp_root / f"{self.label}.result.json"
        self.events_path = temp_root / f"{self.label}.events.jsonl"
        self.gate_path = temp_root / f"{self.label}.gate"
        self.termios_release_path = temp_root / f"{self.label}.termios-release.json"
        self.master, self.slave = pty.openpty()
        self._set_size(columns, rows)
        self.initial_termios = termios.tcgetattr(self.slave)
        self.screen = TerminalScreen(columns, rows)
        self.output = bytearray()
        self.checkpoints: dict[str, Any] = {}
        self.eof = False
        self.process = None
        self.mode_proof: dict[str, Any] = {}
        self.terminal_cleanup_evidence: dict[str, Any] | None = None
        self.executable: str | None = None
        self.child_environment: dict[str, Any] = {}
        self.startup_stage = "pty-opened"

    def _set_size(self, columns: int, rows: int):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def start(self):
        bun = shutil.which("bun")
        if not bun:
            raise RuntimeError(f"required prerequisite unavailable: bun; PATH entries={len(os.environ.get('PATH', '').split(os.pathsep))}")
        self.executable = os.path.realpath(bun)
        fixture_scenario = "signal" if self.scenario in ("sigint", "sigterm", "sighup") else self.scenario
        env = os.environ.copy()
        # Tests in the parent Bun process mutate PATH and XDG/LCA homes while
        # running concurrently. Keep this child on private, scenario-local
        # state/config and do not inherit the test-only LCA override.
        env.pop("LCA_STATE_HOME", None)
        env["XDG_STATE_HOME"] = str(self.temp_root / f"{self.scenario}.state-home")
        env["XDG_CONFIG_HOME"] = str(self.temp_root / f"{self.scenario}.config-home")
        if self.scenario in SKILL_HOME_SCENARIOS:
            isolated_home = (self.temp_root / f"{self.scenario}.home").resolve()
            isolated_home.mkdir(parents=True, exist_ok=True)
            env["HOME"] = str(isolated_home)
            env["LCA_TUI_PTY_HOME"] = str(isolated_home)
        env.update({
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "LCA_TUI_PTY_SCENARIO": fixture_scenario,
            "LCA_TUI_PTY_RESULT": str(self.result_path),
            "LCA_TUI_PTY_EVENTS": str(self.events_path),
            "LCA_TUI_PTY_GATE": str(self.gate_path),
            "LCA_TUI_PTY_TERMIOS_RELEASE": str(self.termios_release_path),
            **self.extra_env,
        })
        self.child_environment = {
            "scenario": self.scenario,
            "fixtureScenario": fixture_scenario,
            "TERM": env.get("TERM"),
            "NO_COLOR": env.get("NO_COLOR"),
            "CI": env.get("CI"),
            "isolatedXdgStateHome": True,
            "isolatedXdgConfigHome": True,
            "isolatedHomeForSkills": self.scenario in SKILL_HOME_SCENARIOS,
            "lcaStateHomeInherited": "LCA_STATE_HOME" in os.environ,
            "pathEntryCount": len(env.get("PATH", "").split(os.pathsep)),
            "bunPathEntryIndex": next((
                index for index, entry in enumerate(env.get("PATH", "").split(os.pathsep))
                if os.path.realpath(os.path.join(entry or os.curdir, "bun")) == self.executable
            ), None),
            "startupOverrides": {
                name: {"set": True, "length": len(env[name])}
                for name in STARTUP_ENV_KEYS if name in env
            },
        }

        def acquire_controlling_tty():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.startup_stage = "spawning-bun"
        self.process = subprocess.Popen(
            [self.executable, "run", str(FIXTURE)],
            cwd=FRAMEWORK,
            env=env,
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            start_new_session=True,
            preexec_fn=acquire_controlling_tty,
        )
        self.startup_stage = "bun-child-spawned"
        return self

    def startup_diagnostics(self):
        process = self.process
        if process is None:
            child: dict[str, Any] = {"state": "not-spawned"}
        else:
            pid = process.pid
            child = {
                "pid": pid,
                "returnCode": process.poll(),
                "argv": process.args,
                "state": "unknown",
                "wchan": "unavailable",
            }
            proc = Path(f"/proc/{pid}")
            try:
                child["actualExecutable"] = os.readlink(proc / "exe")
            except OSError:
                child["actualExecutable"] = self.executable
            try:
                for line in (proc / "status").read_text(encoding="utf-8", errors="replace").splitlines():
                    if line.startswith("State:"):
                        child["state"] = line.partition(":")[2].strip()
                        break
                child["wchan"] = (proc / "wchan").read_text(encoding="utf-8", errors="replace").strip()[:160]
            except OSError:
                pass
            try:
                result = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "pid=,ppid=,stat=,comm=,args="],
                    capture_output=True, text=True, timeout=1, check=False,
                )
                child["ps"] = (result.stdout or result.stderr).strip()[:1000]
                if result.returncode != 0:
                    child["psExitCode"] = result.returncode
            except (OSError, subprocess.TimeoutExpired) as error:
                child["psError"] = f"{type(error).__name__}: {error}"

        fixture_stages = [event.get("stage") for event in self.events()
                          if event.get("type") == "fixture.stage" and isinstance(event.get("stage"), str)]
        try:
            flags = termios.tcgetattr(self.slave)[3]
            terminal_mode = {
                "raw": not (flags & termios.ICANON) and not (flags & termios.ECHO),
                "canonical": bool(flags & termios.ICANON),
                "echo": bool(flags & termios.ECHO),
            }
        except OSError as error:
            terminal_mode = {"error": f"{type(error).__name__}: {error}"}
        return {
            "startupStage": self.startup_stage,
            "fixtureStartupStage": fixture_stages[-1] if fixture_stages else "fixture-main-not-observed",
            "fixtureStages": fixture_stages[-12:],
            "fixtureErrors": [
                str(event.get("error", ""))[:1024]
                for event in self.events() if event.get("type") == "session.error"
            ][-3:],
            "executableResolvedByParent": self.executable,
            "workingDirectory": str(FRAMEWORK),
            "child": child,
            "terminalMode": terminal_mode,
            "ptyBytesReceived": len(self.output),
            "safeRelevantEnvironment": self.child_environment,
        }

    def read_once(self, timeout: float):
        if self.eof:
            return
        ready, _, _ = select.select([self.master], [], [], max(0, timeout))
        if not ready:
            return
        try:
            chunk = os.read(self.master, 65536)
        except OSError as error:
            if error.errno in (5, 9):
                self.eof = True
                return
            raise
        if not chunk:
            self.eof = True
            return
        self.output.extend(chunk)
        if len(self.output) > MAX_OUTPUT:
            raise AssertionError(f"{self.scenario}: PTY output exceeded {MAX_OUTPUT} bytes")
        self.screen.feed(chunk)

    def _wait(self, predicate, description: str, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            self.read_once(min(0.05, max(0, deadline - time.monotonic())))
            if self.process and self.process.poll() is not None and self.eof and not predicate():
                break
        raise AssertionError(
            f"{self.scenario}: timed out waiting for {description}; "
            f"exit={self.process.poll() if self.process else None}; "
            f"screen={self.screen.snapshot_text()[-3000:]}; output={plain_text(self.output)[-3000:]}; "
            f"startupDiagnostics={json.dumps(self.startup_diagnostics(), ensure_ascii=False, sort_keys=True)}"
        )

    def wait_screen(self, text: str, timeout=10.0):
        self._wait(lambda: text in self.screen.current_text(), f"screen text {text!r}", timeout)

    def wait_output(self, text: str, timeout=10.0):
        self._wait(lambda: text in plain_text(self.output), f"output text {text!r}", timeout)

    def send(self, value: bytes):
        os.write(self.master, value)

    def send_timed(self, value: bytes):
        started = time.monotonic_ns()
        written = os.write(self.master, value)
        finished = time.monotonic_ns()
        if written != len(value):
            raise AssertionError(f"{self.scenario}: short PTY write ({written}/{len(value)} bytes)")
        return started, finished

    def send_text(self, value: str):
        self.send(value.encode("utf-8"))

    def wait_events(self, predicate, description: str, timeout=10.0):
        def matching():
            for event in self.events():
                if predicate(event):
                    return event
            return None

        result = matching()
        if result is None:
            self._wait(lambda: matching() is not None, description, timeout)
            result = matching()
        return result

    def events(self):
        try:
            lines = self.events_path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []
        parsed = []
        for line in lines:
            try:
                parsed.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return parsed

    def fixture_report(self):
        if not self.result_path.exists():
            raise AssertionError(f"{self.scenario}: fixture did not write structured result evidence")
        return json.loads(self.result_path.read_text(encoding="utf-8"))

    def raw_mode(self):
        flags = termios.tcgetattr(self.slave)[3]
        return not (flags & termios.ICANON) and not (flags & termios.ECHO)

    def cooked_mode(self):
        flags = termios.tcgetattr(self.slave)[3]
        return bool(flags & termios.ICANON) and bool(flags & termios.ECHO)

    def checkpoint(self, name: str):
        self.checkpoints[name] = {
            "screen": self.screen.current_lines(),
            "rawMode": self.raw_mode(),
            "cookedMode": self.cooked_mode(),
        }

    def wait_exit(self, timeout=10.0):
        assert self.process is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read_once(0.05)
            if self.process.poll() is not None:
                for _ in range(3):
                    self.read_once(0)
                return self.process.returncode
        raise AssertionError(f"{self.scenario}: child did not exit; screen={self.screen.snapshot_text()[-3000:]}")

    def capture_terminal_cleanup(self):
        self._wait(lambda: self.result_path.exists(), "fixture post-cleanup report")
        if self.process is None or self.process.poll() is not None:
            raise AssertionError(f"{self.scenario}: fixture exited before parent could query post-cleanup termios")

        failure = None
        try:
            current = termios.tcgetattr(self.slave)
            restored = normalized_termios(current) == normalized_termios(self.initial_termios)
            evidence = {
                "schemaVersion": 1,
                "source": "parent tcgetattr on PTY slave after runInteractiveSession cleanup",
                "capturedAfterInteractiveCleanup": True,
                "capturedBeforeFixtureExit": self.process.poll() is None,
                "termiosRestored": restored,
                "canonical": bool(current[3] & termios.ICANON),
                "echo": bool(current[3] & termios.ECHO),
                "inputFlags": current[0],
                "outputFlags": current[1],
                "controlFlags": current[2],
                "localFlags": current[3],
            }
            if not evidence["capturedBeforeFixtureExit"]:
                raise AssertionError(f"{self.scenario}: fixture exited before termios query completed")
        except Exception as error:
            failure = error
            evidence = {
                "schemaVersion": 1,
                "source": "parent tcgetattr on PTY slave after runInteractiveSession cleanup",
                "capturedAfterInteractiveCleanup": True,
                "capturedBeforeFixtureExit": self.process.poll() is None,
                "termiosRestored": False,
                "queryError": f"{type(error).__name__}: {error}",
            }

        temporary = self.termios_release_path.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(evidence), encoding="utf-8")
        os.replace(temporary, self.termios_release_path)
        self.terminal_cleanup_evidence = evidence
        self.mode_proof["termiosAfterInteractiveCleanupBeforeFixtureExit"] = evidence
        if failure is not None:
            raise AssertionError(f"{self.scenario}: could not query actual post-cleanup termios: {evidence['queryError']}") from failure
        if not evidence["termiosRestored"]:
            raise AssertionError(f"{self.scenario}: actual post-cleanup termios differs from the initial terminal state")

    def restored(self):
        if self.terminal_cleanup_evidence is None:
            raise AssertionError(f"{self.scenario}: terminal restoration was not captured before fixture exit")
        return self.terminal_cleanup_evidence.get("termiosRestored") is True

    def capture(self):
        decoded = self.output.decode("utf-8", "replace")
        plain = plain_text(self.output)
        return {
            "outputBytes": len(self.output),
            "outputSha256": hashlib.sha256(self.output).hexdigest(),
            "plainOutputTail": plain[-50_000:],
            "screen": self.screen.snapshot_lines(),
            "checkpoints": self.checkpoints,
            "modeProof": self.mode_proof,
            "terminalCleanupEvidence": self.terminal_cleanup_evidence,
            "termiosRestored": self.restored(),
            "noColorEnvironment": "NO_COLOR=1",
            "onlyResetSgr": all(codes in ("", "0") for codes in SGR_RE.findall(decoded)),
        }

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.kill()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                # Bun can leave an owned fixture descendant attached to the PTY after its launcher is killed.
                # Terminate the isolated process group so cleanup cannot hide the original assertion failure.
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


def assert_screen_regions(session: PtySession):
    lines = session.screen.current_lines()
    if len(lines) < 24:
        raise AssertionError("TUI frame did not preserve the expected minimum row count")
    status_index = len(lines) - 3
    transcript = lines[:status_index]
    status_rows = lines[status_index:-1]
    status = " ".join(status_rows)
    composer = lines[-1]
    if not any("Native execution selection:" in line for line in transcript):
        raise AssertionError(f"transcript region missing selection: {transcript[:5]!r}")
    if "codex" not in status or "pty-fixture-model" not in status:
        raise AssertionError(f"status region missing selected model: {status!r}")
    if "You>" not in composer:
        raise AssertionError(f"composer region missing input prompt: {composer!r}")
    return {"transcript": transcript, "status": status, "composer": composer}


def chat_message(session: PtySession):
    # A genuine enhanced Shift+Enter, raw Ctrl+J, and a bracketed paste split
    # across separate PTY writes all enter the production Editor via TuiApp.
    session.send_text("discard me")
    session.wait_screen("discard me")
    session.send(b"\x03")
    session._wait(lambda: "discard me" not in session.screen.current_text() and "You>" in session.screen.current_text(), "first Ctrl+C clears the composer")
    if session.process.poll() is not None:
        raise AssertionError("first Ctrl+C shut down the TUI instead of clearing the draft")
    session.send_text("make a ")
    session.send(b"\x1b[13;2u")
    session.send_text("plan")
    session.send(b"\n")
    session.send_text("include ")
    session.send(b"\x1b[2")
    session.read_once(0.05)
    session.send("00~e\u0301\r\nsecond\t字".encode("utf-8"))
    session.send(b"\x1b[20")
    session.read_once(0.05)
    session.send(b"1~")
    session.wait_screen("second")
    session.send(b"\r")
    event = session.wait_events(lambda item: item.get("type") == "turn.started", "first conversation turn")
    return event["text"]


def select_decision(session: PtySession, action: str):
    session.wait_screen("Execution decision")
    session.wait_screen("Approve")
    if not session.raw_mode():
        raise AssertionError("inline decision was not displayed in raw TUI mode")
    session.mode_proof["rawAtInlineChoice"] = True
    session.checkpoint("inline-choice")

    # A hostile pasted approval must be inert in the inline selector. Moving
    # the actual keyboard selection afterward proves that the selector stayed
    # open and that no cooked reader/decision was entered by paste.
    session.send(b"\x1b[2")
    session.read_once(0.05)
    session.send(f"00~APPROVE {WORKFLOW_ID} {PLAN_SHA}".encode())
    session.send(b"\x1b[20")
    session.read_once(0.05)
    session.send(b"1~")
    session.send(b"\t")
    session.send(b"\x1b[B")
    session.wait_screen("> Reject")
    if not session.raw_mode():
        raise AssertionError("pasted approval left the inline choice or changed terminal mode")
    if any(event.get("type") in ("receipt.consumed", "controller.run") for event in session.events()):
        raise AssertionError("paste caused a receipt or execution before typed operator intent")

    if action == "approve":
        session.send(b"\x1b[A")
        session.wait_screen("> Approve")
    elif action != "reject":
        raise AssertionError(f"unsupported decision action {action}")
    session.send(b"\r")
    prompt = f"Inspect the saved canonical plan first. Type 'APPROVE {WORKFLOW_ID} {PLAN_SHA}'"
    session.wait_output(prompt)
    session.mode_proof["cookedAtHumanDecision"] = session.cooked_mode()
    if not session.mode_proof["cookedAtHumanDecision"]:
        raise AssertionError("real humanDecision prompt did not restore cooked termios")
    session.checkpoint("cooked-human-decision")
    before = session.events()
    if any(event.get("type") in ("receipt.consumed", "controller.run") for event in before):
        raise AssertionError("execution/receipt occurred before the operator typed the displayed subject")
    if f"Plan SHA: {PLAN_SHA}" not in plain_text(session.output):
        raise AssertionError("canonical plan hash was not displayed before the reader prompt")
    if action == "approve":
        session.send_text(f"APPROVE {WORKFLOW_ID} {PLAN_SHA}\r")
    else:
        session.send_text(f"REJECT {WORKFLOW_ID} {PLAN_SHA} rejected by PTY operator\r")
    decision = session.wait_events(lambda item: item.get("type") == "receipt.consumed", "production receipt consumption")
    if action == "approve":
        session.mode_proof["rawAfterHumanDecision"] = False
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not session.raw_mode():
            session.read_once(0.02)
        session.mode_proof["rawAfterHumanDecision"] = session.raw_mode()
        if not session.mode_proof["rawAfterHumanDecision"]:
            raise AssertionError("TuiApp did not reacquire raw input after the approving cooked decision reader")
    else:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not session.cooked_mode():
            session.read_once(0.02)
        session.mode_proof["cookedAtRejectedExit"] = session.cooked_mode()
        if not session.mode_proof["cookedAtRejectedExit"]:
            raise AssertionError("rejected decision did not leave the exiting terminal in cooked mode")
    return decision


def assert_no_additional_dispatch(session: PtySession, turns: int, runs: int):
    deadline = time.monotonic() + 0.25
    while time.monotonic() < deadline:
        session.read_once(min(0.05, max(0, deadline - time.monotonic())))
        events = session.events()
        turn_count = sum(event.get("type") == "turn.started" for event in events)
        run_count = sum(event.get("type") == "controller.run" for event in events)
        if turn_count > turns or run_count > runs:
            raise AssertionError(f"local transcript command dispatched a turn or run: {events}")
    events = session.events()
    if sum(event.get("type") == "turn.started" for event in events) != turns:
        raise AssertionError(f"unexpected conversation turns after local transcript command: {events}")
    if sum(event.get("type") == "controller.run" for event in events) != runs:
        raise AssertionError(f"unexpected execution runs after local transcript command: {events}")


def sdk_observer_counts(session: PtySession):
    snapshots = [event for event in session.events() if event.get("type") == "fixture.counts"]
    if not snapshots:
        raise AssertionError("SDK observer fixture did not publish its runtime/controller/model counters")
    return snapshots[-1]


def assert_sdk_observer_counts(session: PtySession, *, conversations: int, turns: int):
    counts = sdk_observer_counts(session)
    expected = {
        "runtimeCreateCount": 1 if conversations == 1 else 2,
        "runtimeAdmissionCount": 1 if conversations == 1 else 2,
        "controllerCreateCount": conversations,
        "conversationCreateCount": conversations,
        "modelCatalogCallCount": 0,
        "controllerStatusCallCount": 0,
        "controllerCancelCallCount": 0,
        "turnCount": turns,
        "activeTurns": 0,
        "runCount": 0,
        "validationCount": 0,
        "importCount": 0,
        "humanDecisionCalls": 0,
        "decisionCount": 0,
        "receiptConsumed": False,
    }
    observed = {key: counts.get(key) for key in expected}
    if observed != expected:
        raise AssertionError(f"SDK observer dispatched or initialized forbidden work; expected {expected}, observed {observed}")
    return observed


def run_workflow(temp_root: Path, action: str):
    session = PtySession(action, temp_root).start()
    try:
        session.wait_screen("You>")
        session.mode_proof["rawAtChat"] = session.raw_mode()
        if not session.mode_proof["rawAtChat"]:
            raise AssertionError("TuiApp chat did not enter raw terminal mode")
        session.checkpoint("initial-chat")
        regions = assert_screen_regions(session)
        session.send_text("/theme dark\r")
        session._wait(lambda: session.screen.current_lines()[-1].startswith("You>"), "process-local theme command")
        session.send_text("/ascii\r")
        session._wait(lambda: "codex / pty-fixture-model" in session.screen.current_text(), "ASCII status keeps selected model text")
        session.mode_proof["themeAndAsciiLocalNoDispatch"] = True
        assert_no_additional_dispatch(session, turns=0, runs=0)

        session._set_size(70, 20)
        session.screen.resize(70, 20)
        session._wait(lambda: any(value in session.screen.current_text() for value in (
            "Terminal too small: resize to at least 80×24",
            "Terminal too small: resize to at least 80x24",
        )), "small-terminal notice")
        session.checkpoint("resized-small")
        session._set_size(DEFAULT_COLUMNS, DEFAULT_ROWS)
        session.screen.resize(DEFAULT_COLUMNS, DEFAULT_ROWS)
        session.wait_screen("You>")
        session._wait(lambda: "Terminal too small" not in session.screen.current_text(), "resized terminal recovery")
        session.checkpoint("resized-back")
        regions = assert_screen_regions(session)

        actual_input = chat_message(session)
        expected_input = "make a \nplan\ninclude é\nsecond    字"
        if actual_input != expected_input:
            raise AssertionError(f"input protocol mismatch: expected {expected_input!r}, received {actual_input!r}")
        session.wait_screen("Execution decision")
        session.wait_output("한글")
        session.wait_screen("UX01_CANONICAL_ROW_001")
        for _ in range(16):
            session.send(b"\x1b[6~")
        session.wait_screen("UX01_CANONICAL_ROW_220")
        session._set_size(120, 40)
        session.screen.resize(120, 40)
        session.wait_screen("Decisions")
        session._set_size(DEFAULT_COLUMNS, DEFAULT_ROWS)
        session.screen.resize(DEFAULT_COLUMNS, DEFAULT_ROWS)
        session.mode_proof["longApprovalFirstLastResize"] = True
        session.checkpoint("plan-and-choice")
        if not session.raw_mode():
            raise AssertionError("plan review unexpectedly left raw mode before operator choice")

        # Attempt to queue an ordinary chat line while the selector owns input.
        # TuiApp must ignore it; the report later proves no second turn ran.
        session.send_text("not a queued turn")
        session.send(b"\x1bq" if sys.platform == "darwin" else b"\x1b\r")
        decision = select_decision(session, action)
        session.mode_proof["receiptAction"] = decision.get("action")

        if action == "approve":
            session.wait_output("[final] Workflow wf_pty_fixture done; done 1, failed 0, cancelled 0.")
            session.wait_events(lambda item: item.get("type") == "controller.run", "approved fixture run")
            session.wait_screen("Enter send")
            # Give the coordinator's event loop a chance to consume any invalid
            # choice-mode input; any dispatch is also recorded as a turn event.
            session._wait(lambda: len([e for e in session.events() if e.get("type") == "turn.started"]) == 1, "no turn dispatched from inline-choice input", 0.25)
            logical_screen = lambda: " ".join(session.screen.current_text().split())
            session._wait(lambda: any(f"[+] #1 read · call succeeded · execution not observed · task {label} · t1" in logical_screen() for label in ("Implement", "title unavailable")), "validated task title and explicit unobserved execution")
            task_label = "Implement" if "task Implement · t1" in logical_screen() else "title unavailable"
            first_tool = f"[+] #1 read · call succeeded · execution not observed · task {task_label} · t1"
            second_tool = f"[+] #2 read · call failed · execution not observed · task {task_label} · t1"
            session._wait(lambda: second_tool in logical_screen(), "second failed call with explicit execution uncertainty")
            visible = logical_screen()
            if visible.count("read ·") != 2 or "#3 read" in visible:
                raise AssertionError(f"repeated terminal tool event duplicated a tool item: {visible}")
            session.mode_proof["toolItemsBeforeFilter"] = [first_tool, second_tool]

            session.send_text("/expand 2\r")
            call_detail = "Call call-fixture-2 · execution exec-fixture · worker"
            expanded_tool = f"[-] #2 read · call failed · execution not observed · task {task_label} · t1"
            session.wait_screen(call_detail)
            session.mode_proof["expandedCallDetailVisible"] = call_detail in session.screen.current_text()
            if expanded_tool not in logical_screen():
                raise AssertionError("/expand 2 did not expand the failed read tool item")
            assert_no_additional_dispatch(session, turns=1, runs=1)

            session.send_text("/search read failed\r")
            filtered_tool = "#2 read · call failed · execution not observed · task title unavailable · t1"
            session._wait(
                lambda: filtered_tool in logical_screen() and
                "#1 read · call succeeded" not in logical_screen(),
                "search redraw with only the failed tool",
            )
            filtered = logical_screen()
            if filtered.count("read ·") != 1 or "#1 read · call succeeded" in filtered:
                raise AssertionError(f"/search read failed did not isolate exactly the failed read tool: {filtered}")
            session.mode_proof["searchReadFailedVisible"] = filtered_tool in filtered
            session.mode_proof["searchReadFailedMatchCount"] = filtered.count("read ·")
            assert_no_additional_dispatch(session, turns=1, runs=1)

            session.send_text("/search\r")
            session._wait(lambda: any(f"[+] #1 read · call succeeded · execution not observed · task {label} · t1" in logical_screen() for label in ("Implement", "title unavailable")), "cleared search restores first tool with validated or unavailable title")
            session._wait(lambda: any(f"[-] #2 read · call failed · execution not observed · task {label} · t1" in logical_screen() for label in ("Implement", "title unavailable")), "cleared search restores expanded second tool with validated or unavailable title")
            session._wait(
                lambda: "search:" not in " ".join(session.screen.current_lines()[-3:-1]) and
                session.screen.current_lines()[-1].strip() == "You>",
                "search-clear redraw reaches status and empty composer",
            )
            restored = logical_screen()
            if restored.count("read ·") != 2:
                raise AssertionError(f"/search did not clear the current-session filter: {restored}")
            session.mode_proof["emptySearchRestoredBothTools"] = True
            assert_no_additional_dispatch(session, turns=1, runs=1)

            session.send_text("/details\r")
            session.wait_screen("Task/evidence details")
            session.send(b"\x1b[B")
            session.send(b"\r")
            session.send(b"\x1b")
            session._wait(lambda: "Task/evidence details" not in session.screen.current_text(), "details panel closes without dispatch")
            session.mode_proof["detailsFocusedNavigatedClosed"] = True
            assert_no_additional_dispatch(session, turns=1, runs=1)
            session.send(b"\x04")
            session.capture_terminal_cleanup()
            code = session.wait_exit()
        else:
            session.wait_output("Workflow wf_pty_fixture rejected; execution was not started.", timeout=30.0)
            session.capture_terminal_cleanup()
            code = session.wait_exit()

        fixture = session.fixture_report()
        if fixture.get("exitCode") != 0 or code != 0:
            raise AssertionError(f"{action}: unexpected fixture/session exit codes: {fixture.get('exitCode')} / {code}")
        if fixture.get("runtime") != "synthetic deterministic fixture; no live CLI engine or model is launched":
            raise AssertionError("fixture evidence failed to disclose synthetic runtime scope")
        if fixture.get("turnInputs") != [expected_input]:
            raise AssertionError(f"{action}: unexpected conversation inputs: {fixture.get('turnInputs')!r}")
        if fixture.get("validationCount") != 1 or fixture.get("importCount") != 1:
            raise AssertionError(f"{action}: plan validation/import counts were not one")
        if fixture.get("humanDecisionCalls") != 1 or fixture.get("decisionCount") != 1:
            raise AssertionError(f"{action}: real human decision/receipt counts were not one")
        if not fixture.get("receiptConsumed") or fixture.get("runBeforeReceipt") or not fixture.get("noPlanExecutionBeforeReceipt"):
            raise AssertionError(f"{action}: receipt ordering invariant failed: {fixture}")
        consumed = next(event for event in fixture["events"] if event.get("type") == "receipt.consumed")
        if consumed.get("action") != action or consumed.get("workflowID") != WORKFLOW_ID or consumed.get("planSha") != PLAN_SHA:
            raise AssertionError(f"{action}: receipt did not match displayed workflow/hash: {consumed}")
        expected_runs = 1 if action == "approve" else 0
        if fixture.get("runCount") != expected_runs:
            raise AssertionError(f"{action}: unexpected execution dispatch count {fixture.get('runCount')}")
        if action == "approve":
            session.mode_proof["finalProgressVisible"] = "[final] Workflow wf_pty_fixture done" in plain_text(session.output)
            if not session.mode_proof["finalProgressVisible"]:
                raise AssertionError("approved flow did not render final progress")
            if "[tasks] t1 done." not in plain_text(session.output):
                raise AssertionError("approved flow did not render task progress")
        elif fixture.get("runCount") != 0:
            raise AssertionError("rejection dispatched task execution")
        if not session.restored():
            raise AssertionError(f"{action}: termios state did not restore after clean exit")
        capture = session.capture()
        capture["screenRegions"] = regions
        return {"action": action, "exitCode": code, "fixture": fixture, "capture": capture}
    finally:
        session.close()


def run_queue(temp_root: Path):
    session = PtySession("queue", temp_root).start()
    try:
        session.wait_screen("You>")
        session.mode_proof["rawAtChat"] = session.raw_mode()
        session.send_text("first turn\r")
        session.wait_events(lambda item: item.get("type") == "turn.started" and item.get("turn") == 1, "gated first turn")
        session.send_text("queued one")
        session.send(b"\x1bq" if sys.platform == "darwin" else b"\x1b\r")
        session._wait(lambda: "queued 1" in session.screen.current_text(), "first busy FIFO queue item")
        session.send_text("queued two")
        session.send(b"\x1bq" if sys.platform == "darwin" else b"\x1b\r")
        session._wait(lambda: "queued 2" in session.screen.current_text(), "second busy FIFO queue item")
        session.checkpoint("two-queued-turns")
        session.gate_path.write_text("release\n", encoding="utf-8")
        session.wait_events(lambda item: item.get("type") == "turn.started" and item.get("turn") == 3, "both FIFO turns after gated first turn")
        session._wait(lambda: len([event for event in session.events() if event.get("type") == "turn.finished"]) == 3, "all serial turns settled")
        session._wait(lambda: session.raw_mode() and "You>" in session.screen.current_text(), "chat restored after queue")
        if session.process.poll() is not None:
            raise AssertionError("queued conversation exited before returning to chat")
        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        expected = ["first turn", "queued one", "queued two"]
        if fixture.get("turnInputs") != expected:
            raise AssertionError(f"busy queue was not FIFO: {fixture.get('turnInputs')!r}")
        if fixture.get("turnCount") != 3 or fixture.get("maxConcurrentTurns") != 1 or fixture.get("activeTurns") != 0:
            raise AssertionError(f"conversations overlapped or failed to settle: {fixture}")
        if fixture.get("runCount") != 0 or fixture.get("decisionCount") != 0:
            raise AssertionError("queue-only fixture unexpectedly entered plan approval/execution")
        if code != 0 or fixture.get("exitCode") != 0 or not session.restored():
            raise AssertionError("queue fixture did not exit cleanly with terminal state restored")
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def run_restore(temp_root: Path):
    session = PtySession("restore", temp_root).start()
    try:
        session.wait_screen("You>", timeout=30.0)
        session.mode_proof["rawAtInitialChat"] = session.raw_mode()
        if not session.mode_proof["rawAtInitialChat"]:
            raise AssertionError("restore fixture did not start in raw TUI mode")

        saved_sid = "pty-restored-session"
        session.send_text("/sessions\r")
        session.wait_screen("Retained sessions")
        session.wait_screen("/207")
        session.send(b"\x1b[6~")
        session._wait(lambda: "showing 1-" not in session.screen.current_text(), "captured session chooser page advances")
        session.send(b"\x1b")
        session._wait(lambda: "Retained sessions · Up/Down" not in session.screen.current_text() and session.screen.current_lines()[-1].startswith("You>"), "session chooser Escape restores composer")
        session.mode_proof["capturedSessionChooserPagedAndCancelled"] = True
        session.send_text(f"/resume {saved_sid}\r")
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            "UNSENT_RESTORED_DRAFT" in session.screen.current_lines()[-1] and
            "QUEUED_RESTORED_DRAFT" in session.screen.current_text() and
            "LATEST_RESTORED_HISTORY_NEEDLE" in session.screen.current_text() and
            any("codex" in line and "pty-fixture-model" in line for line in session.screen.current_lines()[-3:-1]),
            "production /resume to restore the held draft and unsent queued notice",
        )
        if not session.raw_mode():
            raise AssertionError("restored session did not remain in the real raw PTY mode")
        session.mode_proof["restoredDraftVisible"] = True
        session.mode_proof["restoredQueueRetainedUnsent"] = True
        session.checkpoint("restored-held-session")
        if any(event.get("type") in ("turn.started", "controller.run") for event in session.events()):
            raise AssertionError("restoring the held session dispatched a model turn or execution run")

        # Search all submitted history while preserving the restored draft.
        session.send(b"\x12")
        session.wait_screen("Search input history")
        session.send_text("EARLIEST_RESTORED_HISTORY_NEEDLE")
        session.wait_screen("> EARLIEST_RESTORED_HISTORY_NEEDLE")
        session.send(b"\x1b")
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            "UNSENT_RESTORED_DRAFT" in session.screen.current_lines()[-1] and
            "Search input history" not in session.screen.current_text(),
            "Escape to cancel history search and restore the saved composer draft",
        )
        session.mode_proof["historyEscapeRestoredDraft"] = True
        assert_no_additional_dispatch(session, turns=0, runs=0)

        # A single Ctrl+C clears the nonempty restored draft; it must not exit.
        session.send(b"\x03")
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            "UNSENT_RESTORED_DRAFT" not in session.screen.current_lines()[-1],
            "single Ctrl+C to clear the restored draft",
        )
        if session.process.poll() is not None:
            raise AssertionError("single Ctrl+C while clearing a nonempty draft shut down the TUI")

        session.send_text("/search EARLIEST_RESTORED_HISTORY_NEEDLE\r")
        session._wait(
            lambda: any("search:" in line for line in session.screen.current_lines()[-3:-1]) and
            any("[You] EARLIEST_RESTORED_HISTORY_NEEDLE" in line for line in session.screen.current_lines()),
            "local transcript search to find the oldest submitted segment",
        )
        session.mode_proof["oldestSegmentSearchVisible"] = True
        assert_no_additional_dispatch(session, turns=0, runs=0)

        session.send(b"\x12")
        session.wait_screen("Search input history")
        session.send_text("EARLIEST_RESTORED_HISTORY_NEEDLE")
        session.wait_screen("> EARLIEST_RESTORED_HISTORY_NEEDLE")
        session.send(b"\r")
        history_text = "EARLIEST_RESTORED_HISTORY_NEEDLE oldest submitted prompt"
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            history_text in session.screen.current_lines()[-1] and
            "Search input history" not in session.screen.current_text(),
            "Enter to insert the old history match into the composer only",
        )
        session.mode_proof["historyEnterInsertedWithoutDispatch"] = True
        assert_no_additional_dispatch(session, turns=0, runs=0)

        # Clear the selected history entry with real Backspace input, not a second Ctrl+C.
        session.send(b"\x7f" * len(history_text))
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            session.screen.current_lines()[-1].strip() == "You>",
            "Backspace to clear the selected history entry",
        )
        session.send_text("/search\r")
        session._wait(
            lambda: "search:" not in session.screen.current_lines()[-2] and
            session.screen.current_lines()[-1].strip() == "You>",
            "clear the local transcript filter before the Resume decision",
        )
        assert_no_additional_dispatch(session, turns=0, runs=0)
        session.send_text("/continue\r")
        session.wait_screen("Resume residual approved work after recovery checks?")
        session.wait_screen("> Keep held")
        session.send(b"\r")
        session._wait(
            lambda: "Resume residual approved work after recovery checks?: Keep held" in session.screen.current_text() and
            "> Keep held" not in session.screen.current_text(),
            "default Keep held choice to resolve without unholding the saved session",
        )
        session.mode_proof["continueKeepPreservedHold"] = True
        assert_no_additional_dispatch(session, turns=0, runs=0)

        session.send_text("RESTORED_HELD_INPUT_MUST_NOT_DISPATCH\r")
        session._wait(
            lambda: "Session held: use /continue to review and explicitly resume; draft was not sent." in session.screen.current_text(),
            "held-session refusal for an ordinary submitted message",
        )
        session.mode_proof["ordinaryMessageRefused"] = True
        assert_no_additional_dispatch(session, turns=0, runs=0)

        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        if session.screen.alt or session.screen.last_alt is None:
            raise AssertionError("Ctrl+D exit did not emit real alternate-screen restoration through the PTY")
        session.mode_proof["altScreenRestored"] = True
        fixture = session.fixture_report()
        if code != 0 or fixture.get("exitCode") != 0:
            raise AssertionError(f"restore fixture did not exit cleanly: {code} / {fixture.get('exitCode')}")
        if fixture.get("turnInputs") != [] or fixture.get("turnCount") != 0 or fixture.get("runCount") != 0:
            raise AssertionError(f"restoration or history selection dispatched work: {fixture}")

        seed = fixture.get("restoreSeed")
        if not isinstance(seed, dict) or seed.get("pairCount") != 102 or seed.get("segmentCount", 0) <= 3 or seed.get("earliestPairInFirstSegment") is not True:
            raise AssertionError(f"restore seed did not include over 100 pairs across more than three segments: {seed}")
        retained = fixture.get("restoreRetained")
        if not isinstance(retained, dict) or retained.get("sessionID") != saved_sid or retained.get("replayComplete") is not True:
            raise AssertionError(f"post-shutdown retained replay was incomplete: {retained}")
        if retained.get("recordCount") != retained.get("totalRecords") or retained.get("segmentCount", 0) <= 3:
            raise AssertionError(f"post-shutdown store record/segment counts were incomplete: {retained}")
        if retained.get("recordCount", 0) <= seed.get("recordCount", 0):
            raise AssertionError(f"interactive coordinator did not retain new session transcript records: {retained}")
        if retained.get("metadata") != {"engine": "codex", "model": "pty-fixture-model", "held": True}:
            raise AssertionError(f"saved session metadata was not retained held after shutdown: {retained.get('metadata')}")
        if not session.restored():
            raise AssertionError("restoration PTY did not restore actual termios state after clean exit")
        return {
            "exitCode": code,
            "fixture": fixture,
            "capture": session.capture(),
        }
    finally:
        session.close()


def run_sdk_observer(temp_root: Path):
    session = PtySession("sdk-observer", temp_root).start()
    try:
        session.wait_screen("You>")
        initial_counts = assert_sdk_observer_counts(session, conversations=1, turns=0)
        sid = "pty-retained-sdk-session"
        banner = f"Retained SDK session {sid} · read-only history"
        session.send_text(f"/resume {sid}\r")
        session._wait(
            lambda: banner in session.screen.current_text() and
            "SDK_RETAINED_HISTORY_NEEDLE original upstream user prompt" in session.screen.current_text() and
            "Retained upstream assistant history remains readable without its vendor." in session.screen.current_text() and
            session.screen.current_lines()[-1].startswith("History>"),
            "production /resume to observe retained OpenCode history without a vendor runtime",
        )
        if not session.raw_mode():
            raise AssertionError("retained SDK observation did not remain in raw PTY mode")
        session.mode_proof["sdkObserverBannerAndHistory"] = True
        assert_sdk_observer_counts(session, conversations=1, turns=0)

        session.send_text("/search SDK_RETAINED_HISTORY_NEEDLE\r")
        session._wait(
            lambda: any("search: SDK_RETAINED_HISTORY_NEEDLE" in line for line in session.screen.current_lines()[-3:-1]) and
            any("SDK_RETAINED_HISTORY_NEEDLE original upstream user prompt" in line
                for line in session.screen.current_lines()[:-1]),
            "local transcript search over retained SDK history",
        )
        session.mode_proof["sdkObserverSearchVisible"] = True
        assert_sdk_observer_counts(session, conversations=1, turns=0)
        session.send_text("/search\r")
        session._wait(
            lambda: "search:" not in session.screen.current_lines()[-2] and
            session.screen.current_lines()[-1].startswith("History>"),
            "clear retained-history search before testing refused work commands",
        )

        readonly_refusal = f"Retained SDK session {sid} is read-only; command or message was not applied."

        def refuse(command: str):
            session._wait(
                lambda: (f"History> {command}" in session.screen.current_text() or f"[You] {command}" in session.screen.current_text()) and
                readonly_refusal in " ".join(
                    " ".join(line.removeprefix("  | ") for line in session.screen.current_lines()).split()
                ) and
                session.screen.current_lines()[-1].startswith("History>"),
                f"read-only SDK refusal of {command!r}",
            )

        session.send_text("/continue\r")
        refuse("/continue")
        assert_sdk_observer_counts(session, conversations=1, turns=0)
        session.send_text("/cancel\r")
        refuse("/cancel")
        assert_sdk_observer_counts(session, conversations=1, turns=0)
        session.send_text("/model\r")
        refuse("/model")
        assert_sdk_observer_counts(session, conversations=1, turns=0)
        session.send_text("must not reach an upstream model\r")
        refuse("must not reach an upstream model")
        session.mode_proof["sdkObserverCommandsRefused"] = True
        assert_sdk_observer_counts(session, conversations=1, turns=0)
        assert_no_additional_dispatch(session, turns=0, runs=0)

        session.send_text("/new\r")
        session.wait_events(
            lambda event: event.get("type") == "conversation.created" and event.get("sessionID") == "lca-pty-session-2",
            "new unique CLI conversation after SDK observation",
        )
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            "codex" in session.screen.current_lines()[-2] and
            "pty-fixture-model" in session.screen.current_lines()[-2],
            "fresh CLI session composer after leaving the read-only SDK observer",
        )
        new_counts = assert_sdk_observer_counts(session, conversations=2, turns=0)
        if new_counts["runtimeCreateCount"] != initial_counts["runtimeCreateCount"] + 1:
            raise AssertionError("/new did not create exactly one new CLI runtime after SDK observation")
        session.mode_proof["newCliSessionAllocated"] = True

        session.send_text("ordinary input after SDK observer\r")
        turn = session.wait_events(
            lambda event: event.get("type") == "turn.started" and event.get("text") == "ordinary input after SDK observer",
            "ordinary conversation turn in the fresh CLI session",
        )
        if turn.get("sessionID") != "lca-pty-session-2":
            raise AssertionError(f"new CLI turn used the wrong session identity: {turn}")
        session.wait_screen("Fixture turn 1 completed.")
        session.mode_proof["newCliTurnWorks"] = True
        assert_sdk_observer_counts(session, conversations=2, turns=1)
        assert_no_additional_dispatch(session, turns=1, runs=0)

        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        if session.screen.alt or session.screen.last_alt is None:
            raise AssertionError("Ctrl+D exit did not restore the actual alternate screen through the PTY")
        session.mode_proof["altScreenRestored"] = True
        fixture = session.fixture_report()
        if code != 0 or fixture.get("exitCode") != 0 or not session.restored():
            raise AssertionError(f"SDK observer PTY did not exit cleanly with terminal state restored: {code} / {fixture.get('exitCode')}")
        if fixture.get("turnInputs") != ["ordinary input after SDK observer"] or fixture.get("turnCount") != 1 or fixture.get("runCount") != 0:
            raise AssertionError(f"SDK observer or new CLI session dispatched unexpected work: {fixture}")

        seed = fixture.get("sdkSeed")
        retained = fixture.get("sdkRetained")
        if not isinstance(seed, dict) or seed.get("sessionID") != sid or seed.get("metadata") != {"engine": "opencode", "held": True}:
            raise AssertionError(f"SDK seed did not retain OpenCode metadata without a model: {seed}")
        if not isinstance(retained, dict) or retained.get("recordCount") != seed.get("recordCount") or retained.get("totalRecords") != seed.get("recordCount"):
            raise AssertionError(f"SDK observer modified or incompletely replayed retained transcript: {retained}")
        if retained.get("metadata") != {"engine": "opencode", "held": True} or retained.get("attachmentReceiptCount") != 1 or retained.get("attachmentState") != "released" or retained.get("attachLockExists") is not False:
            raise AssertionError(f"SDK observer acquired/remapped a writer or changed retained metadata: {retained}")
        if fixture.get("runtimeCreateCount") != 2 or fixture.get("runtimeAdmissionCount") != 2 or fixture.get("controllerCreateCount") != 2 or fixture.get("conversationCreateCount") != 2:
            raise AssertionError(f"SDK observation unexpectedly caused runtime/controller creation: {fixture}")
        if fixture.get("modelCatalogCallCount") != 0 or fixture.get("controllerStatusCallCount") != 0 or fixture.get("controllerCancelCallCount") != 0:
            raise AssertionError(f"read-only observer performed model, status or cancel calls: {fixture}")
        selections = fixture.get("runtimeSelections")
        if not isinstance(selections, list) or [item.get("sessionID") for item in selections] != ["lca-pty-session", "lca-pty-session-2"] or any(item.get("engine") != "codex" for item in selections):
            raise AssertionError(f"SDK session was remapped to a native CLI runtime: {selections}")
        session.mode_proof["sdkMetadataAndWriterUntouched"] = True
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def skill_choice_events(session: PtySession):
    return [event for event in session.events() if event.get("type") == "skill.choice.completed"]


def skill_turn_events(session: PtySession):
    return [event for event in session.events() if event.get("type") == "turn.started"]


def submit_explicit_skill(session: PtySession, command: str):
    session.send_text(command)
    session.wait_screen(command)
    session._wait(
        lambda: command in session.screen.current_text() and
        session.screen.current_lines()[-1].startswith("You>") and
        not any("matches · Up/Down" in line for line in session.screen.current_lines()),
        f"explicit skill arguments leave completion before submitting {command!r}",
    )
    session.send(b"\r")


def wait_source_choice(session: PtySession, name: str):
    session.wait_screen(f"Skill: {name}")
    session.wait_screen("> Allow this content in this session")
    if not session.raw_mode():
        raise AssertionError("skill source consent was not displayed in raw PTY mode")
    session.mode_proof["rawAtSkillChoice"] = True


def assert_skill_turn_count(session: PtySession, expected: int, description: str):
    observed = skill_turn_events(session)
    if len(observed) != expected:
        raise AssertionError(f"{description}: expected {expected} turns, observed {observed}")
    assert_no_additional_dispatch(session, turns=expected, runs=0)


def assert_no_source_choice(session: PtySession, description: str):
    observed = [event for event in session.events() if event.get("type") == "skill.choice.started"]
    if observed:
        raise AssertionError(f"{description}: unexpected source chooser opened: {observed}")


def wait_readline_prompt_after(session: PtySession, text: str):
    session._wait(
        lambda: plain_text(session.output).rfind("You>") > plain_text(session.output).rfind(text),
        f"readline prompt after {text!r}",
    )


def assert_project_skill_catalog(session: PtySession):
    listing = session.screen.current_text()
    for expected in (
        "/skill:pty-inspect · project · custom · Inspect the PTY fixture project",
        "/skill:pty-cancel · project · custom · Exercise chooser cancellation",
    ):
        if expected not in listing:
            raise AssertionError(f"project skill catalog entry is missing: {expected!r}")
    for ambient in ("find-skills", " · home · ", "ambiguous"):
        if ambient in listing:
            raise AssertionError(f"isolated skill fixture included ambient home catalog data: {ambient!r}")


def run_skills(temp_root: Path):
    session = PtySession("skills", temp_root).start()
    try:
        session.wait_screen("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and
            event.get("engine") == "local" and event.get("compatible") is True,
            "real CLI host preflight and coordinator admission for project skills",
        )
        if not session.raw_mode():
            raise AssertionError("skill scenario did not enter raw PTY mode")

        session.send_text("/skills\r")
        session.wait_screen("/skill:pty-inspect · project · custom · Inspect the PTY fixture project")
        assert_project_skill_catalog(session)
        session.mode_proof["projectSkillCatalogRendered"] = True
        assert_skill_turn_count(session, 0, "catalog listing must not dispatch a conversation turn")
        assert_no_source_choice(session, "catalog listing")

        session.send_text("/skill:pty-insp")
        session.wait_screen("pty-inspect — Inspect the PTY fixture project")
        session.send(b"\x1b")
        session._wait(
            lambda: session.screen.current_lines()[-1] == "You> /skill:pty-insp" and
            not any("matches · Up/Down" in line for line in session.screen.current_lines()),
            "Escape dismisses completion without changing or submitting the draft",
        )
        assert_skill_turn_count(session, 0, "completion dismissal must not dispatch")
        assert_no_source_choice(session, "completion dismissal")
        session.send(b"\x7f")
        session.send_text("pect")
        session.wait_screen("pty-inspect — Inspect the PTY fixture project")
        session.send(b"\r")
        session._wait(
            lambda: session.screen.current_lines()[-1] == "You> /skill:pty-inspect",
            "skill completion inserts a command into the composer",
        )
        session.mode_proof["completionInsertedIntoComposer"] = True
        assert_skill_turn_count(session, 0, "completion insertion must not dispatch")
        assert_no_source_choice(session, "completion insertion")

        session.send_text("inspect via inserted completion")
        session._wait(
            lambda: session.screen.current_lines()[-1] == "You> /skill:pty-inspect inspect via inserted completion" and
            not any("matches · Up/Down" in line for line in session.screen.current_lines()),
            "request arguments preserve the inserted explicit command without a chooser",
        )
        session.send(b"\r")
        wait_source_choice(session, "pty-inspect")
        session.send(b"\x1b[B")
        session.wait_screen("> Deny")
        session.send(b"\r")
        session.wait_screen("Skill invocation refused; source instructions were not dispatched.")
        session._wait(lambda: session.screen.current_lines()[-1].startswith("You>"), "composer after source consent denial")
        assert_skill_turn_count(session, 0, "declining source consent must not dispatch")
        session.mode_proof["declinedSourceConsentDidNotDispatch"] = True

        submit_explicit_skill(session, "/skill:pty-inspect inspect via inserted completion")
        wait_source_choice(session, "pty-inspect")
        session.send(b"\r")
        session.wait_screen("Fixture turn 1 completed.")
        session.wait_events(
            lambda event: event.get("type") == "skill.handoff.claimed" and event.get("turn") == 1,
            "accepted project skill reaches the one-use coordinator handoff",
        )
        session._wait(lambda: session.screen.current_lines()[-1].startswith("You>"), "composer after accepted source turn")
        assert_skill_turn_count(session, 1, "accepted source consent")
        choices_after_accept = skill_choice_events(session)
        if len(choices_after_accept) != 2 or choices_after_accept[-1].get("answer") != 0:
            raise AssertionError(f"accepted source consent did not select Allow: {choices_after_accept}")
        session.mode_proof["acceptedSourceConsentDispatched"] = True

        submit_explicit_skill(session, "/skill:pty-inspect reuse same-session grant")
        session.wait_screen("Fixture turn 2 completed.")
        session._wait(lambda: session.screen.current_lines()[-1].startswith("You>"), "composer after reused source grant")
        assert_skill_turn_count(session, 2, "same-session source grant reuse")
        if len(skill_choice_events(session)) != 2:
            raise AssertionError("same-session source grant unexpectedly prompted for consent again")
        session.mode_proof["grantReusedWithinSession"] = True

        session.send_text("/new\r")
        session.wait_events(
            lambda event: event.get("type") == "conversation.created" and event.get("sessionID") == "lca-pty-session-2",
            "new foreground session after a source grant",
        )
        session._wait(
            lambda: session.screen.current_lines()[-1].startswith("You>") and
            "Native execution selection:" in session.screen.current_text(),
            "composer after /new resets the foreground session",
        )
        submit_explicit_skill(session, "/skill:pty-inspect after new session")
        wait_source_choice(session, "pty-inspect")
        choices_after_switch = skill_choice_events(session)
        if len(choices_after_switch) != 2:
            raise AssertionError(f"/new did not revoke the old session's source grant: {choices_after_switch}")
        session.send(b"\r")
        session.wait_screen("Fixture turn 3 completed.")
        session.wait_events(
            lambda event: event.get("type") == "skill.handoff.claimed" and event.get("turn") == 3,
            "new-session consent produces a distinct skill handoff",
        )
        session._wait(lambda: session.screen.current_lines()[-1].startswith("You>"), "composer after new-session source turn")
        assert_skill_turn_count(session, 3, "new-session source consent")
        session.mode_proof["newSessionRequiredFreshConsent"] = True

        submit_explicit_skill(session, "/skill:pty-cancel cancel while chooser is open")
        wait_source_choice(session, "pty-cancel")
        session.send(b"\x03\x03")
        session.mode_proof["ctrlCAbortedPendingSourceConsent"] = True
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        if session.screen.alt or session.screen.last_alt is None:
            raise AssertionError("source-consent cancellation did not restore the actual alternate screen")
        session.mode_proof["altScreenRestored"] = True
        fixture = session.fixture_report()
        if code != 130 or fixture.get("exitCode") != 130 or not session.restored():
            raise AssertionError(f"cancelling source consent did not exit with restored terminal state: {code} / {fixture.get('exitCode')}")
        if fixture.get("turnInputs") != [
            "/skill:pty-inspect inspect via inserted completion",
            "/skill:pty-inspect reuse same-session grant",
            "/skill:pty-inspect after new session",
        ] or fixture.get("turnCount") != 3 or fixture.get("runCount") != 0:
            raise AssertionError(f"skill consent flow dispatched an unexpected turn or run: {fixture.get('turnInputs')} / {fixture.get('runCount')}")
        choices = fixture.get("sourceChoices")
        expected_choices = [
            {"sessionID": "lca-pty-session", "answer": 1},
            {"sessionID": "lca-pty-session", "answer": 0},
            {"sessionID": "lca-pty-session-2", "answer": 0},
            {"sessionID": "lca-pty-session-2", "answer": None},
        ]
        if not isinstance(choices, list) or [
            {"sessionID": item.get("sessionID"), "answer": item.get("answer")} for item in choices
        ] != expected_choices:
            raise AssertionError(f"source chooser did not record decline, accept, new-session consent, and cancellation: {choices}")
        handoffs = fixture.get("skillHandoffs")
        if not isinstance(handoffs, list) or len(handoffs) != 3 or any(
            item.get("name") != "pty-inspect" or item.get("exactSource") is not True for item in handoffs
        ) or [item.get("sessionID") for item in handoffs] != [
            "lca-pty-session", "lca-pty-session", "lca-pty-session-2",
        ]:
            raise AssertionError(f"source handoff did not preserve exact custom skill bytes and session ownership: {handoffs}")
        if fixture.get("runtimeCreateCount") != 2 or fixture.get("runtimeAdmissionCount") != 2 or \
                fixture.get("controllerCreateCount") != 2 or fixture.get("conversationCreateCount") != 2:
            raise AssertionError(f"skill flow did not use real runtime/admission for both sessions: {fixture}")
        if fixture.get("modelTransportStub") != {"command": "ollama", "invocations": 0}:
            raise AssertionError(f"external model transport stub was unexpectedly invoked: {fixture.get('modelTransportStub')}")
        session.mode_proof["realRuntimeAndAdmission"] = True
        session.mode_proof["externalModelTransportNotInvoked"] = True
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def run_readline_pickers(preflight: dict[str, Any]):
    cases = {}
    with tempfile.TemporaryDirectory(prefix="lca-readline-pickers-") as directory:
        root = Path(directory).resolve()
        for level in ("engine", "model"):
            for action in ("escape", "cancel", "eof"):
                name = f"{level}-{action}"
                case_root = root / name
                case_root.mkdir()
                session = PtySession("readline-picker", case_root).start()
                try:
                    session.wait_output("You>")
                    session.send_text("/model\r")
                    prompt = "Engine [1-3]:"
                    session.wait_output(prompt)
                    if level == "model":
                        session.send_text("1\r")
                        prompt = "Model [native ID]:"
                        session.wait_output(prompt)
                    session.checkpoint("picker")
                    start = len(session.output)
                    session.send({"escape": b"\x1b", "cancel": b"/cancel\r", "eof": b"\x04"}[action])
                    if action != "eof":
                        session._wait(
                            lambda: "You>" in plain_text(session.output[start:]),
                            f"{name}: fresh composer after cancellation",
                        )
                        session.checkpoint("cancelled")
                        session.send_text("/quit\r")
                    session.capture_terminal_cleanup()
                    code = session.wait_exit()
                    fixture = session.fixture_report()
                    expected = {
                        "runtimeCreateCount": 0,
                        "runtimeAdmissionCount": 0,
                        "turnCount": 0,
                        "decisionCount": 0,
                        "runCount": 0,
                        "modelCatalogCallCount": 1 if level == "model" else 0,
                    }
                    if code != 0 or any(fixture.get(key) != value for key, value in expected.items()):
                        raise AssertionError(f"{name}: unexpected exit or side effect: {code}, {fixture}")
                    cases[name] = {"exitCode": code, "fixture": fixture, "capture": session.capture()}
                finally:
                    session.close()
    return {
        "status": "passed",
        "scope": "production readline terminal and coordinator; deterministic empty model catalog, no runtime or inference",
        "preflight": preflight,
        "cases": cases,
    }


def run_readline_skills(temp_root: Path):
    session = PtySession("readline-skills", temp_root).start()
    try:
        session.wait_output("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and
            event.get("engine") == "local" and event.get("compatible") is True,
            "real CLI host preflight for readline source consent",
        )
        session.mode_proof["readlineChooserUsesCreateReadlineTerminal"] = True

        session.send_text("/skills\r")
        catalog_line = "/skill:pty-inspect · project · custom · Inspect the PTY fixture project"
        session.wait_output(catalog_line)
        assert_project_skill_catalog(session)
        wait_readline_prompt_after(session, catalog_line)
        assert_skill_turn_count(session, 0, "readline catalog listing must not dispatch")

        choice_start = len(session.output)
        session.send_text("/skill:pty-inspect decline via readline\r")
        session._wait(
            lambda: "Choice [1-2; Enter cancels]: " in plain_text(session.output[choice_start:]),
            "fresh readline source consent prompt",
        )
        choice_output = plain_text(session.output[choice_start:])
        if not re.search(r"Hash: [0-9a-f]{64}", choice_output) or "Class: custom" not in choice_output or "Declared scope: read" not in choice_output:
            raise AssertionError("readline consent did not display the complete source hash, classification and tool scope")
        session.send_text("2\r")
        refusal = "Skill invocation refused; source instructions were not dispatched."
        session.wait_output(refusal)
        session.wait_events(
            lambda event: event.get("type") == "skill.choice.completed" and event.get("answer") == 1,
            "readline source-consent denial",
        )
        wait_readline_prompt_after(session, refusal)
        assert_skill_turn_count(session, 0, "readline denial must not dispatch")
        session.mode_proof["readlineDeclineDidNotDispatch"] = True

        choice_start = len(session.output)
        session.send_text("/skill:pty-inspect accept via readline\r")
        session._wait(
            lambda: "Choice [1-2; Enter cancels]: " in plain_text(session.output[choice_start:]),
            "second readline source consent prompt after source recapture",
        )
        session.send_text("1\r")
        response = "Fixture turn 1 completed."
        session.wait_output(response)
        session.wait_events(
            lambda event: event.get("type") == "skill.handoff.claimed" and event.get("turn") == 1,
            "readline source-consent acceptance reaches the skill handoff",
        )
        wait_readline_prompt_after(session, response)
        assert_skill_turn_count(session, 1, "readline acceptance")
        session.mode_proof["readlineAcceptDispatched"] = True

        session.send_text("/quit\r")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        if code != 0 or fixture.get("exitCode") != 0 or not session.restored():
            raise AssertionError(f"readline skill PTY did not exit cleanly with terminal state restored: {code} / {fixture.get('exitCode')}")
        if fixture.get("turnInputs") != ["/skill:pty-inspect accept via readline"] or fixture.get("turnCount") != 1:
            raise AssertionError(f"readline consent flow dispatched unexpected turns: {fixture.get('turnInputs')}")
        if fixture.get("sourceChoices") != [
            {"sessionID": "lca-pty-session", "values": ["Allow this content in this session", "Deny"], "answer": 1},
            {"sessionID": "lca-pty-session", "values": ["Allow this content in this session", "Deny"], "answer": 0},
        ]:
            raise AssertionError(f"readline chooser did not preserve denial and acceptance: {fixture.get('sourceChoices')}")
        if fixture.get("skillHandoffs") != [
            {"sessionID": "lca-pty-session", "turn": 1, "name": "pty-inspect", "exactSource": True},
        ]:
            raise AssertionError(f"readline chooser did not hand off the exact project skill: {fixture.get('skillHandoffs')}")
        if fixture.get("runtimeCreateCount") != 1 or fixture.get("runtimeAdmissionCount") != 1 or \
                fixture.get("modelTransportStub") != {"command": "ollama", "invocations": 0}:
            raise AssertionError(f"readline fixture did not use real runtime/admission without inference: {fixture}")
        session.mode_proof["realRuntimeAndAdmission"] = True
        session.mode_proof["externalModelTransportNotInvoked"] = True
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def native_tool_events(fixture: dict[str, Any]):
    events = fixture.get("nativeToolActivities")
    if not isinstance(events, list):
        raise AssertionError(f"native tool activity evidence is unavailable: {events}")
    return native_tool_activity_events(events)


def native_tool_activity_events(events: list[dict[str, Any]]):
    return [
        {key: event.get(key) for key in ("kind", "role", "tool", "outcome", "ok") if key in event}
        for event in events if event.get("kind") in ("tool-started", "tool-finished")
    ]


def assert_pending_tool_has_no_effect(session: PtySession, tool: str):
    events = [event for event in session.events() if event.get("type") == "native.tool.activity"]
    observed = native_tool_activity_events(events)
    if observed != [{"kind": "tool-started", "role": "main", "tool": tool}]:
        raise AssertionError(f"{tool} tool effect occurred before the foreground choice: {observed}")


def wait_skill_source_consent(session: PtySession, name: str):
    session.wait_events(
        lambda event: event.get("type") == "skill.sourceConsent.started" and event.get("values") == [
            "Allow this content in this session", "Deny",
        ],
        f"explicit source consent for {name}",
    )
    session.wait_screen(f"Skill: {name}")
    session.wait_screen("> Allow this content in this session")
    if not session.raw_mode():
        raise AssertionError("source consent was not presented by the attached foreground TUI")
    session.send(b"\r")


def wait_skill_tool_permission(session: PtySession, name: str, tool: str, occurrence: int):
    matches = [event for event in session.events() if event.get("type") == "skill.toolPermission.started"]
    if len(matches) < occurrence:
        session.wait_events(
            lambda event: event.get("type") == "skill.toolPermission.started" and event.get("values") == ["Allow once", "Deny"] and
            sum(candidate.get("type") == "skill.toolPermission.started" for candidate in session.events()) >= occurrence,
            f"foreground {tool} scope choice {occurrence}",
        )
    session.wait_screen(f"Skill permission: {name} (custom)")
    session.wait_screen("> Allow once")
    if not session.raw_mode():
        raise AssertionError("skill tool permission was not presented by the foreground raw TUI")
    latest = [event for event in session.events() if event.get("type") == "skill.toolPermission.started"][-1]
    if latest.get("values") != ["Allow once", "Deny"] or f"Tool: {tool}" not in latest.get("title", "") or \
            "declared tools: read" not in latest.get("title", ""):
        raise AssertionError(f"tool choice did not retain the exact scoped foreground request: {latest}")


def finish_skill_tool_scenario(session: PtySession, expected_code: int):
    session.capture_terminal_cleanup()
    code = session.wait_exit()
    fixture = session.fixture_report()
    if code != expected_code or fixture.get("exitCode") != expected_code or not session.restored():
        raise AssertionError(f"skill tool scenario terminal cleanup/exit mismatch: {code} / {fixture.get('exitCode')}")
    return {"exitCode": code, "fixture": fixture, "capture": session.capture()}


def exit_settled_failure(session: PtySession):
    session.wait_screen("[Error] The model request failed")
    session._wait(
        lambda: "request:failed(" in session.screen.current_text() and
        session.screen.current_lines()[-1].startswith("You> /skill:"),
        "settled response failure retains its draft and a live composer",
    )
    if session.process.poll() is not None:
        raise AssertionError("settled response failure terminated the TUI before explicit exit")
    session.mode_proof["settledFailureRetainsComposer"] = True
    session.send(b"\x04")


def run_skill_tool_scope(temp_root: Path):
    session = PtySession("skill-tool-scope", temp_root).start()
    try:
        session.wait_screen("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real local host admission for native skill tool scope",
        )
        if not session.raw_mode():
            raise AssertionError("native skill tool scope did not start in raw mode")

        command = "/skill:pty-scope grep PTY_SCOPE_NEEDLE in scope-target.txt"
        submit_explicit_skill(session, command)
        wait_skill_source_consent(session, "pty-scope")
        wait_skill_tool_permission(session, "pty-scope", "grep", 1)
        assert_pending_tool_has_no_effect(session, "grep")
        session.mode_proof["grepEffectBlockedUntilOwnerChoice"] = True

        session.send(b"\r")
        session.wait_events(
            lambda event: event.get("type") == "ollama.stub.request" and event.get("index") == 2 and event.get("priorGrepResult") is True,
            "second deterministic model request observes the one permitted actual grep result",
        )
        wait_skill_tool_permission(session, "pty-scope", "grep", 2)
        tool_activity = [event for event in session.events() if event.get("type") == "native.tool.activity"]
        observed = native_tool_activity_events(tool_activity)
        if observed != [
            {"kind": "tool-started", "role": "main", "tool": "grep"},
            {"kind": "tool-finished", "role": "main", "tool": "grep", "outcome": "succeeded", "ok": True},
            {"kind": "tool-started", "role": "main", "tool": "grep"},
        ]:
            raise AssertionError(f"allow-once grep execution or repeated-call scope was not observed exactly: {observed}")
        session.mode_proof["oneGrepExecutedAndSameNextCallRequiresChoice"] = True
        session.send(b"\x1b[B")
        session.wait_screen("> Deny")
        session.send(b"\r")
        session.wait_events(
            lambda event: event.get("type") == "skill.toolPermission.completed" and event.get("answer") == 1,
            "owner denial of the repeated grep call",
        )

        exit_settled_failure(session)
        outcome = finish_skill_tool_scenario(session, 0)
        fixture = outcome["fixture"]
        final_tools = native_tool_events(fixture)
        expected_tools = [
            {"kind": "tool-started", "role": "main", "tool": "grep"},
            {"kind": "tool-finished", "role": "main", "tool": "grep", "outcome": "succeeded", "ok": True},
            {"kind": "tool-started", "role": "main", "tool": "grep"},
            {"kind": "tool-finished", "role": "main", "tool": "grep", "outcome": "denied", "ok": False},
        ]
        if final_tools != expected_tools:
            raise AssertionError(f"repeated grep denial did not produce a failed native tool result without a second effect: {final_tools}")
        if fixture.get("error") is not None or fixture.get("runCount") != 0:
            raise AssertionError(f"denied repeated grep did not fail the owned model turn without execution: {fixture.get('error')} / {fixture.get('runCount')}")
        if fixture.get("sourceChoices") != [{
            "sessionID": "lca-pty-session", "values": ["Allow this content in this session", "Deny"], "answer": 0,
        }]:
            raise AssertionError(f"project source was not admitted exactly once through the foreground owner: {fixture.get('sourceChoices')}")
        choices = fixture.get("toolPermissionChoices")
        if not isinstance(choices, list) or len(choices) != 2 or [item.get("answer") for item in choices] != [0, 1] or \
                any("Tool: grep" not in item.get("title", "") or "declared tools: read" not in item.get("title", "") for item in choices):
            raise AssertionError(f"same out-of-scope grep call did not require a distinct allow-once choice: {choices}")
        model = fixture.get("skillModelServer")
        requests = fixture.get("skillModelRequests")
        if not isinstance(model, dict) or model.get("requests") != 2 or model.get("responses") != 2 or model.get("simulated") is not True or \
                not isinstance(requests, list) or len(requests) != 2 or any(not item.get("hasSkillInstructions") for item in requests) or \
                requests[1].get("priorGrepResult") is not True:
            raise AssertionError(f"deterministic local model transport did not observe authentic captured skill/tool history: {model} / {requests}")
        if not fixture.get("policyIDBefore") or fixture.get("policyIDBefore") != fixture.get("policyIDAfter"):
            raise AssertionError("the fixed main-role policy ID changed across permission decisions")
        evidence = fixture.get("planExecutionEvidence")
        if not isinstance(evidence, list) or evidence != [{
            "ownerSession": "lca-pty-session", "role": "main", "policyID": fixture.get("policyIDBefore"),
            "kind": "host", "hostDispatched": True, "outcome": "failed", "reconciled": True,
        }]:
            raise AssertionError(f"real planning conversation did not retain a reconciled main-role host intent: {evidence}")
        if [event for event in fixture.get("events", []) if event.get("type") == "conversation.planCreated"] != [{
            "type": "conversation.planCreated", "sessionID": "lca-pty-session", "implementation": "createPlanConversation",
        }]:
            raise AssertionError("native scope scenario did not use the real PlanConversation factory under the attached session")
        if fixture.get("runtimeCreateCount") != 1 or fixture.get("runtimeAdmissionCount") != 1 or \
                fixture.get("controllerCreateCount") != 1 or fixture.get("conversationCreateCount") != 1:
            raise AssertionError(f"native scope scenario did not use the real coordinator runtime/admission: {fixture}")
        session.mode_proof["realPlanConversationAndExecutionIntent"] = True
        session.mode_proof["oneUseToolPermitAndFailedRepeat"] = True
        session.mode_proof["mainPolicyIDUnchanged"] = True
        session.mode_proof["simulatedLocalOllamaHTTPOnly"] = True
        return outcome
    finally:
        session.close()


def run_skill_tool_cancel(temp_root: Path):
    session = PtySession("skill-tool-cancel", temp_root).start()
    try:
        session.wait_screen("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real local host admission for pending skill tool cancellation",
        )
        command = "/skill:pty-scope grep PTY_SCOPE_NEEDLE before cancellation"
        submit_explicit_skill(session, command)
        wait_skill_source_consent(session, "pty-scope")
        wait_skill_tool_permission(session, "pty-scope", "grep", 1)
        assert_pending_tool_has_no_effect(session, "grep")
        session.mode_proof["cancelledGrepEffectBlockedUntilOwnerChoice"] = True
        session.send(b"\x03\x03")
        session.mode_proof["ctrlCAbortedPendingToolPermission"] = True
        outcome = finish_skill_tool_scenario(session, 130)
        fixture = outcome["fixture"]
        expected_tools = [
            {"kind": "tool-started", "role": "main", "tool": "grep"},
            {"kind": "tool-finished", "role": "main", "tool": "grep", "outcome": "denied", "ok": False},
        ]
        if native_tool_events(fixture) != expected_tools or fixture.get("runCount") != 0:
            raise AssertionError(f"cancelled permission wait executed grep or lost failed-result evidence: {native_tool_events(fixture)}")
        choices = fixture.get("toolPermissionChoices")
        if not isinstance(choices, list) or len(choices) != 1 or choices[0].get("answer") is not None:
            raise AssertionError(f"cancel did not dismiss the owned tool permission choice: {choices}")
        model = fixture.get("skillModelServer")
        if not isinstance(model, dict) or model.get("requests") != 1 or model.get("responses") != 1:
            raise AssertionError(f"cancelled tool permission unexpectedly resumed model work: {model}")
        if fixture.get("policyIDBefore") != fixture.get("policyIDAfter"):
            raise AssertionError("main policy identity changed during cancelled permission wait")
        evidence = fixture.get("planExecutionEvidence")
        if not isinstance(evidence, list) or evidence != [{
            "ownerSession": "lca-pty-session", "role": "main", "policyID": fixture.get("policyIDBefore"),
            "kind": "host", "hostDispatched": True, "outcome": "cancelled", "reconciled": True,
        }]:
            raise AssertionError(f"cancelled plan turn did not reconcile its real main-role execution intent: {evidence}")
        outcome["capture"]["modeProof"].update({
            "realPlanConversationAndExecutionIntent": True,
            "cancelledToolPermitProducedNoEffect": True,
            "mainPolicyIDUnchanged": True,
            "simulatedLocalOllamaHTTPOnly": True,
        })
        return outcome
    finally:
        session.close()


def run_skill_main_write(temp_root: Path):
    session = PtySession("skill-main-write", temp_root).start()
    try:
        session.wait_screen("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real local host admission for fixed main-role write refusal",
        )
        command = "/skill:pty-main-write create scope-write-target.txt"
        submit_explicit_skill(session, command)
        wait_skill_source_consent(session, "pty-main-write")
        session.wait_events(
            lambda event: event.get("type") == "native.tool.activity" and event.get("kind") == "tool-started" and event.get("tool") == "write",
            "real host receives the model's skill-context write request",
        )
        exit_settled_failure(session)
        outcome = finish_skill_tool_scenario(session, 0)
        fixture = outcome["fixture"]
        if native_tool_events(fixture) != [
            {"kind": "tool-started", "role": "main", "tool": "write"},
            {"kind": "tool-finished", "role": "main", "tool": "write", "outcome": "denied", "ok": False},
        ]:
            raise AssertionError(f"main-role write was not refused by the native fixed-role gate: {native_tool_events(fixture)}")
        if fixture.get("toolPermissionChoices") != []:
            raise AssertionError(f"main-role write incorrectly opened a skill allow-once chooser: {fixture.get('toolPermissionChoices')}")
        if fixture.get("writeFileContent") != "FIXTURE_FILE_MUST_STAY_UNCHANGED\n" or fixture.get("runCount") != 0:
            raise AssertionError(f"main-role skill write changed a file or started a workflow: {fixture.get('writeFileContent')} / {fixture.get('runCount')}")
        if fixture.get("policyIDBefore") != fixture.get("policyIDAfter"):
            raise AssertionError("main policy identity changed on write refusal")
        evidence = fixture.get("planExecutionEvidence")
        if not isinstance(evidence, list) or evidence != [{
            "ownerSession": "lca-pty-session", "role": "main", "policyID": fixture.get("policyIDBefore"),
            "kind": "host", "hostDispatched": True, "outcome": "failed", "reconciled": True,
        }]:
            raise AssertionError(f"main-role write refusal did not reconcile its real host execution intent: {evidence}")
        outcome["capture"]["modeProof"].update({
            "realPlanConversationAndExecutionIntent": True,
            "fixedMainRoleDeniedWriteWithoutChooser": True,
            "mainPolicyIDUnchanged": True,
            "simulatedLocalOllamaHTTPOnly": True,
        })
        return outcome
    finally:
        session.close()


def wait_workflow_status(session: PtySession, text: str, timeout=15.0):
    """The committed `kind · stage` segment must be on one of the bounded TUI status rows."""
    def present():
        lines = session.screen.current_lines()
        return len(lines) >= 2 and any(text in line for line in lines[-3:-1])
    session._wait(present, f"status line segment {text!r}", timeout)


def pick_workflow_choice(session: PtySession, first: str, downs: int = 0):
    """Inline chooser: wait for the highlighted first entry, move, and select with Enter."""
    session.wait_screen(f"> {first}")
    for _ in range(downs):
        session.send(b"\x1b[B")
    session.send(b"\r")


def submit_answer(session: PtySession, question: str, answer_text: str):
    session.wait_screen(question)
    session._wait(lambda: session.screen.current_lines()[-1].startswith("You>"), "answer composer")
    session.send_text(answer_text)
    session.wait_screen(answer_text)
    session.send(b"\r")


def run_workflow_di(temp_root: Path):
    session = PtySession("workflow-di", temp_root).start()
    try:
        session.wait_screen("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real local host admission for the workflow scenario",
        )
        if not session.raw_mode():
            raise AssertionError("workflow scenario did not start in raw mode")
        submit_explicit_skill(session, "/skill:deep-interview build the widget")
        # the committed stage is on the status line while the topology model step runs, before any question
        wait_workflow_status(session, "deep-interview · topology")
        session.mode_proof["statusDeepInterviewTopology"] = True
        pick_workflow_choice(session, "Confirm topology")
        session.mode_proof["inlineTopologyChoice"] = True
        submit_answer(session, "Question 1:", "the widget must render")
        submit_answer(session, "Question 2:", "it must be tested")
        wait_workflow_status(session, "deep-interview · panel")
        session.mode_proof["statusPanel"] = True
        pick_workflow_choice(session, "Yes, crystallize")
        session.mode_proof["inlineRestatementChoice"] = True
        wait_workflow_status(session, "ralplan · planner")
        session.mode_proof["statusRalplanPlanner"] = True
        session.wait_screen("Architect CLEAR/APPROVE + Critic OKAY")
        session.wait_screen("execution pending")
        pick_workflow_choice(session, "Stop here (planning complete; not executed)", downs=2)
        session.wait_screen("Decide later")
        session.wait_screen("The plan stays pending")
        session.mode_proof["consensusDoesNotExecute"] = True
        session.send_text("/quit")
        session.send(b"\r")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        if code != 0 or fixture.get("exitCode") != 0 or not session.restored():
            raise AssertionError(f"workflow scenario terminal cleanup/exit mismatch: {code} / {fixture.get('exitCode')} / {fixture.get('error')}")
        evidence = fixture.get("workflowEvidence") or {}
        if evidence.get("kind") != "ralplan" or evidence.get("stage") != "pending_execution" or evidence.get("phase") != "pending_approval":
            raise AssertionError(f"workflow did not end pending execution: {evidence}")
        if evidence.get("created") != ["deep-interview", "ralplan"]:
            raise AssertionError(f"workflow starts were not exactly one deep-interview then one ralplan: {evidence.get('created')}")
        lineage = (evidence.get("lineage") or {}).get("predecessor") or {}
        if lineage.get("kind") != "deep-interview" or not str((lineage.get("artifact") or {}).get("path", "")).endswith("/spec.md"):
            raise AssertionError(f"ralplan successor has no deep-interview spec lineage: {lineage}")
        if evidence.get("ledgerTasks") != 0 or evidence.get("gjcDirectory") or evidence.get("implementationFiles"):
            raise AssertionError(f"workflow implemented or executed something: {evidence}")
        statuses = [item for item in fixture.get("workflowStatuses", []) if item]
        wanted = ["deep-interview · topology", "deep-interview · answer", "deep-interview · panel", "ralplan · planner", "ralplan · pending_execution"]
        cursor = 0
        for status in statuses:
            if cursor < len(wanted) and status.startswith(wanted[cursor]):
                cursor += 1
        if cursor != len(wanted):
            raise AssertionError(f"committed status segments were not observed in order {wanted}: {statuses}")
        choices = fixture.get("workflowChoices") or []
        if [item.get("values")[0] for item in choices] != ["Confirm topology", "Yes, crystallize", "Stop here (planning complete; not executed)"] or \
                [item.get("answer") for item in choices] != [0, 0, 2]:
            raise AssertionError(f"workflow choices were not the three inline lists answered in order: {choices}")
        requests = fixture.get("workflowModelRequests") or {}
        for stage in ("di.interviewer.topology", "di.interviewer.question", "di.scorer", "di.panel.researcher", "di.panel.contrarian", "di.panel.simplifier", "di.closure", "di.restate", "di.crystallize", "ralplan.planner", "ralplan.architect", "ralplan.critic"):
            if not requests.get(stage):
                raise AssertionError(f"real engine stage {stage} never reached the loopback model: {requests}")
        if fixture.get("shadowSkillReachedModel"):
            raise AssertionError("a project skill named deep-interview reached a model request")
        if fixture.get("turnCount") != 0 or fixture.get("runCount") != 0 or fixture.get("conversationCreateCount") != 1:
            raise AssertionError(f"workflow used a plain conversation turn or a queue run: {fixture.get('turnCount')} / {fixture.get('runCount')}")
        model = fixture.get("skillModelServer") or {}
        if model.get("simulated") is not True or not str(model.get("endpoint", "")).startswith("http://127.0.0.1:"):
            raise AssertionError(f"loopback model stub evidence is missing: {model}")
        outcome = {"exitCode": code, "fixture": fixture, "capture": session.capture()}
        outcome["capture"]["modeProof"].update({
            "realEnginesAndWorkflowTurns": True,
            "oneDeepInterviewOneRalplan": True,
            "diSpecLineageOnSuccessor": True,
            "zeroImplementationZeroLedgerTasks": True,
            "projectSkillCollisionNeverReachedModel": True,
            "simulatedLocalOllamaHTTPOnly": True,
        })
        return outcome
    finally:
        session.close()


def run_signal(temp_root: Path, name: str, signum: int, expected_code: int):
    session = PtySession(name, temp_root).start()
    try:
        session.wait_screen("You>")
        if not session.raw_mode():
            raise AssertionError(f"{name}: TUI was not in raw mode before signal")
        session.mode_proof["rawBeforeSignal"] = True
        os.kill(session.process.pid, signum)
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        if code != expected_code or fixture.get("exitCode") != expected_code:
            raise AssertionError(f"{name}: expected signal exit {expected_code}, got {code} / {fixture.get('exitCode')}")
        if fixture.get("runCount") != 0 or fixture.get("decisionCount") != 0:
            raise AssertionError(f"{name}: signal unexpectedly entered workflow execution")
        if not session.restored():
            raise AssertionError(f"{name}: signal cleanup failed to restore termios")
        return {"signal": name, "exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


GRANT_ROW_RE = re.compile(r"^(?P<sid>\S+) · (?P<name>\S+) · (?P<source>project|home) · (?P<classification>common|custom) · (?P<hash>[0-9a-f]{64}) · (?P<scope>.+)$")


def source_choice_started(session: PtySession):
    return [event for event in session.events() if event.get("type") == "skill.choice.started" and str(event.get("title", "")).startswith("Skill: ")]


def wait_nth_source_choice(session: PtySession, name: str, count: int):
    session.wait_events(
        lambda event: event.get("type") == "skill.choice.started" and len(source_choice_started(session)) >= count,
        f"source consent prompt number {count} for {name}",
    )
    if len(source_choice_started(session)) != count:
        raise AssertionError(f"expected exactly {count} source consent prompts: {source_choice_started(session)}")
    session.wait_screen("> Allow this content in this session")
    if not session.raw_mode():
        raise AssertionError("skill source consent was not displayed in raw PTY mode")
    return source_choice_started(session)[count - 1]


def consent_hash(choice: dict[str, Any]) -> str:
    match = re.search(r"^Hash: ([0-9a-f]{64})$", str(choice.get("title")), re.MULTILINE)
    if not match:
        raise AssertionError(f"source consent prompt did not display a 64-hex content hash: {choice.get('title')!r}")
    return match.group(1)


def screen_grant_rows(session: PtySession, name: str):
    rows = []
    for line in session.screen.current_lines():
        value = line.strip()
        if value.startswith("[Notice] "):
            value = value[len("[Notice] "):]
        match = GRANT_ROW_RE.match(value)
        if match and match.group("name") == name:
            rows.append(match.groupdict())
    return rows


def accept_source_grant(session: PtySession, name: str, request: str, count: int):
    submit_explicit_skill(session, f"/skill:{name} {request}")
    choice = wait_nth_source_choice(session, name, count)
    session.send(b"\r")
    return choice


def list_grant_row(session: PtySession, sid: str, name: str, accepted_choice: dict[str, Any]):
    session.send_text("/skills grants\r")
    session._wait(lambda: len(screen_grant_rows(session, name)) == 1, f"/skills grants row for {name}")
    row = screen_grant_rows(session, name)[0]
    if row["sid"] != sid or row["source"] != "project" or row["classification"] != "custom" or \
            row["scope"] != "read" or row["hash"] != consent_hash(accepted_choice):
        raise AssertionError(f"grant row does not match the consented skill: {row} / {accepted_choice}")
    if "Use read-only project inspection." in session.screen.current_text():
        raise AssertionError("grant listing exposed skill instruction bytes")
    return row


def run_skill_grants(temp_root: Path):
    session = PtySession("skill-grants", temp_root, columns=160).start()
    try:
        session.wait_screen("You>")
        session.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real CLI host preflight and coordinator admission for grant listing",
        )
        sid = "lca-pty-session"
        choice = accept_source_grant(session, "pty-inspect", "list and revoke", 1)
        session.wait_screen("Fixture turn 1 completed.")
        row = list_grant_row(session, sid, "pty-inspect", choice)
        session.mode_proof["grantRowListedWithSidNameSourceClassHashScope"] = True

        session.send_text("/skills revoke pty-inspect\r")
        session.wait_screen("Revoked 1 session skill grant(s) for pty-inspect; pending authorization cancelled.")
        session.send_text("/skills grants\r")
        session._wait(
            lambda: "No session skill grants." in session.screen.current_text(),
            "empty /skills grants listing after revoke",
        )
        if len(screen_grant_rows(session, "pty-inspect")) != 1:
            raise AssertionError("revoked grant row reappeared in the post-revoke listing")
        session.mode_proof["revokedGrantListingEmpty"] = True
        assert_skill_turn_count(session, 1, "grant listing and revoke must not dispatch turns")

        submit_explicit_skill(session, "/skill:pty-inspect after revoke")
        reprompt = wait_nth_source_choice(session, "pty-inspect", 2)
        session.send(b"\x1b[B")
        session.wait_screen("> Deny")
        session.send(b"\r")
        session.wait_screen("Skill invocation refused; source instructions were not dispatched.")
        assert_skill_turn_count(session, 1, "revoked skill must not dispatch without fresh consent")
        session.mode_proof["revokedSkillRequiredFreshSourceChoice"] = True

        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        if code != 0 or fixture.get("exitCode") != 0 or not session.restored():
            raise AssertionError(f"skill grants fixture did not exit cleanly: {code} / {fixture.get('exitCode')}")
        choices = [{"sessionID": item.get("sessionID"), "answer": item.get("answer")} for item in fixture.get("sourceChoices", [])]
        if choices != [{"sessionID": sid, "answer": 0}, {"sessionID": sid, "answer": 1}]:
            raise AssertionError(f"source choices did not record accept then fresh post-revoke prompt: {choices}")
        if fixture.get("turnCount") != 1 or len(fixture.get("skillHandoffs", [])) != 1:
            raise AssertionError(f"revoke flow dispatched unexpected work: {fixture.get('turnInputs')}")
        return {
            "exitCode": code, "fixture": fixture, "capture": session.capture(),
            "grantRow": row, "consentHash": consent_hash(choice),
            "promptCountBeforeRevoke": 1, "promptCountAfterRevoke": len(source_choice_started(session)),
            "repromptHash": consent_hash(reprompt),
        }
    finally:
        session.close()


def run_skill_restore(temp_root: Path, mode: str):
    root = temp_root / f"skill-restore-{mode}"
    root.mkdir()
    worktree = root / "worktree"
    worktree.mkdir()
    sid_a = "lca-pty-skill-a"

    def launch(label: str, prefix: str):
        return PtySession("skill-restore", root, columns=160, label=label, extra_env={
            "LCA_TUI_PTY_WORKTREE": str(worktree), "LCA_TUI_PTY_SESSION_PREFIX": prefix,
        }).start()

    first = launch("a", "pty-skill-a")
    try:
        first.wait_screen("You>")
        first.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real CLI host preflight for the original skill session",
        )
        choice_a = accept_source_grant(first, "pty-inspect", "grant in original session", 1)
        first.wait_screen("Fixture turn 1 completed.")
        row_a = list_grant_row(first, sid_a, "pty-inspect", choice_a)
        if mode == "exit":
            first.send(b"\x04")
            first.capture_terminal_cleanup()
            code_a = first.wait_exit()
            if code_a != 0 or not first.restored():
                raise AssertionError(f"original skill session did not exit normally: {code_a}")
        else:
            first.process.send_signal(signal.SIGKILL)
            code_a = first.process.wait(timeout=5)
            if code_a != -signal.SIGKILL:
                raise AssertionError(f"original skill session was not killed by SIGKILL: {code_a}")
        events_a = first.events()
    finally:
        first.close()

    second = launch("b", "pty-skill-b")
    try:
        second.wait_screen("You>")
        second.wait_events(
            lambda event: event.get("type") == "runtime.preflight.accepted" and event.get("engine") == "local" and event.get("compatible") is True,
            "real CLI host preflight for the relaunched process",
        )
        second.send_text(f"/resume {sid_a}\r")
        second.wait_screen("Restored session held. Drafts remain unsent; use /continue for an explicit Resume decision.")
        second.send_text("/skills grants\r")
        second._wait(
            lambda: "No session skill grants." in second.screen.current_text() and not screen_grant_rows(second, "pty-inspect"),
            "restored session to list no source grants",
        )
        second.mode_proof["restoredSessionHasNoGrants"] = True
        submit_explicit_skill(second, "/skill:pty-inspect while restored hold")
        second.wait_screen("Session held: use /continue to review and explicitly resume; draft was not sent.")
        if source_choice_started(second) or skill_turn_events(second):
            raise AssertionError("held restored session honored a skill invocation without explicit Resume")
        second.send_text("/continue\r")
        second.wait_screen("Resume residual approved work after recovery checks?")
        second.wait_screen("> Keep held")
        second.send(b"\x1b[B")
        second.wait_screen("> Resume")
        second.send(b"\r")
        second.wait_screen("Session admitted by explicit Resume; no work was automatically dispatched.")
        if source_choice_started(second) or skill_turn_events(second):
            raise AssertionError(f"explicit Resume reinstated an old skill grant or dispatched work: {source_choice_started(second)} / {skill_turn_events(second)}")
        second.mode_proof["explicitResumeKeptGrantsEmpty"] = True
        submit_explicit_skill(second, "/skill:pty-inspect after resume")
        reprompt = wait_nth_source_choice(second, "pty-inspect", 1)
        second.send(b"\x1b[B")
        second.wait_screen("> Deny")
        second.send(b"\r")
        second.wait_screen("Skill invocation refused; source instructions were not dispatched.")
        if skill_turn_events(second):
            raise AssertionError("restored skill dispatched without fresh consent")
        second.send_text("/skills grants\r")
        second._wait(lambda: not screen_grant_rows(second, "pty-inspect"), "grants still empty after denied fresh prompt")
        second.mode_proof["restoredSkillRequiredFreshSourceChoice"] = True
        second.send(b"\x04")
        second.capture_terminal_cleanup()
        code_b = second.wait_exit()
        fixture_b = second.fixture_report()
        if code_b != 0 or fixture_b.get("exitCode") != 0 or not second.restored():
            raise AssertionError(f"relaunched skill session did not exit cleanly: {code_b} / {fixture_b.get('exitCode')}")
        all_choices = fixture_b.get("sourceChoices", [])
        if [item.get("values") for item in all_choices] != [["Keep held", "Resume"], ["Allow this content in this session", "Deny"]]:
            raise AssertionError(f"restored process choosers were not exactly the Resume decision then fresh skill consent: {all_choices}")
        choices = [{"sessionID": item.get("sessionID"), "answer": item.get("answer")} for item in all_choices if item.get("values")[0].startswith("Allow")]
        if choices != [{"sessionID": sid_a, "answer": 1}] or fixture_b.get("turnCount") != 0 or fixture_b.get("skillHandoffs") != []:
            raise AssertionError(f"restored session honored an old grant or ticket: {choices} / {fixture_b.get('turnInputs')}")
        if consent_hash(reprompt) != consent_hash(choice_a):
            raise AssertionError("fresh prompt after restore was not for the same skill content")
        return {
            "mode": mode, "originalSessionID": sid_a, "originalExitCode": code_a,
            "originalGrantRow": row_a, "originalConsentHash": consent_hash(choice_a),
            "originalSourceChoiceEvents": len([e for e in events_a if e.get("type") == "skill.choice.completed"]),
            "restoredExitCode": code_b, "restoredFixture": fixture_b, "capture": second.capture(),
            "restoredPromptCount": len(source_choice_started(second)), "restoredConsentHash": consent_hash(reprompt),
        }
    finally:
        second.close()


def run_ctrl_c_thresholds(temp_root: Path):
    session = PtySession("ctrlc", temp_root).start()
    try:
        session.wait_screen("You>")
        if not session.raw_mode():
            raise AssertionError("Ctrl+C timing fixture did not start in raw TUI mode")
        session.mode_proof["rawAtChat"] = True

        session.send_text("separated first draft")
        session.wait_screen("separated first draft")
        separated_first, _ = session.send_timed(b"\x03")
        session._wait(
            lambda: "separated first draft" not in session.screen.current_text(),
            "first separated Ctrl+C to clear the composer",
        )
        session.send_text("separated second draft")
        session.wait_screen("separated second draft")
        separated_deadline = separated_first + 650_000_000
        while True:
            remaining = separated_deadline - time.monotonic_ns()
            if remaining <= 0:
                break
            time.sleep(min(0.01, remaining / 1_000_000_000))
        separated_second, _ = session.send_timed(b"\x03")
        separated_interval = separated_second - separated_first
        if separated_interval <= 500_000_000:
            raise AssertionError(f"separated Ctrl+C writes were not more than 500 ms apart: {separated_interval / 1_000_000:.3f} ms")
        session._wait(
            lambda: "separated second draft" not in session.screen.current_text(),
            "second separated Ctrl+C to clear the composer",
        )
        if session.process.poll() is not None:
            raise AssertionError("Ctrl+C writes more than 500 ms apart shut down the TUI")
        separated_clear = {
            "actualIntervalNanoseconds": separated_interval,
            "actualIntervalMs": separated_interval / 1_000_000,
            "thresholdMs": 500,
            "relation": "greater-than",
            "composerCleared": True,
            "sessionRemainedRunning": True,
        }

        separated_expiry = separated_second + 650_000_000
        while True:
            remaining = separated_expiry - time.monotonic_ns()
            if remaining <= 0:
                break
            time.sleep(min(0.01, remaining / 1_000_000_000))
        session.send_text("paired draft")
        session.wait_screen("paired draft")
        paired_first, _ = session.send_timed(b"\x03")
        session._wait(
            lambda: "paired draft" not in session.screen.current_text(),
            "first paired Ctrl+C to clear the composer",
        )
        time.sleep(0.1)
        if time.monotonic_ns() - paired_first >= 400_000_000:
            raise AssertionError("PTY did not observe the first paired Ctrl+C quickly enough for a reliable sub-500 ms second write")
        paired_second, _ = session.send_timed(b"\x03")
        paired_interval = paired_second - paired_first
        if paired_interval >= 500_000_000:
            raise AssertionError(f"paired Ctrl+C writes were not less than 500 ms apart: {paired_interval / 1_000_000:.3f} ms")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        if code != 130 or fixture.get("exitCode") != 130:
            raise AssertionError(f"paired Ctrl+C should exit with code 130; got {code} / {fixture.get('exitCode')}")
        if fixture.get("turnCount") != 0 or fixture.get("decisionCount") != 0 or fixture.get("runCount") != 0:
            raise AssertionError("Ctrl+C threshold fixture unexpectedly entered a workflow or execution")
        if not session.restored():
            raise AssertionError("paired Ctrl+C cleanup did not restore actual termios state")
        paired_exit = {
            "actualIntervalNanoseconds": paired_interval,
            "actualIntervalMs": paired_interval / 1_000_000,
            "thresholdMs": 500,
            "relation": "less-than",
            "firstCtrlCClearedComposer": True,
            "exitCode": code,
        }
        return {
            "exitCode": code,
            "fixture": fixture,
            "capture": session.capture(),
            "separatedClear": separated_clear,
            "doubleExit": paired_exit,
        }
    finally:
        session.close()


def approve_real_decision(session: PtySession):
    """Drive the real inline chooser and cooked human reader for the fixture's production-controller workflow."""
    session.send_text("make a plan\r")
    session.wait_screen("Execution decision", timeout=20.0)
    session.wait_screen("  Approve")
    session.send(b"\t")
    session.wait_screen("> Approve")
    session.send(b"\r")
    begin = session.wait_events(lambda item: item.get("type") == "humanDecision.begin", "cooked human decision begins", 20.0)
    session.wait_output("Inspect the saved canonical plan first.")
    session.send_text(f"APPROVE {begin['workflowID']} {begin['planSha']}\r")
    session.wait_events(lambda item: item.get("type") == "host.run" and item.get("role") == "worker", "first worker execution", 30.0)
    session._wait(session.raw_mode, "raw mode after the real decision reader")


def worker_runs(session: PtySession) -> int:
    return sum(1 for event in session.events() if event.get("type") == "host.run" and event.get("role") == "worker")


def choose_item(session: PtySession, index: int):
    for _ in range(index):
        session.send(b"\x1b[B")
    session.send(b"\r")


def status_until(session: PtySession, needle: str, description: str, attempts: int = 12):
    """Poll /status at idle, one request per attempt (no typing-ahead), until the needle is rendered."""
    for _ in range(attempts):
        session.send_text("/status\r")
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            session.read_once(0.05)
            if needle in session.screen.current_text():
                return
    raise AssertionError(f"timed out waiting for {description}: {session.screen.snapshot_text()[-1500:]}")


def run_pause_resume(temp_root: Path):
    session = PtySession("pause-resume", temp_root).start()
    try:
        session.wait_screen("You>", timeout=30.0)
        approve_real_decision(session)
        before = worker_runs(session)
        session.send_text("/pause\r")
        session.wait_screen("pausing — termination unconfirmed")
        session.mode_proof["pausingLabelVisible"] = True
        # Zero new dispatch while the proof is outstanding, and no /continue admission or suspension.
        session.send_text("/status\r")
        session._wait(lambda: "pausing — termination unconfirmed" in session.screen.current_text() and "paused (from" not in session.screen.current_text(), "status stays pausing before proof")
        session.send(b"\x1a")
        session.wait_screen("Suspension refused: pause/termination remains unconfirmed.")
        if worker_runs(session) != before:
            raise AssertionError("a worker was dispatched while the pause was unconfirmed")
        session.checkpoint("pausing")
        session.gate_path.write_text("release\n", encoding="utf-8")
        session.wait_events(lambda item: item.get("type") == "stop.blocker.released", "fixture released the stop blocker")
        status_until(session, "paused (from executing/unit)", "paused after proof")
        session.mode_proof["pausedAfterProof"] = True
        session.checkpoint("paused")
        paused_runs = worker_runs(session)

        # /continue shows the residual and Keep/Resume; Keep starts nothing.
        session.send_text("/continue\r")
        session.wait_screen("residual t1, t2, t3")
        session.wait_screen("Keep held")
        session.mode_proof["residualShown"] = True
        session.send(b"\r")
        session.wait_screen("Kept held; no work was started.")
        if worker_runs(session) != paused_runs:
            raise AssertionError("Keep started work")

        # Resume runs exactly the residual tasks.
        prompts = plain_text(session.output).count("Resume the residual approved work?")
        session.send_text("/continue\r")
        session._wait(lambda: plain_text(session.output).count("Resume the residual approved work?") > prompts, "second Keep/Resume chooser")
        session.wait_screen("> Keep held")
        choose_item(session, 1)
        session._wait(lambda: "Resumed workflow" in plain_text(session.output) or "Resume refused" in plain_text(session.output), "resume outcome", 30.0)
        session.wait_screen("Enter send")
        if "Resume refused" in plain_text(session.output):
            raise AssertionError("resume refused: " + plain_text(session.output)[plain_text(session.output).rfind("Resume refused"):][:600])
        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        evidence = fixture.get("stopEvidence") or {}
        titles = evidence.get("workerRuns", [])
        if code != 0 or fixture.get("exitCode") != 0:
            raise AssertionError(f"pause-resume exit mismatch: {code} / {fixture.get('exitCode')} / {fixture.get('error')}")
        if len(titles) != paused_runs + 3 or sorted(title for title in titles[paused_runs:]) != sorted(f"lca task {n}: module {n}" for n in (1, 2, 3)):
            raise AssertionError(f"resume did not run exactly the residual tasks: {titles}")
        if evidence.get("taskStatuses") != ["done", "done", "done"] or evidence.get("phase") != "done":
            raise AssertionError(f"residual run did not complete the workflow: {evidence}")
        types = evidence.get("eventTypes", [])
        if types.count("pause_settled") != 1 or types.count("resumed") != 1:
            raise AssertionError(f"expected exactly one pause_settled and one resumed: {types}")
        if not session.restored():
            raise AssertionError("termios did not restore")
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def run_cancel_unconfirmed(temp_root: Path):
    session = PtySession("cancel-unconfirmed", temp_root).start()
    try:
        session.wait_screen("You>", timeout=30.0)
        approve_real_decision(session)
        session.send_text("/cancel\r")
        session.wait_screen("cancelling — termination unconfirmed")
        # Escape is a second cancel request (idempotent): never an exit and never a stopped display.
        session.send(b"\x1b")
        deadline = time.monotonic() + 1.0  # let the lone Escape time out of escape-sequence parsing
        while time.monotonic() < deadline:
            session.read_once(0.05)
        if session.process.poll() is not None:
            raise AssertionError("the process exited on /cancel before termination was proven")
        if "cancelled — this session" in session.screen.current_text() or "workflow cancelled" in session.screen.current_text().lower():
            raise AssertionError("a cancelled label was shown before proof")
        # The interrupted run returns to the held prompt; a pending cancel then blocks /continue.
        session.wait_screen("[final] Workflow")
        session.wait_screen("Enter send")
        session.send_text("/continue\r")
        session.wait_screen("Resume refused: workflow cancellation is pending")
        session.send_text("/status\r")
        session.wait_screen("cancelling — termination unconfirmed")
        session.checkpoint("cancelling")
        session.gate_path.write_text("release\n", encoding="utf-8")
        session.wait_events(lambda item: item.get("type") == "stop.blocker.released", "fixture released the stop blocker")
        status_until(session, "cancelled —", "cancelled after proof")
        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        evidence = fixture.get("stopEvidence") or {}
        if code != 0 or evidence.get("phase") != "cancelled" or evidence.get("eventTypes", []).count("cancel_settled") != 1:
            raise AssertionError(f"cancel did not settle exactly once after proof: {code} {evidence}")
        if not evidence.get("checkpoints") or evidence.get("revisions", 0) < 3:
            raise AssertionError(f"cancel did not retain checkpoints and revisions: {evidence}")
        if not session.restored():
            raise AssertionError("termios did not restore")
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def run_paused_cancel(temp_root: Path):
    session = PtySession("paused-cancel", temp_root).start()
    try:
        session.wait_screen("You>", timeout=30.0)
        approve_real_decision(session)
        session.send_text("/pause\r")
        session.wait_events(lambda item: item.get("type") == "stop.blocker.held", "pause blocker held")
        session.gate_path.write_text("release\n", encoding="utf-8")
        status_until(session, "paused (from executing/unit)", "paused after proof")
        session.send_text("/cancel\r")
        status_until(session, "cancelled —", "cancel from paused settles")
        session.send(b"\x04")
        session.capture_terminal_cleanup()
        code = session.wait_exit()
        fixture = session.fixture_report()
        evidence = fixture.get("stopEvidence") or {}
        types = evidence.get("eventTypes", [])
        if code != 0 or evidence.get("phase") != "cancelled" or types.count("pause_settled") != 1 or types.count("cancel_settled") != 1:
            raise AssertionError(f"cancel from paused did not retain the pause history and settle once: {code} {evidence}")
        if len(evidence.get("checkpoints", [])) < 2 or evidence.get("taskStatuses", []).count("done") != 0:
            raise AssertionError(f"records were not retained or tasks were manufactured: {evidence}")
        if not session.restored():
            raise AssertionError("termios did not restore")
        return {"exitCode": code, "fixture": fixture, "capture": session.capture()}
    finally:
        session.close()


def run_all(preflight: dict[str, Any]):
    with tempfile.TemporaryDirectory(prefix="lca-tui-pty-") as directory:
        root = Path(directory).resolve()
        def ux(acceptance_id: str, evidence: dict[str, Any], obligations: list[str]):
            return {**evidence, "acceptanceID": acceptance_id, "classification": "deterministic fixture transport", "obligations": obligations}
        def ux_root(name: str):
            value = root / name
            value.mkdir()
            return value
        ux05_queue = run_queue(ux_root("ux05-queue"))
        ux05_restore = run_restore(ux_root("ux05-restore"))
        return {
            "schemaVersion": 1,
            "status": "passed",
            "platform": platform.platform(),
            "python": platform.python_version(),
            "preflight": preflight,
            "scope": "production TuiApp, createReadlineTerminal, runInteractiveSession, durable session store, and raw PTY terminal; workflow scenarios use a deterministic mock host/runtime, source-consent scenarios use createCliRuntime with real coordinator admission, and tool-scope scenarios use createPlanConversation plus the real CLI host/executor and real skill broker/context with a deterministic loopback Ollama-compatible model stub; no live model inference or genuine external engine proof",
            "scenarios": {
                "approve": run_workflow(root, "approve"),
                "reject": run_workflow(root, "reject"),
                "busyFifo": run_queue(root),
                "restore": run_restore(root),
                "sdkObserver": run_sdk_observer(root),
                "skills": run_skills(root),
                "readlineSkills": run_readline_skills(root),
                "skillGrants": run_skill_grants(root),
                "skillRestoreExit": run_skill_restore(root, "exit"),
                "skillRestoreKill": run_skill_restore(root, "kill"),
                "skillToolScope": run_skill_tool_scope(root),
                "skillToolCancel": run_skill_tool_cancel(root),
                "skillMainWrite": run_skill_main_write(root),
                "workflowDI": run_workflow_di(root),
                "pauseResume": run_pause_resume(root),
                "cancelUnconfirmed": run_cancel_unconfirmed(root),
                "pausedCancel": run_paused_cancel(root),
                "ctrlCThresholds": run_ctrl_c_thresholds(root),
                "signals": {
                    "SIGINT": run_signal(root, "sigint", signal.SIGINT, 130),
                    "SIGTERM": run_signal(root, "sigterm", signal.SIGTERM, 143),
                    "SIGHUP": run_signal(root, "sighup", signal.SIGHUP, 129),
                },
                "ux01-long-approval": ux("UX01", run_workflow(ux_root("ux01"), "approve"), ["220 canonical rows", "document paging", "resize", "paste inert", "typed consent"]),
                "ux02-status-pressure": ux("UX02", run_cancel_unconfirmed(ux_root("ux02")), ["unconfirmed termination", "safety-priority status", "80x24"]),
                "ux03-focus": ux("UX03", run_skills(ux_root("ux03")), ["choice owns input", "completion insertion only", "no premature dispatch"]),
                "ux04-task-results": ux("UX04", run_workflow(ux_root("ux04"), "approve"), ["task/tool evidence", "details focus", "failed result", "panel close"]),
                "ux05-composer-queue": ux("UX05", {**ux05_queue, "restoreEvidence": ux05_restore}, ["multiline Unicode", "busy FIFO", "restored unsent queue"]),
                "ux06-recovery": ux("UX06", run_restore(ux_root("ux06")), ["207 captured candidates", "original-index paging", "cancel", "held Resume"]),
                "ux07-accessibility": ux("UX07", run_workflow(ux_root("ux07"), "reject"), ["theme", "ASCII", "NO_COLOR", "undersize privacy", "resize recovery"]),
                "ux08-diagnostics": ux("UX08", run_sdk_observer(ux_root("ux08")), ["read-only provenance", "not-observed facts", "no invented inference"]),
            },
            "coverage": {
                "productionUI": ["TuiApp", "createReadlineTerminal", "runInteractiveSession", "openSession", "attachAdmission", "replaySession", "humanDecision", "consumeOperatorDecision", "SkillSession", "createPlanConversation", "createCliRuntime", "native CLI host/tool executor", "skill permission broker"],
                "observed": [
                    "three TTY streams", "raw and cooked terminal modes", "termios restoration", "NO_COLOR",
                    "80x24 resize recovery", "transcript/status/composer regions", "Unicode composer and transcript",
                    "enhanced Shift+Enter", "Ctrl+J", "fragmented bracketed paste", "first Ctrl+C clears draft",
                    "separated >500 ms Ctrl+C clears draft without exit", "paired <500 ms Ctrl+C exits with code 130",
                    "paste cannot select or approve", "typed exact workflow/hash decision", "receipt-before-run fence",
                    "approval task/final progress", "rejection prevents run", "busy Alt+Q FIFO", "no concurrent turns",
                    "SIGINT", "SIGTERM", "SIGHUP",
                    "held durable session restore through /resume", "oldest segment /search", "full submitted-history Ctrl+R beyond 100 inputs",
                    "history Escape restores draft", "history Enter inserts without dispatch", "explicit /continue Keep held", "retained complete replay and held metadata after shutdown",
                    "retained OpenCode SDK history observed without a vendor runtime or writer", "SDK transcript search", "SDK work commands refused without host/model/controller calls",
                    "fresh CLI SID and ordinary conversation after SDK observer", "SDK metadata, transcript and attachment receipt preserved",
                    "project custom skill catalog through the real CLI runtime and admission path",
                    "skill autocomplete inserts a composer command without dispatching",
                    "source consent decline/accept and exact one-use skill handoff",
                    "same-session grant reuse and /new grant reset", "Ctrl+C cancellation while source consent chooser is pending",
                    "readline source-consent decline/accept through the real cooked PTY chooser",
                    "main-role [read] skill scope with actual grep executor, one-use allow-once, repeat denial, and tool effect lifecycle",
                    "pending grep permission cancellation before the file-search effect",
                    "main-role planning policy write refusal despite skill-declared [write] scope",
                    "unchanged main policy ID, authentic PlanConversation intent/context binding, and supervisor-session admission",
                    "real deep-interview and ralplan engines and workflow turns over a deterministic loopback model: status line deep-interview · topology, inline topology/restatement choices, answers, panel, closure, spec, auto-connect to ralplan · planner, consensus, execution pending, zero implementation",
                ],
                "notCovered": [
                    "exact 499/500/501 ms Ctrl+C boundary values remain deterministic editor-unit coverage; PTY coverage records separated >500 ms clearing and paired <500 ms shutdown",
                    "physical PTY master-close terminal-disconnect HUP is not covered; SIGHUP is delivered explicitly with os.kill",
                    "the bare CLI engine picker is not duplicated; it has separate existing PTY evidence",
                    "live local/Codex/Claude engine execution is intentionally not claimed",
                    "skill scenario uses a deterministic conversation/model-transport stub; the installed external CLI stub is not launched",
                    "readline skill scenario uses the same deterministic model-turn and external CLI stubs; no inference is launched",
                    "native skill tool-scope scenarios use deterministic simulated Ollama responses over loopback HTTP; no model inference is launched",
                    "the workflowDI scenario uses scripted stage replies over loopback HTTP; it proves the dispatch, engines, status line and choosers, not live model quality (P7 live smokes remain mandatory)",
                    "PTY qualification applies only to the platform and terminal behavior recorded in this run; other operating systems and terminal emulators are not qualified",
                    "SIGTSTP/SIGCONT suspension is outside this PTY fixture",
                ],
            },
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="check the frozen PTY prerequisites only")
    parser.add_argument("--readline-pickers-only", action="store_true", help="probe fallback selection cancellation and EOF without inference")
    parser.add_argument("--out", type=Path, help="optional path for structured PTY evidence and screen captures")
    args = parser.parse_args()
    required = os.environ.get("LCA_TUI_PTY_REQUIRED") == "1"

    try:
        preflight = preflight_evidence()
    except Exception as error:
        evidence = {
            "schemaVersion": 1,
            "available": False,
            "required": required,
            "error": f"{type(error).__name__}: {error}",
            "scope": "frozen P0 PTY prerequisite probe; no product qualification",
        }
        print(json.dumps(evidence, ensure_ascii=False))
        return 1 if required else (0 if args.check else 77)

    if args.check:
        print(json.dumps({"schemaVersion": 1, "available": True, "preflight": preflight}, ensure_ascii=False))
        return 0

    try:
        evidence = run_readline_pickers(preflight) if args.readline_pickers_only else run_all(preflight)
    except Exception as error:
        evidence = {
            "schemaVersion": 1,
            "status": "failed",
            "platform": platform.platform(),
            "error": f"{type(error).__name__}: {error}",
            "scope": "production TuiApp and shared coordinator PTY integration",
        }
        if required:
            print(json.dumps(evidence, ensure_ascii=False))
            if args.out:
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return 1
        print(json.dumps(evidence, ensure_ascii=False))
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 1

    evidence["harnessSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
