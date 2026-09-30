# lca — local coding agent (OpenCode plugin)

Local-first agent framework for OpenCode with Ollama/Gemma as the only backend. It is the
"opposite premise" of OMC/OMO/OMX (see `docs/agent-framework-review-2026-09-22.md`): the static
prefix (system prompt + tool list + thinking toggle) is fixed at session start and small; repeat
blocking, output trimming and orchestration are done in code, not by the model.

## Stage 3 scope (data layer: db_query, schema_lookup, EvoOntology) — 2026-09-23, first slice

- Off by default (`data.backend: "none"`). With `sqlite` or `postgres` the plugin registers two tools and two agents:
  `db_query(sql, max_rows?)` runs **one** `SELECT`/`WITH` statement (guard in `src/data/guard.ts`; forbidden
  keywords/functions, `FOR UPDATE`, multi-statements are refused before anything is spawned) and returns a tab table
  capped by rows / cell chars / estimated tokens plus a hint line; `schema_lookup(table?)` serves one table (or the
  table list) from a static JSON file (`scripts/lca-schema-extract.py` builds it from PostgreSQL DDL).
- sqlite backend: `src/data/sqlite_query.py` subprocess (`?mode=ro`, SELECT/READ-only authorizer, progress-handler
  timeout, `dist_m()` haversine) because `bun:sqlite` cannot register functions. postgres backend: `psql --csv` in
  `BEGIN READ ONLY` + `SET LOCAL statement_timeout`; the DSN comes **only** from the env var named by `data.pg_dsn_env`
  (default `LCA_PG_DSN`), loopback hosts only unless `data.pg_allow_remote`, never logged or stored.
- EvoOntology (MIT, stdlib) is vendored under `vendor/evoontology`; when `data.evo.workspace` has an `active.json`
  the `config` hook injects `config.mcp["evo-semantic"]` (stdio). Only `browse_semantics` / `resolve_semantics` are
  visible, and only to `data-analyst` (`permission["evo-semantic_*"]: deny` then two allows — order matters; the other
  27 lifecycle/evolution tools stay hidden). MCP tool names are `<server>_<tool>`; `opencode debug agent` does not
  list them, `opencode mcp list` + the effective permission keys do (e2e `--check`, doctor D11d).
- Agents: `data-analyst` (`mode: all` so `opencode run --agent data-analyst` works; steps 12; tools = db_query,
  schema_lookup, evo browse/resolve; thinking off), `data-verifier` (no tools; judges question/SQL/result/checks,
  last line ACCEPT/REJECT) and `ontology-evolver` (no tools; batch only, see stage 4). build/plan and the stage-2
  children get all data tools denied.
- **Delegated data tasks** (second slice): `delegate({tasks: [{title: "<question>", kind: "data"}]})` runs the
  analyst in a child session, extracts the `SQL:` block of its answer, **re-executes it and runs a check suite in
  code** (`src/data/check.ts`: built-in `default` = runs / has rows / not NULL, plus `data/checks/<suite>.json`
  named in `verify`: SQL assertions with the answer spliced in as `{answer}`), then asks the verifier. Same retry /
  advisory rules as code tasks; no snapshot, no files. Main's prompt gets rule 9 ("database question → delegate a
  kind data task") only when a backend is configured, and `data mode:` routes through delegate. The verifier never
  executes anything (the design's `data_check` tool became a queue step, for the same reason the reviewer has no bash).
- Acceptance (`scripts/lca-e2e-data.sh`, fixture `scripts/fixtures/data-vv`: a synthetic sqlite (places, vehicles,
  visits, risk, outbreaks) + code-generated `ontology_v0` + 10 representative questions with expected results): D01 the SQL the
  model reports, re-executed by the harness, matches the expected result (tier-1 >= 6/7), D02 uncached input + output
  <= 10K tokens per question, D03 <= 6 tool calls, D04 no repeated calls, D05 no write/bash, D06 wiring, D07 resolve
  called; `--via main` asks main instead (D08 ledger task done + checks pass, D09 main made 1 delegate call and 0 db
  calls). Measured on gemma4:26b: analyst direct 10/10, 2.1–4.6K tokens and 7–19 s per question (after three ontology
  fixes; each miss was a missing term/alias/convention, never a tool bug); via main 10/10 (one rows-only match),
  5.1–8.4K tokens (main + children) and 16–29 s. Results and design notes: `docs/lca-stage3-2026-09-23.md`.

## Stage 4 scope (ontology evolution batch) — 2026-09-23, first slice

- `scripts/lca-evo-evolve.py` (stdlib, imports the vendored EvoOntology API directly, no MCP): one EvoOntology
  evolution run per invocation. Parent evaluation = `scripts/lca-e2e-data.sh` on the active version (code judge:
  the harness re-executes the model's SQL against `queries.jsonl`), trajectories appended to
  `<workspace>/trajectories/`. Per round the `ontology-evolver` agent (Gemma, no tools) gets the terms/constraints
  and the failed cases (question, unresolved mentions, SQL written, why wrong — never the expected answer) and
  returns a JSON patch: aliases on existing terms, new terms, new constraints. The patch is validated in code
  (additive only, ids/targets must exist, nothing renamed), saved as a candidate version, `validate_semantics`,
  evaluated with the same e2e on a temp workspace copy, and gated by EvoOntology's deterministic `ground_truth`
  protocol (candidate mean > parent mean, no per-case regression on top).
- **Accept ≠ activate**: an accepted candidate is published as the next `ontology_vN` but `active.json` is put
  back to the parent; `evolution/run_N/proposal.md` + the new version directory are the PR diff, and
  `--activate ontology_vN` is the human step. Rejected rounds feed the previous hypothesis + result into the next.
- `scripts/fixtures/data-vv/degrade_ontology.py` recreates the ontology gaps found during stage 3 (no `가금`
  term, no inclusive-window / radius-self conventions, no counting-word aliases) so the loop has something real to
  close: one unattended run on gemma4:26b: parent 8/10 (HPAI-MAP-002/003 fail) → round 1 patch invalid (the model
  re-listed an existing term; the validator now merges such entries as aliases) → round 2 patch (aliases `가금 농장`,
  `야생조류 검출 건수/수/개수`, constraint `c-date-window`) → candidate 9/10, no regressions → accepted and published as
  `ontology_v1`, active stays `ontology_v0`, proposal written. Wall clock ≈ 7 min (two e2e passes + two evolver calls).
- **Worktree isolation** (`delegate.worktree: true`, `src/orchestration/worktree.ts`): the task's worktree starts from
  HEAD plus the main worktree's uncommitted tracked changes and untracked files (so it sees earlier tasks' results and
  the user's WIP), the child sessions are created with `query.directory` (verified on 1.18.32: `POST /session?directory=`
  and file reads resolve inside that directory), verify runs there, and the accepted diff is applied to main in code.
  Failed and cancelled tasks are discarded with their worktree; main never sees them. `scripts/lca-e2e.sh --worktree`
  runs the coding suite this way.
- **Judge hardening** (after the first llm_judge run): the judge prompt carries the ontology's constraints
  (`severity != info`) as "domain conventions", and every case is judged twice with A/B swapped — a winner counts
  only when both passes agree, a critical error when either pass flags the candidate.
- Questions without `expected` (production): `--questions F.jsonl` (or `--no-ground-truth` on the fixture) switch the
  gate to EvoOntology's `llm_judge`: per case the `answer-judge` agent (no tools) sees the question and the two answers
  (SQL + first rows) labelled A/B at random (`EvaluationGate.anonymize/decode`) and names a winner and any critical
  error; accept = zero candidate critical errors and strictly more wins. Failed cases are then those with unresolved
  mentions or unusable results. Measured on the degraded fixture with `expected` stripped: the evolver found the same alias family
  as with ground truth; the judge gave candidate 3 / parent 1 / tie 6 with one candidate critical error → REJECT (the
  core rule). Two of the three candidate "wins" contradicted the ground truth (the 26B judge prefers simpler SQL when
  it does not know the domain conventions), so `llm_judge` needs the ontology's constraints in the judge prompt and a
  swapped second pass before it is trusted on production questions; on the fixture `ground_truth` is authoritative.
- `scripts/lca-evo-nightly.sh` runs the driver only when `EvolutionTrigger` says an evolution is due (30 new
  trajectories or 7 days; `--force` skips), with a lock, an Ollama health check and a dated log under
  `~/.cache/lca/evo/`; `scripts/launchd/com.lca.evo-nightly.plist` is a 03:30 template (not installed).
- Doctor D11e runs the driver's `--self-test` (patch validation, judge decoding; no model).
- `OLLAMA_NUM_PARALLEL=2` is **not needed** for cache isolation: `scripts/lca-np-probe.py` (two ≈7K-token prefixes
  alternated) shows both prefixes restored in <0.15 s on the one-slot server too — llama-server saves idle slots to a
  host-RAM prompt cache (Ollama 0.34.2). Two slots halve the per-slot context for nothing; keep 1.

## Stage 2 scope (ledger, delegate, /stop) — after the 2026-09-22 six-lens review

- `delegate` tool (main only, plugin `tool` hook): main calls it once with the whole task list
  (`title`, `detail`, `verify` per task, at most 12, run in order). The tool appends the tasks to the session's
  **task ledger** and runs the **serial worker queue** inside the tool call, then returns one report (one line per
  task, never truncated). `delegate({ resume: true })` re-runs the open tasks of an interrupted run. Open tasks left by
  an earlier run are cancelled as *superseded* by a new call (never run silently). Schema ~260 est. tokens (doctor D09c).
- `verify` commands are model-authored and run without a permission prompt, so they are **allow-listed**
  (`delegate.verify_allow`: pytest/unittest, bun/npm/pnpm/yarn test, go/cargo test, make test, `*test*.sh`; a `cd dir`
  segment may only descend (no `..`, no absolute path) and never stands alone; `&&` allowed, `| ; & $ \` < >`, newlines
  and runner options that load repository code (`-p`, `-c`, `-o`, `--rootdir`, `--preload`, …) refused, `true`/`echo`/`ls`
  refused). Refused commands are reported back to main at delegate time with the reason; the queue re-checks before
  running, and runs verify with `PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 PYTHONDONTWRITEBYTECODE=1`.
- Task text is checked too: a task that tells the worker to edit a test/assertion or to fake a result (call counters,
  "first call returns 6, second 7", hard-coded answers) is refused at delegate time. In the negative e2e both hacks
  were authored by main, not by the worker.
- Queue (`src/orchestration/queue.ts`), per task: git tree snapshot (temp index + temp object dir, the user's `.git`
  is only read; in-tree clean/smudge filter drivers and hooks are neutralised for every git call) -> fresh `worker`
  child session (`session.create({parentID})` + blocking `session.prompt`, with a session-level tool deny for
  task/delegate/todo) -> diff of exactly this task's cumulative changes (`.lca/state`, `.lca/handoffs`, `__pycache__`,
  `.env`, … excluded via `delegate.diff_exclude`) -> **protected-file check**: the test files named in `verify`, runner
  autoload files (`conftest.py`, `pytest.ini`, `pyproject.toml`, `Makefile`, `package.json`, `bunfig.toml`, … unless
  the task text names them) and, when `verify` names no file, any test-looking path are restored from the snapshot
  (symlinks are never followed; Python bytecode caches are dropped) and the attempt fails -> **gaming scan** of the
  added lines (call counters, frame inspection, pytest detection = fail; weaker shapes = hints for the reviewer) ->
  the task's `verify` command run by code in its own process group (timeout/abort kill the group) -> `reviewer` child
  session (read/glob/grep only; answers four short questions, then the verdict on the LAST line: ACCEPT / REJECT: reason)
  -> ledger update + handoff file. Outside a git repository the review and the protected-file guard are unavailable and
  the report says so.
- Retry/verdict semantics: worker error, protected-file violation, gaming pattern or failed verify -> one retry with
  the reason, then `failed`; when the worker's report says under `Open issues:` that the task cannot be done and verify
  agrees, there is no retry. REJECT on a task whose verify passed -> one retry, then **advisory** (`done`, objection in
  the report); `delegate.review_strict: true` makes it `failed`. No parseable verdict never fails a verified task
  (reported as "no verdict"). A child aborted by someone else (repetition guard) is a failed attempt, not a queue abort;
  a /stop during the review of an already verified change keeps it as `done` (review aborted). Queue-wide cap
  `delegate.queue_ttl_ms` (checked between tasks).
- Ledger (control plane): `$XDG_STATE_HOME/lca/<sha1(worktree)[:12]>/sessions/<main>/ledger.json` (default
  `~/.local/state/lca/…`, override `LCA_STATE_HOME`) — **outside the worktree**, so a worker with bash cannot edit it
  and no repository commits it; a corrupt file is moved aside, never overwritten. Handoffs (data plane, human-readable):
  `<worktree>/.lca/handoffs/<main>/task-<n>.md` (self-ignored via a generated `.gitignore`); the next worker's prompt
  gets a `<= delegate.handoff_context_chars` summary of earlier tasks (status, files, failure reason) and nothing else.
- Interrupted runs (crash, restart, Esc): open ledger tasks are offered back to main **once** — attached to the
  user's next message (`<lca-resume>` block) or injected on idle — as "call `delegate` with `resume: true`"; a delegate
  call that re-sends the same titles is treated as a resume, other new lists cancel the open tasks as superseded. The
  queue only ever runs inside a tool call, so main is busy while workers run. `ulw` active -> stage-1 todo continuation
  (write-before-await + optimistic re-check so a user's cancel is never overwritten). `/stop` (`command.stop`): abort
  marker + mode off + child abort / verify kill; remaining (or, with no queue running, still open) tasks become
  `cancelled`; the marker is lifted only by the user's next message. Verified live over `opencode serve` (HTTP client
  path): /stop settles the ledger 42 ms after the command; the resume offer appears exactly once. Esc×2 in the TUI
  (verified 2026-09-23 in a tmux-driven `opencode` TUI on the ulw3 fixture) aborts the tool call (`ctx.abort`): the
  running child is aborted and the ledger reads `[done, cancelled, cancelled]` (reason "main session aborted") within
  6 s; the TUI shows the turn as interrupted.
- Tool visibility is expressed **only through `permission`** (`denied_tools` in `agents/prompts.ts` ->
  `permission.<tool>: "deny"`, `steps` instead of `maxSteps`): the plugin `config` hook runs after schema decoding and
  agent `tools`/`maxSteps` keys set there are silently ignored (stage-1 bug found by the review: task/todowrite/delegate
  were visible to every agent). Doctor D09b checks the effective tools with `opencode debug agent`.
- Acceptance (`scripts/lca-e2e.sh --fixture ulw3` / `--fixture ulw-fail`): E01-E04 as stage 1, E05 ledger statuses
  match the fixture, E06 every worker/reviewer session of every attempt cross-checked, E07 main cache misses == 1 and
  worker misses <= 1 (reviewer sessions always re-prefill on the single Ollama slot: reported), E08 worker/reviewer
  prefix within their own budgets, E09 verdicts, E10 no reasoning parts in children, E11 no length stops, E12 per-task
  wall, E13 a handoff file per started task, E14 main made no write/edit calls.

## Stage 1 scope

- Agents `main` (primary), `worker`, `reviewer` injected via the `config` hook; the built-in `task` tool is denied via
  `permission` for every agent.
- Prompt budgets (estimated tokens, `src/tokens.ts`): main <= 1500, worker <= 800, reviewer <= 600.
  Whole prefix incl. tools: main <= 8K, worker <= 5K, reviewer <= 3K (`DEFAULT_CONFIG.budget`).
- Guards (`tool.execute.before/after`): identical (tool, args) call blocked after `repeat_limit`,
  read/bash output trimming, edit/JSON error-recovery hints, n-gram repetition abort.
- Modes (`ulw`, `plan`) as <= 300-char suffixes on the user message, state under `$XDG_STATE_HOME/lca/<repo-hash>/`.
- Acceptance: prefix <= 8K tokens, zero repeated identical calls, fib task done in < 5 min.

## Layout

```
framework/src/index.ts        plugin entry (assembly of hook factories)
framework/src/config.ts       lca config: ~/.config/lca/lca.jsonc -> <repo>/.lca/lca.jsonc (project wins)
framework/src/hooks/*.ts      config, chat.params, chat.message, tool-before, tool-after, event, compacting
framework/src/agents/         prompts;  src/guards/  src/modes/  src/state/  src/tokens.ts
framework/src/state/ledger.ts task ledger + handoffs;  src/state/store.ts  state root (outside the worktree)
framework/src/orchestration/{queue,snapshot,shell}.ts  serial worker queue, temp-object-dir snapshots, process-group shell
framework/src/tools/delegate.ts  the `delegate` tool;  src/hooks/command.ts  `/stop`;  src/loop/idle.ts  resume offer + todo loop
.opencode/plugins/lca.ts      project loader: re-exports framework/src/index.ts (OpenCode auto-loads it)
scripts/lca-*.{py,sh}         measurement / verification tooling (below)
```

## Commands

```sh
cd framework && bun install && bun test && bun run typecheck   # unit tests + types
bash scripts/lca-doctor.sh [--json]           # static checks D01-D10 (no GPU); exit 0 ok / 1 warn / 2 fail
python3 scripts/lca-baseline.py --top 10      # per-session prefix / cache-miss / compaction / repeat table
python3 scripts/lca-baseline.py --session <id>  # + per-call timeline   (--since YYYY-MM-DD, --json, --db PATH)
bash scripts/lca-e2e.sh --dry-run             # print the isolated stage-1 run plan
bash scripts/lca-e2e.sh --check               # verify isolation, no model call
bash scripts/lca-e2e.sh                       # real run: fib fixture, ~10 min budget, GPU
bash scripts/lca-e2e.sh --fixture ulw3        # stage-2 run: ulw -> delegate 3 tasks (E01-E14), ~2-4 min
bash scripts/lca-e2e.sh --fixture ulw-fail    # stage-2 negative run: [done, failed, done], queue continues
```

`lca-baseline.py` reads OpenCode's SQLite DB read-only (`~/.local/share/opencode/opencode.db`).
`lca-e2e.sh` runs under `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointing at a scratch dir (`~/.cache/lca/e2e`), with
`OPENCODE_CONFIG_DIR` unset, so neither the user's global config nor the user's session DB is used.

## Config file locations

| What | Path |
|---|---|
| OpenCode global config (user's, loads OMO today) | `~/.config/opencode/opencode.jsonc` |
| OpenCode project config / plugin loader | `<repo>/.opencode/opencode.json(c)`, `<repo>/.opencode/plugins/lca.ts` |
| Extra global dir (only if `OPENCODE_CONFIG_DIR` is set, e.g. by orca) | `$OPENCODE_CONFIG_DIR/opencode.json` |
| lca user / project config | `~/.config/lca/lca.jsonc`, `<repo>/.lca/lca.jsonc` (list only overrides) |
| lca control-plane state (ledger, mode, abort marker, session map) | `$XDG_STATE_HOME/lca/<repo-hash>/sessions/<id>/` (default `~/.local/state/lca/…`; `LCA_STATE_HOME` overrides) |
| lca handoffs (data plane) | `<repo>/.lca/handoffs/<session>/task-<n>.md` |
| OpenCode session DB (read-only for us) | `~/.local/share/opencode/opencode.db` |

## OMO coexistence warning

`oh-my-openagent` and lca both overwrite `config.agent` and `default_agent`; the plugin loaded last
wins and the other's agents/guards silently vanish. Do not run both: remove `"oh-my-openagent@latest"`
from the `plugin` array in `~/.config/opencode/opencode.jsonc` (and from `$OPENCODE_CONFIG_DIR/opencode.json`
if set) before using lca. `lca-doctor.sh` reports this as `D05c WARN`. With OMO loaded, worker/reviewer also see OMO's
tools (`call_omo_agent`, `session_*`, …) in their prefix — another reason not to run both.

## Optional OpenJev skill recommendations

`skill_router` is a per-turn recommendation layer, not a replacement for mode detection
or permission checks. Library defaults are **off**; this repository explicitly opts into
**suggest** mode in `.lca/lca.jsonc`. Recommendations now appear as optional per-turn
advice in the main agent's input. They never automatically load a skill, activate a mode,
or execute a task. `shadow` remains available for observation without affecting the input.
Set `LCA_DEBUG=1` when starting OpenCode to see `skill.router` outcomes and latency.

```json
{
  "skill_router": {
    "mode": "suggest",
    "endpoint": "http://127.0.0.1:8080",
    "timeout_ms": 1000,
    "min_probability": 0.95,
    "min_margin": 0.2
  }
}
```

- Modes: `off`, `shadow`, or explicitly opted-in `suggest`. Suggest appends optional
  per-turn advice, **not** an instruction to load a skill. The probability/margin
  thresholds are experimental, not calibrated correctness or authorization guarantees.
- Candidates are project-local `.opencode/skills/<name>/SKILL.md` metadata, intersected
  with `skills.allow` and the live main-agent permission rules returned by OpenCode.
  Missing, denied, ask-only, external-symlink and malformed skills are excluded.
  Global skill discovery is deliberately not a router catalog; installing a GJC skill
  alone does not make it eligible. Catalogs over 16 allowlisted names abstain.
- Only `name` and bounded frontmatter `description` are sent, never skill instructions
  or other repository file contents. Only the current user text is sent (maximum 2,000 characters);
  common credential patterns cause abstention. This is not a complete secret detector:
  keep confidential material out of routed messages or turn the router off.
- One HTTP call uses `jev-latest`, `samples: 1`, `steps: 1`, and an explicit `none`
  choice. Only literal HTTP loopback endpoints are accepted; redirects are refused.
  Timeout includes host permission lookup and the response body. One request per
  plugin instance is admitted, with no queue or retries. Errors, invalid responses,
  revoked permissions, low margins and stale turns yield no suggestion.
- Explicit slash commands, detected modes, active modes, resume offers, child agents
  and synthetic-only turns bypass inference. A newer main-agent turn cancels pending
  advice for its session; mode TTL, permissions and execution authorization are never
  derived from predictions. Disabling `mode.detect` also disables this hook.
- Client cancellation does **not** prove that already-running MLX work stopped. Other
  clients can still contend for the model. Do not enable suggestions in production
  before held-out routing evaluation and main-agent-plus-router load testing.

Start the separately installed server with `scripts/openjev-local.sh` from the repository
root when it is not already running. Existing launch-agent/LAN settings are not modified
by this feature. A loopback client URL does not secure a server bound to all interfaces;
an unauthenticated network-bound server needs a separately approved deployment decision.

Verification: `cd framework && bun test test/skill-router.test.ts test/detect.test.ts
test/chat-message.test.ts`, then `bun run typecheck`. Router tests exercise real loopback
HTTP with a controlled inference fixture, including revocation, timeout, overload,
invalid output and stale-response cases; they are not model-accuracy benchmarks.

## Tool history and Karpathy-style LLM Wiki

The event hook records completed/error OpenCode tool calls outside the worktree at
`stateRoot(worktree)/tool-outcomes.sqlite`. Only whitelisted metadata is stored:
tool/call/session identity, outcome and its evidence basis, reported timestamps and
duration. No arguments, output/error bodies or arbitrary metadata are retained.
The SQLite observation log is append-only and identical replays are deduplicated;
conflicting observations remain evidence rather than silently overwriting history.
Disable recording with `disabled_hooks: ["tool.history"]`.

Success means host-reported completion or an explicit zero exit code, **not** that an
answer is correct or a user's task is done. Explicit nonzero exits and tool error states
are failures. Conflicting or malformed explicit exit fields are unknown. Ordinary text is not treated as an
error by a regex. This records future OpenCode plugin events only, not this GJC session,
arbitrary terminal commands, or historical activity.
Recording is best-effort: a storage error logs a generic `tool outcome recording failed`
message through the debug logger (`LCA_DEBUG=1`) and does not interrupt tool/guard handling.
Stored-observation counts are therefore not a guarantee that every executed call was captured.

From the repository root:

```bash
bun scripts/lca-wiki.ts capture
bun scripts/lca-wiki.ts lint
```

`capture` writes a content-addressed immutable raw snapshot, a source page, a generated
aggregate report, and updates the index/append-only activity log. It does not pretend to
be an LLM ingest. The coding agent follows [the wiki schema](../knowledge/AGENTS.md) to
read sources, maintain cross-linked concepts/entities, answer with citations, and
record semantic ingest/query/lint operations. Start at [the index](../knowledge/wiki/index.md).
The structural `lint` checks local links, orphan pages and raw integrity; contradictions,
stale claims and causal conclusions require agent review. Existing raw files and enriched
source pages are never overwritten; aggregate reports are explicitly generated.

The pattern follows [Karpathy's original LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
not a separate hosted product. A wiki capture lock prevents concurrent writers. After a
crash, verify that the lock's PID is no longer running before removing that one stale
lock; the CLI never guesses or deletes an existing lock. Git settings remain unchanged.

## Delegate config (`.lca/lca.jsonc` → `delegate`)

| key | default | meaning |
|---|---|---|
| `review` | `true` | run the reviewer child session on each task's diff + verify output |
| `worktree` | `false` | stage 4: each code task runs in a linked git worktree under the state root (worker session + verify bound to it via the SDK's per-request `directory`); its diff is applied to the main worktree only when accepted (`git apply --check` first — a patch that no longer applies fails the task and stays in `.lca/handoffs/<session>/task-N.patch`). Falls back to in-place without a commit. Measured (ulw3): 3/3 done, verify + review in the worktrees, files merged, 88 s vs 64 s in place — each worker's system prompt embeds its own directory, so worker prefixes are no longer shared (3 worker cache misses instead of 1; E07 reports it). Isolation costs one prefill per task. |
| `review_strict` | `false` | `true`: a REJECT / no verdict on the last attempt fails the task even when verify passed |
| `max_attempts` | `2` | worker attempts per task (failed verify / REJECT re-runs once with the reason) |
| `task_ttl_ms` / `review_ttl_ms` | `900000` / `180000` | wall-clock cap per worker / reviewer session; on expiry the child is aborted and the attempt fails |
| `queue_ttl_ms` | `7200000` | cap for a whole delegate call; remaining tasks are cancelled |
| `verify_timeout_ms` | `120000` | cap for the task's `verify` command (own process group, SIGTERM then SIGKILL) |
| `verify_allow` | test/check runners (see `config.ts`) | regexes a verify command must match; everything else is refused before it can run |
| `handoff_context_chars` | `600` | earlier-task summary prepended to the next worker prompt |
| `report_max_chars` / `diff_max_chars` / `verify_output_chars` | `1200` / `6000` / `1500` | trimming of the worker report, the diff shown to the reviewer, the verify output tail |
| `diff_exclude` | `__pycache__`, `.pytest_cache`, `node_modules`, `.venv`, `*.pyc`, `.env`, `*.pem`, … | globs never counted as task changes (any depth); `.lca/state` and `.lca/handoffs` are always excluded (`.lca/lca.jsonc` edits do show up). Without this the reviewer rejects "files outside the task" for test-run artifacts (seen in the first e2e) |

Hook ids for `disabled_hooks`: `tool.delegate` (drops the tool; main's prompt and the `ulw` suffix then fall back to the
stage-1 direct task list) and `command.stop`. Full list in `src/hooks/types.ts` (`HOOK_IDS`).

Known limits (from the reviews, not addressed): a plugin tool's `ctx.metadata()` is a no-op on OpenCode 1.18.32, so
the TUI shows only the tool name while the queue runs (the child sessions' titles `lca task N: …` are the progress
signal); two OpenCode instances on the same repository each run their own queue (no cross-process lock); test gaming
that no pattern catches (a clever worker) is only stopped by the reviewer, which on a 26B with thinking off is weak —
verify commands and protected files are the real gate, so write task-local tests.

## Data config (`.lca/lca.jsonc` → `data`)

| key | default | meaning |
|---|---|---|
| `backend` | `"none"` | `"sqlite"` / `"postgres"` enables db_query, schema_lookup and the data agents |
| `sqlite_path` | `data/app.sqlite` | sqlite file (relative to the worktree), opened read-only |
| `schema_file` | `data/schema.json` | static schema served by schema_lookup |
| `pg_dsn_env` / `pg_allow_remote` / `psql_path` | `LCA_PG_DSN` / `false` / `psql` | env var holding the DSN; non-loopback hosts refused unless allowed; psql binary |
| `max_rows` / `max_cell_chars` / `max_output_tokens` | `50` / `80` / `1500` | result caps (hint line says what was cut) |
| `statement_timeout_ms` | `15000` | per query (sqlite progress handler / `SET LOCAL statement_timeout`) |
| `max_queries_per_session` | `6` | executed db_query calls per session (refused calls do not count) |
| `checks_dir` | `data/checks` | data-task check suites (`<suite>.json`) named by a data task's `verify`; `default` is built in |
| `evo.enabled` / `evo.workspace` / `evo.python` / `evo.server` | `true` / `.evoontology` / `python3` / vendored | EvoOntology MCP injection; `server` overrides the vendored `mcp_server.py` |

Hook ids: `tool.data` (drops db_query/schema_lookup and the data agents), `mcp.evo` (no MCP injection).

## Stage 5 scope (model comparison) — 2026-09-23, first slice

- `scripts/lca-e2e-data.sh --model ollama/<id>` and `LCA_E2E_MODEL=ollama/<id> scripts/lca-e2e.sh` run the same
  isolated suites on another model of the user's `provider.ollama.models`. `qwen3.6:35b-a3b` is not pulled (a
  20 GB download is the user's call), so the first comparison is gemma4:26b-a4b (MoE, default) vs gemma4:31b-mlx:
  same accuracy on both suites (data 10/10, ulw3 3/3), 31B 2.5–5.6× slower, prefix contract unchanged; E07's
  "main cache misses == 1" expectation fails on the MLX runner (reports 0), a runner accounting difference, not a
  regression. qwen3.6:35b-a3b-coding-mtp (pulled later the same day): coding 3/3 in 65 s with E01–E14 PASS once thinking
  was off, but data 7/10 — on three questions it skipped db_query and fabricated or refused the result (the reason the
  pipeline re-executes SQL). Two framework bugs it exposed are fixed: thinking-off was Gemma-only (now every
  Ollama-served model), and the data e2e's `SQL:` regex required code fences. Table and notes: `docs/lca-stage5-2026-09-23.md`.

## Prefix discipline knobs (added after the first e2e)

- `skills.allow` (default `["ulw","plan"]`): OpenCode auto-discovers skills from `~/.claude/skills`, `~/.agents/skills`,
  `.opencode/skills` and lists every description in the skill tool schema (13 skills = ~2K prefix tokens here).
  lca sets `permission.skill` so main sees only the allowlist; worker/reviewer have the skill tool off.
- `guards.read_max_tokens` (default 2500) and `guards.relativize_paths` (default true): tool outputs are cut by
  estimated tokens, not just bytes, and worktree-absolute paths are made relative before the model sees them.
- The `delegate` tool schema costs ~257 est. tokens (doctor D09c and the unit test cap it at 400).
- Stage-1 e2e results: `docs/lca-stage1-2026-09-22.md`.
