// Guard state is shared by consumers of the same CoreDeps object, not by structurally equal dependency bags.
import type { CoreDeps } from "../deps.ts"
import { RepeatGuard } from "./repeat.ts"
import { RepetitionDetector } from "./repetition.ts"

export type Guards = {
  repeat: RepeatGuard
  repetition: RepetitionDetector
  /** sessionID -> timestamp of the last continuation prompt we sent (idle debounce) */
  lastContinuation: Map<string, number>
}

const registry = new WeakMap<CoreDeps, Guards>()

export function getGuards(deps: CoreDeps): Guards {
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
