// Per-plugin-instance guard state shared by tool-before / tool-after / event hooks. Keyed by the HookDeps object
// (index.ts passes the same `deps` to every factory) so HookDeps itself stays a plain dependency bag.
import type { HookDeps } from "../hooks/types.ts"
import { RepeatGuard } from "./repeat.ts"
import { RepetitionDetector } from "./repetition.ts"

export type Guards = {
  repeat: RepeatGuard
  repetition: RepetitionDetector
  /** sessionID -> timestamp of the last continuation prompt we sent (idle debounce) */
  lastContinuation: Map<string, number>
}

const registry = new WeakMap<HookDeps, Guards>()

export function getGuards(deps: HookDeps): Guards {
  let g = registry.get(deps)
  if (!g) {
    g = {
      repeat: new RepeatGuard(deps.config.guards.repeat_limit),
      repetition: new RepetitionDetector(deps.config.guards.repetition_ngram, deps.config.guards.repetition_count),
      lastContinuation: new Map(),
    }
    registry.set(deps, g)
  }
  return g
}
