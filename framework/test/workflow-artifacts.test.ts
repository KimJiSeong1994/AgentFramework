// P5a S4 artifact verification (R11, E5, R25): safe regular-file open, existence + hash verification, no schema check.
// Missing / unreadable / non-regular / symlinked / hash-mismatching => incomplete. Verified state is always recomputed
// from disk, so display and restore never trust a remembered flag, and a worker cannot set one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { savedPlan } from "../src/flow/actions.ts"
import { canonicalPlanSha, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { newWorkflow, planJsonPath, planRevisionDir, readWorkflow, renderArtifact, withFlowTransaction, workflowPath, writePlanJson } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { applyEvent } from "../src/flow/runtime.ts"
import {
  artifactsIncomplete, describeArtifacts, incompleteArtifactSummary, planArtifactRefs, retainContentAddressed, sha256,
  verifyArtifact, workflowArtifactDirectory,
} from "../src/workflows/artifacts.ts"
import { __setCommitFaultHook, readCommitted } from "../src/workflows/commit.ts"
import type { Workflow } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

const S = "ses_artifacts"
let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { __setCommitFaultHook(null); wt.cleanup() })

const PLAN: Plan = {
  goal: "retained goal",
  steps: [1, 2, 3].map(n => ({ title: `step ${n}`, files: [`f${n}.py`], detail: `do ${n}`, verify: "sh check.sh" })),
  risks: ["r"],
  revision: 1,
}
function put(relative: string, content: string | Buffer): string {
  const path = join(wt.worktree, relative)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("verifyArtifact states", () => {
  test("a regular file with a matching hash is verified; a nonsense file is verified too because there is no schema check", () => {
    put("out/report.bin", "not json, not a schema, not anything")
    const ref = { key: "report", path: "out/report.bin", sha256: sha256("not json, not a schema, not anything") }
    expect(verifyArtifact(wt.worktree, ref)).toMatchObject({ key: "report", path: "out/report.bin", state: "verified" })
  })

  test("no recorded hash means existence only", () => {
    put("out/loose.txt", "x")
    expect(verifyArtifact(wt.worktree, { key: "loose", path: "out/loose.txt" })).toMatchObject({ state: "present-unhashed" })
  })

  test("missing, directory, hash mismatch, symlink file, symlinked directory, absolute and escaping paths are all incomplete", () => {
    put("out/real.txt", "real")
    mkdirSync(join(wt.worktree, "out/dir"), { recursive: true })
    symlinkSync(join(wt.worktree, "out/real.txt"), join(wt.worktree, "out/link.txt"))
    symlinkSync(join(wt.worktree, "out"), join(wt.worktree, "linked-dir"))
    const good = sha256("real")
    const cases: Array<[string, { key: string; path: string; sha256?: string }]> = [
      ["missing", { key: "a", path: "out/nope.txt", sha256: good }],
      ["missing unhashed", { key: "a2", path: "out/nope.txt" }],
      ["directory", { key: "b", path: "out/dir", sha256: good }],
      ["mismatch", { key: "c", path: "out/real.txt", sha256: sha256("other") }],
      ["symlink file", { key: "d", path: "out/link.txt", sha256: good }],
      ["symlink file unhashed", { key: "d2", path: "out/link.txt" }],
      ["symlinked directory component", { key: "e", path: "linked-dir/real.txt", sha256: good }],
      ["absolute", { key: "f", path: join(wt.worktree, "out/real.txt"), sha256: good }],
      ["escapes worktree", { key: "g", path: "../outside.txt", sha256: good }],
      ["empty path", { key: "h", path: "", sha256: good }],
    ]
    for (const [label, ref] of cases) {
      const result = verifyArtifact(wt.worktree, ref)
      expect({ label, state: result.state }).toEqual({ label, state: "incomplete" })
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  test.skipIf(process.getuid?.() === 0)("an unreadable file is incomplete, not present", () => {
    const path = put("out/secret.txt", "hidden")
    chmodSync(path, 0o000)
    try {
      expect(verifyArtifact(wt.worktree, { key: "secret", path: "out/secret.txt", sha256: sha256("hidden") })).toMatchObject({ state: "incomplete" })
      expect(verifyArtifact(wt.worktree, { key: "secret", path: "out/secret.txt" })).toMatchObject({ state: "incomplete" })
    } finally { chmodSync(path, 0o600) }
  })

  test("a worker-supplied verified flag on a reference changes nothing: state is recomputed from the bytes", () => {
    put("out/forged.txt", "tampered")
    const forged = { key: "forged", path: "out/forged.txt", sha256: sha256("original"), verified: true, state: "verified" } as never
    expect(verifyArtifact(wt.worktree, forged)).toMatchObject({ state: "incomplete", reason: "hash mismatch" })
  })

  test("the readable artifact directory is <worktree>/.lca/workflows/<sid>/<wid>/", () => {
    expect(workflowArtifactDirectory(wt.worktree, "ses_a", "wf_b")).toBe(join(wt.worktree, ".lca", "workflows", "ses_a", "wf_b"))
  })
})

function committedPlanWorkflow(patch: Partial<Workflow> = {}): { wf: Workflow; runtime: ReturnType<typeof getOpenCodeRuntime> } {
  put("check.sh", "true\n")
  const runtime = getOpenCodeRuntime(makeDeps(fakeClient({ promptAsync: true }), wt.worktree))
  const id = "wf_artifacts"
  const mdPath = planMdPath(id)
  const mdSha = withFlowTransaction(wt.worktree, tx => {
    writePlanJson(tx, id, PLAN)
    return renderArtifact(tx, mdPath, renderPlanMd(id, PLAN))
  })
  const wf = withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, {
    ...newWorkflow(S, currentOwner(Date.now(), "11111111-1111-4111-8111-111111111111"), "command", "r", "opencode"),
    id, phase: "pending_approval", planRef: { jsonSha: canonicalPlanSha(PLAN), mdPath, mdSha, revision: 1 }, ...patch,
  }))
  return { wf, runtime }
}

describe("plan artifacts: authority is the committed hash", () => {
  test("savedPlan accepts the untouched plan and refuses once the rendered markdown is edited", () => {
    const { wf, runtime } = committedPlanWorkflow()
    expect(savedPlan(runtime, wf)).not.toBeNull()
    expect(planArtifactRefs(wf)).toEqual([{ key: "plan.md", path: wf.planRef!.mdPath, sha256: wf.planRef!.mdSha }])
    writeFileSync(join(wt.worktree, wf.planRef!.mdPath), "edited after review")
    expect(savedPlan(runtime, wf)).toBeNull()
  })

  test("a symlinked or missing rendered file is refused by savedPlan", () => {
    const { wf, runtime } = committedPlanWorkflow()
    const md = join(wt.worktree, wf.planRef!.mdPath)
    const copy = readFileSync(md)
    rmSync(md)
    expect(savedPlan(runtime, wf)).toBeNull()
    put("elsewhere.md", copy)
    symlinkSync(join(wt.worktree, "elsewhere.md"), md)
    expect(savedPlan(runtime, wf)).toBeNull()
  })

  test("a tampered canonical plan JSON is refused", () => {
    const { wf, runtime } = committedPlanWorkflow()
    writeFileSync(planJsonPath(wt.worktree, wf.id), JSON.stringify({ ...PLAN, goal: "tampered" }))
    expect(savedPlan(runtime, wf)).toBeNull()
  })
})

describe("display and restore recompute artifact state", () => {
  test("a clean workflow has no incomplete summary; tampering after the fact shows keys and paths on the next display", () => {
    const { wf } = committedPlanWorkflow()
    expect(incompleteArtifactSummary(wt.worktree, wf)).toBeNull()
    expect(artifactsIncomplete(describeArtifacts(wt.worktree, wf))).toEqual([])
    writeFileSync(join(wt.worktree, wf.planRef!.mdPath), "tampered between sessions")
    // a re-read of the committed record (as a restore does) revalidates from disk instead of trusting memory
    const restored = readWorkflow(wt.worktree)!
    const summary = incompleteArtifactSummary(wt.worktree, restored)
    expect(summary).toContain("artifacts incomplete")
    expect(summary).toContain("plan.md")
    expect(summary).toContain(wf.planRef!.mdPath)
    expect(summary).toContain("hash mismatch")
  })

  test("generic artifact refs on the envelope are verified alongside the plan view", () => {
    put(".lca/workflows/ses_artifacts/wf_artifacts/notes.md", "notes")
    const { wf } = committedPlanWorkflow({
      artifacts: [
        { key: "notes", path: ".lca/workflows/ses_artifacts/wf_artifacts/notes.md", sha256: sha256("notes") },
        { key: "absent", path: ".lca/workflows/ses_artifacts/wf_artifacts/absent.md", sha256: sha256("absent") },
      ],
    })
    const results = describeArtifacts(wt.worktree, readWorkflow(wt.worktree)!)
    expect(results.map(item => [item.key, item.state])).toEqual([["plan.md", "verified"], ["notes", "verified"], ["absent", "incomplete"]])
    expect(incompleteArtifactSummary(wt.worktree, wf)).toContain("absent")
  })

  test("a ref that exists only in an uncommitted (orphan) snapshot is never shown, so it is never complete", () => {
    const { wf } = committedPlanWorkflow()
    const runtime = getOpenCodeRuntime(makeDeps(fakeClient({ promptAsync: true }), wt.worktree))
    put("out/late.txt", "late")
    const indexBefore = readFileSync(workflowPath(wt.worktree))
    __setCommitFaultHook(stage => { if (stage === "index-rename") throw new Error("injected index-rename") })
    expect(() => applyEvent(runtime, wf, "reject", "user_command", {}, w => ({
      ...w, artifacts: [{ key: "late", path: "out/late.txt", sha256: sha256("late") }],
    }), { reason: "x" })).toThrow("injected index-rename")
    __setCommitFaultHook(null)
    expect(readFileSync(workflowPath(wt.worktree)).equals(indexBefore)).toBe(true)
    const committed = readCommitted(wt.worktree)
    if (committed.state !== "ok") throw new Error("index not ok")
    expect(committed.wf.artifacts).toEqual([])
    expect(describeArtifacts(wt.worktree, committed.wf).some(item => item.key === "late")).toBe(false)
  })
})

describe("R25: plan json and markdown overwrites keep content-addressed immutable copies", () => {
  test("a revised plan rewrites the live files in place but every earlier revision stays retrievable and re-verifies", () => {
    const id = "wf_retained"
    const first = PLAN
    const second: Plan = { ...PLAN, revision: 2, goal: "second goal" }
    const mdOne = renderPlanMd(id, first)
    const mdTwo = renderPlanMd(id, second)
    withFlowTransaction(wt.worktree, tx => {
      writePlanJson(tx, id, first)
      renderArtifact(tx, planMdPath(id), mdOne)
    })
    withFlowTransaction(wt.worktree, tx => {
      writePlanJson(tx, id, second)
      renderArtifact(tx, planMdPath(id), mdTwo)
    })
    // live files hold the latest revision
    expect(readFileSync(join(wt.worktree, planMdPath(id)), "utf8")).toBe(mdTwo)
    expect(JSON.parse(readFileSync(planJsonPath(wt.worktree, id), "utf8")).goal).toBe("second goal")
    // earlier revision bytes are retained under their own hash and verify by that hash
    const directory = planRevisionDir(wt.worktree, id)
    const names = readdirSync(directory).sort()
    expect(names).toHaveLength(4)
    const oldMd = join(directory, `${sha256(mdOne)}.md`)
    expect(readFileSync(oldMd, "utf8")).toBe(mdOne)
    expect(verifyArtifact(directory, { key: "old", path: `${sha256(mdOne)}.md`, sha256: sha256(mdOne) }).state).toBe("verified")
    expect(readFileSync(join(directory, `${canonicalPlanSha(first)}.json`), "utf8")).toContain("retained goal")
    // an identical rewrite is idempotent
    withFlowTransaction(wt.worktree, tx => renderArtifact(tx, planMdPath(id), mdTwo))
    expect(readdirSync(directory).sort()).toEqual(names)
  })

  test("retainContentAddressed refuses to overwrite a retained file whose bytes diverged", () => {
    const directory = join(wt.worktree, "retained")
    const bytes = Buffer.from("one")
    const path = retainContentAddressed(directory, bytes, "txt", sha256(bytes))
    expect(readFileSync(path, "utf8")).toBe("one")
    writeFileSync(path, "corrupted")
    expect(() => retainContentAddressed(directory, bytes, "txt", sha256(bytes))).toThrow("different content")
    expect(readFileSync(path, "utf8")).toBe("corrupted")
    expect(() => retainContentAddressed(directory, bytes, "../x", sha256(bytes))).toThrow("invalid content address")
  })
})
