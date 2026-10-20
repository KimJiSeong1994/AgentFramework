// Operator shell (`!command` in the chat composer): runs one command for the human operator in the worktree.
// It is not a model tool and grants nothing to the model, and nothing it prints enters the planning conversation.
//
// The command gets the real terminal (stdin/stdout/stderr inherited, the user's $SHELL and TERM), so interactive
// programs work: editors, pagers, ssh, sudo prompts, `git rebase -i`. Otter hands the terminal over the same way it does
// for `/login` and takes it back when the command exits. It stays in Otter's foreground process group, so Ctrl+C and
// Ctrl+Z from the keyboard reach the command; the host ignores SIGINT meanwhile. Output goes straight to the terminal
// and is not captured; only the command, outcome and duration are recorded.

import { spawn } from "node:child_process"

export type ShellStatus = "complete" | "error" | "cancelled" | "timeout"

export type ShellResult = {
  readonly status: ShellStatus
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  /** Retained output lines. An operator shell keeps none: its output went to the terminal. */
  readonly lines: readonly string[]
  readonly totalLines: number
}

/** Shown in place of output on the shell card: the command printed straight to the terminal. */
export const SHELL_OUTPUT_NOT_CAPTURED = "(ran in your terminal; output was not captured)"

function shellProgram(): string {
  const configured = process.env.SHELL
  return configured && configured.startsWith("/") ? configured : "/bin/sh"
}

/** Run `command` with the terminal; resolves when it exits. The caller must have released the terminal first. */
export function runTerminalShell(command: string, cwd: string): Promise<ShellResult> {
  const started = Date.now()
  const env: NodeJS.ProcessEnv = { ...process.env, OTTER_OPERATOR_SHELL: "1" }
  delete env.OTTER_TUI
  return new Promise(resolve => {
    let settled = false
    const finish = (status: ShellStatus, exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      resolve({ status, exitCode, signal, durationMs: Date.now() - started, lines: [], totalLines: 0 })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shellProgram(), ["-c", command], { cwd, env, stdio: "inherit" })
    } catch {
      finish("error", null, null)
      return
    }
    child.on("error", () => finish("error", null, null))
    child.on("exit", (code, signal) => finish(signal === "SIGINT" ? "cancelled" : code === 0 ? "complete" : "error", code, signal))
  })
}
