// Same-task probes (S1). FAKE HOST ONLY: the proposer and worker replies are scripted, so these tests exercise the
// code-owned gates (subject hash, typed approval, isolation, classification, apply/discard) and are NOT live-model proof.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { applyProbe, discardProbes, mainState, proposeProbe, reflectProbes, runProbes, showProbe, type ProbeRoutes } from "../src/harness/probe-flow.ts"
import {
  assertSubjectBody, checkOverlay, classifyProbe, loadSubject, parseOverlayReply, probeLabels, probeScope, probeSubjectSha, probeTaskDetail,
  readProbeRuns, renderContrast, verifyApproval, writeApproval, writeSubject, PROBE_LIMITS, type ProbeSubject, type SubjectBody,
} from "../src/harness/probe.ts"
import { createQueue, workerPrompt } from "../src/orchestration/queue.ts"
import { createTaskWorktree, hasTaskWorktreeState, planWorktreeScope, worktreeRoot } from "../src/orchestration/worktree.ts"
import { readLedger } from "../src/state/ledger.ts"
import { PROBE_DOM_PROMPT, PROBE_INV_PROMPT } from "../src/workflows/prompts/probe.ts"
import { PROBE_REFLECT_PROMPT } from "../src/workflows/prompts/probe-reflect.ts"
import { readLessons } from "../src/harness/lessons.ts"
import { promptIntact } from "../src/workflows/prompts/index.ts"
import { WORKFLOW_CONTROLS } from "./workflow-fixture.ts"
import { GIT_TEST_ENV, tempGitWorktree } from "./guards-helpers.ts"

const OVERLAY_INV = "Read ok_target.txt first, then create ok.py before finishing."
const OVERLAY_DOM = "The module ok.py must exist at the repository root; check that it does before you stop."
const ROUTES: ProbeRoutes = { engine: "local", model: "fixture-model", combo: {} }
const VERIFY = "sh verify_ok.sh"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree({ "README.md": "fixture\n", "verify_ok.sh": "test -f ok.py\n" }) })
afterEach(() => wt.cleanup())

type Fixture = ReturnType<typeof fixture>
function fixture(options: { workerWrites?: (request: ExecutionRequest) => boolean; inv?: string; dom?: string; workerStatus?: "completed" | "failed" } = {}) {
  const requests: ExecutionRequest[] = []
  let reflection = JSON.stringify({ type: "lesson", cue: "task names a file the worker must create", lesson: "state the file to create and re-check it exists before finishing", component: "overlay.inv", evidence: ["inv"] })
  const workerCwds: string[] = []
  // The worker passes verify iff its task text carries the INV overlay; the base and the DOM overlay do not.
  const writes = options.workerWrites ?? (request => request.text.includes("Read ok_target.txt first"))
  const host: ExecutionHost = {
    identity: { engine: "local", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: WORKFLOW_CONTROLS, problems: [] } },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "fixture host has no recovery" } },
    async prepare(request) {
      requests.push(request)
      let done = false
      return {
        reference: { executionID: request.executionID },
        async run(): Promise<ExecutionOutcome> {
          done = true
          if (request.role === "researcher") {
            if (request.text.startsWith(PROBE_INV_PROMPT.text)) return { status: "completed", text: JSON.stringify({ type: "overlay", dimension: "inv", text: options.inv ?? OVERLAY_INV }) }
            if (request.text.startsWith(PROBE_DOM_PROMPT.text)) return { status: "completed", text: JSON.stringify({ type: "overlay", dimension: "dom", text: options.dom ?? OVERLAY_DOM }) }
            if (request.text.startsWith(PROBE_REFLECT_PROMPT.text)) return { status: "completed", text: reflection }
            return { status: "failed", error: "unexpected researcher prompt" }
          }
          if (request.role === "worker") {
            workerCwds.push(request.cwd)
            if (writes(request)) writeFileSync(join(request.cwd, "ok.py"), "OK = 1\n")
            return { status: options.workerStatus ?? "completed", text: "Open issues: none" }
          }
          return { status: "failed", error: `unexpected role ${request.role}` }
        },
        async requestCancel() { done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "fixture owned handle" } },
      }
    },
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.delegate.review = true // the probe origin must still run without a reviewer
  const runtime: ExecutionRuntime = createExecutionRuntime({ directory: wt.worktree, worktree: wt.worktree, config, log() {} }, () => host, { planningOnlyMain: true })
  return { runtime, requests, workerCwds, setReflection: (text: string) => { reflection = text } }
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: wt.worktree, stdio: "pipe", env: GIT_TEST_ENV }).toString()
const checkout = () => git("status", "--porcelain", "--untracked-files=all") + git("rev-parse", "HEAD") + readFileSync(join(wt.worktree, "README.md"), "utf8")
const propose = (f: Fixture, patch: Partial<Parameters<typeof proposeProbe>[1]> = {}) =>
  proposeProbe(f.runtime, { title: "create ok module", detail: "Add ok.py at the root.", verify: VERIFY, k: 2, routes: ROUTES, ...patch })

async function approvedSubject(f: Fixture, patch: Partial<Parameters<typeof proposeProbe>[1]> = {}): Promise<ProbeSubject> {
  const proposed = await propose(f, patch)
  expect(proposed.subject).toBeDefined()
  writeApproval(wt.worktree, proposed.subject!, proposed.subject!.sha)
  return proposed.subject!
}

describe("prompts and overlay validation", () => {
  test("proposer prompts are frozen, hash-intact, read-only researcher prompts that cannot propose anything but overlay text", () => {
    for (const prompt of [PROBE_INV_PROMPT, PROBE_DOM_PROMPT]) {
      expect(Object.isFrozen(prompt)).toBe(true)
      expect(promptIntact(prompt)).toBe(true)
      expect(prompt.role).toBe("researcher")
      expect(prompt.text).toContain("KEEP_BASE")
      expect(prompt.text).toContain("1200 bytes")
    }
    expect(PROBE_INV_PROMPT.text).toContain('"dimension":"inv"')
    expect(PROBE_DOM_PROMPT.text).toContain('"dimension":"dom"')
  })

  test("a reply must be KEEP_BASE or exactly one overlay of the asked dimension", () => {
    expect(parseOverlayReply("KEEP_BASE\n", "inv")).toEqual({ status: "keep_base" })
    expect(parseOverlayReply(JSON.stringify({ type: "overlay", dimension: "inv", text: "x" }), "inv")).toEqual({ status: "overlay", text: "x" })
    expect(parseOverlayReply(JSON.stringify({ type: "overlay", dimension: "dom", text: "x" }), "inv").status).toBe("invalid")
    expect(parseOverlayReply(JSON.stringify({ type: "overlay", dimension: "inv", text: "x", system: "y" }), "inv").status).toBe("invalid")
    expect(parseOverlayReply("here is my overlay: do things", "inv").status).toBe("invalid")
  })

  const task = { title: "t", verify: VERIFY }
  test("empty is KEEP_BASE; over the limit, a secret, a code block, an absolute path or test-edit text is refused", () => {
    expect(checkOverlay("  \n ", task)).toEqual({ status: "keep_base" })
    expect(checkOverlay("a".repeat(PROBE_LIMITS.overlayBytes), task).status).toBe("overlay")
    expect(checkOverlay("a".repeat(PROBE_LIMITS.overlayBytes + 1), task)).toMatchObject({ status: "invalid", reason: expect.stringContaining("exceeds") })
    expect(checkOverlay("é".repeat(PROBE_LIMITS.overlayBytes / 2 + 1), task).status).toBe("invalid") // bytes, not characters
    expect(checkOverlay("use api_key=abcdefgh12345678 to call it", task)).toMatchObject({ status: "invalid", reason: expect.stringContaining("secret") })
    expect(checkOverlay("run this:\n```\nrm -rf .\n```", task).status).toBe("invalid")
    expect(checkOverlay("read /etc/passwd/x first", task)).toMatchObject({ status: "invalid", reason: expect.stringContaining("absolute path") })
    expect(checkOverlay("modify the test file so it passes", task)).toMatchObject({ status: "invalid", reason: expect.stringContaining("edit a test") })
    expect(checkOverlay("make it hard-coded the expected value", task).status).toBe("invalid")
    expect(checkOverlay("edit verify_ok.sh to relax it", task).status).toBe("invalid")
  })

  test("the overlay reaches the worker only as task detail text", () => {
    expect(probeTaskDetail("base", null, null)).toBe("base")
    const detail = probeTaskDetail("base", "do x", "inv")
    expect(detail.startsWith("base\n\nApproach overlay (how to work;")).toBe(true)
    expect(detail).toContain("do x")
  })
})

describe("subject hash and typed approval", () => {
  const body: SubjectBody = {
    schema: "otter.probe-subject.v1", task: { title: "create ok module", detail: "Add ok.py.", verify: VERIFY }, overlays: { inv: OVERLAY_INV, dom: OVERLAY_DOM },
    head: "a".repeat(40), baseTree: "b".repeat(40), profileFingerprint: "c".repeat(64), k: 2, routes: ROUTES,
  }
  test("the sha changes on any task, overlay, verify, k, base, head, profile or route byte", () => {
    const base = probeSubjectSha(body)
    expect(probeSubjectSha(structuredClone(body))).toBe(base)
    const variants: SubjectBody[] = [
      { ...body, task: { ...body.task, title: "create ok modulE" } },
      { ...body, task: { ...body.task, detail: "Add ok.py!" } },
      { ...body, task: { ...body.task, verify: "sh verify_other.sh" } },
      { ...body, overlays: { ...body.overlays, inv: `${OVERLAY_INV}.` } },
      { ...body, overlays: { ...body.overlays, dom: null } },
      { ...body, k: 3 },
      { ...body, baseTree: "d".repeat(40) },
      { ...body, head: "e".repeat(40) },
      { ...body, profileFingerprint: "f".repeat(64) },
      { ...body, routes: { ...ROUTES, model: "other-model" } },
    ]
    const shas = new Set(variants.map(probeSubjectSha))
    expect(shas.size).toBe(variants.length)
    expect(shas.has(base)).toBe(false)
  })

  test("the typed sha must equal the subject sha; a hand-edited subject.json no longer matches", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    const stray = "0".repeat(64)
    expect(() => writeApproval(wt.worktree, subject, stray)).toThrow(/does not match/)
    expect(verifyApproval(wt.worktree, subject)).toMatchObject({ ok: true })
    // a new subject (any byte changed) has no approval of its own
    const changed: ProbeSubject = { ...subject, body: { ...subject.body, k: 3 }, wid: "pr_other", sid: "probe-pr_other" }
    changed.sha = probeSubjectSha(changed.body)
    expect(verifyApproval(wt.worktree, changed).ok).toBe(false)
  })

  test("KEEP_BASE and invalid candidates spend no probe", async () => {
    const f = fixture({ inv: "", dom: "a".repeat(PROBE_LIMITS.overlayBytes + 1) })
    const proposed = await propose(f)
    expect(proposed.subject).toBeUndefined()
    expect(proposed.proposals.map(p => p.status)).toEqual(["keep_base", "invalid"])
    expect(f.requests.filter(r => r.role === "worker")).toHaveLength(0)
    expect(existsSync(join(worktreeRoot(wt.worktree), `probe-${proposed.wid}`))).toBe(false)
  })

  test("an unadmissible verify command or a no-commit repository is refused before any model turn", async () => {
    const f = fixture()
    await expect(propose(f, { verify: "echo hi" })).rejects.toThrow(/verify command refused/)
    await expect(propose(f, { detail: "modify the tests so they pass" })).rejects.toThrow(/edit a test/)
    expect(f.requests).toHaveLength(0)
    const bare = tempGitWorktree({ "README.md": "x\n" })
    try {
      execFileSync("git", ["update-ref", "-d", "HEAD"], { cwd: bare.worktree, env: GIT_TEST_ENV })
      const runtime = createExecutionRuntime({ directory: bare.worktree, worktree: bare.worktree, config: structuredClone(DEFAULT_CONFIG), log() {} }, () => fixture().runtime.host, { planningOnlyMain: true })
      await expect(mainState(bare.worktree, runtime.config)).rejects.toThrow(/no commit|no in-place fallback/)
    } finally { bare.cleanup() }
  })
})

describe("running probes", () => {
  test("the labels are k bases then each overlay; policy ids are identical across base, inv and dom", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    expect(probeLabels(subject.body)).toEqual(["base1", "base2", "inv", "dom"])
    const runs = await runProbes(f.runtime, subject.wid)
    expect(runs.map(r => r.label)).toEqual(["base1", "base2", "inv", "dom"])
    const ids = runs.map(r => JSON.stringify(r.policyIDs))
    expect(new Set(ids).size).toBe(1)
    expect(runs[0]!.policyIDs.worker).toBe(f.runtime.policy.resolve("worker").id)
    for (const run of runs) expect(run.baseTree).toBe(subject.body.baseTree)
  }, 120_000)

  test("each probe runs in its own worktree, sequentially, outcomes are recorded by code and the checkout is byte-identical", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    const before = checkout()
    const runs = await runProbes(f.runtime, subject.wid)
    expect(checkout()).toBe(before)
    expect(existsSync(join(wt.worktree, "ok.py"))).toBe(false)
    expect(new Set(f.workerCwds).size).toBe(4)
    f.workerCwds.forEach((cwd, i) => expect(cwd).toBe(join(worktreeRoot(wt.worktree), subject.sid, probeScope(subject.wid, probeLabels(subject.body)[i]!))))
    const byLabel = Object.fromEntries(runs.map(r => [r.label, r]))
    expect(byLabel.base1!.verify?.ok).toBe(false)
    expect(byLabel.base2!.verify?.ok).toBe(false)
    expect(byLabel.inv!.verify?.ok).toBe(true)
    expect(byLabel.dom!.verify?.ok).toBe(false)
    for (const run of runs) {
      expect(run.valid).toBe(true)
      expect(run.verify!.outputTail).not.toContain(wt.worktree)
      expect(run.overlay).toBe(run.label === "inv" ? "inv" : run.label === "dom" ? "dom" : "none")
      expect(run.overlaySha === null).toBe(run.overlay === "none")
    }
    expect(byLabel.inv!.resultTree).not.toBe(subject.body.baseTree)
    expect(byLabel.inv!.diffStat).toContain("ok.py")
    expect(byLabel.base1!.diffStat).toBe("")
    // the records on disk equal what run returned
    expect(readProbeRuns(wt.worktree, subject)).toEqual(runs)
    const table = renderContrast(runs)
    expect(table.split("\n")[0]).toMatch(/^label\s+overlay\s+verify\s+diff\s+duration\s+valid$/)
    expect(table).toMatch(/inv\s+inv\s+ok/)
    expect(table).toMatch(/base1\s+none\s+fail\(exit 1\)/)
  }, 120_000)

  test("worker tasks are one attempt with no earlier-task handoff and no reviewer, even if config allows more", async () => {
    const f = fixture({ workerWrites: () => false })
    f.runtime.config.delegate.max_attempts = 3
    const subject = await approvedSubject(f)
    await runProbes(f.runtime, subject.wid)
    const workers = f.requests.filter(r => r.role === "worker")
    expect(workers).toHaveLength(4) // one attempt each although verify failed three of the four times and max_attempts is 3
    expect(f.requests.some(r => r.role === "reviewer")).toBe(false)
    for (const request of workers) {
      expect(request.text).not.toContain("Earlier tasks in this run")
      expect(request.text).not.toContain("A previous worker")
    }
    expect(workers.filter(r => r.text.includes("Approach overlay"))).toHaveLength(2)
    expect(workers.filter(r => r.text.includes("Approach overlay (how to work"))).toHaveLength(1)
    // roles' system policy never carries the overlay
    for (const request of f.requests) expect(JSON.stringify(request.policy)).not.toContain("Approach overlay")
  }, 120_000)

  test("workerPrompt with a zero handoff budget omits the earlier-task section", () => {
    const ledger = createQueue(fixture().runtime)
    ledger.add("s", [{ title: "one" }, { title: "two" }])
    const l = readLedger(wt.worktree, "s")
    const done = { ...l, tasks: [{ ...l.tasks[0]!, status: "done" as const, filesChanged: ["a.py"] }, l.tasks[1]!] }
    expect(workerPrompt(done, done.tasks[1]!, undefined, 600)).toContain("Earlier tasks in this run")
    expect(workerPrompt(done, done.tasks[1]!, undefined, 0)).not.toContain("Earlier tasks in this run")
  })

  test("running without a matching receipt is refused before any dispatch; a changed subject needs a new approval", async () => {
    const f = fixture()
    const proposed = await propose(f)
    const subject = proposed.subject!
    await expect(runProbes(f.runtime, subject.wid)).rejects.toThrow(/no approval receipt/)
    writeApproval(wt.worktree, subject, subject.sha)
    expect(f.requests.filter(r => r.role === "worker")).toHaveLength(0)
    const edited: ProbeSubject = { ...subject, body: { ...subject.body, overlays: { ...subject.body.overlays, dom: `${OVERLAY_DOM} extra` } } }
    expect(probeSubjectSha(edited.body)).not.toBe(subject.sha)
    // an approval for the edited subject (new sha) does not authorise the original wid's receipt
    const next: ProbeSubject = { ...edited, sha: probeSubjectSha(edited.body) }
    expect(verifyApproval(wt.worktree, next).ok).toBe(false)
    expect(f.requests.filter(r => r.role === "worker")).toHaveLength(0)
  })

  test("refused when the main HEAD or working tree changed after the subject was proposed", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    writeFileSync(join(wt.worktree, "wip.txt"), "uncommitted\n")
    await expect(runProbes(f.runtime, subject.wid)).rejects.toThrow(/working tree changed/)
    expect(f.requests.filter(r => r.role === "worker")).toHaveLength(0)
    execFileSync("rm", [join(wt.worktree, "wip.txt")])
    writeFileSync(join(wt.worktree, "README.md"), "edited\n")
    git("add", "-A")
    git("-c", "user.email=a@b", "-c", "user.name=n", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "moved")
    await expect(runProbes(f.runtime, subject.wid)).rejects.toThrow(/HEAD changed/)
    expect(f.requests.filter(r => r.role === "worker")).toHaveLength(0)
  })

  test("a verify the worker cannot meet is a valid failing run, not an excluded one; an interrupted worker is invalid", async () => {
    const failing = fixture({ workerWrites: () => false })
    const subject = await approvedSubject(failing)
    const runs = await runProbes(failing.runtime, subject.wid)
    expect(runs.every(r => r.valid && r.verify?.ok === false)).toBe(true)
    expect(classifyProbe({ unsettled: false, interrupted: true, refused: false, integrity: false, verify: null })).toEqual({ valid: false, invalid: "interrupted" })
    expect(classifyProbe({ unsettled: true, interrupted: true, refused: true, integrity: true, verify: null })).toEqual({ valid: false, invalid: "unsettled" })
    expect(classifyProbe({ unsettled: false, interrupted: false, refused: true, integrity: false, verify: null })).toEqual({ valid: false, invalid: "refused" })
    expect(classifyProbe({ unsettled: false, interrupted: false, refused: false, integrity: true, verify: { ok: true, exitCode: 0, timedOut: false, outputTail: "" } })).toEqual({ valid: false, invalid: "integrity" })
    expect(classifyProbe({ unsettled: false, interrupted: false, refused: false, integrity: false, verify: { ok: false, exitCode: 1, timedOut: false, outputTail: "" } })).toEqual({ valid: true })
  }, 120_000)

  test("a worker that edits the protected verify script is restored and the run is not a pass", async () => {
    const f = fixture({ workerWrites: request => { writeFileSync(join(request.cwd, "verify_ok.sh"), "exit 0\n"); return false } })
    const subject = await approvedSubject(f)
    const runs = await runProbes(f.runtime, subject.wid)
    expect(runs.every(r => r.verify?.ok === false)).toBe(true)
  }, 120_000)
})

describe("queue probe origin", () => {
  test("a probe is refused without its worktree, with another scope's worktree, or from a different base tree; ordinary runs are unchanged", async () => {
    const f = fixture()
    const q = createQueue(f.runtime)
    const exclude = f.runtime.config.delegate.diff_exclude
    q.add("s1", [{ title: "t", detail: "d", verify: VERIFY }])
    const state = await mainState(wt.worktree, f.runtime.config)
    const outcome = await q.run("s1", { probe: { scope: "probe-x-base1", baseTree: state.tree } })
    expect(outcome).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    const other = (await createTaskWorktree(wt.worktree, "s1", planWorktreeScope("wf_other"), exclude))!
    expect(await q.run("s1", { planWorktree: other, probe: { scope: "probe-x-base1", baseTree: state.tree } })).toMatchObject({ aborted: true, done: 0 })
    const own = (await createTaskWorktree(wt.worktree, "s1", "probe-x-base1", exclude))!
    expect(await q.run("s1", { planWorktree: own, probe: { scope: "probe-x-base1", baseTree: "0".repeat(40) } })).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readLedger(wt.worktree, "s1").tasks[0]!.status).toBe("pending")
  }, 120_000)
})

describe("apply and discard", () => {
  test("apply applies exactly that probe's diff and removes only that worktree; discard removes the rest; records stay", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    await runProbes(f.runtime, subject.wid)
    const host = { worktree: wt.worktree, config: f.runtime.config }
    const states = (label: string) => hasTaskWorktreeState(wt.worktree, subject.sid, probeScope(subject.wid, label))
    expect(probeLabels(subject.body).every(states)).toBe(true)

    expect(await applyProbe(host, subject.wid, "base1")).toMatchObject({ ok: false, reason: expect.stringContaining("verify did not pass") })
    expect(await applyProbe(host, subject.wid, "dom")).toMatchObject({ ok: false })
    expect(existsSync(join(wt.worktree, "ok.py"))).toBe(false)

    const applied = await applyProbe(host, subject.wid, "inv")
    expect(applied).toEqual({ ok: true, label: "inv", files: ["ok.py"] })
    expect(readFileSync(join(wt.worktree, "ok.py"), "utf8")).toBe("OK = 1\n")
    expect(git("status", "--porcelain", "--untracked-files=all").trim()).toBe("?? ok.py")
    expect(states("inv")).toBe(false)
    expect(states("base1") && states("base2") && states("dom")).toBe(true)

    const removed = await discardProbes(host, subject.wid)
    expect(removed.sort()).toEqual(["base1", "base2", "dom"])
    expect(probeLabels(subject.body).some(states)).toBe(false)
    expect(readProbeRuns(wt.worktree, loadSubject(wt.worktree, subject.wid))).toHaveLength(4)
    const view = showProbe(wt.worktree, subject.wid)
    expect(view.approved).toBe(true)
    expect(view.runs).toHaveLength(4)
  }, 180_000)

  test("the checkout is untouched by discard alone", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    await runProbes(f.runtime, subject.wid)
    const before = checkout()
    await discardProbes({ worktree: wt.worktree, config: f.runtime.config }, subject.wid)
    expect(checkout()).toBe(before)
  }, 120_000)
})

describe("lessons call site", () => {
  test("a reflection citing only helped rows is admitted by code; one citing a non-helped row is not; nothing leaks into the worker prompt", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    const runs = await runProbes(f.runtime, subject.wid)
    expect(await reflectProbes(f.runtime, subject, runs)).toEqual({ status: "admitted" })
    expect(readLessons(wt.worktree, 5)).toHaveLength(1)
    expect(f.requests.filter(r => r.role === "worker").every(r => !r.text.includes("PRIOR LESSONS"))).toBe(true)
    f.setReflection(JSON.stringify({ type: "lesson", cue: "any shape of task", lesson: "state the domain contract before finishing", component: "overlay.dom", evidence: ["dom"] }))
    expect(await reflectProbes(f.runtime, subject, runs)).toMatchObject({ status: "no_entry", reason: expect.stringContaining("not helped or hurt") })
    expect(readLessons(wt.worktree, 5)).toHaveLength(1)
  }, 120_000)
})

describe("subject validation", () => {
  test("a stored body that violates the gates is refused when it is loaded or run", async () => {
    const f = fixture()
    const subject = await approvedSubject(f)
    const bad: ProbeSubject = { ...subject, wid: "pr_bad", sid: "probe-pr_bad", body: { ...subject.body, overlays: { inv: "modify the test file", dom: null } } }
    bad.sha = probeSubjectSha(bad.body)
    expect(() => assertSubjectBody(bad.body, f.runtime.config)).toThrow(/overlay refused/)
    writeSubject(wt.worktree, bad)
    writeApproval(wt.worktree, bad, bad.sha)
    await expect(runProbes(f.runtime, "pr_bad")).rejects.toThrow(/overlay refused/)
    expect(f.requests.filter(r => r.role === "worker")).toHaveLength(0)
  })
})
