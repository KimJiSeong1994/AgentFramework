import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  cancelSkillPermissionActivities,
  pendingSkillPermissionActivityCount,
  registerSkillPermissionActivity,
} from "../src/skills/activity.ts"
import { tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>

beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

describe("skill permission activity registry", () => {
  test("registration blocks until idempotent cleanup and cancellation does not remove the blocker early", () => {
    const controller = new AbortController()
    const cleanup = registerSkillPermissionActivity(wt.worktree, "skill_session", "epoch-one", controller)
    expect(pendingSkillPermissionActivityCount(wt.worktree, "skill_session", "epoch-one")).toBe(1)
    expect(cancelSkillPermissionActivities(wt.worktree, "skill_session", "epoch-one")).toBe(1)
    expect(controller.signal.aborted).toBe(true)
    expect(pendingSkillPermissionActivityCount(wt.worktree, "skill_session", "epoch-one")).toBe(1)
    cleanup()
    cleanup()
    expect(pendingSkillPermissionActivityCount(wt.worktree, "skill_session", "epoch-one")).toBe(0)
    expect(cancelSkillPermissionActivities(wt.worktree, "skill_session", "epoch-one")).toBe(0)
  })

  test("canonical worktree, session, and epoch cancellation are isolated", () => {
    const first = new AbortController()
    const foreignSession = new AbortController()
    const foreignEpoch = new AbortController()
    const foreignWorktree = new AbortController()
    const cleanups = [
      registerSkillPermissionActivity(wt.worktree, "skill_session", "epoch-one", first),
      registerSkillPermissionActivity(wt.worktree, "other_session", "epoch-one", foreignSession),
      registerSkillPermissionActivity(wt.worktree, "skill_session", "epoch-two", foreignEpoch),
    ]
    const other = tempWorktree()
    try {
      cleanups.push(registerSkillPermissionActivity(other.worktree, "skill_session", "epoch-one", foreignWorktree))
      expect(cancelSkillPermissionActivities(wt.worktree, "skill_session", "epoch-one")).toBe(1)
      expect(first.signal.aborted).toBe(true)
      expect(foreignSession.signal.aborted).toBe(false)
      expect(foreignEpoch.signal.aborted).toBe(false)
      expect(foreignWorktree.signal.aborted).toBe(false)
      expect(pendingSkillPermissionActivityCount(wt.worktree, "skill_session", "epoch-one")).toBe(1)
      expect(pendingSkillPermissionActivityCount(wt.worktree, "other_session", "epoch-one")).toBe(1)
      expect(pendingSkillPermissionActivityCount(wt.worktree, "skill_session", "epoch-two")).toBe(1)
    } finally {
      for (const cleanup of cleanups) cleanup()
      other.cleanup()
    }
    expect(pendingSkillPermissionActivityCount(wt.worktree, "skill_session", "epoch-one")).toBe(0)
  })

  test("the same controller cannot be registered under a foreign identity", () => {
    const controller = new AbortController()
    const cleanup = registerSkillPermissionActivity(wt.worktree, "skill_session", "epoch-one", controller)
    expect(() => registerSkillPermissionActivity(wt.worktree, "other_session", "epoch-two", controller)).toThrow()
    cleanup()
    const aborted = new AbortController()
    aborted.abort()
    expect(() => registerSkillPermissionActivity(wt.worktree, "skill_session", "epoch-one", aborted)).toThrow()
  })
})
