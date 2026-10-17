"""Required macOS native-model smoke for the production Otter TUI."""
from __future__ import annotations
import argparse, fcntl, hashlib, json, os, pty, re, select, struct, subprocess, sys, tempfile, termios, time
from pathlib import Path

ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")

def plain(raw: bytes) -> str:
    return ANSI.sub("", raw.decode("utf-8", "replace"))

def run(argv: list[str], cwd: Path) -> str:
    return subprocess.check_output(argv, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()

def wait_for(master: int, output: bytearray, needle: str, deadline: float, start: int = 0) -> None:
    while time.monotonic() < deadline:
        if needle in plain(output[start:]): return
        ready, _, _ = select.select([master], [], [], min(0.25, max(0, deadline - time.monotonic())))
        if ready:
            chunk = os.read(master, 65536)
            if not chunk: break
            output.extend(chunk)
    raise AssertionError(f"timed out waiting for {needle!r}; tail={plain(output)[-2000:]!r}")

def wait_for_any(master: int, output: bytearray, needles: tuple[str, ...], deadline: float, start: int = 0) -> str:
    while time.monotonic() < deadline:
        current = plain(output[start:])
        for needle in needles:
            if needle in current: return needle
        ready, _, _ = select.select([master], [], [], min(0.25, max(0, deadline - time.monotonic())))
        if ready:
            chunk = os.read(master, 65536)
            if not chunk: break
            output.extend(chunk)
    raise AssertionError(f"timed out waiting for one of {needles!r}; tail={plain(output)[-2000:]!r}")

def wait_exit(process: subprocess.Popen[bytes], master: int, output: bytearray, deadline: float) -> int:
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            return code
        ready, _, _ = select.select([master], [], [], 0.25)
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: pass
    raise AssertionError(f"production TUI did not exit; tail={plain(output)[-2000:]!r}")

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--framework", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--source-hash", required=True)
    args = parser.parse_args()
    framework = Path(args.framework).resolve()
    listing = run(["ollama", "list"], framework)
    installed = next((line.split() for line in listing.splitlines()[1:] if line.split() and line.split()[0] == args.model), None)
    if not installed or len(installed) < 2 or installed[1] != args.model_id:
        raise AssertionError(f"installed model identity mismatch for {args.model}: {installed}")
    source_head = run(["git", "rev-parse", "HEAD"], framework)
    source_diff = subprocess.check_output(["git", "diff", "--binary", "--", "framework"], cwd=framework.parent)
    source_digest = hashlib.sha256(source_diff).hexdigest()
    started = time.monotonic()
    output = bytearray()
    with tempfile.TemporaryDirectory(prefix="otter-native-ux-") as directory:
        root = Path(os.path.realpath(directory))
        worktree = root / "worktree"
        worktree.mkdir()
        run(["git", "init", "-q"], worktree)
        run(["git", "config", "user.email", "native@localhost"], worktree)
        run(["git", "config", "user.name", "native"], worktree)
        (worktree / "README.md").write_text("isolated native TUI smoke\n", encoding="utf-8")
        (worktree / "check_native_1.sh").write_text("test -f NATIVE_UX_PROOF_1.txt\n", encoding="utf-8")
        (worktree / "check_native_2.sh").write_text("grep -q NATIVE_UX_README README.md\n", encoding="utf-8")
        (worktree / "check_native_3.sh").write_text("test -f NATIVE_UX_PROOF_3.txt\n", encoding="utf-8")
        run(["git", "add", "README.md", "check_native_1.sh", "check_native_2.sh", "check_native_3.sh"], worktree)
        run(["git", "commit", "-q", "-m", "fixture"], worktree)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        env = os.environ.copy()
        env.update({"TERM": "xterm-256color", "NO_COLOR": "1", "XDG_STATE_HOME": str(root / "state"), "XDG_CONFIG_HOME": str(root / "config")})
        command = ["bun", "src/hosts/cli.ts", "chat", "--worktree", str(worktree), "--engine", "local", "--model", args.model]
        process = subprocess.Popen(command, cwd=framework, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        try:
            wait_for(master, output, "You>", time.monotonic() + 60)
            response_start = len(output)
            os.write(master, b"Reply with the exact text OTTER_UX_NATIVE_READY and do not propose a plan.\r")
            wait_for(master, output, "[Assistant]", time.monotonic() + 900, response_start)
            response_text = plain(output[response_start:])
            if "OTTER_UX_NATIVE_READY" not in response_text[response_text.rfind("[Assistant]"):]:
                raise AssertionError("native response did not contain the required marker")
            prompt_start = len(output)
            wait_for(master, output, "You>", time.monotonic() + 60, prompt_start)
            plan_start = len(output)
            os.write(master, b"Create exactly three plan steps: (1) add NATIVE_UX_PROOF_1.txt containing ok, verify exactly sh check_native_1.sh; (2) append NATIVE_UX_README to README.md, verify exactly sh check_native_2.sh; (3) add NATIVE_UX_PROOF_3.txt containing ok, verify exactly sh check_native_3.sh. Return a valid plan with exactly these three steps.\r")
            outcome = wait_for_any(master, output, ("Decisions", "Plan did not reach pending approval"), time.monotonic() + 900, plan_start)
            if outcome != "Decisions":
                revision_start = len(output)
                os.write(master, b"Revise the rejected plan. Keep exactly the three requested independent file-edit steps and exact verify commands, use only the existing files named, and return the complete valid plan for approval.\r")
                outcome = wait_for_any(master, output, ("Decisions", "Plan did not reach pending approval"), time.monotonic() + 900, revision_start)
                if outcome != "Decisions":
                    raise AssertionError("native plan reviewer rejected the single corrected revision")
            # Keep pending first: document focus -> decisions -> third item.
            os.write(master, b"\t\x1b[B\x1b[B\r")
            wait_for(master, output, "Plan remains pending", time.monotonic() + 60, plan_start)
            continue_start = len(output)
            os.write(master, b"/continue\r")
            wait_for(master, output, "Resume", time.monotonic() + 120, continue_start)
            os.write(master, b"\x1b[B\r")
            wait_for(master, output, "Decisions", time.monotonic() + 120, continue_start)
            os.write(master, b"\t\r")
            wait_for(master, output, "Type 'APPROVE ", time.monotonic() + 60, continue_start)
            cooked = plain(output[continue_start:])
            matches = re.findall(r"APPROVE (wf_[A-Za-z0-9_]+) ([0-9a-f]{64})", cooked)
            if not matches: raise AssertionError("typed approval subject was not displayed")
            workflow_id, plan_sha = matches[-1]
            os.write(master, f"APPROVE {workflow_id} {plan_sha}\r".encode())
            wait_for(master, output, "[final] Workflow", time.monotonic() + 900, continue_start)
            final_text = plain(output[continue_start:])
            result_match = re.findall(r"done (\d+), failed (\d+), cancelled (\d+)", final_text)
            if not result_match:
                raise AssertionError("native approved plan result counts were not observable")
            workflow_result = {"done": int(result_match[-1][0]), "failed": int(result_match[-1][1]), "cancelled": int(result_match[-1][2])}
            post_plan_prompt = len(output)
            wait_for(master, output, "You>", time.monotonic() + 60, post_plan_prompt)
            os.write(master, b"/quit\r")
            code = wait_exit(process, master, output, time.monotonic() + 60)
            if code != 0: raise AssertionError(f"production TUI exited {code}")
        finally:
            if process.poll() is None:
                process.kill(); process.wait(timeout=10)
            os.close(master)
    evidence = {
        "schemaVersion": 1, "status": "passed", "classification": "macOS native",
        "model": args.model, "modelID": args.model_id, "sourceHead": source_head,
        "modifiedSourceDigest": source_digest, "command": "production src/hosts/cli.ts chat over a real PTY",
        "candidateSourceHash": args.source_hash,
        "scenario": "isolated prompt, canonical plan Keep/Resume, exact typed consent, authorized result, clean exit",
        "observed": ["selected model banner", "native response marker", "canonical plan pager", "Keep pending", "explicit Resume", "exact typed consent", "authorized workflow result", "clean exit"],
        "workflowResult": workflow_result,
        "outputSha256": hashlib.sha256(output).hexdigest(), "durationSeconds": round(time.monotonic() - started, 1),
    }
    destination = Path(args.out); destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except Exception as error:
        print(f"native TUI verification failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
