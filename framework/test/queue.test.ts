import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createQueue, parseVerdict, reviewerPrompt, workerPrompt, CHILD_TOOL_DENY } from "../src/orchestration/queue.ts"
import { addTasks, emptyLedger, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { abortPath, sessionDir, writeJsonAtomic } from "../src/state/store.ts"
import { observeSkillTask } from "../src/telemetry/skill-observer.ts"
import { activateSkillCampaign, listSkillObservations, skillObservationDatabasePath } from "../src/telemetry/skills.ts"
import { fakeClient, makeDeps, tempGitWorktree, verifyScript, waitFor, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree({ "README.md": "fixture\n" })
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

const write = (name: string, content: string) => writeFileSync(join(wt.worktree, name), content)
const prompts = (agent: string) => client.calls.filter((c) => c.method === "prompt" && (c.args as any).body.agent === agent)
const noReview = { delegate: { review: false } as any }
// allow-listed verify scripts (sh <name>.sh) — real commands, refused ones are covered separately
const okVerify = () => verifyScript(wt.worktree, "verify_ok.sh", "exit 0")
const failVerify = () => verifyScript(wt.worktree, "verify_fail.sh", "echo boom-output; exit 2")
const existsVerify = (file: string) => verifyScript(wt.worktree, `check_${file}.sh`, `test -f ${file}`)
const observedDeps = (patch: Parameters<typeof makeDeps>[2] = {}) => {
  const campaignID = "queue-test"
  const activated = activateSkillCampaign(wt.worktree, campaignID)
  return makeDeps(client, wt.worktree, {
    ...patch,
    skill_observation: { enabled: true, campaign_id: campaignID, owner_root: wt.worktree, owner_binding: activated.ownerBinding! },
  })
}
const observations = () => listSkillObservations(wt.worktree).facts
const factPayload = (fact: { payload: unknown }) => fact.payload as Record<string, unknown>

describe("serial queue", () => {
  test("runs three tasks serially in fresh child sessions, verifies in code, reviews, writes ledger + handoffs", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    let n = 0
    client.replies.worker = () => {
      n++
      const file = `mod${n}.py`
      return { texts: ["thinking aloud…", `Files changed: ${file}\nVerification: ok\nOpen issues: none`], run: () => write(file, `V = ${n}\n`) }
    }
    client.replies.reviewer = { text: "ACCEPT\n- fine" }
    const added = q.add(S, [
      { title: "one", detail: "create mod1.py", verify: existsVerify("mod1.py") },
      { title: "two", verify: existsVerify("mod2.py") },
      { title: "three", verify: existsVerify("mod3.py") },
    ])
    expect(added.map((t) => t.id)).toEqual(["t1", "t2", "t3"])
    expect(q.isRunning(S)).toBe(false)
    const run = await q.run(S)
    expect(run).toEqual({ taskIds: ["t1", "t2", "t3"], done: 3, failed: 0, cancelled: 0, aborted: false })

    // one worker + one reviewer child session per task, all children of main, serial order
    expect(client.created.map((c) => c.parentID)).toEqual([S, S, S, S, S, S])
    expect(client.created.map((c) => c.title)).toEqual([
      "lca task 1: one", "lca review 1: one", "lca task 2: two", "lca review 2: two", "lca task 3: three", "lca review 3: three",
    ])
    const w = prompts("worker").map((c) => (c.args as any))
    expect(w.map((a) => a.path.id)).toEqual(["child_1", "child_3", "child_5"])
    // session-level tool deny travels with every child prompt (defense in depth)
    expect(w[0].body.tools).toEqual(CHILD_TOOL_DENY)
    expect(w[0].body.parts[0].text).toContain("Task 1 of 3: one")
    expect(w[0].body.parts[0].text).toContain("create mod1.py")
    expect(w[0].body.parts[0].text).toContain("Run this once before you finish: sh check_mod1.py.sh")
    // handoff context carries earlier results, and only those
    expect(w[1].body.parts[0].text).toContain("Task 1 (done): one [files: mod1.py]")
    expect(w[2].body.parts[0].text).toContain("Task 2 (done): two [files: mod2.py]")
    expect(w[0].body.parts[0].text).not.toContain("Earlier tasks")
    // reviewer sees the per-task diff, the full scope and the verify result
    const r = prompts("reviewer").map((c) => (c.args as any).body.parts[0].text)
    expect(r[1]).toContain("+V = 2")
    expect(r[1]).not.toContain("+V = 1")
    expect(r[1]).toContain("`sh check_mod2.py.sh` -> exit 0 (pass)")
    expect(r[0]).toContain("Scope: create mod1.py")

    const ledger = readLedger(wt.worktree, S)
    expect(ledger.running).toBeUndefined()
    for (const t of ledger.tasks) {
      expect(t.status).toBe("done")
      expect(t.attempts).toBe(1)
      expect(t.filesChanged).toEqual([`mod${t.n}.py`])
      expect(t.verify_result?.ok).toBe(true)
      expect(t.review?.verdict).toBe("accept")
      expect(t.childSessions.length).toBe(1)
      expect(t.workerSessionID).toBe(`child_${t.n * 2 - 1}`)
      // several text parts are joined; the final report is kept
      expect(t.report).toContain(`Files changed: mod${t.n}.py`)
      expect(existsSync(join(wt.worktree, t.handoff!))).toBe(true)
      // child session state dirs are cleaned up
      expect(existsSync(sessionDir(wt.worktree, t.workerSessionID!))).toBe(false)
    }
    expect(readFileSync(join(wt.worktree, ledger.tasks[2]!.handoff!), "utf8")).toContain("# Task 3: three")
    expect(existsSync(join(wt.worktree, ".lca/handoffs/.gitignore"))).toBe(true)
    expect(deps.logs.some((l) => l === "queue finished")).toBe(true)
  })

  test("records worker completion separately from a failed code-owned verification without persisting prose", async () => {
    const deps = observedDeps({ delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "private-worker-report-sentinel", run: () => write("f.py", "x = 1\n") }
    q.add(S, [{ title: "verify failure", verify: failVerify() }])

    const run = await q.run(S, { messageID: "msg_verify_failure", resumed: false })
    const facts = observations()
    const parentTask = facts.find((f) => f.kind === "task_context" && f.sessionID === S)
    const workerTask = facts.find((f) => f.kind === "task_context" && f.sessionID === "child_1")
    const verification = facts.find((f) => f.kind === "verification_observation")

    expect(run.failed).toBe(1)
    expect(parentTask && factPayload(parentTask)).toMatchObject({ phase: "terminal", status: "failed", messageID: "msg_verify_failure" })
    expect(workerTask && factPayload(workerTask)).toMatchObject({ phase: "terminal", status: "done", ownerSessionID: S, childSessionID: "child_1", actualRole: "worker", roleBasis: "code_owned" })
    expect(verification && factPayload(verification)).toMatchObject({ phase: "terminal", status: "fail", codeOwned: true, exitCode: 2, taskStatus: "failed" })
    expect(typeof (verification && factPayload(verification).startedAt)).toBe("number")
    expect(typeof (verification && factPayload(verification).finishedAt)).toBe("number")
    expect(typeof (verification && factPayload(verification).durationMs)).toBe("number")
    expect(JSON.stringify(facts)).not.toContain("private-worker-report-sentinel")
    expect(JSON.stringify(facts)).not.toContain("boom-output")
    expect(JSON.stringify(facts)).not.toContain("verify_fail.sh")
  })

  test("retries get distinct UUID attempts and preserve identical explicit origin message IDs", async () => {
    const deps = observedDeps({ delegate: { review: false, max_attempts: 2 } as any })
    const q = createQueue(deps)
    client.replies.worker = (o, nth) => ({ text: `worker ${nth}`, run: () => { if (nth === 2) write("ready.txt", "ready\n") } })
    const verify = existsVerify("ready.txt")
    q.add(S, [{ title: "retry", verify }])
    await q.run(S, { messageID: "msg_reused", resumed: false })
    q.add(S, [{ title: "another task" }])
    await q.run(S, { messageID: "msg_reused", resumed: true })

    const facts = observations()
    const taskFacts = facts.filter((f) => f.kind === "task_context" && f.sessionID === S).map(factPayload)
    const retryAttempts = taskFacts.filter((f) => f.taskID === "t1")
    const verifications = facts.filter((f) => f.kind === "verification_observation").map(factPayload)
    const retryVerifications = verifications.filter((f) => f.taskID === "t1")

    expect(retryAttempts).toHaveLength(2)
    expect(retryAttempts.map((f) => f.attemptID)[0]).not.toBe(retryAttempts.map((f) => f.attemptID)[1])
    expect(retryAttempts.map((f) => f.messageID)).toEqual(["msg_reused", "msg_reused"])
    expect(retryAttempts[1]?.resumeOfAttemptID).toBe(retryAttempts[0]?.attemptID)
    expect(retryVerifications.map((f) => f.status)).toEqual(["fail", "pass"])
    expect(retryVerifications[1]?.attemptID).not.toBe(retryVerifications[0]?.attemptID)
    expect(taskFacts.find((f) => f.taskID === "t2")?.messageID).toBe("msg_reused")
    expect(taskFacts.find((f) => f.taskID === "t2")?.resumeOfAttemptID).toBeNull()
  })

  test("records refused and not-run verification outcomes, plus cancellation, without changing queue results", async () => {
    const deps = observedDeps({ delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "worker completed", run: () => write("f.py", "x\n") }
    const refused = q.add(S, [{ title: "refused" }])[0]!
    const refusedLedger = readLedger(wt.worktree, S)
    writeLedger(wt.worktree, updateTask(refusedLedger, refused.id, { verify: "rm -rf build" }))
    await q.run(S, { messageID: "msg_refused" })

    write("test_invalidated.py", "def test_guard():\n    assert True\n")
    client.replies.worker = { text: "worker completed", run: () => write("test_invalidated.py", "def test_guard():\n    assert False\n") }
    q.add(S, [{ title: "invalidated", verify: "python3 -m pytest -q test_invalidated.py" }])
    await q.run(S, { messageID: "msg_invalidated" })

    let stalled = false
    client.replies.worker = { text: "waiting", run: () => { stalled = true; return new Promise<void>(() => {}) } }
    const cancelSession = "ses_cancel"
    q.add(cancelSession, [{ title: "cancelled", verify: okVerify() }])
    const running = q.run(cancelSession, { messageID: "msg_cancel" })
    await waitFor(() => stalled)
    await q.abort(cancelSession, "user_stop")
    const run = await running

    const facts = observations()
    const refusal = facts.find((f) => f.kind === "verification_observation" && f.sessionID === S && factPayload(f).taskID === "t1")
    const invalidation = facts.find((f) => f.kind === "verification_observation" && f.sessionID === S && factPayload(f).taskID === "t2")
    const cancelledTask = facts.find((f) => f.kind === "task_context" && f.sessionID === cancelSession)
    const cancelledChild = facts.find((f) => f.kind === "task_context" && f.sessionID === "child_3")
    const notRun = facts.find((f) => f.kind === "verification_observation" && f.sessionID === cancelSession)
    expect(refusal && factPayload(refusal)).toMatchObject({ status: "refused", phase: "terminal", exitCode: null })
    expect((refusal && factPayload(refusal).startedAt) ?? null).toBeNull()
    expect(typeof (refusal && factPayload(refusal).finishedAt)).toBe("number")
    expect(invalidation && factPayload(invalidation)).toMatchObject({ status: "invalidated", phase: "terminal", exitCode: null })
    expect((invalidation && factPayload(invalidation).startedAt) ?? null).toBeNull()
    expect(cancelledTask && factPayload(cancelledTask)).toMatchObject({ status: "cancelled", phase: "terminal" })
    expect(cancelledChild && factPayload(cancelledChild)).toMatchObject({ status: "cancelled", phase: "terminal", childSessionID: "child_3" })
    expect(notRun && factPayload(notRun)).toMatchObject({ status: "not_run", taskStatus: "cancelled" })
    expect(run).toMatchObject({ aborted: true, cancelled: 1 })
    expect(JSON.stringify(facts)).not.toContain("rm -rf build")
  })

  test("reviewer rejection remains separate from a passing verification and advisory task completion", async () => {
    const deps = observedDeps({ delegate: { review: true, review_strict: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "worker finished", run: () => write("reviewed.py", "x = 1\n") }
    client.replies.reviewer = { text: "REJECT: keep an advisory note" }
    q.add(S, [{ title: "review advisory", verify: okVerify() }])

    const run = await q.run(S, { messageID: "msg_review" })
    const facts = observations()
    const parentTask = facts.find((f) => f.kind === "task_context" && f.sessionID === S)
    const reviewerTask = facts.find((f) => f.kind === "task_context" && f.sessionID === "child_2")
    const verification = facts.find((f) => f.kind === "verification_observation")

    expect(run.done).toBe(1)
    expect(parentTask && factPayload(parentTask)).toMatchObject({ status: "done", phase: "terminal" })
    expect(reviewerTask && factPayload(reviewerTask)).toMatchObject({ status: "done", actualRole: "reviewer", ownerSessionID: S })
    expect(verification && factPayload(verification)).toMatchObject({ status: "pass", taskStatus: "done", reviewVerdict: "reject" })
  })

  test("data checks never become code-owned verification passes", async () => {
    const fixtureRoot = join(import.meta.dir, "../../scripts/fixtures/data-vv")
    const deps = observedDeps({
      delegate: { review: false, max_attempts: 1 } as any,
      data: {
        backend: "sqlite", sqlite_path: join(fixtureRoot, "data/vehicle_visit.sqlite"),
        schema_file: join(fixtureRoot, "data/schema.json"), checks_dir: "checks",
      } as any,
    })
    const q = createQueue(deps)
    client.replies["data-analyst"] = { text: "SQL:\nSELECT 1 AS answer\nRESULT:\n1\nANSWER: one" }
    q.add(S, [{ title: "data question", kind: "data" }])
    const run = await q.run(S, { messageID: "msg_data" })

    const facts = observations()
    expect(run.done).toBe(1)
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result).toMatchObject({ ok: true, exitCode: 0 })
    expect(facts.some((f) => f.kind === "verification_observation")).toBe(false)
    expect(facts.some((f) => f.kind === "task_context" && f.sessionID === S && factPayload(f).status === "done")).toBe(true)
    expect(facts.some((f) => f.kind === "task_context" && f.sessionID === "child_1" && factPayload(f).ownerSessionID === S)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain("SELECT 1")
    expect(JSON.stringify(facts)).not.toContain("ANSWER: one")
  })

  test("crash recovery assigns a fresh UUID instead of reusing the restored attempt counter", async () => {
    const deps = observedDeps({ delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    observeSkillTask(deps, { sessionID: S, taskID: "t1", attemptID: "old_attempt_1", phase: "pending", status: "started", ownerSessionID: S })
    let { ledger } = addTasks(emptyLedger(S), [{ title: "crashed attempt" }])
    ledger = updateTask(ledger, "t1", { status: "running", attempts: 1 })
    writeLedger(wt.worktree, { ...ledger, running: { taskId: "t1", since: 1 } })
    client.replies.worker = { text: "resumed" }

    await q.run(S, { messageID: "msg_restart", resumed: true })

    const taskFacts = observations().filter((f) => f.kind === "task_context" && f.sessionID === S && factPayload(f).taskID === "t1")
    const restarted = taskFacts.map(factPayload).find((f) => f.phase === "terminal")
    expect(readLedger(wt.worktree, S).tasks[0]).toMatchObject({ attempts: 1, status: "done" })
    expect(taskFacts.some((f) => factPayload(f).attemptID === "old_attempt_1" && factPayload(f).phase === "pending")).toBe(true)
    expect(restarted?.attemptID).not.toBe("old_attempt_1")
    expect(restarted).toMatchObject({ messageID: "msg_restart", resumeOfAttemptID: null })
  })

  test("legacy Queue.run calls keep missing origin lineage explicitly unknown", async () => {
    const deps = observedDeps({ delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "done" }
    q.add(S, [{ title: "no origin" }])
    await q.run(S)

    const taskFact = observations().find((f) => f.kind === "task_context" && f.sessionID === S)
    const task = taskFact && factPayload(taskFact)
    expect(task).toMatchObject({ status: "done", messageID: null, originTaskID: null, resumeOfAttemptID: null })
  })

  test("disabled observation leaves queue behavior unchanged and creates no database", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    const databasePath = skillObservationDatabasePath(wt.worktree)
    client.replies.worker = { text: "worker report", run: () => write("ok.txt", "ok\n") }
    q.add(S, [{ title: "disabled observer", verify: okVerify() }])

    const run = await q.run(S)
    expect(run.done).toBe(1)
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.ok).toBe(true)
    expect(existsSync(databasePath)).toBe(false)
  })

  test("verify failure re-runs the worker once with the reason, then marks the task failed; the queue goes on", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    client.replies.worker = (o, nth) => ({ text: `attempt ${nth}`, run: () => write(`w${nth}.txt`, "x") })
    client.replies.reviewer = { text: "ACCEPT" }
    q.add(S, [{ title: "bad", verify: failVerify() }, { title: "good", verify: okVerify() }])
    const run = await q.run(S)
    expect(run.done).toBe(1)
    expect(run.failed).toBe(1)
    const w = prompts("worker").map((c) => (c.args as any).body.parts[0].text)
    expect(w.length).toBe(3) // bad x2, good x1
    expect(w[1]).toContain("A previous worker already changed files for this task, but the result was not accepted. Reason: verify failed (exit 2)")
    expect(w[1]).toContain("boom-output")
    expect(w[2]).toContain("Task 1 (failed (verify failed (exit 2): boom-output)): bad")
    // no reviewer call for a task whose verify failed
    expect(prompts("reviewer").length).toBe(1)
    const l = readLedger(wt.worktree, S)
    expect(l.tasks[0]!.status).toBe("failed")
    expect(l.tasks[0]!.attempts).toBe(2)
    expect(l.tasks[0]!.error).toContain("verify failed")
    expect(l.tasks[0]!.review?.verdict).toBe("skipped")
    expect(l.tasks[1]!.status).toBe("done")
    const handoff = readFileSync(join(wt.worktree, l.tasks[0]!.handoff!), "utf8")
    expect(handoff).toContain("- status: failed")
    expect(handoff).toContain("boom-output")
  })

  test("a worker that edits the test file named in the verify command fails the attempt even though verify passes", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 2 } as any })
    const q = createQueue(deps)
    write("test_rect.py", "def test_x():\n    assert 1 == 2\n")
    client.replies.worker = (o, nth) => ({
      text: `w${nth}`,
      run: () => {
        write("rect.py", "x = 1\n")
        if (nth === 1) write("test_rect.py", "def test_x():\n    assert 1 == 1\n") // cheating
      },
    })
    const v = verifyScript(wt.worktree, "verify_rect.sh", "python3 -m pytest -q test_rect.py")
    q.add(S, [{ title: "rect", verify: `${v} && python3 -m pytest -q test_rect.py` }])
    const run = await q.run(S)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(2)
    const w = prompts("worker").map((c) => (c.args as any).body.parts[0].text)
    expect(w[0]).toContain("Never edit verify_rect.sh, test_rect.py")
    expect(w[1]).toContain("modified protected file(s): test_rect.py")
    // the cheated test file is restored BEFORE verify (the verify result of a violating attempt is void), so
    // attempt 2's verify fails honestly -> failed
    expect(readFileSync(join(wt.worktree, "test_rect.py"), "utf8")).toContain("assert 1 == 2")
    expect(t.status).toBe("failed")
    expect(t.error).toContain("verify failed")
    expect(t.childSessions.length).toBe(2)
    expect(run.failed).toBe(1)
    // the voided attempt never reports "verify: pass"
    const l1 = readLedger(wt.worktree, S)
    expect(JSON.stringify(l1)).not.toContain('"ok":true')
  })

  test("a verify command that is not an allow-listed runner is refused and never executed", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "ok", run: () => write("marker.txt", "x") }
    let { ledger } = addTasks(emptyLedger(S), [{ title: "evil" }])
    ledger = updateTask(ledger, "t1", { verify: "rm -rf build && sh verify_ok.sh" }) // bypasses delegate-time validation
    writeLedger(wt.worktree, ledger)
    await q.run(S)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.status).toBe("failed")
    expect(t.verify_result?.exitCode).toBeNull()
    expect(t.verify_result?.output).toContain("verify command refused")
    expect(t.error).toContain("verify refused")
  })

  test("reviewer REJECT retries with the reason; a second REJECT on a verified task is advisory (task done)", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    // attempt 1 writes the file; attempt 2 changes nothing more
    client.replies.worker = (o, nth) => ({ text: `w${nth}`, run: () => (nth === 1 ? write("f.py", "v=1\n") : undefined) })
    client.replies.reviewer = { text: "REJECT: missing edge case\n- n=0" }
    q.add(S, [{ title: "t", verify: okVerify() }])
    const run = await q.run(S)
    expect(run.done).toBe(1)
    expect(run.failed).toBe(0)
    const w = prompts("worker").map((c) => (c.args as any).body.parts[0].text)
    expect(w[1]).toContain("review rejected: missing edge case")
    // the second reviewer call still sees f.py (cumulative diff): not "skipped: no file changes"
    const r = prompts("reviewer").map((c) => (c.args as any).body.parts[0].text)
    expect(r.length).toBe(2)
    expect(r[1]).toContain("+v=1")
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.status).toBe("done")
    expect(t.attempts).toBe(2)
    expect(t.review?.verdict).toBe("reject")
    expect(t.error).toContain("accepted with review objection: missing edge case")
    expect(t.filesChanged).toEqual(["f.py"])
  })

  test("review_strict: a REJECT on the last attempt fails the task even when verify passed", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review_strict: true } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "w", run: () => write("f.py", "v\n") }
    client.replies.reviewer = { text: "REJECT: scope creep" }
    q.add(S, [{ title: "t", verify: okVerify() }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    expect(readLedger(wt.worktree, S).tasks[0]!.error).toContain("review rejected: scope creep")
  })

  test("a REJECT without any verify command retries and then fails (nothing else proves the task)", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    client.replies.worker = { text: "w", run: () => write("f.py", "v\n") }
    client.replies.reviewer = { text: "REJECT: incomplete" }
    q.add(S, [{ title: "t" }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    expect(prompts("worker").length).toBe(2)
  })

  test("an unparseable verdict never fails a verified task and is reported as 'no verdict'", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    client.replies.worker = { text: "w", run: () => write("f.py", "v\n") }
    client.replies.reviewer = { text: "Looks fine to me overall." }
    q.add(S, [{ title: "t", verify: okVerify() }])
    const run = await q.run(S)
    expect(run.done).toBe(1)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(1)
    expect(t.review?.verdict).toBe("error")
    expect(readFileSync(join(wt.worktree, t.handoff!), "utf8")).toContain("- review: NO VERDICT")
  })

  test("review is skipped when the worker changed nothing, and when disabled by config", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    client.replies.worker = { text: "nothing to do" }
    client.replies.reviewer = { text: "REJECT: should not be asked" }
    q.add(S, [{ title: "noop" }])
    await q.run(S)
    expect(prompts("reviewer").length).toBe(0)
    expect(readLedger(wt.worktree, S).tasks[0]!.review).toEqual({ verdict: "skipped", reason: "no file changes" })

    const deps2 = makeDeps(client, wt.worktree, noReview)
    const q2 = createQueue(deps2)
    client.replies.worker = { text: "did it", run: () => write("z.txt", "z") }
    q2.add("ses_2", [{ title: "x" }])
    await q2.run("ses_2")
    expect(prompts("reviewer").length).toBe(0)
    expect(readLedger(wt.worktree, "ses_2").tasks[0]!.status).toBe("done")
  })

  test("worker error (provider error in info.error) counts as a failed attempt", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.replies.worker = { error: { name: "ApiError", data: { message: "500 from ollama" } } }
    q.add(S, [{ title: "t" }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.status).toBe("failed")
    expect(t.error).toContain("ApiError: 500 from ollama")
  })

  test("session.create returning {error} is a readable failure, not [object Object]", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(deps)
    client.createError = { name: "NotFoundError", data: { message: "parent gone" } }
    q.add(S, [{ title: "t" }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.error).toContain("NotFoundError: parent gone")
    expect(t.error).not.toContain("[object Object]")
  })

  test("a child aborted by someone else (repetition guard) is a failed attempt and retried, not a queue abort", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = createQueue(deps)
    client.replies.worker = (o, nth) => (nth === 1 ? { error: { name: "MessageAbortedError" } } : { text: "ok", run: () => write("a.txt", "a") })
    q.add(S, [{ title: "a" }, { title: "b" }])
    const run = await q.run(S)
    expect(run.aborted).toBe(false)
    expect(run.done).toBe(2)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(2)
    expect(t.status).toBe("done")
    expect(prompts("worker")[1]!.args as any).toBeDefined()
    expect((prompts("worker")[1]!.args as any).body.parts[0].text).toContain("aborted (repetition guard or external abort)")
  })

  test("abort mid-worker: child session aborted, task cancelled, remaining tasks cancelled, ledger settled", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = createQueue(deps)
    let inSecond = false
    client.replies.worker = (o, nth) => {
      if (nth === 1) return { text: "one", run: () => write("a.txt", "a") }
      inSecond = true
      return { text: "never finishes", run: () => new Promise<void>(() => {}) } // hangs until aborted
    }
    q.add(S, [{ title: "a" }, { title: "b" }, { title: "c" }])
    const running = q.run(S)
    await waitFor(() => inSecond)
    expect(q.isRunning(S)).toBe(true)
    await q.abort(S, "user_stop")
    expect(client.calls.some((c) => c.method === "abort" && (c.args as any).path.id === "child_2")).toBe(true)
    const run = await running
    expect(run.aborted).toBe(true)
    expect(run.abortReason).toBe("user_stop")
    expect(run.done).toBe(1)
    expect(run.cancelled).toBe(2)
    const l = readLedger(wt.worktree, S)
    expect(l.tasks.map((t) => t.status)).toEqual(["done", "cancelled", "cancelled"])
    expect(l.tasks[1]!.error).toBe("user_stop")
    expect(l.running).toBeUndefined()
    expect(q.isRunning(S)).toBe(false)
  })

  test("abort during the reviewer: a verified change is kept as done (review aborted), an unverified one is cancelled", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    let inReview = false
    client.replies.worker = { text: "w", run: () => write("f.py", "v\n") }
    client.replies.reviewer = () => {
      inReview = true
      return { text: "REJECT: late", run: () => new Promise<void>(() => {}) }
    }
    q.add(S, [{ title: "only", verify: okVerify() }])
    const running = q.run(S)
    await waitFor(() => inReview)
    await q.abort(S, "user_stop")
    const run = await running
    expect(run.aborted).toBe(true)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.status).toBe("done")
    expect(t.error).toContain("review aborted")
    expect(t.review?.aborted).toBe(true)

    inReview = false
    client.calls.length = 0
    client.replies.worker = { text: "w", run: () => write("g.py", "v\n") }
    q.add("ses_b", [{ title: "no verify" }])
    const running2 = q.run("ses_b")
    await waitFor(() => inReview)
    await q.abort("ses_b", "user_stop")
    await running2
    expect(readLedger(wt.worktree, "ses_b").tasks[0]!.status).toBe("cancelled")
  })

  test("abort during the verify command kills it and cancels the task", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = createQueue(deps)
    client.replies.worker = { text: "w", run: () => write("f.py", "v\n") }
    const slow = verifyScript(wt.worktree, "verify_slow.sh", "sleep 20")
    q.add(S, [{ title: "slow verify", verify: slow }, { title: "next" }])
    const running = q.run(S)
    await waitFor(() => deps.logs.includes("task start") && client.calls.filter((c) => c.method === "prompt").length === 1)
    await new Promise((r) => setTimeout(r, 150)) // let the verify process start
    const t0 = Date.now()
    await q.abort(S, "user_stop")
    const run = await running
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(run.aborted).toBe(true)
    const l = readLedger(wt.worktree, S)
    expect(l.tasks[0]!.status).toBe("cancelled")
    expect(l.tasks[0]!.verify_result?.output).toContain("killed")
    expect(l.tasks[1]!.status).toBe("cancelled")
  })

  test("abort file present before start cancels every pending task without prompting", async () => {
    const deps = makeDeps(client, wt.worktree)
    const q = createQueue(deps)
    writeJsonAtomic(abortPath(wt.worktree, S), { reason: "user_stop", at: Date.now() })
    q.add(S, [{ title: "a" }, { title: "b" }])
    const run = await q.run(S)
    expect(run).toMatchObject({ done: 0, cancelled: 2, aborted: true, abortReason: "user_stop" })
    expect(prompts("worker").length).toBe(0)
  })

  test("queue ttl cancels the remaining tasks", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, queue_ttl_ms: 60 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "ok", delayMs: 80 }
    q.add(S, [{ title: "a" }, { title: "b" }])
    const run = await q.run(S)
    expect(run.done).toBe(1)
    expect(run.cancelled).toBe(1)
    expect(run.abortReason).toBe("queue ttl exceeded")
  })

  test("second run for the same session is refused while the first is active; a stale running task is resumed with its attempt restored", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = createQueue(deps)
    let started = false
    let release: (() => void) | undefined
    client.replies.worker = {
      text: "ok",
      run: () => {
        started = true
        write("r.txt", "r")
        return new Promise<void>((r) => (release = r))
      },
    }
    // simulate a crash during attempt 2 of 2: task left "running" on disk
    let { ledger } = addTasks(emptyLedger(S), [{ title: "stale" }])
    ledger = updateTask(ledger, "t1", { status: "running", attempts: 2 })
    writeLedger(wt.worktree, { ...ledger, running: { taskId: "t1", since: 1 } })
    const first = q.run(S)
    const second = await q.run(S)
    expect(second.skipped).toBe("already_running")
    await waitFor(() => started)
    release!()
    const r = await first
    expect(r.done).toBe(1)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(2) // 2 -> 1 (restored) -> 2 (this run)
    expect(t.status).toBe("done")
  })

  test("running.childSessionID is recorded while a worker runs", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = createQueue(deps)
    let seen: string | undefined
    client.replies.worker = {
      text: "ok",
      run: () => {
        seen = readLedger(wt.worktree, S).running?.childSessionID
      },
    }
    q.add(S, [{ title: "a" }])
    await q.run(S)
    expect(seen).toBe("child_1")
    expect(readLedger(wt.worktree, S).running).toBeUndefined()
  })

  test("child session timeout aborts the child and fails the attempt; the retry gets the reason", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 2, task_ttl_ms: 50 } as any })
    const q = createQueue(deps)
    client.replies.worker = { text: "late", delayMs: 300 }
    q.add(S, [{ title: "slow" }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(2)
    expect((prompts("worker")[1]!.args as any).body.parts[0].text).toContain("timed out")
    expect(readLedger(wt.worktree, S).tasks[0]!.error).toContain("timed out")
  })

  test("configured worker/reviewer models are passed as provider/model on the child prompt", async () => {
    const deps = makeDeps(client, wt.worktree, { models: { worker: "ollama/gemma4:31b-mlx" }, ...noReview })
    const q = createQueue(deps)
    client.replies.worker = { text: "ok" }
    q.add(S, [{ title: "m" }])
    await q.run(S)
    expect((prompts("worker")[0]!.args as any).body.model).toEqual({ providerID: "ollama", modelID: "gemma4:31b-mlx" })
  })
})

describe("prompt builders + verdict parser", () => {
  test("workerPrompt counts tasks within the batch and carries the retry guidance", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a", detail: "do a", verify: "pytest -q a.py" }, { title: "b" }])
    ledger = addTasks(ledger, [{ title: "c" }]).ledger
    const p = workerPrompt(ledger, ledger.tasks[1]!, "verify failed: x", 600)
    expect(p.startsWith("Task 2 of 2: b")).toBe(true)
    expect(p).toContain("Reason: verify failed: x")
    expect(p).toContain("keep what already works")
    expect(p).not.toContain("Run this once")
    // a later batch counts from 1 again (the ledger number stays global for handoff file names)
    expect(workerPrompt(ledger, ledger.tasks[2]!, undefined, 600).startsWith("Task 1 of 1: c")).toBe(true)
    expect(p.length).toBeLessThan(600)
  })

  test("reviewerPrompt without verify says so and shows the full scope", () => {
    const { ledger } = addTasks(emptyLedger(S), [{ title: "a", detail: "x".repeat(500) }])
    const p = reviewerPrompt(ledger.tasks[0]!, "+x", undefined)
    expect(p).toContain("Verification: none provided by the task; judge the diff only.")
    expect(p).toContain("Scope: " + "x".repeat(500))
  })

  test("parseVerdict handles the contract and common local-model deviations", () => {
    expect(parseVerdict("ACCEPT\n- fine")).toEqual({ verdict: "accept" })
    expect(parseVerdict("REJECT: tests fail\n- x")).toEqual({ verdict: "reject", reason: "tests fail" })
    expect(parseVerdict("**REJECT** - scope creep")).toEqual({ verdict: "reject", reason: "scope creep" })
    expect(parseVerdict("\n\nAccept.")).toEqual({ verdict: "accept" })
    expect(parseVerdict("REJECTED: scope creep")).toEqual({ verdict: "reject", reason: "scope creep" })
    expect(parseVerdict("Verdict: REJECT — missing tests")).toEqual({ verdict: "reject", reason: "missing tests" })
    expect(parseVerdict("**Verdict:** ACCEPT")).toEqual({ verdict: "accept" })
    expect(parseVerdict("거부: 테스트 없음")).toEqual({ verdict: "reject", reason: "테스트 없음" })
    expect(parseVerdict("승인")).toEqual({ verdict: "accept" })
    // identifiers in the reason survive (underscores are not stripped)
    expect(parseVerdict("REJECT: bug in is_right")).toEqual({ verdict: "reject", reason: "bug in is_right" })
    // a verdict on the second line still counts; rule recitals do not
    expect(parseVerdict("Looking at the diff...\nREJECT: missing test")).toEqual({ verdict: "reject", reason: "missing test" })
    expect(parseVerdict("I would reject when tests fail, but here they pass.\nLooks good").verdict).toBe("error")
    // verdict-last format (current reviewer contract) and rule recitals
    expect(parseVerdict("1. Test files in the diff: none\n2. Test-aware code: none\n3. yes\n4. none\nACCEPT")).toEqual({ verdict: "accept" })
    expect(parseVerdict("1. none\n2. global _call_count\n3. no: counter\n4. none\nREJECT: test-aware code")).toEqual({ verdict: "reject", reason: "test-aware code" })
    expect(parseVerdict("REJECT when 1, 2 or 4 is not none.\n1. none\n2. none\n3. yes\n4. none\nAccept")).toEqual({ verdict: "accept" })
    expect(parseVerdict("REJECT if any of 1, 2, 4 is not none.\n…\n**Verdict:** REJECT: special-cased")).toEqual({ verdict: "reject", reason: "special-cased" })
    expect(parseVerdict("Looks good to me").verdict).toBe("error")
    expect(parseVerdict("").verdict).toBe("error")
  })
})
