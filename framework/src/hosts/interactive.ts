import { TuiApp } from "../tui/app.ts"
import { tuiCapability } from "../tui/capability.ts"
import { createReadlineTerminal, runInteractiveSession, type InteractiveArgs, type InteractiveDependencies, type InteractiveExit } from "./interactive-session.ts"

export { InteractiveLaunchError, parseInteractiveArgs, validModelID } from "./interactive-session.ts"
export type { CliEngine, InteractiveArgs, InteractiveDependencies, InteractiveExit, Terminal } from "./interactive-session.ts"

export function launchInteractive(args: InteractiveArgs, overrides: Partial<InteractiveDependencies> = {}): Promise<InteractiveExit> {
  if (overrides.terminal) return runInteractiveSession(args, overrides)
  const capability = tuiCapability({
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    stderrTTY: process.stderr.isTTY === true,
    term: process.env.TERM,
    columns: process.stdout.columns || 0,
    rows: process.stdout.rows || 0,
    rawSupported: typeof process.stdin.setRawMode === "function",
    optOut: process.env.OTTER_TUI,
  })
  if (!capability.enabled) process.stderr.write(`Otter: using readline (${capability.reason}).\n`)
  return runInteractiveSession(args, { ...overrides, terminal: capability.enabled ? new TuiApp() : createReadlineTerminal() })
}
