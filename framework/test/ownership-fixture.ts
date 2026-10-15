// Shared fixtures for the S6.2a reattach / ownership / retention suites: a host runtime over a temp worktree, a
// released-then-reattachable workflow, and a byte-level control-tree snapshot for "refused without mutation" checks.
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, withFlowTransaction, type Workflow } from "../src/flow/state.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { attachAdmission, holdAdmission } from "../src/sessions/admission.ts"
import { openSession, type SessionStore } from "../src/sessions/store.ts"
import { stateRoot } from "../src/state/store.ts"
import { sha256Hex } from "../src/workflows/commit.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { fakeClient, makeDeps } from "./guards-helpers.ts"

export type OwnerHost = ReturnType<typeof ownerHost>

export function ownerHost(worktree: string) {
  const client = fakeClient({ promptAsync: true })
  return Object.assign(getOpenCodeRuntime(makeDeps(client, worktree)), { testCalls: client.calls })
}

export function putWorkflow(worktree: string, sessionID: string, owner: Workflow["owner"], patch: Partial<Workflow> = {}): Workflow {
  const wf = { ...newWorkflow(sessionID, owner, "command", "resume held session", "opencode"), ...patch }
  return withFlowTransaction(worktree, tx => writeWorkflow(tx, wf))
}

/** Attach, bind a workflow to that epoch, hold and release it with a workflow-bound receipt. */
export function releaseWorkflow(worktree: string, host: OwnerHost, sid: string, patch: Partial<Workflow> = {}): Workflow {
  const previous = attachAdmission(host, sid, { engine: "opencode" })
  const wf = putWorkflow(worktree, sid, currentOwner(Date.now(), previous.epoch), patch)
  holdAdmission(worktree, sid, "restore")
  previous.release({
    workflowQuiescent: true,
    evidence: "test fixture has no queue, activity, claim, or unsettled execution",
    workflowID: wf.id,
    revision: wf.lastSeq,
  })
  return wf
}

/** Open a held replacement epoch without invoking attachAdmission's automatic rebind path. */
export function openHeldStore(worktree: string, sid: string): SessionStore {
  const store = openSession(worktree, sid, { engine: "opencode" })
  holdAdmission(worktree, sid, "restore")
  return store
}

export function releasedWithHeldStore(worktree: string, host: OwnerHost, sid: string, patch: Partial<Workflow> = {}) {
  const wf = releaseWorkflow(worktree, host, sid, patch)
  return { wf, store: openHeldStore(worktree, sid) }
}

/** Content hash of every file below the state root (symlinks flagged), for byte-identity assertions. */
export function controlTree(worktree: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else if (stat.isSymbolicLink()) out[path] = "symlink"
      else out[path] = sha256Hex(readFileSync(path))
    }
  }
  walk(stateRoot(worktree))
  return out
}

/** The tree without liveness-only sidecars, so a refusal can be compared across a status read. */
export function stableTree(worktree: string): Record<string, string> {
  return Object.fromEntries(Object.entries(controlTree(worktree)).filter(([path]) => !path.endsWith("heartbeat.json")))
}
