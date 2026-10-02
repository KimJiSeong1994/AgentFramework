# lca harness M1 — plan workflow (2026-10-01)

Plan: ralplan run `01a0ea72-f6db-769f-85ef-61344fca8b4c` §6 M1 (on top of M0, `docs/lca-harness-m0-2026-09-30.md`). Numbers observed on this machine (Apple M4 Pro, Ollama, `gemma4:26b-a4b-it-mtp-q4_K_M`, opencode binary 1.18.33, plugin/sdk pinned 1.18.32).

## What ships

`/plan <request>` (or `ralplan …` / `plan mode …` / `hyperplan …` / `계획부터 …` / `계획 모드 …`) → read-only investigation (code-enforced boundary) → `lca_flow op:"plan"` → code gates (`flow/plan.ts validatePlan`) → advisory reviewer child inside the tool call (`flow/review.ts`) → canonical plan JSON in the state root + rendered `.lca/plans/<id>.md` → user `/approve` → code converts steps into ledger tasks tagged `{wf id, planSha}` → existing serial queue (worker + verify + reviewer) via `delegate resume:true` → settle → `done`. `/reject <reason>`, `/cancel`, `/status` work at every phase. A new `opencode` process continues the same session (owning-session takeover).

## Acceptance evidence

| AC | Evidence |
|---|---|
| AC1.1 | `lca-e2e.sh --flow plan --fixture plan3` **PASS**: F01 plan json validates (3 steps) + md; F02 created→plan_submitted→approved→tasks_created, settled to done (an `owner_takeover` occurs when `/approve` runs in a new process); F03 0 edit/write by main during planning; F04 tagged tasks == steps (3), titles identical, all done; F05 pytest 9 passed |
| AC1.2 | `--entry keyword` (`ralplan …`) **PASS**: F01–F06 (entry == keyword) |
| AC1.3 | `lca-flow-tool.test.ts`, `flow-integration.test.ts` scenario 4: invalid plan never reaches the reviewer; errors listed; 3 invalid → stuck(plan_invalid) → `/reject` exits |
| AC1.4 | `flow-approve.test.ts`, `flow-integration.test.ts` scenarios 1, 3, 6, 7; double `/approve` creates tasks once |
| AC1.5 | `flow-approve.test.ts`, `flow-integration.test.ts`: prose `/approve` / "approved" never approves; only the lca-injected `approve` command turn does |
| AC1.6 | `flow-keyword.test.ts` (11 cases): informational questions create no workflow, `force:` works, `flow.enabled=false` restores legacy plan mode, active workflow + keyword → notice only, foreign dead owner → T20 then T1, foreign live owner → refusal without mutation |
| AC1.7 | `--repeat 10 --stop-after pending_approval`: **10/10** runs with a valid `plan_submitted`, measured twice: before the review repairs (`flow-repeat-20261001-151933.json`) and again on the final reviewed tree (`flow-repeat-20261001-171325.json`). No schema-flatten retry was needed |
| AC1.8 | `--seed-open-task` **PASS**: F07 the pre-seeded untagged open task was cancelled as superseded and never ran |
| AC1.9 | Main first-call prefix **4,631** (fib) / **4,752** (ulw3) vs M0 4,369 / 4,490 → **+262**, ≤ +400 and ≤ 6.0K. Doctor D12a lca_flow ~299 est. tokens main-only PASS; D12c PLAN_REVIEW_TEMPLATE ~191 PASS; D12b command set (stop, status, plan, approve, reject, cancel) PASS |

## Cross-cutting

| X | Evidence |
|---|---|
| X1 | ulw3 E01–E14 PASS; fib PASS; `lca-e2e-data.sh --tier 2` all tiers **10/10** (tier-1 7/7) |
| X2 | main ≤ 6.0K (4,752 max); worker ≤ 5K; reviewer ≤ 3K |
| X3 | control decisions read only `parseVerdict`/`parsePlanVerdict` verdict lines and the nudge's trailing-`?` check; no text-parse plan fallback exists |
| X4 | every transition writes one `transition` event with global monotonic seq (`flow-state`, `flow-integration` tests; live event log seq 1..10) |
| X5 | `/cancel`, `/stop`, rotation and session deletion never delete `.lca/plans/` or handoffs (`flow-integration`, `flow-owner` tests) |

Full suite on the final tree: **575 tests, 574 pass, 1 skip (pre-existing), 0 fail**, 2,504 assertions (`evidence/harness/framework-tests.xml` in the Ultragoal session); `bunx tsc --noEmit` clean.

## Advisory reviewer value (critic escalation input)

Across the 10 repeat runs plus the 4 full runs the reviewer returned **OKAY every time** (0 ITERATE, 0 invalid submissions). It cost one reviewer child per plan. On this fixture it adds no signal; whether it stays default-on is the open roadmap decision listed in the plan (§14), to be decided with more varied tasks. It is kept on (advisory only, never a gate).

## Fixes found by the live runs (not visible in unit tests)

1. **e2e driver** ran `with_timeout` (a shell function) through `env`, so `opencode` never started — replaced with the inline `perl` alarm at every call site.
2. **F02 oracle** looked for `settle_ok`/`done` as event types; settle is a `transition` event. Now F02 requires the typed events plus a final phase of `done`.
3. **Executing-phase escape (keyword run 1, FAIL → fixed)**: Gemma re-sent the approved task list with `resume:true`; the forced-resume guard refused it in a loop, and main then wrote the three files itself (F03/F04 failed). Fix in `hooks/tool-before.ts`: in `executing` a re-sent task list with `resume:true` is dropped and the call proceeds as a plain resume (the approved tasks already exist in the ledger), and main's write/edit/patch and mutating bash are refused while the plan executes (workers implement it). Re-run: keyword entry F01–F06 PASS; command entry PASS.

## Agent-team review (boundary cohort) and repairs

Generation 1 froze `sha256:0acdb7d0…` and ran three lanes in parallel: architect (architecture/product/code), AI-slop cleaner, executor red-team QA. Joined findings, all repaired in one batch:

| Finding | Source | Fix | Regression |
|---|---|---|---|
| HIGH lost update: a review awaited in `lca_flow` wrote back onto a stale snapshot, so `/cancel` during review was undone and a new `/plan` could be overwritten; a stale heartbeat was written back | architect | `applyEvent` is compare-and-swap (re-reads workflow.json; refuses when id, lastSeq or phase changed; keeps the fresher heartbeat); `lca_flow` re-checks after the review and makes one guarded write for review + md sha | `flow-review-fixes.test.ts` (cancel during review stays cancelled; cancel + new plan keeps B; stale record refused; heartbeat not rolled back) |
| Esc did not abort the review (T8) | architect | `runPlanReview` races the tool call's abort signal and aborts the child | Esc test |
| load repair could flip a live foreign owner's review | architect | `repairOnLoad` skips a workflow owned by another live instance | foreign live owner test |
| `mode.detect` off still ran legacy detection (ARCH-13) | cleaner | `chat.message` stops after commands/workflow turn when `mode.detect` is off (the plan keyword is keyword detection too) | mode.detect-off test |
| heartbeat tick error silently stopped the heartbeat | cleaner | errors are logged and retried; only `false` stops it | heartbeat test |
| F03 oracle masked probe errors as 0 and counted refused calls | cleaner/architect | F03 counts only completed write/edit/patch/apply_patch parts and FAILs on a probe error | live runs |
| forged `<lca-mode>`/`<lca-flow>` in user text skipped detection | red-team D3 | provenance by (part id, exact text lca produced); markers in any other user text are stripped | forged-marker tests |
| `tail -10f` follows forever; `file -C` writes | red-team D2 / architect | short-option clusters containing f/F refused for tail; `-C/--compile` refused for file | policy table |
| Unicode fullwidth `．．/x` path escape | red-team D1 | **not a defect**: `path.resolve` keeps it inside the worktree (`<wt>/．．/x`), verified | — |

Contract notes recorded with the review: in `executing` a re-sent task list with `resume:true` is dropped (event `boundary_coerced`) instead of refused, and main's writes/mutating bash are refused (AC0.5/§5.4 amended in spirit; architect judged it consistent and safe). A plan keyword while the same session owns a workflow is a notice only (AC1.6), narrower than `/plan`. Reading files outside the repo with read-only bash during planning remains possible (the boundary is read-only, not repo-scoped) and is left as a documented limitation.

### Generations 2–5 (delta-only re-reviews, same three lanes)

| Gen | Frozen hash | Architect | Cleaner | Red-team | Residual and fix | Regression |
|---|---|---|---|---|---|---|
| 1 | `0acdb7d0…` | REQUEST CHANGES | BLOCKED | failed | see the table above | `flow-review-fixes.test.ts` |
| 2 | `f32d6005…` | CLEAR/APPROVE | PASS | failed | `tail +5f` (BSD +N follow form) → refuse any `-`/`+` cluster with f/F; forged markers in UPPER/mixed case → case-insensitive stripping + stray-tag pass | policy table, case test |
| 3 | `c75bb88a…` | CLEAR/APPROVE | PASS | failed (minor) | zero-width characters spliced into a tag name → invisible/format characters removed before matching | zero-width test |
| 4 | `a982ef4e…` | CLEAR/APPROVE | PASS | failed (minor) | Cyrillic look-alike letters in a tag name → **root-cause fix**: new `framework/src/modes/markers.ts` matches on a TR39-style skeleton (NFKC incl. fullwidth `＜＞`, combining marks and invisible/format characters dropped, Cyrillic/Greek Latin look-alikes and dash variants mapped, lowercase) and cuts the matched ranges from the **original** text, so all other text stays byte-identical | `markers.test.ts` (12 forgeries, untouched emoji/ZWNJ/Hangul/Cyrillic prose, exact cut boundaries) |
| 5 | **`6b293401ea82fb0a11562b00f6154ae6724df11fb61e5281369f15ac9ba45a20`** | CLEAR/APPROVE | PASS | **passed, 0 defects** (index map exact with astral/NFKC chars; 1 MB worst case ~31 ms) | — | — |

Why this mattered: the main prompt tells the model to follow `<lca-flow>` blocks, so a forged block in user text was a prompt-injection surface. No forged marker could ever change workflow state (transitions come only from code and injected commands); the filter removes the text so the model is not misled.

### Live runs and which tree they used

| Run | Tree | Result |
|---|---|---|
| `--flow plan` command, keyword (F01–F06), seed (F07), `/status` smoke, fib, `--repeat 10` | final gen5 `6b293401…` | all PASS; repeat 10/10; fib main 4,631 |
| ulw3 | gen4 code + markers module (before freeze) | PASS, main 4,752, worker 3,400, reviewer 1,836 |
| `lca-e2e-data.sh --tier 2` | gen2 (no data-layer or chat path change for data agents since) | all tiers 10/10 |
| first `--repeat 10`, first command/keyword runs | before gen1 repairs | 10/10; keyword run 1 FAIL → executing-phase fix (above) |

### Known limitations (accepted gen5 LOW advisories)

- The look-alike map does not fold a capital Latin `I` into `l` (e.g. `<Ica-flow>`); the map covers the letters of the marker names but not the full Unicode confusables table. Effect is limited to model persuasion; no code gate reads marker text.
- Marker names are listed in `modes/markers.ts` and separately in the suffix builders in `modes/instructions.ts`; a new marker must be added to both.
- Two OpenCode processes on one repo can still interleave writes inside the compare-and-swap window (no file lock). Single-instance use is the supported mode; a lease is roadmap M5.
- Read-only bash during planning can read files outside the repo (the boundary is read-only, not repo-scoped).

## Doctor

21 pass, 2 warn, 1 fail. New PASS: D12a, D12b (M1 set), D12c. Unchanged and pre-existing: D12e WARN (binary 1.18.33), D05c WARN and D09b FAIL caused by the user's global `oh-my-openagent` plugin (reproduced before M0).
