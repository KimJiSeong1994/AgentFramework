// Leaf module (no imports from flow/ or the queue) so the queue's finally-observer can be injected without an import cycle.
import type { ExecutionRuntime } from "../hosts/types.ts"

type QueueSettledListener = (deps: ExecutionRuntime, sessionID: string) => void
const listeners = new Set<QueueSettledListener>()

/** Observer for a finished queue run, called after its claim and activity are released. */
export function onQueueSettled(listener: QueueSettledListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function notifyQueueSettled(deps: ExecutionRuntime, sessionID: string): void {
  for (const listener of [...listeners]) {
    try { listener(deps, sessionID) } catch (error) { deps.log("queue settlement observer failed", { sessionID, error: String(error) }) }
  }
}

const stopListeners = new Set<QueueSettledListener>()

/** Observer for a queue that sees a recorded stop intent (so an owner can adopt a stop another process issued). */
export function onQueueStopObserved(listener: QueueSettledListener): () => void {
  stopListeners.add(listener)
  return () => { stopListeners.delete(listener) }
}

export function notifyQueueStopObserved(deps: ExecutionRuntime, sessionID: string): void {
  for (const listener of [...stopListeners]) {
    try { listener(deps, sessionID) } catch (error) { deps.log("queue stop observer failed", { sessionID, error: String(error) }) }
  }
}
