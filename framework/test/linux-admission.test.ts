import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { submitAdmittedImportedPlan, submitImportedPlan } from "../src/flow/actions.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { eventsPath, newWorkflow, planJsonPath, workflowPath, withFlowTransaction } from "../src/flow/state.ts"
import { rewriteCommitted, writeWorkflow } from "./commit-fixture.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime, type LinuxAdmission } from "../src/hosts/types.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import { createQueue } from "../src/orchestration/queue.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { ledgerPath, readLedger } from "../src/state/ledger.ts"
import { stateRoot } from "../src/state/store.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { planMdPath, type Plan } from "../src/flow/plan.ts"

const SESSION = "ses_linux_admission"

function plan(): Plan {
  return {
    goal: "implement the change",
    revision: 1,
    steps: [1, 2, 3].map(index => ({
      title: `step ${index}`, files: [`src/file-${index}.ts`], detail: `implement step ${index}`,
      verify: `bun test test/file-${index}.test.ts`,
    })),
    risks: ["an edge case could regress"],
  }
}

function queueRuntime(linuxAdmission: LinuxAdmission) {
  const worktree = wt.worktree
  const config = {
    ...DEFAULT_CONFIG,
    delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, review: false, max_attempts: 1 },
  }
  const runs = createExecutionRunStore(worktree)
  const policy = createExecutionPolicy(config, { directory: worktree, worktree })
  const requests: string[] = []
  const runtime: ExecutionRuntime = {
    instance: "linux-admission-queue-fixture", directory: worktree, worktree,
    stateRoot: stateRoot(worktree), config, log: () => {}, runs, policy,
    verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(), linuxAdmission,
    host: {
      identity: { engine: "fixture", profile: "test" },
      async preflight() { return { compatible: true, controls: {}, problems: [] } },
      async reconcile() { return { outcome: "unknown" as const, quiescent: false, evidence: "no prior execution" } },
      async prepare(request) {
        requests.push(request.executionID)
        const reference = { executionID: request.executionID, vendorSessionID: `child-${requests.length}` }
        request.onReference?.(reference)
        policy.bindSession(reference.vendorSessionID, request.handlers, request.policy)
        return {
          reference,
          async run() { return { status: "completed" as const, text: "Files changed: none\nOpen issues: none" } },
          async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: "terminal" as const, quiescent: true, evidence: "fixture completed" } },
        }
      },
    },
  }
  return { runtime, requests }
}

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree() })
afterEach(() => wt.cleanup())
// Each test gets an isolated committed worktree because queue snapshots require a real baseline.
test("initial G-admit refusal preserves the pending ledger, releases recovery claim, and same-boot retry works", async () => {
  let refused = true
  let admissions = 0
  const linuxAdmission: LinuxAdmission = {
    assertBootEpoch() {},
    async admitNewExecution() {
      admissions++
      if (refused) throw new LinuxAdmissionRefused("admit", ["latched"])
    },
    async admitPlanSubmission() { throw new Error("not used") },
    consumePlanSubmission() { throw new Error("not used") },
  }
  const f = queueRuntime(linuxAdmission)
  const queue = createQueue(f.runtime)
  queue.add(SESSION, [{ title: "preserve this task" }])
  const path = ledgerPath(wt.worktree, SESSION)
  const before = readFileSync(path)

  const denied = await queue.run(SESSION)
  expect(denied).toMatchObject({ refused: { phase: "admit", reasons: ["latched"] }, done: 0, failed: 0, aborted: false })
  expect(readFileSync(path)).toEqual(before)
  expect(readLedger(wt.worktree, SESSION).tasks.map(task => task.status)).toEqual(["pending"])
  expect(f.runtime.runs.status()).toMatchObject({ executions: [], claim: undefined })
  expect(f.requests).toEqual([])

  refused = false
  const recovered = await queue.run(SESSION)
  expect(recovered).toMatchObject({ done: 1, failed: 0 })
  expect(recovered.refused).toBeUndefined()
  expect(f.requests).toHaveLength(1)
  expect(readLedger(wt.worktree, SESSION).tasks.map(task => task.status)).toEqual(["done"])
  expect(admissions).toBeGreaterThan(1)
})

test("mid-child G-admit refusal fails only the current task without registering intent or preparing a host", async () => {
  let admissions = 0
  const linuxAdmission: LinuxAdmission = {
    assertBootEpoch() {},
    async admitNewExecution() {
      admissions++
      if (admissions === 3) throw new LinuxAdmissionRefused("admit", ["latched"])
    },
    async admitPlanSubmission() { throw new Error("not used") },
    consumePlanSubmission() { throw new Error("not used") },
  }
  const f = queueRuntime(linuxAdmission)
  const queue = createQueue(f.runtime)
  queue.add(SESSION, [{ title: "blocked first" }, { title: "leave pending" }])
  const result = await queue.run(SESSION)
  expect(result).toMatchObject({ refused: { phase: "admit", reasons: ["latched"] }, failed: 0, done: 0, aborted: false })
  expect(f.requests).toEqual([])
  expect(f.runtime.runs.status()).toMatchObject({ executions: [], claim: undefined })
  expect(readLedger(wt.worktree, SESSION).tasks.map(task => task.status)).toEqual(["failed", "pending"])
  expect(readLedger(wt.worktree, SESSION).tasks[0]?.error).toBe("linux admission refused: latched")
})

test("direct imported-plan A4c refusal occurs before plan and workflow writes", async () => {
  const workflow = newWorkflow(SESSION, currentOwner(), "command", "approved test workflow", "fixture")
  withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, workflow))
  const before = readFileSync(workflowPath(wt.worktree))
  const refused = new LinuxAdmissionRefused("admit", ["latched"])
  let checks = 0
  const runtime = {
    worktree: wt.worktree,
    host: { identity: { engine: "fixture" } },
    linuxAdmission: {
      async admitNewExecution() { checks++; throw refused },
    },
  } as unknown as ExecutionRuntime

  await expect(submitImportedPlan(runtime, workflow, plan())).rejects.toBe(refused)
  expect(checks).toBe(1)
  expect(readFileSync(workflowPath(wt.worktree))).toEqual(before)
  expect(existsSync(planJsonPath(wt.worktree, workflow.id))).toBe(false)
  expect(existsSync(join(wt.worktree, planMdPath(workflow.id)))).toBe(false)
})

for (const changedEngine of ["foreign", "missing"] as const) {
  test(`plan admission rechecks ${changedEngine} persisted engine before artifacts or events`, async () => {
    let calls = 0
    let changedBytes: Buffer | undefined
    const linuxAdmission: LinuxAdmission = {
      assertBootEpoch() {},
      async admitNewExecution() {
        calls++
        const path = workflowPath(wt.worktree)
        rewriteCommitted(wt.worktree, (current) => {
          const next = { ...current } as Record<string, unknown>
          if (changedEngine === "missing") delete next.engine
          else next.engine = "foreign-engine"
          return next as never
        })
        changedBytes = readFileSync(path)
      },
      async admitPlanSubmission() { throw new Error("not used") },
      consumePlanSubmission() { throw new Error("not used") },
    }
    const { runtime } = queueRuntime(linuxAdmission)
    const workflow = newWorkflow(SESSION, currentOwner(), "command", "approved test workflow", "fixture")
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, workflow))

    await expect(submitImportedPlan(runtime, workflow, plan())).rejects.toThrow("workflow engine identity")

    expect(calls).toBe(1)
    expect(changedBytes).toBeDefined()
    expect(readFileSync(workflowPath(wt.worktree)).equals(changedBytes!)).toBe(true)
    expect(existsSync(planJsonPath(wt.worktree, workflow.id))).toBe(false)
    expect(existsSync(join(wt.worktree, planMdPath(workflow.id)))).toBe(false)
    expect(existsSync(ledgerPath(wt.worktree, SESSION))).toBe(false)
    expect(existsSync(eventsPath(wt.worktree))).toBe(false)
  })
}

function isolated(source: string, extraEnv: Record<string, string> = {}): any {
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  })
  if (child.error || child.status !== 0) {
    throw new Error(`admission characterization subprocess failed: ${child.error?.message ?? child.stderr}\n${child.stdout}`)
  }
  return JSON.parse(child.stdout)
}

test("unit only, not native proof: fixed-native mocks show unqualified and latched reasons aggregate", () => {
  const modules = {
    runtime: fileURLToPath(new URL("../src/hosts/runtime.ts", import.meta.url)),
    domain: fileURLToPath(new URL("../src/hosts/linux-domain.ts", import.meta.url)),
  }
  const outcome = isolated(`import { mock } from "bun:test";
let localQualified = false;
const diagnosticQualifications = [];
let health = {
  bootEpochMatch: false,
  journal: { persistentEffective: true, persistentEntry: true, readable: true },
  pendingTickets: 0, pendingBytes: 0, unknownBound: 0, staleActive: 0,
  latched: true, quarantineRequired: true, capacityAvailable: false,
  reasons: ["boot-epoch", "latched"],
};
mock.module(${JSON.stringify(modules.domain)}, () => ({
  authenticateLinuxVerification() { return false; },
  inspectLinuxVerifierProfile(qualification) {
    if (qualification !== false && qualification !== true) throw new Error("unexpected profile mode");
    return qualification || localQualified
      ? { compatible: true, problems: [] }
      : { compatible: false, problems: ["root verifier profile is not qualified for production"] };
  },
  linuxBootEpochMatches() { return true; },
  isCurrentLinuxVerifierReference() { return false; },
  runLinuxVerifierClient(operation, _data, deadlineAt, qualification) {
    if (operation !== "preflight" || qualification !== true || deadlineAt <= Date.now()) throw new Error("unexpected native client call");
    diagnosticQualifications.push(qualification);
    const compatible = health.bootEpochMatch && health.journal.persistentEffective && health.journal.persistentEntry &&
      health.journal.readable && !health.latched && !health.quarantineRequired;
    return Promise.resolve({
      ok: true, compatible,
      problems: health.latched ? ["native Linux verifier admission is latched"] : [],
      admission: health,
    });
  },
}));
const { createLinuxAdmission } = await import(${JSON.stringify(modules.runtime)});
const first = createLinuxAdmission({ qualification: false });
let refusal;
try { await first.admitNewExecution(); }
catch (error) { refusal = { name: error.name, phase: error.phase, reasons: error.reasons }; }
localQualified = true;
health = {
  bootEpochMatch: true,
  journal: { persistentEffective: true, persistentEntry: true, readable: true },
  pendingTickets: 0, pendingBytes: 0, unknownBound: 0, staleActive: 0,
  latched: false, quarantineRequired: false, capacityAvailable: true, reasons: [],
};
const owner = createLinuxAdmission({ qualification: true });
const other = createLinuxAdmission({ qualification: true });
const minted = await owner.admitPlanSubmission("session-A");
const failures = [];
for (const [candidate, target, label, instance] of [
  [{ purpose: "plan-submission", sessionID: "session-A" }, "session-A", "fabricated", owner],
  [minted, "session-A", "consumed", owner],
  [await owner.admitPlanSubmission("session-A"), "session-B", "wrong-session", owner],
  [await owner.admitPlanSubmission("session-A"), "session-A", "wrong-runtime", other],
]) {
  if (label === "consumed") owner.consumePlanSubmission(candidate, target);
  try { instance.consumePlanSubmission(candidate, target); failures.push({ label, name: "accepted" }); }
  catch (error) { failures.push({ label, name: error.name }); }
}
health.capacityAvailable = false;
health.pendingTickets = 16;
let capacity;
try { await owner.admitNewExecution(); } catch (error) { capacity = error.reasons; }
health = {
  bootEpochMatch: false, journal: { persistentEffective: false, persistentEntry: false, readable: false },
  pendingTickets: 0, pendingBytes: 0, unknownBound: 0, staleActive: 0,
  latched: false, quarantineRequired: false, capacityAvailable: false, reasons: [],
};
let unavailable;
try { await owner.admitNewExecution(); } catch (error) { unavailable = error.reasons; }
console.log(JSON.stringify({ refusal, capacity, unavailable, tokenFrozen: Object.isFrozen(minted), token: minted, failures, diagnosticQualifications }));`)
  expect(outcome.refusal).toEqual({ name: "LinuxAdmissionRefused", phase: "admit", reasons: ["unqualified", "boot-epoch", "latched"] })
  expect(outcome.capacity).toEqual(["capacity-exhausted"])
  expect(outcome.unavailable).toEqual(["gate-unavailable"])
  expect(outcome.tokenFrozen).toBe(true)
  expect(outcome.token).toEqual({ purpose: "plan-submission", sessionID: "session-A" })
  expect(outcome.failures).toEqual([
    { label: "fabricated", name: "TypeError" },
    { label: "consumed", name: "TypeError" },
    { label: "wrong-session", name: "TypeError" },
    { label: "wrong-runtime", name: "TypeError" },
  ])
  expect(outcome.diagnosticQualifications.every((qualification: boolean) => qualification)).toBe(true)
})

test("plan-submission token misuse and legacy-runtime use fail before imported-plan writes", () => {
  const modules = {
    runtime: fileURLToPath(new URL("../src/hosts/runtime.ts", import.meta.url)),
    domain: fileURLToPath(new URL("../src/hosts/linux-domain.ts", import.meta.url)),
    actions: fileURLToPath(new URL("../src/flow/actions.ts", import.meta.url)),
    owner: fileURLToPath(new URL("../src/flow/owner.ts", import.meta.url)),
    state: fileURLToPath(new URL("../src/flow/state.ts", import.meta.url)),
    plan: fileURLToPath(new URL("../src/flow/plan.ts", import.meta.url)),
  }
  const root = wt.worktree
  const outcome = isolated(`import { mock } from "bun:test";
mock.module(${JSON.stringify(modules.domain)}, () => ({
  authenticateLinuxVerification() { return false; },
  inspectLinuxVerifierProfile() { return { compatible: true, problems: [] }; },
  isCurrentLinuxVerifierReference() { return false; },
  linuxBootEpochMatches() { return true; },
  runLinuxVerifierClient(operation, _data, deadlineAt, qualification) {
    if (operation !== "preflight" || qualification !== true || deadlineAt <= Date.now()) throw new Error("unexpected native client call");
    return Promise.resolve({
      ok: true, compatible: true, problems: [], admission: {
      bootEpochMatch: true, journal: { persistentEffective: true, persistentEntry: true, readable: true },
      pendingTickets: 0, pendingBytes: 0, unknownBound: 0, staleActive: 0,
      latched: false, quarantineRequired: false, capacityAvailable: true, reasons: [],
      },
    });
  },
}));
const { createLinuxAdmission } = await import(${JSON.stringify(modules.runtime)});
const { submitAdmittedImportedPlan } = await import(${JSON.stringify(modules.actions)});
const { currentOwner } = await import(${JSON.stringify(modules.owner)});
const { newWorkflow, withFlowTransaction, workflowPath, planJsonPath } = await import(${JSON.stringify(modules.state)});
const { writeWorkflow } = await import(${JSON.stringify(fileURLToPath(new URL("./commit-fixture.ts", import.meta.url)))});
const { planMdPath } = await import(${JSON.stringify(modules.plan)});
const { readFileSync, existsSync } = await import("node:fs");
const { join } = await import("node:path");
const root = process.env.LCA_ADMISSION_TEST_WORKTREE;
const owner = createLinuxAdmission({ qualification: true });
const other = createLinuxAdmission({ qualification: true });
const token = await owner.admitPlanSubmission("session-A");
const spent = await owner.admitPlanSubmission("session-A");
owner.consumePlanSubmission(spent, "session-A");
const wrongSession = await owner.admitPlanSubmission("session-A");
const wrongRuntime = await owner.admitPlanSubmission("session-A");
const plan = { goal: "g", revision: 1, risks: ["r"], steps: [1,2,3].map(n => ({ title: "s"+n, files: ["src/s"+n+".ts"], detail: "d", verify: "bun test test/s"+n+".test.ts" })) };
const outcomes = [];
const baseRuntime = { worktree: root, host: { identity: { engine: "fixture" } } };
for (const [label, runtime, sessionID, admission] of [
  ["fabricated", { ...baseRuntime, linuxAdmission: owner }, "session-A", { purpose: "plan-submission", sessionID: "session-A" }],
  ["reused", { ...baseRuntime, linuxAdmission: owner }, "session-A", spent],
  ["wrong-session", { ...baseRuntime, linuxAdmission: owner }, "session-B", wrongSession],
  ["wrong-runtime", { ...baseRuntime, linuxAdmission: other }, "session-A", wrongRuntime],
  ["legacy", baseRuntime, "session-A", token],
]) {
  const workflow = newWorkflow(sessionID, currentOwner(), "command", "plan", "fixture");
  withFlowTransaction(root, tx => writeWorkflow(tx, workflow));
  const before = readFileSync(workflowPath(root));
  const jsonPath = planJsonPath(root, workflow.id);
  const mdPath = join(root, planMdPath(workflow.id));
  let errorName = "accepted";
  try { await submitAdmittedImportedPlan(runtime, workflow, plan, admission); }
  catch (error) { errorName = error.name; }
  outcomes.push({ label, errorName, unchanged: readFileSync(workflowPath(root)).equals(before), noPlanFiles: !existsSync(jsonPath) && !existsSync(mdPath) });
}
console.log(JSON.stringify(outcomes));`, { LCA_ADMISSION_TEST_WORKTREE: root })
  expect(outcome).toEqual([
    { label: "fabricated", errorName: "TypeError", unchanged: true, noPlanFiles: true },
    { label: "reused", errorName: "TypeError", unchanged: true, noPlanFiles: true },
    { label: "wrong-session", errorName: "TypeError", unchanged: true, noPlanFiles: true },
    { label: "wrong-runtime", errorName: "TypeError", unchanged: true, noPlanFiles: true },
    { label: "legacy", errorName: "TypeError", unchanged: true, noPlanFiles: true },
  ])
})

test("delegate G-epoch refusal precedes abort handling and ledger recovery on fresh and resume calls", () => {
  const modules = {
    runtime: fileURLToPath(new URL("../src/hosts/opencode-runtime.ts", import.meta.url)),
    delegate: fileURLToPath(new URL("../src/tools/delegate.ts", import.meta.url)),
  }
  const outcome = isolated(`import { mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from ${JSON.stringify(fileURLToPath(new URL("../src/config.ts", import.meta.url)))};
import { createExecutionRunStore } from ${JSON.stringify(fileURLToPath(new URL("../src/hosts/run-state.ts", import.meta.url)))};
import { createExecutionPolicy } from ${JSON.stringify(fileURLToPath(new URL("../src/hosts/tool-policy.ts", import.meta.url)))};
import { createLegacyVerifierExecutor } from ${JSON.stringify(fileURLToPath(new URL("../src/orchestration/legacy-verifier.ts", import.meta.url)))};
import { stateRoot } from ${JSON.stringify(fileURLToPath(new URL("../src/state/store.ts", import.meta.url)))};
import { ledgerPath } from ${JSON.stringify(fileURLToPath(new URL("../src/state/ledger.ts", import.meta.url)))};
import { LinuxAdmissionRefused } from ${JSON.stringify(fileURLToPath(new URL("../src/hosts/types.ts", import.meta.url)))};
const root = process.env.LCA_ADMISSION_TEST_WORKTREE;
const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, review: false } };
const runs = createExecutionRunStore(root);
let claims = 0, statuses = 0, epochs = 0;
const claim = runs.claim.bind(runs), status = runs.status.bind(runs);
runs.claim = (...args) => { claims++; return claim(...args); };
runs.status = () => { statuses++; return status(); };
const refused = new LinuxAdmissionRefused("epoch", ["boot-epoch"]);
const linuxAdmission = { assertBootEpoch() { epochs++; throw refused; }, async admitNewExecution() { throw refused; }, async admitPlanSubmission() { throw refused; }, consumePlanSubmission() { throw refused; } };
const runtime = {
  instance: "delegate-test", directory: root, worktree: root, stateRoot: stateRoot(root), config, log() {}, runs,
  verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(), linuxAdmission,
  policy: createExecutionPolicy(config, { directory: root, worktree: root }),
  host: { identity: { engine: "fixture", profile: "test" }, async preflight() { return { compatible: true, controls: {}, problems: [] }; }, async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "none" }; }, async prepare() { throw new Error("must not prepare"); } },
};
const runtimeExports = await import(${JSON.stringify(modules.runtime)});
mock.module(${JSON.stringify(modules.runtime)}, () => ({ ...runtimeExports, getOpenCodeRuntime() { return runtime; } }));
const { createDelegateTool } = await import(${JSON.stringify(modules.delegate)});
const deps = { client: {}, directory: root, worktree: root, config, log() {} };
const tool = createDelegateTool(deps);
const path = ledgerPath(root, "session");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, "not-json ledger\\n");
const ledgerBefore = readFileSync(path);
const marker = join(dirname(path), "abort.json");
writeFileSync(marker, JSON.stringify({ reason: "repetition", at: Date.now() }));
const markerBefore = readFileSync(marker);
const failure = async (args, alreadyAborted) => {
  const abort = new AbortController();
  if (alreadyAborted) abort.abort();
  try { await tool.execute(args, { agent: "main", sessionID: "session", messageID: "m", abort: abort.signal, metadata() {} }); return "accepted"; }
  catch (error) { return { name: error.name, phase: error.phase, reasons: error.reasons }; }
};
const fresh = await failure({ tasks: [{ title: "fresh" }] }, true);
const resume = await failure({ resume: true }, false);
console.log(JSON.stringify({ fresh, resume, epochs, claims, statuses,
  ledgerUnchanged: readFileSync(path).equals(ledgerBefore), markerUnchanged: readFileSync(marker).equals(markerBefore) }));`, { LCA_ADMISSION_TEST_WORKTREE: wt.worktree })
  expect(outcome).toEqual({
    fresh: { name: "LinuxAdmissionRefused", phase: "epoch", reasons: ["boot-epoch"] },
    resume: { name: "LinuxAdmissionRefused", phase: "epoch", reasons: ["boot-epoch"] },
    epochs: 2, claims: 0, statuses: 0, ledgerUnchanged: true, markerUnchanged: true,
  })
})

test("lca_flow A4 refuses both invalid and valid plans before either submission branch writes", () => {
  const modules = {
    runtime: fileURLToPath(new URL("../src/hosts/opencode-runtime.ts", import.meta.url)),
    tool: fileURLToPath(new URL("../src/tools/lca-flow.ts", import.meta.url)),
  }
  const root = wt.worktree
  const outcome = isolated(`import { mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from ${JSON.stringify(fileURLToPath(new URL("../src/config.ts", import.meta.url)))};
import { LinuxAdmissionRefused } from ${JSON.stringify(fileURLToPath(new URL("../src/hosts/types.ts", import.meta.url)))};
import { currentOwner } from ${JSON.stringify(fileURLToPath(new URL("../src/flow/owner.ts", import.meta.url)))};
import { attachAdmission } from ${JSON.stringify(fileURLToPath(new URL("../src/sessions/admission.ts", import.meta.url)))};
import { newWorkflow, withFlowTransaction, readWorkflow, workflowPath, planJsonPath } from ${JSON.stringify(fileURLToPath(new URL("../src/flow/state.ts", import.meta.url)))};
import { writeWorkflow } from ${JSON.stringify(fileURLToPath(new URL("./commit-fixture.ts", import.meta.url)))};
import { planMdPath } from ${JSON.stringify(fileURLToPath(new URL("../src/flow/plan.ts", import.meta.url)))};
const root = process.env.LCA_ADMISSION_TEST_WORKTREE;
let admissions = 0;
const refused = new LinuxAdmissionRefused("admit", ["latched"]);
const runtimeExports = await import(${JSON.stringify(modules.runtime)});
const config = DEFAULT_CONFIG;
const deps = { client: {}, directory: root, worktree: root, config, log() {} };
const runtime = { ...runtimeExports.getOpenCodeRuntime(deps), linuxAdmission: { assertBootEpoch() {}, async admitNewExecution() { admissions++; throw refused; } } };
mock.module(${JSON.stringify(modules.runtime)}, () => ({ ...runtimeExports, getOpenCodeRuntime() { return runtime; } }));
const { createLcaFlowTool } = await import(${JSON.stringify(modules.tool)});
const sessionID = "lca-session";
const store = attachAdmission(runtime, sessionID, { engine: "opencode" });
const workflow = newWorkflow(sessionID, currentOwner(Date.now(), store.epoch), "command", "test", "opencode");
withFlowTransaction(root, tx => writeWorkflow(tx, workflow));
const before = readFileSync(workflowPath(root));
const tool = createLcaFlowTool(deps);
const ctx = { sessionID, messageID: "m", agent: "main", abort: new AbortController().signal, metadata() {} };
const valid = { goal: "g", steps: [1,2,3].map(n => ({ title: "s"+n, files: ["src/s"+n+".ts"], detail: "d", verify: "bun test test/s"+n+".test.ts" })), risks: ["r"] };
const invalid = { ...valid, steps: [{ title: "bad", files: ["x"], verify: "true" }] };
const invalidResult = await tool.execute({ op: "plan", plan: invalid }, ctx);
const invalidUnchanged = readFileSync(workflowPath(root)).equals(before);
const invalidNoFiles = !existsSync(planJsonPath(root, workflow.id)) && !existsSync(join(root, planMdPath(workflow.id)));
const validResult = await tool.execute({ op: "plan", plan: valid }, ctx);
console.log(JSON.stringify({ admissions,
  invalid: { title: invalidResult.title, output: invalidResult.output, unchanged: invalidUnchanged, noFiles: invalidNoFiles },
  valid: { title: validResult.title, output: validResult.output, unchanged: readFileSync(workflowPath(root)).equals(before), noFiles: !existsSync(planJsonPath(root, workflow.id)) && !existsSync(join(root, planMdPath(workflow.id))) },
  phase: readWorkflow(root).phase }));`, { LCA_ADMISSION_TEST_WORKTREE: root })
  expect(outcome.admissions).toBe(2)
  expect(outcome.invalid).toMatchObject({ title: "lca_flow: refused", unchanged: true, noFiles: true, output: expect.stringContaining("latched") })
  expect(outcome.valid).toMatchObject({ title: "lca_flow: refused", unchanged: true, noFiles: true, output: expect.stringContaining("latched") })
  expect(outcome.phase).toBe("planning")
})

test("admitted-plan wrapper refuses a legacy runtime before imported-plan writes", async () => {
  const runtime = {} as ExecutionRuntime
  const workflow = newWorkflow(SESSION, currentOwner(), "command", "legacy", "fixture")
  withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, workflow))
  const before = readFileSync(workflowPath(wt.worktree))
  await expect(submitAdmittedImportedPlan(runtime, workflow, plan(), { purpose: "plan-submission", sessionID: SESSION })).rejects.toThrow(TypeError)
  expect(readFileSync(workflowPath(wt.worktree))).toEqual(before)
  expect(existsSync(planJsonPath(wt.worktree, workflow.id))).toBe(false)
})

test("plan-submission admission capability is absent from dispatch, retirement, and verifier authority paths", () => {
  const forbidden = [
    "../src/orchestration/queue.ts",
    "../src/flow/review.ts",
    "../src/hosts/run-state.ts",
    "../src/orchestration/linux-verifier.ts",
    "../src/hosts/linux-domain.ts",
  ]
  for (const path of forbidden) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
    expect(source).not.toContain("PlanSubmissionAdmission")
  }
})
