export type TerminalCapabilities = {
  stdinTTY: boolean
  stdoutTTY: boolean
  stderrTTY: boolean
  term?: string
  columns: number
  rows: number
  rawSupported: boolean
  optOut?: string
}

const MIN_COLUMNS = 80
const MIN_ROWS = 24

export function tuiCapability(input: TerminalCapabilities): { enabled: boolean; reason?: string } {
  if (input.optOut === "0") {
    return { enabled: false, reason: "disabled by LCA_TUI=0" }
  }

  if (!input.stdinTTY || !input.stdoutTTY || !input.stderrTTY) {
    return { enabled: false, reason: "stdin, stdout, and stderr must all be TTYs" }
  }

  const term = input.term?.trim()
  if (!term || term.toLowerCase() === "dumb") {
    return { enabled: false, reason: "TERM must be set to a non-dumb terminal" }
  }

  if (!input.rawSupported) {
    return { enabled: false, reason: "terminal must support raw input mode" }
  }

  if (!Number.isFinite(input.columns) || !Number.isFinite(input.rows) ||
    !(input.columns >= MIN_COLUMNS) || !(input.rows >= MIN_ROWS)) {
    return { enabled: false, reason: "terminal must be at least 80 columns by 24 rows" }
  }

  return { enabled: true }
}
