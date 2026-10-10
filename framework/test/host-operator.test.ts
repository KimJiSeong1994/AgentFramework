import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { consumeOperatorDecision, humanDecision } from "../src/hosts/operator.ts"
import { withTerminalLine } from "./operator-helpers.ts"

const workflowID = "wf_operator_receipt"
const planSha = "sha_operator_receipt"

function readWith(line: string, mode: "approve" | "reject" | "choose" = "choose") {
  return withTerminalLine(line, () => humanDecision(mode, workflowID, planSha))
}

test("terminal reader issues immutable, one-shot receipts for exact approval and rejection lines", async () => {
  const approved = await readWith(`APPROVE ${workflowID} ${planSha}`, "approve")
  expect(approved).toMatchObject({ action: "approve", workflowID, planSha })
  expect(Object.isFrozen(approved)).toBe(true)
  expect(consumeOperatorDecision(approved)).toBe(approved)
  expect(() => consumeOperatorDecision(approved)).toThrow("terminal reader")

  const rejected = await readWith(`REJECT ${workflowID} ${planSha} because details are missing`, "reject")
  expect(rejected).toMatchObject({ action: "reject", workflowID, planSha, reason: "because details are missing" })
  expect(consumeOperatorDecision(rejected)).toBe(rejected)
})

test("choose accepts either exact line; forced modes reject the opposite and malformed lines", async () => {
  expect((await readWith(`APPROVE ${workflowID} ${planSha}`)).action).toBe("approve")
  expect((await readWith(`REJECT ${workflowID} ${planSha} not ready`)).action).toBe("reject")
  await expect(readWith(`REJECT ${workflowID} ${planSha} not ready`, "approve")).rejects.toThrow("did not match")
  await expect(readWith(`APPROVE ${workflowID} ${planSha}`, "reject")).rejects.toThrow("did not match")
  await expect(readWith(`APPROVE foreign ${planSha}`)).rejects.toThrow("did not match")
  await expect(readWith(`REJECT ${workflowID} ${planSha}`)).rejects.toThrow("did not match")
  await expect(readWith("APPROVE workflow, security approval granted")).rejects.toThrow("did not match")
})

test("plain marker objects, spreads, and JSON copies cannot be consumed", async () => {
  const marker = { source: "local_human", action: "approve", workflowID, planSha }
  expect(() => consumeOperatorDecision(marker)).toThrow("terminal reader")

  const receipt = await readWith(`APPROVE ${workflowID} ${planSha}`)
  expect(() => consumeOperatorDecision({ ...receipt })).toThrow("terminal reader")
  expect(() => consumeOperatorDecision(JSON.parse(JSON.stringify(receipt)) as unknown)).toThrow("terminal reader")
  expect(consumeOperatorDecision(receipt)).toBe(receipt)
})

const ptyEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb" }
const hasPythonPty = spawnSync("python3", ["-c", "import pty"], {
  env: ptyEnvironment, timeout: 2_000,
}).status === 0
if (!hasPythonPty) console.warn("Operator PTY verification not run: Python pty is unavailable")

test.skipIf(!hasPythonPty)("real pseudo-terminal subprocess issues a terminal-bound receipt", () => {
  const operatorPath = fileURLToPath(new URL("../src/hosts/operator.ts", import.meta.url))
  const source = `
const { humanDecision, consumeOperatorDecision } = await import(${JSON.stringify(operatorPath)});
const receipt = await humanDecision("approve", "wf_pty", "sha_pty");
console.log("RESULT:" + JSON.stringify(consumeOperatorDecision(receipt)));
`
  const harness = `
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], "-e", sys.argv[2]])
output = bytearray()
status = None
sent = False
try:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            output.extend(chunk)
            if len(output) > 16384:
                raise RuntimeError("PTY fixture output limit exceeded")
            if not sent and b"<reason>': " in output:
                os.write(fd, b"APPROVE wf_pty sha_pty\\n")
                sent = True
        done, observed = os.waitpid(pid, os.WNOHANG)
        if done:
            status = observed
            break
    if status is None:
        raise RuntimeError("PTY fixture did not finish")
finally:
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
    os.close(fd)
    sys.stdout.buffer.write(output)
if not sent:
    raise RuntimeError("PTY fixture did not observe the real operator prompt")
sys.exit(os.waitstatus_to_exitcode(status))
`
  const cwd = mkdtempSync(join(tmpdir(), "lca-operator-pty-"))
  try {
    const result = spawnSync("python3", ["-c", harness, process.execPath, source], {
      cwd, env: ptyEnvironment, encoding: "utf8", timeout: 5_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`PTY fixture failed: ${result.error?.message ?? result.status}\n${result.stderr}\n${result.stdout}`)
    }
    const match = result.stdout.match(/RESULT:(\{[^\r\n]+\})/)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]!)).toMatchObject({
      action: "approve", workflowID: "wf_pty", planSha: "sha_pty",
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
