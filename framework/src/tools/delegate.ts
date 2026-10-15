// `delegate` tool (main only): append tasks to the session ledger and run the serial worker queue inside this tool
// call. Main's turn blocks until the queue is empty (same shape as OpenCode's built-in task tool, one call for the
// whole list). `resume: true` re-runs open tasks left by an interrupted run instead of adding new ones.
// The description + schema are part of main's static prefix: keep them short and never change them mid-session.
// Cost measured with estimateToolSchemaTokens in test/delegate-tool.test.ts.
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HookDeps } from "../hooks/types.ts"
import { verifyCommandProblem } from "../config.ts"
import { suiteProblem } from "../data/check.ts"
import { taskTextProblem } from "../orchestration/gaming.ts"
import { getQueue } from "../orchestration/queue.ts"
import { getOpenCodeRuntime } from "../hosts/opencode-runtime.ts"
import { LinuxAdmissionRefused } from "../hosts/types.ts"
import { openTasks, protectedFiles, readLedger, summarizeLedger } from "../state/ledger.ts"
import { clearAbort, readAbort } from "../state/store.ts"
import { MAIN_AGENT } from "../hooks/tool-before.ts"
import { activeWorkflow, readWorkflow, workflowEngineRefusal } from "../flow/state.ts"

export const DELEGATE_DESCRIPTION =
  "Run coding tasks one after another in isolated worker sessions and get one report back. Use it for work with " +
  "several steps or many files; call it once with the whole list (at most 12, run in the given order). Each task: " +
  "a one-line title, a detail (what to change, which files), and a verify command that exits 0 when THIS task alone " +
  "is done (its own test file, never the whole suite, never true/echo/ls). " +
  "A database question is a task with kind \"data\": title = the question, no verify."

export const MAX_TASKS = 12

const z = tool.schema

export const delegateArgs = {
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200).describe("one line, what the task delivers"),
        detail: z.string().max(2000).optional().describe("what to change and in which files"),
        verify: z.string().max(300).optional().describe("test command for this task only, e.g. python3 -m pytest -q test_x.py"),
        kind: z.enum(["code", "data"]).optional().describe("data: answer the question in title from the database"),
      }),
    )
    .max(MAX_TASKS)
    .optional(),
  resume: z.boolean().optional().describe("true: run the unfinished tasks of an interrupted run instead of adding tasks"),
}

function taggedWorkflowRefusal(deps: HookDeps, engine: unknown, tasks: Array<{ wf?: { id: string } }>): string | undefined {
  const workflowIDs = new Set(tasks.flatMap((task) => task.wf ? [task.wf.id] : []))
  if (workflowIDs.size === 0) return undefined
  const workflow = readWorkflow(deps.worktree)
  if (!workflow || [...workflowIDs].some((id) => id !== workflow.id)) return "workflow identity unavailable; recovery refused"
  return workflowEngineRefusal(workflow, engine)
}

export function createDelegateTool(deps: HookDeps): ToolDefinition {
  const runtime = getOpenCodeRuntime(deps)
  const queue = getQueue(runtime)
  return tool({
    description: DELEGATE_DESCRIPTION,
    args: delegateArgs,
    async execute(args, ctx) {
      if (ctx.agent && ctx.agent !== MAIN_AGENT) {
        throw new Error(`lca: delegate is only available to the ${MAIN_AGENT} agent (current agent: ${ctx.agent}). Do the work directly.`)
      }
      runtime.linuxAdmission?.assertBootEpoch()
      const sessionID = ctx.sessionID
      if (ctx.abort.aborted) throw new Error("lca: aborted before the task queue started")
      if (queue.isRunning(sessionID)) {
        throw new Error("lca: a task queue is already running for this session. Wait for its report; do not call delegate again.")
      }
      // A user's /stop stays in force until the user sends a new message (chat.message clears it); a model reacting
      // to the /stop text must not restart the queue.
      if (readAbort(deps.worktree, sessionID)?.reason === "user_stop") {
        throw new Error("lca: the user stopped the task queue (/stop). Do not call delegate again until the user asks for more work.")
      }
      const active = activeWorkflow(deps.worktree)
      if (active?.sessionID === sessionID) {
        const refusal = workflowEngineRefusal(active, runtime.host.identity.engine)
        if (refusal) throw new Error(`lca: ${refusal}`)
        if (active.stopIntent || active.phase === "paused") {
          throw new Error(`lca: the workflow is ${active.stopIntent ? `${active.stopIntent.kind} pending` : "paused"}; do not call delegate.`)
        }
      }

      const tasks = args.tasks ?? []
      const notes: string[] = []
      let taskIds: string[]
      // A model that re-sends the same list after an interruption means "resume", not "start over" (live review E2a).
      const ledgerNow = readLedger(deps.worktree, sessionID)
      const open = openTasks(ledgerNow)
      const workflowRefusal = taggedWorkflowRefusal(deps, runtime.host.identity.engine, open)
      if (workflowRefusal) throw new Error(`lca: ${workflowRefusal}`)
      if (clearAbort(deps.worktree, sessionID, { keepUserStop: true })) deps.log("delegate: cleared stale abort marker", { sessionID })
      let resume = !!args.resume
      const norm = (s: string) => s.trim().toLowerCase()
      const known = new Set(ledgerNow.tasks.map((t) => norm(t.title)))
      if (!resume && tasks.length && open.length && tasks.every((t) => known.has(norm(t.title))) && open.every((o) => tasks.some((t) => norm(t.title) === norm(o.title)))) {
        resume = true
        notes.push(`The task list matched the ${open.length} unfinished task(s) of the interrupted run, so they were resumed instead of restarted.`)
      }
      if (resume) {
        if (open.length === 0) throw new Error("lca: nothing to resume — the ledger has no unfinished tasks. Call delegate with tasks instead.")
        if (args.resume && tasks.length) notes.push(`${tasks.length} new task(s) were ignored because resume was requested; call delegate again with them afterwards.`)
        taskIds = open.map((t) => t.id)
      } else {
        if (tasks.length === 0) throw new Error("lca: give at least one task, or resume: true.")
        const dataOn = deps.config.data.backend !== "none"
        const problems = tasks.map((t) => {
          if (t.kind === "data") {
            if (!dataOn) return "no database is configured in this project (data.backend is none); answer without the database"
            return t.verify ? suiteProblem(deps.worktree, deps.config.data.checks_dir, t.verify) : null
          }
          return t.verify ? verifyCommandProblem(t.verify, deps.config.delegate.verify_allow) : null
        })
        if (problems.some(Boolean)) {
          const lines = tasks.flatMap((t, i) => (problems[i] ? [`- task ${i + 1} "${t.title.slice(0, 40)}": ${problems[i]}`] : []))
          throw new Error(`lca: tasks refused (verify commands run without confirmation, so only test/check runners are allowed; data tasks need a configured database):\n${lines.join("\n")}\nFix them and call delegate again with the whole list.`)
        }
        // Tasks that instruct the worker to edit tests or fake results are refused (the hack in the negative e2e was
        // authored by main and passed down as task detail).
        const gaming = tasks.map((t) => (t.kind === "data" ? null : taskTextProblem(t.title, t.detail, protectedFiles(t))))
        if (gaming.some(Boolean)) {
          const lines = tasks.flatMap((t, i) => (gaming[i] ? [`- task ${i + 1} "${t.title.slice(0, 40)}": ${gaming[i]}`] : []))
          throw new Error(`lca: tasks refused:\n${lines.join("\n")}\nWorkers implement code honestly and never edit tests. If a test looks impossible, delegate the honest implementation and let its verify fail; the report will say so.`)
        }
        // Open tasks from an earlier, interrupted run would otherwise be executed silently before the new ones.
        const stale = queue.cancelOpen(sessionID, "superseded by a new delegate call")
        if (stale.length) notes.push(`${stale.length} unfinished task(s) from an earlier run were cancelled (superseded).`)
        taskIds = queue.add(sessionID, tasks).map((t) => t.id)
      }
      // ctx.metadata is a no-op for plugin tools on 1.18.32 (not bridged); harmless, kept for newer versions.
      ctx.metadata({ title: `delegate: ${taskIds.length} task(s)`, metadata: { taskIds } })
      const onAbort = () => void queue.abort(sessionID, "main session aborted")
      ctx.abort.addEventListener("abort", onAbort)
      try {
        const runPromise = queue.run(sessionID, { messageID: ctx.messageID, resumed: args.resume === true })
        if (ctx.abort.aborted) onAbort() // aborted between the check above and run(): the entry now exists
        const run = await runPromise
        if (run.refused) throw new LinuxAdmissionRefused(run.refused.phase, run.refused.reasons)
        const ledger = readLedger(deps.worktree, sessionID)
        if (run.noSnapshot && ledger.tasks.some((t) => taskIds.includes(t.id) && t.kind !== "data")) notes.push("This directory is not a git repository: the reviewer and the protected-file guard were unavailable, only the verify commands were checked.")
        const closing = "Report this result to the user now, in at most 10 lines. Do not rerun the tests or fix failed tasks yourself unless the user asks."
        const output = summarizeLedger(ledger, taskIds, { note: [...notes, closing].join(" ") })
        return {
          title: `delegate: ${run.done}/${taskIds.length} done${run.failed ? `, ${run.failed} failed` : ""}${run.aborted ? ` (aborted: ${run.abortReason ?? ""})` : ""}`,
          output,
          metadata: { taskIds, done: run.done, failed: run.failed, cancelled: run.cancelled, aborted: run.aborted },
        }
      } finally {
        ctx.abort.removeEventListener("abort", onAbort)
      }
    },
  })
}
