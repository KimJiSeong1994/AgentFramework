import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { consumeOperatorDecision, humanDecision, OperatorDecisionInputError } from "../src/hosts/operator.ts"
import { planBinding, withTerminalLine } from "./operator-helpers.ts"

const workflowID = "wf_operator_receipt"
const planSha = "sha_operator_receipt"
const sessionID = "ses_operator_receipt"
const binding = planBinding(sessionID, { id: workflowID, lastSeq: 7 }, planSha)

function readWith(line: string, mode: "approve" | "reject" | "choose" = "choose") {
  return withTerminalLine(line, () => humanDecision(mode, binding))
}

test("terminal reader issues immutable, one-shot receipts for exact approval and rejection lines", async () => {
  const approved = await readWith(`APPROVE ${workflowID} ${planSha}`, "approve")
  expect(approved).toMatchObject({ action: "approve", sessionID, workflowID, expectedRevision: 7, subject: { kind: "plan", id: workflowID, sha256: planSha } })
  expect(Object.isFrozen(approved)).toBe(true)
  expect(consumeOperatorDecision(approved)).toBe(approved)
  expect(() => consumeOperatorDecision(approved)).toThrow("terminal reader")

  const rejected = await readWith(`REJECT ${workflowID} ${planSha} because details are missing`, "reject")
  expect(rejected).toMatchObject({ action: "reject", sessionID, workflowID, expectedRevision: 7, subject: { kind: "plan", id: workflowID, sha256: planSha }, reason: "because details are missing" })
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

test.each(["실제로 수행해줘", "", "APPROVE foreign sha_operator_receipt"])("invalid operator input %j has a recoverable type without issuing approval", async line => {
  const error = await readWith(line).then(() => undefined, error => error)
  expect(error).toBeInstanceOf(OperatorDecisionInputError)
  expect(error.name).toBe("OperatorDecisionInputError")
  expect(error.message).toContain("enter the exact displayed APPROVE or REJECT line")
  if (line) expect(error.message).not.toContain(line)
  expect(() => consumeOperatorDecision(error)).toThrow("terminal reader")

  // Recovery requires a new exact terminal submission, never a natural-language grant.
  const approved = await readWith(`APPROVE ${workflowID} ${planSha}`)
  expect(consumeOperatorDecision(approved).action).toBe("approve")
  expect(() => consumeOperatorDecision(approved)).toThrow("terminal reader")
})

test("an aborted operator read remains distinct from a submitted invalid line", async () => {
  const abort = new AbortController()
  abort.abort()
  const error = await withTerminalLine(`APPROVE ${workflowID} ${planSha}`,
    () => humanDecision("approve", binding, abort.signal)).then(() => undefined, error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(OperatorDecisionInputError)
  expect(error.name).toBe("AbortError")
  expect(() => consumeOperatorDecision(error)).toThrow("terminal reader")
})

test("plain marker objects, spreads, and JSON copies cannot be consumed", async () => {
  const marker = { source: "local_human", action: "approve", ...binding }
  expect(() => consumeOperatorDecision(marker)).toThrow("terminal reader")

  const receipt = await readWith(`APPROVE ${workflowID} ${planSha}`)
  expect(() => consumeOperatorDecision({ ...receipt })).toThrow("terminal reader")
  expect(() => consumeOperatorDecision(JSON.parse(JSON.stringify(receipt)) as unknown)).toThrow("terminal reader")
  expect(consumeOperatorDecision(receipt)).toBe(receipt)
})

const ptyEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb" }
const hasPythonPty = spawnSync("python3", ["-I", "-S", "-B", "-c", "import pty"], {
  env: ptyEnvironment, timeout: 2_000,
}).status === 0
if (!hasPythonPty) console.warn("Operator PTY verification not run: Python pty is unavailable")

test.skipIf(!hasPythonPty).each([
  ["plan", "saved canonical plan"],
  ["experiment-unit", "experiment scope, selected data, models, and budget"],
  ["implementation-unit", "exact implementation change and verification evidence"],
] as const)("real pseudo-terminal binds a %s receipt to its displayed scope", (subjectKind, description) => {
  const operatorPath = fileURLToPath(new URL("../src/hosts/operator.ts", import.meta.url))
  const source = `
const { humanDecision, consumeOperatorDecision } = await import(${JSON.stringify(operatorPath)});
const receipt = await humanDecision("approve", { sessionID: "ses_pty", workflowID: "wf_pty", expectedRevision: 3, subject: { kind: ${JSON.stringify(subjectKind)}, id: "wf_pty", sha256: "sha_pty" } });
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
  const cwd = mkdtempSync(join(tmpdir(), "otter-operator-pty-"))
  try {
    const result = spawnSync("python3", ["-I", "-S", "-B", "-c", harness, process.execPath, source], {
      cwd, env: ptyEnvironment, encoding: "utf8", timeout: 5_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`PTY fixture failed: ${result.error?.message ?? result.status}\n${result.stderr}\n${result.stdout}`)
    }
    const match = result.stdout.match(/RESULT:(\{[^\r\n]+\})/)
    expect(result.stdout).toContain(`Inspect the ${description} first.`)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]!)).toMatchObject({
      action: "approve", sessionID: "ses_pty", workflowID: "wf_pty", expectedRevision: 3, subject: { kind: subjectKind, id: "wf_pty", sha256: "sha_pty" },
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
