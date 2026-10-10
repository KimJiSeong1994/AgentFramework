import type { LcaConfig } from "./config.ts"

export type Logger = (msg: string, extra?: Record<string, unknown>) => void

export type CoreDeps = {
  directory: string
  worktree: string
  config: LcaConfig
  log: Logger
}
