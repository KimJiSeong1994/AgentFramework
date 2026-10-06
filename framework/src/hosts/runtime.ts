import type { ExecutionRuntime } from "./types.ts"

type Activity = { token: symbol; sessionID: string; kind: "queue" | "review" }
const active = new Map<string, Activity>()

/** Serialize queue and advisory review in one process before either changes a ledger.
 * Cross-process exclusivity and crash recovery remain the run store's responsibility.
 */
export function beginExecutionActivity(runtime: ExecutionRuntime, sessionID: string, kind: Activity["kind"]): (() => void) | null {
  const key = runtime.stateRoot
  if (active.has(key)) return null
  const token = Symbol(kind)
  active.set(key, { token, sessionID, kind })
  return () => {
    if (active.get(key)?.token === token) active.delete(key)
  }
}
