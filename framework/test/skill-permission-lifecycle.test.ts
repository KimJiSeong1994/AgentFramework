import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { beginExecutionActivity, executionActivity } from "../src/hosts/runtime.ts"
import {
  attachAdmission,
  detachAdmission,
  endAdmission,
  holdAdmission,
  resumeAdmission,
} from "../src/sessions/admission.ts"
import { openSession, inspectSessionAttachment, type SessionStore } from "../src/sessions/store.ts"
import { cancelSkillPermissionActivities, pendingSkillPermissionActivityCount, registerSkillPermissionActivity } from "../src/skills/activity.ts"
import { tempWorktree, fakeClient, makeDeps } from "./guards-helpers.ts"

const SESSION = "permission_lifecycle"
const OTHER_SESSION = "permission_lifecycle_other"
const RELEASE_PROOF = {
  workflowQuiescent: true as const,
  evidence: "fixture has no active workflow, queue, or execution",
  workflowID: null,
  revision: null,
}

let wt: ReturnType<typeof tempWorktree>
let host: ReturnType<typeof getOpenCodeRuntime>
let client: ReturnType<typeof fakeClient>
let cleanups: Array<() => void>

beforeEach(() => {
  wt = tempWorktree()
  cleanups = []
  client = fakeClient()
  ;(client.session as any).get = async ({ path }: { path: { id: string } }) => ({
    data: { id: path.id, directory: wt.worktree, time: { created: 1, updated: 2 } },
  })
  host = getOpenCodeRuntime(makeDeps(client, wt.worktree))
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  wt.cleanup()
})

function attach(sessionID = SESSION): SessionStore {
  return attachAdmission(host, sessionID, { engine: "opencode" })
}

function track(controller: AbortController, store: SessionStore): () => void {
  const cleanup = registerSkillPermissionActivity(wt.worktree, store.sessionID, store.epoch, controller)
  cleanups.push(cleanup)
  return cleanup
}

describe("skill permission lifecycle fencing", () => {
  test("an owned hold aborts only its exact epoch and remains a blocker until cleanup", () => {
    const store = attach()
    const foreignSID = attach(OTHER_SESSION)
    const currentWait = new AbortController()
    const foreignSessionWait = new AbortController()
    const foreignEpochWait = new AbortController()
    const foreignWorktree = tempWorktree()
    const foreignClient = fakeClient()
    ;(foreignClient.session as any).get = async ({ path }: { path: { id: string } }) => ({
      data: { id: path.id, directory: foreignWorktree.worktree, time: { created: 1, updated: 2 } },
    })
    const foreignRuntime = getOpenCodeRuntime(makeDeps(foreignClient, foreignWorktree.worktree))
    const foreignStore = attachAdmission(foreignRuntime, SESSION, { engine: "opencode" })
    const foreignWorktreeWait = new AbortController()
    track(currentWait, store)
    track(foreignSessionWait, foreignSID)
    const unregisterForeignEpoch = registerSkillPermissionActivity(wt.worktree, SESSION, "foreign-old-epoch", foreignEpochWait)
    cleanups.push(unregisterForeignEpoch)
    const unregisterForeignWorktree = registerSkillPermissionActivity(foreignWorktree.worktree, SESSION, foreignStore.epoch, foreignWorktreeWait)
    cleanups.push(unregisterForeignWorktree)

    try {
      holdAdmission(wt.worktree, SESSION, "user_stop")

      expect(currentWait.signal.aborted).toBe(true)
      expect(foreignSessionWait.signal.aborted).toBe(false)
      expect(foreignEpochWait.signal.aborted).toBe(false)
      expect(foreignWorktreeWait.signal.aborted).toBe(false)
      expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, store.epoch)).toBe(1)
      expect(executionActivity(wt.worktree)).toMatchObject({ sessionID: SESSION, kind: "permission" })
      expect(cancelSkillPermissionActivities(wt.worktree, SESSION, store.epoch)).toBe(0)

      cleanups[0]!()
      expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, store.epoch)).toBe(0)
      expect(foreignSessionWait.signal.aborted).toBe(false)
      expect(foreignEpochWait.signal.aborted).toBe(false)
      expect(foreignWorktreeWait.signal.aborted).toBe(false)
    } finally {
      foreignWorktree.cleanup()
    }
  })

  test("Resume waits for the cancelled callback's own unregister before admitting", () => {
    const store = attach()
    const controller = new AbortController()
    const cleanup = track(controller, store)
    holdAdmission(wt.worktree, SESSION, "resume-fence")

    expect(controller.signal.aborted).toBe(true)
    expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, store.epoch)).toBe(1)
    expect(() => resumeAdmission(host, SESSION)).toThrow(/permission activity|execution activity/u)

    cleanup()
    expect(resumeAdmission(host, SESSION)).toBe(store)
  })

  test("direct release and detach refuse while a permission wait is pending, then retain proof requirements", async () => {
    const direct = attach()
    const directController = new AbortController()
    const directCleanup = track(directController, direct)
    holdAdmission(wt.worktree, SESSION, "direct-release-fence")
    expect(directController.signal.aborted).toBe(true)
    expect(() => direct.release(RELEASE_PROOF)).toThrow(/permission activity/u)
    directCleanup()
    direct.release(RELEASE_PROOF)

    const detachable = attach("permission_detach")
    const detachController = new AbortController()
    const detachCleanup = track(detachController, detachable)
    expect(await detachAdmission(host, detachable.sessionID, detachable.epoch, "permission-detach")).toBe(false)
    expect(detachController.signal.aborted).toBe(true)
    expect(pendingSkillPermissionActivityCount(wt.worktree, detachable.sessionID, detachable.epoch)).toBe(1)
    detachCleanup()
    expect(await detachAdmission(host, detachable.sessionID, detachable.epoch, "permission-detach")).toBe(true)
  })

  test("host deletion end remains held until activity unregister and then uses existing end proof", async () => {
    const store = attach()
    const controller = new AbortController()
    const cleanup = track(controller, store)
    holdAdmission(wt.worktree, SESSION, "host_session_deleted")
    expect(controller.signal.aborted).toBe(true)

    expect(await endAdmission(host, SESSION, store.epoch)).toBe(false)
    expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, store.epoch)).toBe(1)
    expect(inspectSessionAttachment(wt.worktree, SESSION, store.epoch)?.state).toBe("attached")

    cleanup()
    expect(await endAdmission(host, SESSION, store.epoch)).toBe(true)
    expect(inspectSessionAttachment(wt.worktree, SESSION, store.epoch)?.state).toBe("released")
  })

  test("released receipt cannot bypass a live old-epoch blocker during same-SID reattach or stale reclaim", () => {
    const first = openSession(wt.worktree, SESSION, { engine: "opencode" })
    const oldEpoch = first.epoch
    first.release(RELEASE_PROOF)
    expect(inspectSessionAttachment(wt.worktree, SESSION, oldEpoch)?.state).toBe("released")

    const pendingOldEpoch = new AbortController()
    const cleanup = registerSkillPermissionActivity(wt.worktree, SESSION, oldEpoch, pendingOldEpoch)
    cleanups.push(cleanup)
    expect(() => openSession(wt.worktree, SESSION, { engine: "opencode" })).toThrow(/permission activity/u)
    expect(() => attach()).toThrow(/permission activity/u)
    expect(inspectSessionAttachment(wt.worktree, SESSION, oldEpoch)?.state).toBe("released")

    cleanup()
    const restored = attach()
    expect(restored.epoch).not.toBe(oldEpoch)
    expect(restored.metadata.held).toBe(true)
  })

  test("pending permission activity blocks new coarse execution activity without fabricating quiescence", () => {
    const store = attach()
    const controller = new AbortController()
    const cleanup = track(controller, store)
    expect(executionActivity(wt.worktree)).toEqual({ sessionID: SESSION, kind: "permission" })
    expect(beginExecutionActivity(host, SESSION, "review")).toBeNull()
    controller.abort(new Error("cancelled by fixture"))
    expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, store.epoch)).toBe(1)
    expect(executionActivity(wt.worktree)).toEqual({ sessionID: SESSION, kind: "permission" })
    cleanup()
    const release = beginExecutionActivity(host, SESSION, "review")
    expect(release).toBeTruthy()
    release?.()
  })
})
