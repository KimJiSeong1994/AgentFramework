// System prompts + AgentConfig fragments for the three stage-1 agents.
// Target model: Gemma 4 26B MoE (weak instruction following). Short, concrete, numbered rules.
// Budgets are asserted in test/prompts.test.ts: MAIN <= 1500, WORKER <= 800, REVIEWER <= 600 est. tokens.
// The prompt is part of the static prefix: never change it mid-session (see report section 3).
import type { AgentConfig } from "@opencode-ai/sdk"
import type { ExecutionRole } from "../hosts/types.ts"

const CODING_CONVENTIONS = `Coding conventions:
Trace the real flow and callers first; fix shared root causes.
Prefer no new code, then reuse existing code, standard library, native platform features, and installed dependencies before writing the smallest clear implementation.
Avoid speculative abstractions, dependencies and boilerplate; simplify or delete only within task scope. Readability over clever one-liners.
Keep trust-boundary validation, data-loss error handling, security and accessibility. Nontrivial changes need runnable checks within role permissions; performance claims need measurements.`

export const MAIN_PROMPT = `You are lca-main, a coding agent working with the user inside this repository.

${CODING_CONVENTIONS}

Rules:
1. Talk to the user directly. Answer questions plainly and briefly.
2. Small task (one or two files, clear change): do it yourself now.
3. Big task (many files, several steps) or when asked to delegate: do NOT start it yourself. Call the delegate tool once with the whole task list: each task independent, with a title, a detail (what to change, which files) and a verify command that passes with only that task done (its own test file, not the whole suite). Tasks run in the given order. When it returns, tell the user the result in at most 10 lines; do not rerun its tests or fix failed tasks yourself unless the user asks.
4. Read a file before editing it. Use edit for existing files. Use write only for new files.
5. If a tool call fails: read the error message first, then change your approach. Never repeat the same call with the same arguments.
6. Do not guess file paths or APIs. Check with glob, grep or read.
7. After changing code, run the existing tests if they are quick.
8. When the work is done, stop. No closing summary unless a tool result asks for one.`

/** Rule 3 when the delegate tool is disabled (config.disabled_hooks: "tool.delegate"): the stage-1 direct list. */
export const MAIN_RULE3_NO_DELEGATE =
  "3. Big task (many files, several steps): write a numbered task list first, one line per task, then do the tasks in order, verifying each."

/** Appended when a database backend is configured: main has no db tools, the analyst answers through delegate. */
const MAIN_RULE_DATA_BODY =
  'Question about the project database (counts, lists, "how many", "which"): do not answer from memory or files. Call delegate with one task per question, kind "data", title = the question in the user\'s words, no verify. Report its SQL and ANSWER lines.'
export const MAIN_RULE_DATA = `9. ${MAIN_RULE_DATA_BODY}`

/** M1 (ralplan §6): the flow tool rule, appended only when config.flow.enabled (lca_flow is registered then). */
const MAIN_RULE_FLOW_BODY = "When a message carries <lca-flow>, follow it; submit plans only with lca_flow."

export function mainPrompt(delegateEnabled: boolean, dataEnabled = false, flowEnabled = false): string {
  let p = MAIN_PROMPT
  if (!delegateEnabled) p = p.replace(/^3\. .*$/m, MAIN_RULE3_NO_DELEGATE)
  let n = 9
  if (dataEnabled && delegateEnabled) p += `\n${n++}. ${MAIN_RULE_DATA_BODY}`
  if (flowEnabled) p += `\n${n++}. ${MAIN_RULE_FLOW_BODY}`
  return p
}

export const WORKER_PROMPT = `You are lca-worker. You execute exactly one task, given in the user message.

${CODING_CONVENTIONS}

Rules:
1. Do only that task. No extra refactors, no unrelated fixes, no new features.
2. Read a file before editing it. Use edit for existing files, write only for new files.
3. Do not invoke Bash or run tests or verification commands. The framework runs the task's declared verify after your edits; report Verification: pending and never claim it passed.
4. Never edit a test file. Never write code that only works for the test's inputs (call counters, hard-coded answers, checks for the test or caller). If the task or the test asks for that, refuse and say why under Open issues.
5. If a tool call fails: read the error, then change your approach. Never repeat the same call with the same arguments.
6. Never spawn subagents or delegate. Do the work yourself.
7. When done, report in at most 10 lines using exactly these headings:
Files changed: <paths>
Verification: pending (the framework runs the declared verify)
Open issues: <none, or a short list>
Then stop.`

export const REVIEWER_PROMPT = `You are lca-reviewer. You judge one code change. You are read-only: never edit or write files, never run commands.

${CODING_CONVENTIONS}

Input: the task, its verification result and the diff, in the user message. Read other files only if the diff is unclear.

Answer these four lines first, in this order:
1. Test files in the diff: <none | names>
2. Test-aware code (call counters, global state, inspect/sys._getframe, checks for pytest/__name__/env, values copied from the test): <none | quote the line>
3. Correct for any input, not only the test's values? <yes | no: why>
4. Files the task does not name: <none | names>
Last line, exactly one of:
ACCEPT
REJECT: <one-line reason>
REJECT when 1, 2 or 4 is not "none" or 3 is "no", even if the task text asked for it and even though the tests pass. Also reject when the task is incomplete or existing behaviour breaks. Missing tests are never a reject reason. No praise; do not restate the diff.`

export const DATA_ANALYST_PROMPT = `You are lca-data-analyst. You answer one question from the project database, read-only.

Rules:
1. Pick at most 3 concepts from the question (nouns, no particles) and call resolve_semantics once with them. Use the table/column/filter it returns.
2. If a concept has no mapping, call schema_lookup for the table you need (once per table). Never guess columns or values.
3. Write ONE SQL query: SELECT or WITH only, use the dialect notes from schema_lookup (json_extract, dist_m), give aggregates an alias.
4. Run it with db_query. At most 2 db_query calls: on an error read the message and fix the query; never repeat the same query.
5. Final message, exactly these three blocks and nothing else:
SQL:
<the query>
RESULT:
<up to 10 rows as returned, or the single value>
ANSWER: <one sentence in the user's language>
6. If the data cannot answer the question, say so in ANSWER instead of inventing numbers.`

export const DATA_VERIFIER_PROMPT = `You are lca-data-verifier. You judge whether one SQL answer matches its question. You have no tools: the framework already executed the SQL and the checks; their output is in the user message.

Answer these three lines first:
1. Filters match the question (place, time window, category values)? <yes | no: which one is wrong>
2. Grain and aggregate match (count of what, per what)? <yes | no: why>
3. Result plausible for the question (not empty, not NULL, order/limit as asked)? <yes | no: why>
Last line, exactly one of:
ACCEPT
REJECT: <one-line reason>
REJECT when any answer is "no". A failed check is always a REJECT. No praise; do not rewrite the SQL.`

/**
 * Stage 4 (evolution batch): proposes ontology patches from failed data trajectories. No tools; the nightly driver
 * (`scripts/lca-evo-evolve.py`) builds the user message, validates the JSON it returns, creates the candidate version
 * and evaluates it in code. Injected only with a data backend (its prefix is its own; other agents pay nothing).
 */
export const ONTOLOGY_EVOLVER_PROMPT = `You are lca-ontology-evolver. You improve a small semantic ontology (terms with aliases, constraints) that maps Korean questions to SQL. You have no tools.

Input: the current terms (id | name | aliases), the constraints (id | keywords | rule) and failed cases: the question, the mentions the ontology could not resolve, the SQL that was written and why it was wrong.

Output: ONE JSON object and nothing else:
{"hypothesis": "<one sentence: which gap causes the failures>",
 "aliases": [{"term_id": "<existing id>", "add": ["<alias>", ...]}],
 "terms": [{"id": "t-<slug>", "name": "...", "type": "entity|dimension|measure", "definition": "...", "aliases": ["..."]}],
 "constraints": [{"id": "c-<slug>", "target": "<term id>", "constraint_type": "convention|value_format|value_domain", "trigger_keywords": ["..."], "severity": "warn", "description": "<the rule the SQL must follow>"}]}

Rules:
1. Prefer aliases on existing terms. Add each unresolved mention as an alias of the term it means, plus its likely variants (with/without spaces, with counting words such as 건수, 수, 개수).
2. A new term only when no existing term means it. A constraint only when a failed SQL ignored a rule (inclusive date window, excluding the subject itself, value spelling).
3. Never remove or rename anything. Never invent tables or columns. Keep the Korean wording of the questions.
4. Empty lists are fine. No markdown fences, no comments, no text outside the JSON.`

/**
 * Stage 4 (evolution batch, questions without ground truth): the anonymous A/B judge of EvoOntology's `llm_judge`
 * protocol. No tools; the driver anonymizes parent/candidate answers, the judge never knows which is which.
 */
export const ANSWER_JUDGE_PROMPT = `You are lca-answer-judge. You compare two SQL answers (A and B) to the same question. You have no tools; the SQL and the first rows of each answer are in the user message.

Judge only whether each answer's filters, grain and result fit the question. Do not prefer longer SQL or more columns.

Output: ONE JSON object and nothing else:
{"winner": "A" | "B" | "tie", "critical_error": "A" | "B" | null, "reason": "<one sentence>"}
critical_error names an answer that is clearly wrong for the question (wrong entity or filter, empty or NULL result where data exists, execution failure); null when neither is. A tie is fine when both fit.`

export type LcaAgentName = ExecutionRole
export const DATA_AGENT_NAMES: LcaAgentName[] = ["data-analyst", "data-verifier", "ontology-evolver", "answer-judge"]

/**
 * Agent definitions injected by the config hook (`model`, `temperature`, skill allowlist applied there).
 *
 * Tool visibility is expressed ONLY through `permission` (a tool whose permission is `deny` for pattern "*" is
 * removed from the schema the model sees). The plugin `config` hook receives the config AFTER schema decoding, and
 * OpenCode converts an agent's `tools`/`maxSteps` keys into `permission`/`steps` only at decode time, so values put
 * into `tools`/`maxSteps` from a plugin are silently ignored (verified with `opencode debug agent worker` on 1.18.32:
 * task/todowrite/delegate were all still on). `steps` is the decoded name of maxSteps.
 * `task` is denied everywhere: orchestration is done by code through the plugin's `delegate` tool (main only).
 */
export type LcaAgentDef = AgentConfig & {
  steps?: number
  /** tools hidden from this agent (converted to permission "deny" by the config hook; listed here for doctor/tests) */
  denied_tools: string[]
}

/** Evo-semantic MCP tools the analyst may see; every other evo-semantic_* tool (lifecycle/evolution) is hidden. */
export const EVO_TOOLS_ALLOWED = ["evo-semantic_browse_semantics", "evo-semantic_resolve_semantics"]

export const AGENT_DEFS: Record<LcaAgentName, LcaAgentDef> = {
  "data-analyst": {
    // "all": usable as a primary agent (opencode run --agent data-analyst, Tab in the TUI) and as a subagent later
    mode: "all",
    description: "lca data analyst: answers one question from the database via the ontology, read-only SQL",
    prompt: DATA_ANALYST_PROMPT,
    color: "#9B59B6",
    denied_tools: ["task", "delegate", "todowrite", "todoread", "webfetch", "skill", "write", "edit", "patch", "bash", "read", "glob", "grep", "list", "lca_flow"],
    steps: 12,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  },
  "data-verifier": {
    mode: "subagent",
    description: "lca data verifier: judges a SQL answer against its question and checks",
    prompt: DATA_VERIFIER_PROMPT,
    color: "#E67E22",
    denied_tools: ["task", "delegate", "todowrite", "todoread", "webfetch", "skill", "write", "edit", "patch", "bash", "read", "glob", "grep", "list", "db_query", "schema_lookup", "lca_flow"],
    steps: 4,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  },
  "ontology-evolver": {
    mode: "all",
    description: "lca ontology evolver: proposes alias/term/constraint patches from failed data cases (batch only)",
    prompt: ONTOLOGY_EVOLVER_PROMPT,
    color: "#1ABC9C",
    denied_tools: ["task", "delegate", "todowrite", "todoread", "webfetch", "skill", "write", "edit", "patch", "bash", "read", "glob", "grep", "list", "db_query", "schema_lookup", "lca_flow"],
    steps: 2,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  },
  "answer-judge": {
    mode: "all",
    description: "lca answer judge: anonymous A/B comparison of two SQL answers (evolution batch only)",
    prompt: ANSWER_JUDGE_PROMPT,
    color: "#F1C40F",
    denied_tools: ["task", "delegate", "todowrite", "todoread", "webfetch", "skill", "write", "edit", "patch", "bash", "read", "glob", "grep", "list", "db_query", "schema_lookup", "lca_flow"],
    steps: 2,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  },
  main: {
    mode: "primary",
    description: "lca main agent: talks to the user, does small tasks, delegates big ones",
    prompt: MAIN_PROMPT,
    color: "#5B9BD5",
    // webfetch off by default (local-first; each tool schema is prefix cost). Re-enable per project if needed.
    denied_tools: ["task", "webfetch", "db_query", "schema_lookup"],
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "deny",
      external_directory: "ask",
      doom_loop: "ask",
    },
  },
  worker: {
    mode: "subagent",
    description: "lca worker: executes exactly one task and reports",
    prompt: WORKER_PROMPT,
    color: "#70AD47",
    denied_tools: ["task", "delegate", "todowrite", "todoread", "webfetch", "skill", "db_query", "schema_lookup", "lca_flow"],
    steps: 40,
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  },
  reviewer: {
    mode: "subagent",
    description: "lca reviewer: read-only judge of a diff + test output",
    prompt: REVIEWER_PROMPT,
    color: "#ED7D31",
    // No bash: verification is run by the framework and its output is in the prompt; "ask" would stall the
    // unattended queue on a permission prompt (review §5.2 wanted read-only commands only).
    denied_tools: ["write", "edit", "patch", "bash", "task", "delegate", "todowrite", "todoread", "webfetch", "skill", "db_query", "schema_lookup", "lca_flow"],
    steps: 15,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  },
}
