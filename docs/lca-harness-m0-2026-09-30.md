# lca harness M0 — pin, flow core, live `/status` (2026-09-30)

Plan: ralplan run `01a0ea72-f6db-769f-85ef-61344fca8b4c` (`pending-approval.md`, consensus Architect CLEAR/APPROVE + Critic OKAY). Scope of this milestone: §6 M0. All numbers below were observed on this machine (Apple M4 Pro, Ollama 0.34.3, `gemma4:26b-a4b-it-mtp-q4_K_M`), not estimated.

## Step 0 — prefix re-baseline (before any M0 code)

| run | main first-call prefix | worker | reviewer | cache misses | wall |
|---|---|---|---|---|---|
| `lca-e2e.sh --fixture fib` | 4,369 | — | — | — | 27 s |
| `lca-e2e.sh --fixture ulw3` (E01–E14 PASS) | 4,490 | 3,392 | 1,838 | main 1, workers 1 | 63 s |

The 5.6K escalation trigger was not reached; no cuts were applied. `scripts/lca-baseline.py` reads the user's own OpenCode DB (not the isolated e2e DB), so the e2e E03/E08 numbers are the measurement of record.

## Step 1 — OpenCode pin (D1)

- `framework/package.json`: `@opencode-ai/plugin` and `@opencode-ai/sdk` pinned to exactly `1.18.32` (`bun install`, `bun.lock` updated; installed copies resolve 1.18.32). `.opencode/package.json` was already 1.18.32.
- `scripts/lca-doctor.sh`: `OPENCODE_MIN`/`OPENCODE_PIN` = 1.18.32; new **D12e opencode-pin** over five sources; `LCA_DOCTOR_ONLY` / `LCA_DOCTOR_ROOT` for tests. D01 keeps its semantics (below MIN = WARN).
- Real repo result: **D12e WARN** — the installed `opencode` binary auto-upgraded to **1.18.33**; every package source is 1.18.32. This is the intended user-visible drift signal (decision D1: WARN, not FAIL). Everything below ran on the 1.18.33 binary.

## Steps 2–3 — flow core and `/status`

Flow core (`framework/src/flow/`): `machine.ts` (§5.2 table as data), `state.ts` (workflow.json / archive / events.jsonl in the state root), `owner.ts` (§5.3 authority, liveness, heartbeat, owning-session takeover), `runtime.ts` (start/approve/settle/cancel/session-deleted/`repairOnLoad` — authority-free), `bash-policy.ts`, `status.ts`. Hooks: planning boundary + forced resume (`tool-before.ts`), settle at delegate return (`tool-after.ts`), `session.deleted` T19 and idle workflow branch (`event.ts`, `loop/idle.ts`), legacy precedence + `<lca-flow>` suffix + router skip (`chat-message.ts`), `/status` (`command.ts`, `config.ts`, `command-turns.ts`), `repairOnLoad` at init (`index.ts`). Ledger tasks carry an optional `wf` tag. M0 has no user entry into a plan workflow (that is M1); the core is exercised by tests.

## Acceptance evidence

| AC | Evidence |
|---|---|
| AC0.1 | `bun test` 479 pass / 1 skip (pre-existing) / 0 fail; `bunx tsc --noEmit` clean; node_modules plugin+sdk 1.18.32 |
| AC0.2 | `test/doctor-pin.test.ts` asserts D12e rows (PASS all on pin; WARN naming `opencode:1.18.33`, `framework/package.json:*:1.18.31`, `node_modules:*:not-installed`; D01 below MIN = WARN) + unfiltered run regression |
| AC0.3 | `test/flow-machine.test.ts` enumerates every (phase, event) pair; tabled rows incl. cap boundaries, all others error |
| AC0.4 | `test/flow-boundary.test.ts`, `test/flow-bash-policy.test.ts` (full denied/allowed tool and bash lists) |
| AC0.5 | `test/flow-boundary.test.ts` (forced resume), `test/flow-ledger.test.ts` (idempotent approve, foreign cancel, `resumeNotifiedFor`) |
| AC0.6 | `test/flow-owner.test.ts` (full §5.3 matrix incl. owning-session/dead-owner takeover; foreign dead owner `/status` byte-identical; T20 only on foreign `/plan`), `test/flow-state.test.ts` (load with a dead owner leaves phase and owner unchanged) |
| AC0.7 | main prefix after M0: fib **4,369**, ulw3 **4,490** (identical to the step-0 baseline); `lca_flow` absent from the effective config (`test/command-status.test.ts`) |
| AC0.8 | `test/flow-idle.test.ts` / `chat-message` cases: router not called while a workflow is non-terminal; `skill-router.test.ts` green |
| AC0.9 | `bash scripts/lca-e2e.sh --smoke-command status` → **PASS** (live, real model). The stored user message of the command turn is the code-rendered block starting with `[lca status]`; the model replied `ok`. Note: `opencode run --format json` streams only assistant parts on 1.18.33, so the smoke reads the user-role text from the isolated DB; the SDK fallback driver was not needed |
| AC0.10 | `detect.test.ts`, `chat-message.test.ts`: `plan mode` without a workflow still yields `<lca-mode name="plan">` |
| AC0.11 | `test/flow-idle.test.ts`: one nudge, then stuck(no_submission) + toast; no nudge when the last assistant text ends with `?`; user message resets; one idle handler |
| AC0.12 | `test/flow-idle.test.ts`: start clears ulw; `ulw` during planning → notice only; no `CONTINUE_PROMPT`/`offerResume` in any workflow phase; `loop.idle` off still settles without prompting |

## Legacy regression (X1) after M0

| run | result |
|---|---|
| `lca-e2e.sh --fixture fib` | PASS (E01–E04) |
| `lca-e2e.sh --fixture ulw3` | PASS (E01–E14), main 4,490, worker 3,382, reviewer 1,798 |
| `lca-e2e-data.sh` | PASS, tier-1 7/7, all tiers 7/7 |

## Doctor

`bash scripts/lca-doctor.sh`: 19 pass, 2 warn, 1 fail. New rows: **D12b PASS** (effective commands include `stop`, `status`), **D12e WARN** (binary 1.18.33). The **D09b FAIL** (reviewer sees foreign OMO tools) and **D05c WARN** (oh-my-openagent loaded) are pre-existing and caused by the user's global `oh-my-openagent` plugin — the same FAIL reproduces on the pre-M0 commit (`git worktree` at HEAD 1a498fe). They are out of M0 scope (OMO refusal is roadmap M2/M5).

## Deviations from the plan text

- Smoke oracle reads the isolated DB instead of the JSON stream (the JSON stream contains no user-role events on 1.18.33); same assertion, stronger source.
- The doctor fast path for `LCA_DOCTOR_ONLY` had a bug (an unfiltered run stopped after D01/D12e); fixed during M0 with a regression test.
