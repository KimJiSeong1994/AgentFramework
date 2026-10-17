// Process helpers shared by the queue: run a shell command with a timeout and capture the tail of its output.
// node:child_process is used (not Bun.spawn) so the same code runs in bun test and inside OpenCode.
//
// The command runs detached in its own process group; timeout / abort sends termination signals to that group
// (SIGTERM, then SIGKILL) because killing only `sh` can leave children holding stdout open. Resolution happens on
// `exit`, not `close`, so it observes only the immediate child and does not prove that descendants stopped.
// Use only for legacy-unowned verification.
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

export type RunResult = { ok: boolean; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; killed: boolean; output: string; ms: number }

export type RunHandle = {
  result: Promise<RunResult>
  /** request termination of the process group (used by queue.abort) */
  kill(reason?: string): void
}

export function startShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; maxOutputChars?: number; env?: Record<string, string>; replaceEnv?: boolean },
): RunHandle {
  const max = opts.maxOutputChars ?? 4000
  const t0 = Date.now()
  let out = ""
  let timedOut = false
  let killed = false
  let done = false
  const decoder = new StringDecoder("utf8")
  const child = spawn("/bin/sh", ["-c", command], {
    cwd: opts.cwd,
    env: { ...(opts.replaceEnv ? {} : process.env), ...(opts.env ?? {}), OTTER_VERIFY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {}
    }
  }
  const push = (chunk: Buffer) => {
    out += decoder.write(chunk)
    if (out.length > max * 2) out = out.slice(out.length - max * 2)
  }
  child.stdout?.on("data", push)
  child.stderr?.on("data", push)

  let resolveResult!: (r: RunResult) => void
  const result = new Promise<RunResult>((r) => (resolveResult = r))
  let escalate: ReturnType<typeof setTimeout> | undefined
  const stop = (why: "timeout" | "kill") => {
    if (done) return
    if (why === "timeout") timedOut = true
    else killed = true
    if (escalate) return // already stopping: keep the first escalation timer
    killGroup("SIGTERM")
    escalate = setTimeout(() => killGroup("SIGKILL"), 3000)
  }
  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs)
  const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (escalate) clearTimeout(escalate)
    out += decoder.end()
    const output = out.length > max ? "…" + out.slice(out.length - max + 1) : out
    resolveResult({ ok: code === 0 && signal === null && !timedOut && !killed, exitCode: code, signal, timedOut, killed, output: output.trimEnd(), ms: Date.now() - t0 })
    // Best-effort cleanup of remaining group members; this does not prove descendants have stopped.
    setTimeout(() => killGroup("SIGKILL"), 0)
  }
  child.on("error", (e) => {
    out += `\n${e.message}`
    finish(null)
  })
  child.on("exit", (code, signal) => finish(code, signal))
  return { result, kill: () => stop("kill") }
}

export function runShell(command: string, opts: Parameters<typeof startShell>[1]): Promise<RunResult> {
  return startShell(command, opts).result
}

/** Like git() but returns raw bytes (file contents from cat-file). */
export async function gitBuffer(cwd: string, args: string[], env?: Record<string, string>): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const child = spawn("git", args, { cwd, env: { ...process.env, ...(env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (c: Buffer) => chunks.push(c))
    child.on("error", () => resolve(null))
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null))
  })
}

/** Run git with args in cwd; returns stdout (trimmed) or null on failure. Never throws. */
export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    const child = spawn("git", args, { cwd, env: { ...process.env, ...(env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (c: Buffer) => (out += c.toString()))
    child.stderr.on("data", (c: Buffer) => (err += c.toString()))
    child.on("error", () => resolve(null))
    child.on("close", (code) => resolve(code === 0 ? out.replace(/\n+$/, "") : null))
  })
}
