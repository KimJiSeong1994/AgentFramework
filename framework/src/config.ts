// otter configuration: user (~/.config/otter/otter.jsonc) -> project (<worktree>/.otter/otter.jsonc), project wins per key.
// Contract owned by the scaffold. Fill-in lives here; other modules only import the types + loadConfig.
import { lstatSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse as parseJsonWithComments, type ParseError } from "jsonc-parser"

export type Mode = "none" | "ulw" | "plan" | "data"

/** Ollama retention: inherit is represented by omission/null in config, not by a CLI value. */
export function isLocalKeepAlive(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value === "-1" || value === "0") return true
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value)
  if (!match) return false
  const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1)
  return Number.isSafeInteger(seconds) && seconds <= 24 * 60 * 60
}

/** Otter's estimated local input budget; does not change the model server's context window. */
export function localContextInputTokens(config: Pick<OtterConfig, "local_model">): number {
  return config.local_model?.context_input_tokens ?? 8192
}

/** Retained percentage after local context overflow; leaves room before the next batch trim. */
export function localContextTrimTargetPercent(config: Pick<OtterConfig, "local_model">): number {
  return config.local_model?.context_trim_target_percent ?? 70
}

export type ModelSelection = { providerID: string; modelID: string }

/** Parse OpenCode's provider/model selector without silently accepting an empty or ambiguous component. */
export function parseModelSelection(value: string): ModelSelection {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`Invalid model selection ${JSON.stringify(value)}; expected provider/model`)
  }
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid model selection ${JSON.stringify(value)}; expected provider/model`)
  }
  const providerID = value.slice(0, slash)
  const modelID = value.slice(slash + 1)
  if (/[\\\s]/.test(providerID) || /[\\\s]/.test(modelID)) {
    throw new Error(`Invalid model selection ${JSON.stringify(value)}; provider and model IDs cannot contain whitespace or backslashes`)
  }
  return { providerID, modelID }
}

/** Reject an explicit selection that disagrees with the host's resolved provider/model identity. */
export function assertModelSelectionMatches(selection: ModelSelection, providerID: string, modelID: string): void {
  if (selection.providerID !== providerID || selection.modelID !== modelID) {
    throw new Error(`Configured model ${selection.providerID}/${selection.modelID} conflicts with resolved model ${providerID}/${modelID}`)
  }
}

/** Output budget after applying the role ceiling, caller/host limit, and trusted finite model limit. */
export function effectiveOutputLimit(roleLimit: number, hostLimit: number | undefined, modelLimit: number | undefined): number {
  for (const [name, limit] of [["role", roleLimit], ["host", hostLimit], ["model", modelLimit]] as const) {
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) {
      throw new Error(`Invalid ${name} output limit: ${limit}`)
    }
  }
  const limits = [roleLimit, hostLimit, modelLimit].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
  return Math.min(...limits)
}

/** Temperature is only forced for known local providers; cloud provider support is not assumed. */
export function supportsLocalTemperature(providerID: string): boolean {
  return /^(ollama|local)(?:[-_].*)?$/i.test(providerID)
}

/** Shell control characters a verify command may never contain (`&&` is allowed; a lone `&`, `|`, `;`, `$`, backtick, `<`, `>` are not). */
export const VERIFY_DENY_RE = /[|;$`<>]|(?<!&)&(?!&)|[\r\n\t]/
/** Runner options that load code/config from files the worker may have written (pytest -p/-c/-o/--rootdir, npm -C, ...). */
export const VERIFY_DENY_OPTION_RE = /(^|\s)(-p|-c|-o|-C|--rootdir|--config-file|--override-ini|--import-mode|--preload|--require|-r|--prefix|--userconfig)(\s|=|$)/
/** A TypeScript type check (`tsc`, `npx tsc`, `bunx tsc`, `bun x tsc`, ...). */
const TSC_SEGMENT_RE = /^(?:(?:npx|bunx|pnpm dlx|(?:bun|npm|pnpm|yarn) x)\s+)?tsc(?:\s|$)/
/**
 * tsc's `-p`/`--project` names which project to check; it loads compiler options, not executable code. It is allowed
 * only with a relative path inside the worktree (no `..`, not absolute), and tsconfig files are protected like the
 * test runners' config (AUTOLOAD_PROTECTED), so a worker cannot weaken the check it is verified by.
 */
const TSC_PROJECT_RE = /(^|\s)(?:-p|--project)(?:\s+|=)((?!\/)(?!-)(?!(?:[^\s]*\/)?\.\.(?:\/|\s|$))[A-Za-z0-9_.\/-]+)(?=\s|$)/g
/** A `cd` segment may only descend into the worktree: no `..` segment, no absolute path, no option-looking argument. */
export const VERIFY_CD_RE = /^cd (?!\/)(?!-)(?!(?:[^\s]*\/)?\.\.(?:\/|$))[A-Za-z0-9_.\/-]+$/

/**
 * Files the test runners load implicitly (config, plugins, hooks). A worker may not change them unless the task's own
 * text names them: otherwise `conftest.py` skipping every test or a `Makefile` with an empty `test:` target passes
 * verify without touching the protected test file (stage-2 second review, S1).
 */
export const AUTOLOAD_PROTECTED = [
  "conftest.py", "pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml", "sitecustomize.py", "usercustomize.py", "*.pth",
  "Makefile", "makefile", "GNUmakefile", "package.json", "bunfig.toml", ".npmrc", "jest.config.*", "vitest.config.*",
  ".gitattributes", "go.mod", "Cargo.toml", "build.rs", "tsconfig.json", "tsconfig.*.json",
]

/** Why a verify command is refused, or null when it may run. Trivial always-pass commands are refused too. */
export function verifyCommandProblem(command: string, allow: string[]): string | null {
  const c = command.trim()
  if (!c) return "empty"
  if (VERIFY_DENY_RE.test(c)) return "contains a shell control character (| ; & $ ` < > or a newline); use a single test command, && is allowed"
  if (/^(true|false|echo|ls|cat|exit|test)\b|^[:[]/.test(c)) return "trivial command that proves nothing; use the task's test command"
  let runners = 0
  for (const part of c.split("&&")) {
    const seg = part.trim()
    if (/^cd\b/.test(seg)) {
      if (!VERIFY_CD_RE.test(seg)) return `cd must stay inside the project (no .., no absolute path): "${seg.slice(0, 60)}"`
      continue
    }
    // A tsc project path is checked on its own; every other option on every runner goes through the deny list.
    const checked = TSC_SEGMENT_RE.test(seg) ? seg.replace(TSC_PROJECT_RE, "$1") : seg
    const denied = VERIFY_DENY_OPTION_RE.exec(checked)
    if (denied) {
      const option = denied[2]
      return TSC_SEGMENT_RE.test(seg) && (option === "-p")
        ? "tsc -p/--project must name a relative path inside the project (no .., not absolute)"
        : `uses a runner option that loads plugins/config from the repository (${option}); drop it`
    }
    if (!allow.some((re) => new RegExp(re).test(seg))) return `not a recognised test/check runner: "${seg.slice(0, 60)}" (allowed: pytest, unittest, bun/npm test, go/cargo test, make test, *test*.sh ...)`
    runners++
  }
  if (runners === 0) return "no test/check runner in the command (cd alone proves nothing)"
  return null
}

export type OtterConfig = {
  /** Ollama model residency after a request; absent/null inherits the server default. */
  local_model?: { keep_alive?: string | null; context_input_tokens?: number | null; context_trim_target_percent?: number | null }
  /** hook ids to disable, e.g. ["guard.repeat", "mode.detect"] */
  disabled_hooks: string[]
  /** prefix budgets in estimated tokens; doctor/tests assert these */
  budget: { main: number; worker: number; reviewer: number }
  guards: {
    /** identical (tool,args) calls allowed per session before the call is blocked */
    repeat_limit: number
    /** read/glob/grep/bash output trimming: lines, bytes and (estimated) tokens — the token cap is what protects
     *  the prefill budget; long absolute paths tokenize at ~2 chars/token so bytes alone under-count. */
    read_max_lines: number
    read_max_bytes: number
    read_max_tokens: number
    /** strip the worktree/directory prefix from tool outputs (glob/grep/list/read/bash) before the model sees them */
    relativize_paths: boolean
    /** abort the session when the assistant text repeats an n-gram this many times */
    repetition_ngram: number
    repetition_count: number
    abort_on_repetition: boolean
  }
  loop: {
    max_iterations: number
    ttl_ms: number
    stagnation: number
    failures: number
    compaction_guard_ms: number
  }
  /** Interactive `otter` chat. `default_model` is the persisted startup selection (`/model default` writes it). */
  chat: {
    default_model?: { engine: string; model: string } | null
    /** Per-role engine/model routes (role -> {engine, model}); applied to new sessions only. A null role removes a user route. */
    combo?: Record<string, { engine: string; model: string } | null> | null
    /**
     * CLI intent routing. Unset means "offer" (see `chatIntentMode`); it stays unset in DEFAULT_CONFIG because `chat` is
     * carried by the runtime and compared against the frozen policy baseline.
     */
    intent?: "offer" | "off"
    /**
     * CLI run isolation. Unset means "plan" (see `chatWorktreeMode`): an approved plan runs in ONE linked worktree and
     * reaches the checkout only through an explicit Apply. "off" runs in the checkout. Unset in DEFAULT_CONFIG for the same
     * policy-baseline reason as `intent`; `delegate.worktree` (per-task, auto-merge) is a separate, unchanged switch.
     */
    worktree?: "plan" | "off"
    /**
     * What the chat model may do itself. Unset means "ask" (see `chatExecuteMode`): it may edit/write files in the
     * worktree and run commands, each only after a local human approval; "auto-edit" applies file edits without asking
     * (commands still ask); "plan" keeps it read-only (execution only through /plan). Unset in DEFAULT_CONFIG for the
     * same policy-baseline reason as `intent`; the main role's tool set (and so its policy identity) follows the mode.
     */
    execute?: "ask" | "auto-edit" | "plan"
    /** Command prefixes the user chose "Always allow" for. Read from the user config only; a project value is ignored. */
    allow?: string[]
  }
  models: {
    /** provider/model ids; undefined = inherit OpenCode default */
    main?: string
    worker?: string
    reviewer?: string
    "data-analyst"?: string
    "data-verifier"?: string
    "ontology-evolver"?: string
    "answer-judge"?: string
  }
  /** max output tokens per agent role (data agents fall back to the worker cap when unset) */
  max_output: { main: number; worker: number; reviewer: number; "data-analyst"?: number; "data-verifier"?: number; "ontology-evolver"?: number; "answer-judge"?: number }
  /**
   * Skills the main agent may see. OpenCode auto-discovers skills from ~/.claude/skills, ~/.agents/skills,
   * .opencode/skills etc. and puts every description into the skill tool's schema (measured: 13 skills = ~2K
   * prefix tokens). Everything not listed here is denied via the agent's permission.skill, which hides it.
   */
  skills: { allow: string[] }
  /**
   * Plan workflow (harness M0/M1): code-owned phase state, a read-only planning boundary, user-only approval.
   * Caps: invalid plan submissions before stuck, reviewer iterations before pending_approval, idle nudges before stuck.
   */
  flow: {
    enabled: boolean
    max_code_invalid: number
    max_review_iterations: number
    nudge_max: number
    review_max_tool_calls: number
  }
  /** Observation requires an explicitly activated durable campaign; config alone never creates a budget. */
  skill_observation: {
    enabled: boolean
    campaign_id?: string
    owner_root?: string
    owner_binding?: string
  }
  /** Optional per-turn advice, never execution authorization. Only project-local skills are considered. */
  skill_router: {
    mode: "off" | "shadow" | "suggest"
    /** OpenJev server for skill routing when `memory.engine` is `jev`; unused with the Claude/Codex CLI engines. */
    endpoint: string
    /** OpenJev request budget; a Claude/Codex CLI judgment uses `min(memory.timeout_ms, 15 s)`. */
    timeout_ms: number
    min_probability: number
    min_margin: number
  }
  /**
   * Agent memory recall (`memory` tool): an inference engine links the request to knowledge/wiki pages listed in
   * the wiki index. `auto` (default) uses the Claude CLI when it is on PATH, else the Codex CLI, so no local model
   * server is needed; `claude`/`codex`/`local` pin that CLI (run tool-free through the Otter CLI transport);
   * `jev` is the local OpenJev server at `endpoint`. claude/codex send the request text and the index titles to that
   * vendor. Recall output is reference data, never instructions or authorization. Validated at use, read per call.
   */
  memory: {
    engine: "auto" | "claude" | "codex" | "local" | "jev" | "off"
    /**
     * Native model ID for claude/codex/local. Unset claude/codex (and auto) use the built-in memory defaults
     * (claude-haiku-5-5, gpt-5.6-luna); local requires it; jev and off ignore it.
     */
    model?: string
    endpoint: string
    timeout_ms: number
    /** a page is linked only when its probability is at least this and above the `none` probability */
    min_probability: number
    max_pages: number
    /**
     * Start recall when a user turn reaches main, in parallel with the model's first step; the first memory call of
     * the turn consumes it. Costs one inference per main turn (also turns that never call memory). Default off.
     */
    prefetch?: boolean
  }
  /** Stage 2: serial worker delegation (delegate tool + idle-loop resume). */
  delegate: {
    /** Explicit verifier selection; Linux admission never falls back to the legacy executor. */
    verifier: "legacy-unowned" | "linux-single-use"
    /** run the reviewer child session on each task's diff + verify output */
    review: boolean
    /**
     * Code tasks run in a linked git worktree under the state root (worker + verify bound to it); the task's diff is
     * applied to the main worktree only when the task is accepted (`git apply --check` first; a patch that no longer
     * applies marks the task blocked and stays in .otter/handoffs). Needs a repository with at least one commit.
     */
    worktree: boolean
    /**
     * false (default): a REJECT on a task whose verify command passed is advisory after the last attempt (task = done,
     * summary shows the reason); an unparseable verdict never fails a task. true: REJECT/no-verdict on the last
     * attempt marks the task failed even when verify passed.
     */
    review_strict: boolean
    /** worker attempts per task; a failed verify or a REJECT re-runs the worker once with the reason */
    max_attempts: number
    /** wall-clock cap for one worker session run */
    task_ttl_ms: number
    /** wall-clock cap for one reviewer session run */
    review_ttl_ms: number
    /** wall-clock cap for a whole queue run (all tasks); remaining tasks are cancelled when exceeded */
    queue_ttl_ms: number
    /** cap for the task's `verify` shell command */
    verify_timeout_ms: number
    /** chars of "previous tasks" context prepended to the next worker prompt (handoff summary) */
    handoff_context_chars: number
    /** chars of the worker's final report kept in the ledger / handoff file / tool result */
    report_max_chars: number
    /** maximum complete task diff for scanning/review; truncation fails the attempt before verification */
    diff_max_chars: number
    /** chars of verify output kept (tail) */
    verify_output_chars: number
    /** path globs never counted as task changes (git pathspec globs, matched at any depth); .otter/state and .otter/handoffs are always excluded */
    diff_exclude: string[]
    /**
     * Regexes (case-sensitive, tested against the trimmed command) at least one of which a task's `verify` command must
     * match. The model authors these commands and they run without a permission prompt, so only recognised test
     * runners/checkers are allowed; anything else is refused at delegate time (the model gets told) and never runs.
     * Shell control characters | ; & (except &&) $ ` < > are always refused (VERIFY_DENY_RE).
     */
    verify_allow: string[]
  }
  /**
   * Stage 3 data layer: read-only SQL access (`db_query`), a static schema description (`schema_lookup`) and the
   * EvoOntology semantic MCP (`evo-semantic`, only browse/resolve exposed) for the `data-analyst` agent.
   * `backend: "none"` (default) registers nothing, so the prefix of every other agent is untouched.
   */
  data: {
    backend: "none" | "sqlite" | "postgres"
    /** directory of data-task check suites (`<suite>.json`, SQL assertions over the answer query); `default` is built in */
    checks_dir: string
    /** sqlite file, relative to the worktree unless absolute; opened read-only */
    sqlite_path: string
    /** JSON produced by scripts/otter-schema-extract.py (or by hand): { dialect, notes, tables: {...} }; relative to the worktree */
    schema_file: string
    /** postgres: the DSN is read ONLY from this environment variable (never from config/logs) */
    pg_dsn_env: string
    /** postgres: refuse hosts other than loopback unless true (the handover DB is a production superuser account) */
    pg_allow_remote: boolean
    psql_path: string
    /** result trimming for db_query */
    max_rows: number
    max_cell_chars: number
    max_output_tokens: number
    statement_timeout_ms: number
    /** cap on db_query calls per session (the analyst prompt says 2; this is the hard stop) */
    max_queries_per_session: number
    evo: {
      enabled: boolean
      /** EvoOntology workspace (contains active.json + versions/), relative to the worktree unless absolute */
      workspace: string
      python: string
      /** path to evoontology/runtime/mcp_server.py; empty = the vendored copy under framework/vendor */
      server: string
    }
  }
}

export const DATA_DEFAULTS: OtterConfig["data"] = {
  backend: "none",
  checks_dir: "data/checks",
  sqlite_path: "data/app.sqlite",
  schema_file: "data/schema.json",
  pg_dsn_env: "OTTER_PG_DSN",
  pg_allow_remote: false,
  psql_path: "psql",
  max_rows: 50,
  max_cell_chars: 80,
  max_output_tokens: 1500,
  statement_timeout_ms: 15_000,
  max_queries_per_session: 6,
  evo: { enabled: true, workspace: ".evoontology", python: "python3", server: "" },
}

export const DEFAULT_CONFIG: OtterConfig = {
  disabled_hooks: [],
  chat: {},
  budget: { main: 8000, worker: 5000, reviewer: 3000 },
  guards: {
    repeat_limit: 2,
    read_max_lines: 200,
    read_max_bytes: 20000,
    read_max_tokens: 2500,
    relativize_paths: true,
    repetition_ngram: 12,
    repetition_count: 4,
    abort_on_repetition: true,
  },
  loop: {
    max_iterations: 20,
    ttl_ms: 2 * 60 * 60 * 1000,
    stagnation: 3,
    failures: 5,
    compaction_guard_ms: 60_000,
  },
  models: {},
  max_output: { main: 8192, worker: 4096, reviewer: 2048, "data-analyst": 2048, "data-verifier": 1024, "ontology-evolver": 4096, "answer-judge": 512 },
  skills: { allow: ["ulw", "plan"] },
  flow: { enabled: true, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 },
  skill_observation: { enabled: false },
  skill_router: {
    mode: "off",
    endpoint: "http://127.0.0.1:8080",
    timeout_ms: 1000,
    min_probability: 0.95,
    min_margin: 0.2,
  },
  // CLI engines answered in 3-6 s (claude haiku, 2026-10-17); 30 s fails fast on a stuck CLI. A local Jev server under
  // memory pressure measured 43-72 s, so `jev` users should raise timeout_ms.
  memory: { engine: "auto", prefetch: true, endpoint: "http://127.0.0.1:8080", timeout_ms: 30_000, min_probability: 0.3, max_pages: 3 },
  delegate: {
    verifier: "legacy-unowned",
    review: true,
    worktree: false,
    review_strict: false,
    max_attempts: 2,
    task_ttl_ms: 15 * 60 * 1000,
    review_ttl_ms: 3 * 60 * 1000,
    queue_ttl_ms: 2 * 60 * 60 * 1000,
    verify_timeout_ms: 120_000,
    handoff_context_chars: 600,
    report_max_chars: 1200,
    diff_max_chars: 6000,
    verify_output_chars: 1500,
    diff_exclude: [
      "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".venv", "dist", "build", "*.pyc", "*.log",
      // never let secrets into a diff (or into git objects): the reviewer prompt and handoffs are plain text
      ".env", ".env.*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*",
    ],
    verify_allow: [
      "^(python3?|py) -m (pytest|unittest|mypy|ruff|black|flake8|doctest)\\b",
      "^(pytest|mypy|ruff|flake8|black|pyright)\\b",
      "^(bun|npm|pnpm|yarn) (test|run test|run check|run lint|run typecheck|x tsc|x vitest|x jest)\\b",
      "^(bun test|bunx (tsc|vitest|jest|eslint|biome))\\b",
      "^(npx|node --test|tsc|vitest|jest|eslint|biome|deno test)\\b",
      "^(go (test|vet|build)|cargo (test|check|clippy|build)|make (test|check|lint)|ctest|mvn test|gradle test|dotnet test|swift test|mix test|rspec|bundle exec rspec)\\b",
      "^(bash|sh) (\\./)?[A-Za-z0-9_./-]*(test|check|verify)[A-Za-z0-9_./-]*\\.sh\\b",
      "^(\\./)?[A-Za-z0-9_./-]*(test|check|verify)[A-Za-z0-9_./-]*\\.sh\\b",
    ],
  },
  data: DATA_DEFAULTS,
}

export function parseJsonc<T = unknown>(text: string): T {
  const errors: ParseError[] = []
  const value = parseJsonWithComments(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new SyntaxError("invalid JSONC")
  return value as T
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base
  const out: any = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

export function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "otter", "otter.jsonc")
}

export function projectConfigPath(worktree: string): string {
  return join(worktree, ".otter", "otter.jsonc")
}

export type ConfigErrorKind = "unreadable" | "not-a-file" | "invalid-jsonc" | "invalid-verifier-selector" | "invalid-chat-intent" | "invalid-chat-worktree" | "invalid-chat-execute" | "invalid-local-model"

/** Effective `chat.intent`: an absent key means the default, "offer". */
export function chatIntentMode(config: { chat: { intent?: "offer" | "off" } }): "offer" | "off" {
  return config.chat.intent === "off" ? "off" : "offer"
}

/** Effective `chat.execute`: an absent key means the default, "ask" (every action needs a local approval). */
export function chatExecuteMode(config: { chat: { execute?: "ask" | "auto-edit" | "plan" } }): "ask" | "auto-edit" | "plan" {
  return config.chat.execute === "plan" || config.chat.execute === "auto-edit" ? config.chat.execute : "ask"
}

/** Effective `chat.worktree`: an absent key means the default, "plan". */
export function chatWorktreeMode(config: { chat: { worktree?: "plan" | "off" } }): "plan" | "off" {
  return config.chat.worktree === "off" ? "off" : "plan"
}

export class ConfigError extends Error {
  constructor(readonly path: string, readonly kind: ConfigErrorKind) {
    super(`otter: config ${path}: ${kind}`)
    this.name = "ConfigError"
  }
}

function configReadError(path: string, error: unknown): ConfigError {
  const code = (error as NodeJS.ErrnoException)?.code
  return new ConfigError(path, code === "ENOTDIR" || code === "EISDIR" ? "not-a-file" : "unreadable")
}

function configIsAbsent(path: string): boolean {
  let cursor = path
  for (;;) {
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw configReadError(path, error)
      const parent = dirname(cursor)
      if (parent === cursor) throw configReadError(path, error)
      cursor = parent
      continue
    }
    if (cursor === path) return false
    if (entry.isSymbolicLink()) {
      try { entry = statSync(cursor) }
      catch (error) { throw configReadError(path, error) }
    }
    if (!entry.isDirectory()) throw new ConfigError(path, "not-a-file")
    return true
  }
}

export function loadConfig(worktree: string): OtterConfig {
  let cfg = DEFAULT_CONFIG
  let selectorPath = projectConfigPath(worktree)
  for (const p of [userConfigPath(), projectConfigPath(worktree)]) {
    let text: string
    try {
      text = readFileSync(p, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && configIsAbsent(p)) continue
      throw configReadError(p, e)
    }
    let patch: Partial<OtterConfig>
    try {
      patch = parseJsonc<Partial<OtterConfig>>(text)
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error()
    } catch {
      throw new ConfigError(p, "invalid-jsonc")
    }
    if (Object.hasOwn(patch, "delegate")) {
      if (!patch.delegate || typeof patch.delegate !== "object" || Array.isArray(patch.delegate)) {
        throw new ConfigError(p, "invalid-verifier-selector")
      }
      if (Object.hasOwn(patch.delegate, "verifier")) selectorPath = p
    }
    if (Object.hasOwn(patch, "chat") && patch.chat && typeof patch.chat === "object" && !Array.isArray(patch.chat) &&
        Object.hasOwn(patch.chat, "intent") && patch.chat.intent !== "offer" && patch.chat.intent !== "off") {
      throw new ConfigError(p, "invalid-chat-intent")
    }
    if (Object.hasOwn(patch, "chat") && patch.chat && typeof patch.chat === "object" && !Array.isArray(patch.chat) &&
        Object.hasOwn(patch.chat, "worktree") && patch.chat.worktree !== "plan" && patch.chat.worktree !== "off") {
      throw new ConfigError(p, "invalid-chat-worktree")
    }
    if (Object.hasOwn(patch, "chat") && patch.chat && typeof patch.chat === "object" && !Array.isArray(patch.chat) &&
        Object.hasOwn(patch.chat, "execute") && patch.chat.execute !== "ask" && patch.chat.execute !== "auto-edit" && patch.chat.execute !== "plan") {
      throw new ConfigError(p, "invalid-chat-execute")
    }
    if (Object.hasOwn(patch, "local_model")) {
      const local = patch.local_model
      if (!local || typeof local !== "object" || Array.isArray(local) ||
          Object.keys(local).some(key => key !== "keep_alive" && key !== "context_input_tokens" && key !== "context_trim_target_percent") ||
          (local.keep_alive !== undefined && local.keep_alive !== null && !isLocalKeepAlive(local.keep_alive)) ||
          (local.context_input_tokens !== undefined && local.context_input_tokens !== null &&
            (!Number.isInteger(local.context_input_tokens) || local.context_input_tokens < 4096 || local.context_input_tokens > 65536)) ||
          (local.context_trim_target_percent !== undefined && local.context_trim_target_percent !== null &&
            (!Number.isInteger(local.context_trim_target_percent) || local.context_trim_target_percent < 50 || local.context_trim_target_percent > 85))) {
        throw new ConfigError(p, "invalid-local-model")
      }
    }
    cfg = deepMerge(cfg, patch)
  }
  if (cfg.delegate.verifier !== "legacy-unowned" && cfg.delegate.verifier !== "linux-single-use") {
    throw new ConfigError(selectorPath, "invalid-verifier-selector")
  }
  return cfg
}
