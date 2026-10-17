// Operator shell (`!command` in the chat composer): runs one command for the human operator in the worktree.
// It is not a model tool and grants nothing to the model: output is shown and recorded in the session
// transcript, but it is never added to the planning conversation.
//
// The command runs in its own process group; cancellation/timeout signal the whole group (SIGTERM, then
// SIGKILL). Resolution waits for stdout/stderr to close, bounded so a background descendant that keeps a pipe
// open cannot hang the terminal.
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

export type ShellStatus = "complete" | "error" | "cancelled" | "timeout"

export type ShellResult = {
  readonly status: ShellStatus
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  /** Retained tail of completed output lines (bounded). */
  readonly lines: readonly string[]
  /** Total completed output lines observed, including lines no longer retained. */
  readonly totalLines: number
}

export type ShellSnapshot = {
  /** Retained completed lines plus the unterminated last line, for live display. */
  readonly lines: readonly string[]
  readonly totalLines: number
  /** Completed lines observed so far (for streaming writers that print only finished lines). */
  readonly completed: number
  readonly completedTail: readonly string[]
}

export const OPERATOR_SHELL_TIMEOUT_MS = 10 * 60 * 1000
export const SHELL_LIVE_LINES = 2000
export const SHELL_PERSIST_LINES = 200
export const SHELL_PERSIST_BYTES = 64 * 1024
export const SHELL_LINE_CHARS = 4000
const CLOSE_GRACE_MS = 2000
const KILL_ESCALATION_MS = 3000

/** Remove terminal control sequences; keep printable text, tabs and line breaks. */
export function stripTerminalControls(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
}

function clampLine(line: string): string {
  return line.length > SHELL_LINE_CHARS ? `${line.slice(0, SHELL_LINE_CHARS)}… [${line.length - SHELL_LINE_CHARS} more characters]` : line
}

/** Bounded line buffer; a carriage return keeps only the text after it (progress bars). */
export class ShellOutputBuffer {
  private tail: string[] = []
  private partial = ""
  private completed = 0

  append(chunk: string): void {
    const parts = chunk.replace(/\r\n/gu, "\n").split("\n")
    for (let index = 0; index < parts.length; index += 1) {
      const piece = parts[index]!
      const joined = this.partial + piece
      const line = joined.includes("\r") ? joined.slice(joined.lastIndexOf("\r") + 1) : joined
      if (index < parts.length - 1) {
        this.push(line)
        this.partial = ""
      } else {
        this.partial = line
      }
    }
  }

  flush(): void {
    if (this.partial) this.push(this.partial)
    this.partial = ""
  }

  private push(line: string): void {
    this.tail.push(clampLine(stripTerminalControls(line)))
    this.completed += 1
    if (this.tail.length > SHELL_LIVE_LINES) this.tail.splice(0, this.tail.length - SHELL_LIVE_LINES)
  }

  snapshot(): ShellSnapshot {
    const partial = stripTerminalControls(this.partial)
    return {
      lines: partial ? [...this.tail, clampLine(partial)] : [...this.tail],
      totalLines: this.completed + (partial ? 1 : 0),
      completed: this.completed,
      completedTail: [...this.tail],
    }
  }

  /** Newest completed lines that fit the persisted record bounds. */
  persisted(): { lines: string[]; totalLines: number } {
    const lines = this.tail.slice(-SHELL_PERSIST_LINES)
    let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0)
    while (lines.length && bytes > SHELL_PERSIST_BYTES) bytes -= Buffer.byteLength(lines.shift()!, "utf8") + 1
    return { lines, totalLines: this.completed }
  }
}

function shellProgram(): string {
  const configured = process.env.SHELL
  return configured && configured.startsWith("/") ? configured : "/bin/sh"
}

export function runOperatorShell(command: string, options: {
  cwd: string
  signal: AbortSignal
  timeoutMs?: number
  onUpdate?: (snapshot: ShellSnapshot) => void
}): Promise<ShellResult> {
  const started = Date.now()
  const buffer = new ShellOutputBuffer()
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "dumb", NO_COLOR: "1", OTTER_OPERATOR_SHELL: "1" }
  delete env.OTTER_TUI
  return new Promise(resolve => {
    let settled = false
    let reason: "cancelled" | "timeout" | undefined
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let open = 2
    let escalate: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
    const child = spawn(shellProgram(), ["-c", command], { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} }
    }
    const stop = (why: "cancelled" | "timeout") => {
      if (settled || reason) return
      reason = why
      killGroup("SIGTERM")
      escalate = setTimeout(() => killGroup("SIGKILL"), KILL_ESCALATION_MS)
    }
    const update = () => { try { options.onUpdate?.(buffer.snapshot()) } catch {} }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (escalate) clearTimeout(escalate)
      if (grace) clearTimeout(grace)
      options.signal.removeEventListener("abort", onAbort)
      if (error) buffer.append(`\n${error.message}`)
      buffer.flush()
      // Best-effort cleanup of anything left in the group; this does not prove descendants stopped.
      setTimeout(() => killGroup("SIGKILL"), 0)
      const persisted = buffer.persisted()
      const code = exit?.code ?? null
      const status: ShellStatus = reason ?? (error || code !== 0 ? "error" : "complete")
      resolve({ status, exitCode: code, signal: exit?.signal ?? null, durationMs: Date.now() - started, ...persisted })
    }
    const onAbort = () => stop("cancelled")
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? OPERATOR_SHELL_TIMEOUT_MS)
    options.signal.addEventListener("abort", onAbort, { once: true })
    if (options.signal.aborted) stop("cancelled")
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.on("data", (chunk: Buffer) => { buffer.append(decoders[stream].write(chunk)); update() })
      child[stream]?.on("close", () => {
        buffer.append(decoders[stream].end())
        open -= 1
        if (open === 0 && exit) finish()
      })
    }
    child.on("error", error => finish(error))
    child.on("exit", (code, signal) => {
      exit = { code, signal }
      if (open === 0) finish()
      else grace = setTimeout(() => finish(), CLOSE_GRACE_MS)
    })
  })
}
