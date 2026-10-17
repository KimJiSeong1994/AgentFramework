// M1: plan gates (§5.1 hard gates in validatePlan), canonical sha stability, planToTasks 1:1.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { canonicalPlanJson, canonicalPlanSha, coercePlan, planToTasks, validatePlan, type Plan } from "../src/flow/plan.ts"

const verifyAllow = DEFAULT_CONFIG.delegate.verify_allow

function tempWorktree(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "otter-plan-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function step(over: Partial<Plan["steps"][number]> = {}): Plan["steps"][number] {
  return { title: "do a thing", files: ["src/a.ts"], detail: "make the change", verify: "bun test test/a.test.ts", ...over }
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    goal: "fix the bug",
    steps: [step(), step({ title: "step two", files: ["src/b.ts"] }), step({ title: "step three", files: ["src/c.ts"] })],
    risks: ["might miss an edge case"],
    revision: 1,
    ...over,
  }
}

describe("validatePlan gates", () => {
  test("a well-formed 3-step plan is valid", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      expect(validatePlan(plan(), dir, verifyAllow)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("verify: true is refused (trivial command)", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step({ verify: "true" }), step({ title: "s2" }), step({ title: "s3" })] }), dir, verifyAllow)
      expect(errs.some((e) => /verify/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a file path with '..' is refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step({ files: ["../escape.ts"] }), step({ title: "s2" }), step({ title: "s3" })] }), dir, verifyAllow)
      expect(errs.some((e) => /must not contain '\.\.'/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("an absolute file path is refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step({ files: ["/etc/passwd"] }), step({ title: "s2" }), step({ title: "s3" })] }), dir, verifyAllow)
      expect(errs.some((e) => /must be relative/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a file under .git/ is refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step({ files: [".git/hooks/pre-commit"] }), step({ title: "s2" }), step({ title: "s3" })] }), dir, verifyAllow)
      expect(errs.some((e) => /under \.git\/ is not allowed/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a file under .otter/ is refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step({ files: [".otter/plans/x.md"] }), step({ title: "s2" }), step({ title: "s3" })] }), dir, verifyAllow)
      expect(errs.some((e) => /under \.otter\/ is not allowed/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a file under knowledge/raw/ is refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step({ files: ["knowledge/raw/x.md"] }), step({ title: "s2" }), step({ title: "s3" })] }), dir, verifyAllow)
      expect(errs.some((e) => /under knowledge\/raw\/ is not allowed/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("2 steps is refused (below minSteps)", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(plan({ steps: [step(), step({ title: "s2" })] }), dir, verifyAllow)
      expect(errs.some((e) => /3-10 steps \(got 2\)/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("11 steps is refused (above maxSteps)", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const steps = Array.from({ length: 11 }, (_, i) => step({ title: `step ${i}`, files: [`src/f${i}.ts`] }))
      const errs = validatePlan(plan({ steps }), dir, verifyAllow)
      expect(errs.some((e) => /3-10 steps \(got 11\)/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("duplicate titles are refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(
        plan({ steps: [step({ title: "same" }), step({ title: "same", files: ["src/b.ts"] }), step({ title: "s3" })] }),
        dir,
        verifyAllow,
      )
      expect(errs.some((e) => /duplicate title "same"/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a taskTextProblem hit ('edit test_x.py to pass') is refused", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(
        plan({ steps: [step({ title: "edit test_x.py to pass", detail: "modify the test file" }), step({ title: "s2" }), step({ title: "s3" })] }),
        dir,
        verifyAllow,
      )
      expect(errs.some((e) => /tells the worker to edit a test or assertion/.test(e))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a new file under a new directory is accepted (existence not required)", () => {
    const { dir, cleanup } = tempWorktree()
    try {
      const errs = validatePlan(
        plan({ steps: [step({ files: ["brand/new/dir/file.ts"] }), step({ title: "s2" }), step({ title: "s3" })] }),
        dir,
        verifyAllow,
      )
      expect(errs).toEqual([])
    } finally {
      cleanup()
    }
  })
})

describe("canonical plan sha", () => {
  test("stable across key order in the source object passed to coercePlan", () => {
    const a = coercePlan({ goal: "g", steps: [{ title: "t", files: ["f"], detail: "d", verify: "v" }], risks: ["r"] }, 1)
    const b = coercePlan({ risks: ["r"], steps: [{ verify: "v", detail: "d", files: ["f"], title: "t" }], goal: "g" }, 1)
    expect(canonicalPlanJson(a)).toBe(canonicalPlanJson(b))
    expect(canonicalPlanSha(a)).toBe(canonicalPlanSha(b))
  })

  test("a different revision changes the sha", () => {
    const a = coercePlan({ goal: "g", steps: [{ title: "t", files: ["f"], detail: "d", verify: "v" }], risks: ["r"] }, 1)
    const b = coercePlan({ goal: "g", steps: [{ title: "t", files: ["f"], detail: "d", verify: "v" }], risks: ["r"] }, 2)
    expect(canonicalPlanSha(a)).not.toBe(canonicalPlanSha(b))
  })
})

describe("planToTasks", () => {
  test("1:1 in order, files carried in detail, kind code", () => {
    const p = plan()
    const tasks = planToTasks(p)
    expect(tasks.length).toBe(p.steps.length)
    tasks.forEach((t, i) => {
      expect(t.title).toBe(p.steps[i]!.title)
      expect(t.verify).toBe(p.steps[i]!.verify)
      expect(t.kind).toBe("code")
      expect(t.detail).toContain(p.steps[i]!.files.join(", "))
      expect(t.detail).toContain(p.steps[i]!.detail)
    })
  })
})
