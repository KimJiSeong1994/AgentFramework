import type { OtterConfig } from "./config.ts"

export type Logger = (msg: string, extra?: Record<string, unknown>) => void

export type CoreDeps = {
  directory: string
  worktree: string
  config: OtterConfig
  log: Logger
  /** Display-only: each finished verify command (see VerifyRunObservation). */
  verifyRun?: (run: import("./hosts/types.ts").VerifyRunObservation) => void
}
