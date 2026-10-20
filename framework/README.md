# otter — controlled coding agent

Common terminal for installed Ollama, Codex and Claude Code CLIs, with a retained
OpenCode plugin and imported-plan runner. Otter fixes its role policy at session start;
approval, tool restrictions, output trimming and orchestration are enforced in code,
not granted by model output. Native CLI budget and containment limits are described below.

## Core and qualification boundaries

| Layer | Files | Scope |
| --- | --- | --- |
| Shared runtime | `src/hosts/{types,runtime,tool-policy,run-state}.ts` | Host contracts, fixed role policy, execution ownership and durable recovery state. |
| Common CLI host | `src/hosts/{interactive,interactive-session,cli-progress,model-catalog,cli-runtime,cli-host,cli-transport,cli-tools,codex-profile,plan-conversation}.ts` | Shared TUI/readline coordinator, engine/model selection, conversation and controlled native CLI inference. |
| Terminal UI | `src/tui/` | Exclusive raw input, editor, transcript viewport and observational progress. |
| Durable sessions | `src/sessions/`, `src/state/durable.ts` | Segmented history, exclusive attachment epochs, restored holds and explicit admission. |
| OpenCode adapter | `src/hosts/{opencode,opencode-runtime}.ts` | Retained plugin and imported-plan host integration. |
| Workflow entry points | `src/hosts/{cli,controller}.ts`, `src/flow/`, `src/hooks/`, `src/tools/` | Import, approval, delegation, review, cancellation and status. |
| Task execution | `src/orchestration/{queue,snapshot,worktree,git-boundary,shell,verifier,legacy-verifier}.ts` | Serial tasks, snapshots, verification and accepted changes. The default verifier remains `legacy-unowned`. |
| Owned-verifier qualification | `src/hosts/linux-domain.ts`, `src/orchestration/linux-verifier.ts`, `scripts/linux-verifier/`, `scripts/otter-linux-verifier-{e2.py,queue.ts}` | Opt-in Linux/systemd verifier boundary; not default admission or worker/reviewer containment. |

Review the runtime, queue, workflow callers and their tests as one integration change:
committing the queue without its new host contracts leaves unresolved imports. Native-host
and Seatbelt qualification results are a separate review scope, not proof that the core
is safe for untrusted workloads. The common terminal uses installed vendor CLIs, not
provider SDK adapters. Earlier macOS Seatbelt experiments do not qualify this runtime.
Linux verifier admission requires its own platform qualification.
Core changes still require regression tests and type checking. Native containment claims
additionally require the corresponding platform qualification, not just passing unit tests.

The plugin and OpenCode imported-plan CLI assemble execution through `getOpenCodeRuntime`;
the common terminal uses `createCliRuntime`. Both reuse `createExecutionRuntime` rather
than maintaining separate policy or verifier factories. Disabling `config.agents` or
`chat.params` refuses OpenCode admission before a plan-review child is created.
Configured data checks and task observation also follow the shared runtime.
Read-only CLI `status` bypasses runtime construction.

The shared process-risk fence also applies to plugin `delegate`, not only the foreground
CLI: a managed worker that invokes `bash` cannot prove descendant termination from a
returned prompt alone, so the execution remains fenced instead of being accepted.
Worker prompts therefore reserve test execution for the framework's verifier and report
verification as pending rather than instructing the worker to run Bash itself.
Use trusted file-tool-only fixtures for core acceptance; this integration does not
establish general shell-workload containment.

## Default coding conventions

Main, worker and reviewer share compact [Ponytail-inspired](https://github.com/DietrichGebert/ponytail)
guidance: trace the real flow and callers, fix root causes, then prefer no new code,
existing code, the standard library, native platform features and installed dependencies
before writing the smallest clear implementation. Avoid speculative abstractions,
dependencies and boilerplate; prefer readable code over clever one-liners.
Simplification stays within task scope and never removes necessary validation,
data-loss handling, security or accessibility. Nontrivial changes need runnable checks
within the role's existing permissions; performance claims need measurements.

These are default prompt instructions, not a new enforcement hook or a performance
guarantee. Existing worker verification and read-only reviewer rules remain unchanged.
No external plugin or dependency is installed. The guidance is part of the static
prefix: restart OpenCode and start a new session to load it, rather than changing an
active session's prefix.

## Model selection and output limits

Set role models in `.otter/otter.jsonc` with `models: { "worker": "provider/model-id" }`.
The provider is the first path segment; the remaining model ID may itself contain slashes.
An unset role inherits OpenCode's configured default, which may be a cloud provider; otter does
not silently switch providers. Worker/reviewer temperature is set to `0.2` only when the
effective model is explicitly known to use a local provider. Cloud temperature and reasoning
options are not assumed to be supported.

The framework's per-role output ceiling is further limited by a lower OpenCode request limit or
the selected model's declared positive finite output limit. Invalid explicit limits are rejected.
This is a request bound, not evidence that a remote provider enforces it or stops billing.

## Common Otter terminal

Bare `otter` and `otter chat` open Otter's composer with no engine or model selected, not the
OpenCode TUI. No model discovery, runtime setup, or model call happens at launch. Enter
`/model` in the composer to select **local** (the installed Ollama CLI), **Codex**, or
**Claude Code**. Chat and workflow input is refused with a `/model` hint until selection.
The default path runs natively in the current environment with `legacy-unowned`
verification; it requires no VM. Linux verifier qualification remains a separate,
explicitly selected facility, not a prerequisite for ordinary CLI use.
Startup selection can be supplied explicitly with both `--engine` and `--model`:

```sh
otter chat --engine local --model llama3.2:3b
otter chat --engine codex --model gpt-5.6-sol
otter chat --engine claude --model sonnet
```

### Chat execution (`chat.execute`)

Every execution is approved by the local human, one action at a time or one plan at a time.

| `chat.execute` | Chat model tools | Approval |
| --- | --- | --- |
| `"ask"` (default) | `read list glob grep memory` + `write edit multiedit bash` | every write, edit and command (read-only commands run without asking) |
| `"auto-edit"` | same | commands only; file edits apply and are noted |
| `"plan"` | `read list glob grep memory` | none (read-only; the model points to `/plan` and `!<command>`) |

- The mode shapes the main role's tool set, so it is part of main's policy identity (`otter:main:<sha>`); it applies
  when a runtime is created (model selection, `/new`, model switch). Workers, reviewers and workflow roles are unchanged.
- The host owns every decision (`ActionGate`, `src/hosts/chat-actions.ts`). Right before the effect it shows the action
  (edit diff, write content, command line and time limit) and asks [Allow once | Always allow `<rule>` | Deny]; readline
  shows a numbered menu where empty input denies. A denial is the tool result, so the turn continues and the model adapts.
- `bash` runs `/bin/sh -c` in the worktree without a terminal (`OTTER_CHAT_COMMAND=1`), time limit 120 s by default
  (`timeoutSeconds` 1..600), output tail to the model, process group stopped on Esc/cancel or timeout. `"interactive":
  true` hands the real terminal over after approval (editors, password prompts); its output is not captured.
- Refused even when the human would allow: privilege escalation (`sudo`, `su`, `doas`), deleting `/` or home, force
  push, disk formatting/raw disk writes, shutdown, fork bombs. The human can still run them with `!<command>`.
- "Always allow" saves a command rule (the first two words, e.g. `bun test`) to `chat.allow` in the user config only;
  a project config cannot pre-approve commands. Commands that chain, pipe, redirect or substitute never match or offer a
  rule. `/permissions` shows the mode and rules; `/permissions clear` removes them.
- Writes stay inside the worktree and never touch `.git/`, `.otter/`, `.gjc/` or `knowledge/raw/` (immutable wiki
  sources). Each command run is recorded as a shell card; each decision as an `action` record (tool, how it was decided,
  written paths, a command's rule prefix — never contents).
- **Read-only commands** run without asking (still shown and recorded): `git status|diff|log|show|blame|ls-files`,
  plain `git branch`/`git remote`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`/`grep`, `pwd`, `which`, `<tool> --version`.
  Chaining, pipes, redirection, substitution, `find -delete/-exec`, `-o/--output` and `env`/`printenv` always ask.
- **This-turn folder grant**: the approval offers "Allow edits in `<dir>`/ for this turn" (the deepest folder holding
  every written path); later writes under it in the same turn are allowed and noted. Never for commands; not saved.
- **`multiedit`** (gated main only): up to 20 exact-text edits across files, previewed as one diff and approved once,
  applied only if every old text occurs exactly once (in order per file); otherwise nothing changes.
- **`/undo [list | <turn>]`**: before a turn's first effect the worktree is captured (private Git snapshot: index,
  HEAD and objects untouched; outside Git only written/edited files are backed up) and again when the turn ends. `/undo`
  restores the files the turn changed, skips files changed again afterwards and lists them; the last 10 turns are kept.
- **Tool-call limit**: at 24 tool calls a chat turn asks to continue (24 more, at most 3 times) instead of failing;
  workers and workflow roles keep the hard limit.
- **Context**: Claude/Codex chat uses a 96,000-character conversation window (vendor main input estimate 49,152
  tokens); local and OpenCode keep 24,000 characters (8,192 tokens).

### Session history (`/history`, `/facts`, `/wiki`)

- Every executed CLI tool (codex/claude/local) joins `tool-outcomes.sqlite` like OpenCode tool events (identity, tool,
  status/basis, timing; a command's exit code decides its basis; denied calls never ran and are not recorded).
- When a chat session ends or is replaced, a deterministic **session digest** is written to
  `$XDG_STATE_HOME/otter/<worktree-key>/digests/<sessionID>.json` (outside the worktree): turns, tool and decision
  counts, written paths, commands as rule prefixes with status/exit/duration, workflow stages, outcome. Never message
  text, file contents, edit text, full command lines or output. `/history [<count> | <session-id>]` lists or shows them.
- **Project facts** (`/facts`) are deterministic aggregates of the last 50 digests: commands that keep passing,
  commands that keep failing, files changed in several sessions. An acting chat turn carries them as a bounded
  (600-character) reference block, labelled as data to verify, never instructions.
- **Auto-capture**: in a project with a wiki (`knowledge/AGENTS.md`, `wiki/index.md`, `wiki/log.md`) and
  `wiki.auto_capture` (default true; `"wiki": { "auto_capture": false }` turns it off), new digests are captured at
  session end into `knowledge/raw/session-digests/<sha>.json` + `wiki/sources/session-digests-<sha>.md`, the
  regenerated `wiki/reports/project-facts.md`, an index link and a capture log entry. Nothing is written when there is
  no new digest; a held wiki lock skips the capture (the digest stays and is captured next time).
- `/wiki` shows pending sources; `/wiki ingest` (chat execution only) asks the model to integrate them following
  `knowledge/AGENTS.md` (each wiki edit approved), then runs the wiki lint; `/wiki lint` runs it alone.

To skip `/model` on every launch, set a default. With neither `--engine` nor `--model`,
`otter` starts with `chat.default_model` from `~/.config/otter/otter.jsonc` (a project's
`.otter/otter.jsonc` wins per key), exactly as if both flags were given: no discovery, the
same preflight, and no fallback to another model if it is refused:

```jsonc
{ "chat": { "default_model": { "engine": "local", "model": "gemma4-26b-mtp:latest" } } }
```

In the full-screen TUI, selecting a model with `/model` (including `/model <engine> <native-id>`)
opens an **Apply model** picker: **This session only** uses it without changing the saved
default; **Set as default** also saves it to user config for future launches. The first option
is initially highlighted. Escape cancels the model change. Defaults are saved only after
the selected model is successfully applied; a save failure leaves it active for this session
and displays the error. Project configuration still takes precedence over the user default.

In the composer, `/model default` shows the effective default, `/model default save`
stores the current selection, `/model default <local|codex|claude> <native-id>` stores
that model (and selects it if none is selected yet), and `/model default clear` removes
the user default. Saving rewrites only that key in the user config, preserving comments,
refuses to overwrite invalid JSONC, and never switches an active session. An invalid
default is reported and ignored, leaving the composer unselected; a project default that
still overrides a saved user default is reported. Explicit flags always win.

### Engine sign-in (codex, claude)

Otter delegates sign-in to each vendor CLI and never reads, stores, forwards or prints a credential.

- `otter auth` (in chat `/auth`) runs each vendor's read-only status command (`codex login status`,
  `claude auth status --json`) and shows only signed in / not signed in / unknown plus the sign-in method label;
  account email and organization are not kept. Exit 0 when both are signed in.
- `otter login <codex|claude> [method]` (in chat `/login`, which asks for the engine and method) hands the real
  terminal to the vendor's own command: codex `browser` (`codex login`), `device` (`codex login --device-auth`, a
  one-time code for remote/headless machines) or `api-key` (`codex login --with-api-key`, the key is typed into the
  codex prompt); claude `browser` (`claude auth login`, subscription) or `console` (`claude auth login --console`,
  API billing). Raw input and progress redraws are released first; Ctrl+C stops only the vendor command. The new
  status is shown afterwards and a notice records the outcome (no credential data).
- `otter logout <codex|claude>` (in chat `/logout`, with a confirmation) runs the vendor's sign-out. It removes that
  CLI's saved sign-in for every program that uses it.
- `local` (Ollama) has no sign-in. `/login`, `/auth` and `/logout` work before a model is selected and while a session
  is held, never during a running turn.
- When a codex/claude model request fails or a model switch is refused, otter checks the status of the engines
  involved (anchor and combo routes) and names a signed-out engine with the command to sign in; a refused startup
  admission points at `otter auth` / `otter login`.

### Role combo

The `models` key above is OpenCode-only. In the native chat, `chat.combo` assigns a different
engine and model to individual roles; the model chosen with `/model` stays the *main* anchor:

```jsonc
{
  "chat": {
    "combo": {
      "planner":   { "engine": "claude", "model": "opus" },
      "architect": { "engine": "codex",  "model": "gpt-5.6-sol" },
      "critic":    { "engine": "claude", "model": "sonnet" },
      "worker":    { "engine": "local",  "model": "gemma4-26b-mtp:latest" }
    }
  }
}
```

Roles: `interviewer`, `planner`, `architect`, `critic`, `researcher`, `contrarian`, `simplifier`, plus
the worker-side roles (`worker`, `reviewer`, ...). `main` is not a combo role. A role uses its route
if set, otherwise the main model; a route never silently falls back to main, and an invalid or
unavailable combo is reported and not applied (chat start and `/model combo apply` print the reason
and keep running). A route is replaced as a whole object: a project route for a role replaces the
user's route for that role, a partial project route (for example only `engine`) is invalid, and a
project `null` removes the user's route. Model IDs must match `[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}`,
and a Codex route must name a bundled Codex slug. A route equal to the main selection is dropped.

In chat, `/model combo` (or the `combo` entry at the end of the `/model` engine list) offers recommended
templates and **Custom settings**. The GJC-inspired templates are:

| Template | Planning | Execution | Architecture / review |
| --- | --- | --- | --- |
| `astra-fable` | Codex GPT-6 Astra | Codex GPT-6 Luna | Claude Fable |
| `astra-fable-opus` | Claude Opus | Codex GPT-6 Luna | Claude Fable |
| `opus-codex` | Claude Sonnet | Codex GPT-5.6 Terra | Codex GPT-6 Sol |

Each template covers all routable roles; the preview shows the complete assignment. The main model stays
at the current `/model` selection (Astra pairs with `astra-fable-opus`, Opus with `opus-codex`).
These templates require both Codex and Claude; `/auth` checks sign-in and `/login <engine>` signs in.
They use Otter's bundled Codex slugs and native Claude aliases, rather than a live account model list.
Existing session preflight checks still apply. Saving a template atomically replaces user role routes, preserves unrelated settings,
and respects project overrides. After saving, the custom editor opens for further changes.
`/model combo presets` lists templates without changing anything; `/model combo preset <name>` saves one directly.

**Custom settings**, also available through `/model combo custom`, lets you pick a
role (each shows its current route or "main model"), then an
engine (or "Use the main model" to remove the route), then a model from the same discovered list `/model`
uses (or enter a native ID). Each pick is saved immediately and the menu returns to the role list; it also
offers "Recommended combos", "Apply to a new session" (once a model is selected), "Clear all routes" and "Done". The full-screen
TUI shows filterable pickers; readline shows numbered menus. Typed forms do the same without the menu:
`/model combo show` shows the effective routes, the source of each, and whether the current session uses them.
`/model combo <role> <local|codex|claude> <native-id>` saves a
route to `~/.config/otter/otter.jsonc` and does not change the current session. `/model combo clear <role>`
and `/model combo clear` remove user routes (any value, including a malformed one) and say so when a
project route still applies. Show, set and clear only touch config,
so they also work while a session is held. `/model combo apply` starts a new session with the carried
conversation under the saved combo; it is refused while a workflow is active or ownership is unsettled.
Choosing a recommended combo (menu "Apply to this session", or `/model combo preset <name>`) saves it and, once a
model is selected, applies it at once through the same path as `/model combo apply` (conversation carried; rebound
in place during an active workflow; refused while held). Before a model is selected it is saved and used by the
first selection. Custom role edits still only save until `/model combo apply`.
Status shows `engine / model +N roles`.

A combo applies to a session when it starts (or when a recommended combo is chosen, see above). The routes are pinned in the session metadata. Every non-resume new
session (a plain `/model <engine> <id>` switch, `/new`, `/model combo apply`) derives its routes from the
currently saved combo, normalized against the new main model, so a route that equals an intermediate main
model comes back when you switch away from it; an invalid combo is reported and not applied. `/resume` and the
common-engine recovery commands (`approve`, `resume`, ...) use the pinned routes, never the current
config. Recovery refuses a pinned route that differs from the execution evidence already recorded for a role;
a role with no recorded execution yet has no such evidence and is not checked. `otter cancel` and `otter pause`
dispatch no model and do not build routes. An unavailable route is named in the refusal (`combo route
unavailable: <roles> -> <engine> / <model>`). Ledger entries and `workflow.engine` keep the main engine; routed
roles are distinguished by their policy IDs.

Limits: roles run one after another, not as parallel model execution. There is no prompt-cache
continuity across roles, and no tier aliases (`opus`/`sonnet` are the engine's native names). Each
role's input budget is set per role (`roleInputLimit`), not per model. Switching between local Ollama models
can incur a model reload delay on the first call of each role.

Either flag on its own still opens the unselected composer; `/model` then asks for the
missing choice. Without an explicit model, `/model` offers numbered choices or native
model ID entry. Ollama choices come from a bounded, read-only `ollama list` probe in the same
subprocess environment as inference; unavailable or empty discovery is reported
without starting a service or downloading a model. Discovery happens only when the
operator requests `/model`; explicit `--model` skips discovery. Codex choices are the bundled,
version-pinned supported slugs, not an account entitlement query. Claude choices are
the native aliases Fable (`fable`), Sonnet (`sonnet`), Opus (`opus`), and Haiku (`haiku`),
not a fetched account catalogue. `/model claude fable` selects Fable directly.

Before initial selection, `/model` opens the engine and model pickers (using any
partial flag already supplied); `/model claude sonnet` selects that engine/model
directly. Cancelling either picker returns to the unselected composer. During idle
conversation, `/model` offers engine selection followed by that engine's models;
`/model claude sonnet` switches engines/models directly. Full-screen pickers filter
as you type and preserve the current selection on Escape or `/cancel`. They do not
dump their menus into the transcript. `/help` opens a contextual command palette:
Enter inserts the selected command; a separate submission is required to run it.
Readline prints contextual help and numbered engine/model choices. Empty input,
`/cancel`, or physical Escape in its pickers cancels without changing the current
selection or leaking partial selection text into the composer. EOF closes the
readline input owner; later reads return EOF rather than reusing a closed reader.
An actual `/model` switch keeps the conversation going: the earlier user/assistant
turns (newest first, up to 24 turns and the 24k-character conversation budget) are
carried into the new engine/model and sent with the next message, and stay visible in
the transcript under `Earlier conversation with <engine> / <model>`. Each engine/model
still gets its own durable session (ownership, admission and recovery stay bound to the
model that ran them); the new session records the carried turns with their source
session, engine and model, so earlier answers are never attributed to the new model and
the context survives `/resume`. Carried text is sent to whichever engine you pick,
including a remote one. `/new` starts without earlier turns; if the current conversation
cannot be read in full, the switch is refused rather than dropping context. No approval
is ever reused. Selecting the same engine/model keeps
the current session. Switching is refused while workflow state is corrupt or execution
ownership is unresolved; recover with the original engine/model/session instead.

**Model change during a workflow (same-session rebind).** While a workflow this session
owns is active (a deep-interview awaiting an answer, ralplan or plan pending approval,
ultragoal/autoresearch between steps), `/model <engine> <id>` and `/model combo apply`
do not start a new session. They rebind the current session in place at a step
boundary: the session ID, history and workflow stay the same, the session metadata
(`model`, `routes`) is rewritten durably under the attachment epoch, a `model-rebind`
transcript record `{from, to, workflowID}` is appended and replayed, and the next
workflow step runs with the new model's policy. The rebind is refused while any model
turn, queue run, activity or unsettled execution exists, when the session is held or not
epoch-current, or when the engine would change: the workflow records its engine, so the
refusal reads "the active workflow <id> runs on <engine>; pick another <engine> model, or
finish/cancel the workflow to switch engines." Settled executions keep the policy ID they
ran under; recovery compares only unsettled executions after a rebind, so a later
`/resume` attaches on the new model. During an interview answer prompt `/model` is
accepted too; type the answer afterwards. Without a workflow, an engine change still uses
the new-session-plus-carried-context path above. Cancelling the picker or a failed selection leaves
the current selection intact. Native host preflight must pass before a candidate
replaces the current selection. Held contexts omit `/model` from contextual help;
typing it explicitly is refused before discovery or switching, while the switch
guards still recheck ownership. These commands do not run model inference. Settled
model-request errors return to the composer only when persistence and ownership
remain safe; transcript append failures stay fail-closed without draft restoration.
The full-screen terminal returns to conversation after execution. Readline still
exits after execution; rejection exits either frontend. Model switching never
turns recovery into a different-model replay.

Bare `otter` opens a model-unselected home with `/model`, `/help`, and `/quit` actions.
The TUI follows the GJC arrangement: an empty session opens a bordered welcome box
(identity and selected model on the left, getting-started commands and flow keys on
the right); the transcript flows top-down. User, assistant and canonical-plan messages
sit under a `you` / `otter` / `plan` label with an indented body (user text on a
full-width bar when color is on); notices (`·`) and errors (`✗`) are compact glyph rows,
and tool calls show an outcome icon (`✔` succeeded, `✘` failed/denied, `⟳` running)
before the unchanged truthful summary, so provenance never depends on color. Assistant
and plan text is laid out as Markdown — headings, `•` lists, fenced code blocks, `▏`
quotes, rules, bold/italic, inline code and `label (url)` links — without interpreting
terminal controls in model output. While work is live, one status row names the most specific
current step with a spinner, its elapsed time and the cancel key: `⠧ Bash: bun test · 12s ⟦esc⟧`,
`⠧ Read src/math.ts:1-40 · 2.1s ⟦esc⟧`, `⠧ Task t2: Add multiply · 3.4s ⟦esc⟧`, `⠧ ralplan · critic · 1.2s ⟦esc⟧`,
else `Model request` / `Working` (ASCII `[esc]`). It only reports observed state and never infers progress.

Choices follow GJC: numbered rows with a `❯` cursor, `↑↓` to move, `1-9` to jump, Enter to select, Esc to dismiss
(`↑↓ move · Enter select · 1-9 jump · Esc cancel`); the status row shows `Waiting for your choice`. Deep-interview
questions may carry 2-4 ranked answer options from the interviewer (`options`, optional `recommended`): they appear as
a question with numbered options, `(Recommended)` on the suggested one, and a final `Other (type your own)` row that
opens an inline editor. The chosen label or typed text is recorded as the answer; dismissing returns to the chat
prompt (where `/finish`, `/pause`, `/cancel` still work). Options are stored next to the question
(`rounds/<n>-question.options.json`); the question text and its hash are unchanged. Readline prints the numbered
options and accepts a bare number or free text. Beneath it sit up to two status rows, a rule
carrying the `⬢ engine / model` badge, the workspace (`⑂ branch / ~/path`, read from `.git/HEAD` at most every
two seconds; `git:branch` in ASCII) and scroll position, and a bordered composer. An empty composer shows a muted
hint naming only what works in the current context (`Type a message · / commands · ! shell · …`; `Session held ·
/status explains …` while held); it is never part of the draft and is omitted under `NO_COLOR`, where it would read
as typed text. While chat is held the status row says why in words (`deep-interview workflow owned by another
session`, beside the `safety[…]` markers), the hint row names the way out in the same order Enter checks it
(`Observer · /model switch · /status · /resume <owner> opens the owner`, `Session held · /continue reviews and resumes`, …), and
the home panel replaces "Get started" with "Session held". The `/` palette uses GJC rows: a `❯` cursor, aligned
names, descriptions clipped with `…`, and a `(n/N) · ↑↓ move · Tab/Enter insert · Esc dismiss` footer.

Tool calls read like GJC: `✔ Read framework/test/cli-progress.test.ts:120-140 · 42ms`, `✔ Edit calc.py ⟦+2 / -1⟧ · 8ms`,
`✘ Grep "todo" in src · 15ms`, with the call/task facts on a muted line beneath (`▸ #1 · execution not observed ·
task … · t1`). The target (path, search pattern, read range, changed line counts) and duration come from a separate
display-only host channel that reaches only the full-screen transcript; the content-free tool lifecycle used by
progress, persistence and telemetry is unchanged, file contents are never copied, and restored sessions show the
outcome-only row. `/expand <n>` adds the call identity, the returned line count or the bounded error.

Shell commands render as titled cards: `┌─── ✔ Bash ───┐`, the full `$ command` (wrapped), an `├─── Output ───┤`
divider with the output tail, and a `⟦exit 0 · 1.8s⟧` footer. Each queue verify command gets the same card titled
`Verify · <task>` (and `· attempt <n>` after the first) with `⟦exit 1 · 2.4s · timeout 2m00s⟧`; it is recorded in the
session transcript with a bounded output tail (200 lines / 64 KiB) so `/resume` shows it again. The
ledger remains the authority for task outcome. Readline prints the verify run as a `[verify]` block.
`!<command>` is the operator shell escape: Otter hands the real terminal to `$SHELL -c <command>` in the worktree (like
`/login`), so interactive programs work (`vim`, `less`, `ssh`, `sudo` prompts, `git rebase -i`), and takes it back when
the command exits. Ctrl+C/Ctrl+Z from the keyboard reach the command; Otter ignores SIGINT meanwhile. There is no
timeout. Output goes straight to the terminal and is not captured: the session records the command, outcome and
duration, shown as a Bash card that says so (readline prints `[shell] exit 0 · 1.2s`). It is never sent to the model and
works before a model is selected.
While work is live, the composer's top border carries a progress bar built only from observed state, most
concrete first: a task run (`███░░ 3/5 tasks · 60%`, failed/cancelled counted as finished), ultragoal goals
(`1/4 goals`), the owned workflow's step (`step 2/5 · ralplan · architect`; a position, not a percent, because
revisions and interview rounds loop back), or, for a plain model turn, a sliding indeterminate bar. Waiting phases
(pending approval, paused, stuck) keep a still bar; nothing live means a plain border.
Readline mode (`OTTER_TUI=0`, or a terminal without full-screen support) prints the same task bar as a
`[progress] ####---- 3/5 tasks | 60%` line whenever a task finishes.
Pickers, command/skill suggestions and history search title the composer border instead and
list their choices beneath it; details, approval, session lists and read failures
occupy a bordered body panel that hides the retained draft and shows no active
prompt. Initial selection stays on the rule instead of dumping a path banner into
the transcript. A new conversation is identified by one compact notice.
Transient main-model activity stays in status rather than becoming chat messages;
errors and unconfirmed cancellation notices remain visible.
Unselected help offers setup, theme/ASCII accessibility controls, and `/quit`;
transcript search and task details become available after selecting a model.
`/quit` is the single exit command. The TUI is enabled when all
standard streams are TTYs, raw input is supported, `TERM` is set and not `dumb`,
and the screen is at least 60x20 (split panes included). `OTTER_TUI=0` selects readline. Unsupported
terminals receive a plain fallback notice; missing stdin/stderr TTYs still
refuse interactive operation. Noninteractive JSON/status commands are unchanged.
`NO_COLOR` disables semantic styling, not the TUI. `/theme neutral`, `/theme light`
and `/theme dark` select a process-local palette; `/ascii` toggles ASCII chrome.
Neither setting is persisted, and ASCII mode never rewrites user, plan, model or
receipt text. Shrinking below 60x20 shows only nonprivate recovery instructions
and blocks ordinary input, paste, queue and decisions; growing redraws the same
draft, pager, chooser and optional panel.

Enter submits; Shift+Enter (enhanced keyboard protocol) and Ctrl+J insert a
newline. Legacy terminals that send the same bytes for Enter and Shift+Enter
cannot distinguish them. Bracketed paste is one editing transaction and never
submits. Tab/Enter on a focused completion inserts only. Up/Down navigate
history at editor boundaries, and Ctrl+R searches submitted input.

To copy part of a reply, hold the left mouse button and drag across the visible transcript.
The selected text is highlighted; releasing the button copies it to the clipboard automatically.
No modifier key is needed. The view stays fixed during the drag so live output cannot shift the
selection. The mouse wheel still scrolls the transcript; scroll to older text before selecting it.
A click without dragging does not copy. Typing, scrolling, resizing, or switching sessions cancels
an unfinished selection. The composer and approval/picker controls are excluded from selection.

Ctrl+Y or `/copy` copies the latest assistant answer in the current transcript page,
including its complete Markdown/code and line breaks, without the TUI borders or labels.
Ctrl+Y preserves the draft and cursor. After searching or paging through history, copying
uses the most recent assistant answer in that loaded page. Local clipboard utilities are
used when available; otherwise an OSC 52 request is sent to the terminal (including over SSH),
which requires terminal clipboard support. For a portion of visible text, terminals that
support bypassing mouse reporting allow Shift+drag followed by the terminal's Copy command.
In the composer,
first Ctrl+C clears the draft; a second strictly less than 500ms later requests shutdown.
Details and pickers own their input without editing the underlying draft; Ctrl+D
and the double-Ctrl+C shutdown control remain available in these overlays.
Escape dismisses transient input UI or interrupts running work (a model turn or workflow step, a queue execution,
an unconfirmed cancel). With nothing running it never stops a workflow: an idle Escape on a restored interview or
approved plan only says `Nothing is running; Escape does not stop the <kind> workflow`; `/cancel` stops it and
`/pause` keeps it. When chat is held only because another session owns the active workflow, the session is an
`observer`: held commands plus `/model` (the palette and `/help` list it). Switching the model there never touches
the other session's workflow; chat stays blocked until that workflow is resolved (`/resume <owner>`). A hold on this
session itself, unresolved execution ownership or corrupt workflow state still refuse `/model`. While busy,
Alt+Q on macOS / Alt+Enter on Linux queues text for later serial turns; queued
text never answers choices or supplies execution approval.

Sessions are saved automatically in the current canonical worktree's state directory and survive
Otter restarts. Startup always opens a new conversation; previous sessions are chosen only when
needed. `otter --resume`, `/sessions` or `/resume` lists previous CLI sessions (newest activity first),
showing the first question, model, time, and session ID. Choose a session to restore its conversation,
model, and role routes, or choose **Start a new conversation**; Escape starts fresh. Saved defaults
apply only to new conversations.

```sh
otter --continue          # open the most recent saved CLI session in this worktree
otter --resume            # choose a previous session
otter --resume SESSION_ID # open an exact session
```

`/sessions` and `/resume [SESSION_ID]` are also available before selecting a model, including
in readline. Restoring opens the transcript and restores bounded complete conversation turns
for the next model request. The session remains held: enter `/continue` and choose Resume to
admit further work. Restoring alone does not execute pending tasks or send saved drafts.
Histories are scoped to the canonical worktree path; use `--worktree PATH` to open that worktree's history.

`/sessions` opens a captured, stable-ID retained-session chooser with original-index
paging and selected/visible-range indicators; it never refreshes or rebinds candidates
while pending. Enter passes the captured stable ID through the same `/resume` checks,
and navigation, resize, cancellation and opening history dispatch no work. `/resume
<sid>` remains the direct checked form. `/new` opens a fresh session. Session switching is distinct from `/continue`,
which offers Keep/Resume for the current session; noninteractive `otter resume
--session ...` remains work-resume. Switching refuses live turns, queues,
reviewers, claims and unsettled execution intents. A settled nonterminal owner
is held before its attachment is released; another session cannot take its work.

Accepted history is retained in private, numbered JSONL segments under the
external session state directory, independently of the bounded newest-complete-pair
model context. Search and paging include older segments; unsent drafts and queued
text never become restored model input. Every restored attachment starts held,
with no reusable process-local admission. Same-session owner rebinding requires
exclusive attachment and an exact released-epoch receipt or proven dead process
identity; rebinding itself does not resume work. `/status` never takes ownership.
Host session deletion retains history, metadata and execution evidence, and
releases only a matching attachment after termination and quiescence are proven.
Corrupt history or uncertain ownership stays held rather than being truncated
or reported as a complete replay.

Inline plan review keeps the exact canonical document independently scrollable from
its pinned decisions and binding. Document focus is initial: Up/Down scroll, PageUp/
PageDown page, Tab changes focus, and Enter cannot decide until decision focus is
explicit. Approve/Reject then opens the unchanged exclusive cooked-terminal
confirmation using the existing reader-issued, single-use receipt. Keep or Escape
leaves the plan pending without execution. Raw input and buffered paste are detached
before that reader runs.
`/pause` requests a pause and `/cancel` (or Escape) requests a cancel. Both are requests: the status line says
`pausing — termination unconfirmed` or `cancelling — termination unconfirmed` until the owner proves that no queue,
review, stage, broker wait, claim or unsettled execution remains, and only then shows `paused (from <phase>/<stage>)`
or `cancelled`. A cancel never exits the process while termination is unconfirmed. `/continue` on a paused workflow
shows the residual and done tasks and asks Keep or Resume; Resume rechecks every precondition, commits one `resume` and
runs only the residual tasks. `/continue` and `otter resume` refuse while a cancel is pending. Ctrl+Z requests a pause and
suspends only after the pause is settled with no blockers; otherwise it refuses.

Progress output separates model waiting, task lifecycle, tool activity, verification and
review from model replies, approval and the final result. It reports observed
activity rather than estimated completion percentages or OS-process health.
Repeated calls to the same tool are individual correlated items, including
denied and thrown calls; duplicate notifications for one call are not new calls.
The TUI uses `/search <tool/status/task>` to filter this session's transcript,
`/search` to clear the filter, `/expand <item number>` to show correlation and
termination evidence, `/details` to toggle the bounded task/evidence panel, and
PageUp/PageDown or the mouse wheel (three rows per notch) to scroll. The TUI enables SGR mouse reporting
(`?1000`/`?1002`/`?1006`) so the wheel scrolls the conversation instead of the terminal turning it into Up/Down,
which would recall submitted input; in an open list or palette the wheel moves the selection.
Left-button drags highlight and copy transcript text on release; isolated clicks do not copy.
The viewport identifies older/newer content, including
retained pages; multiline drafts have a separate overflow row that does not overwrite
their text or cursor. Help and completion share context-filtered command descriptors.
Transcript text preserves user, assistant, notice, error, and canonical-plan
provenance with a continuation gutter; canonical-plan text is presentation only,
not approval authority. Code/diff presentation remains inert. Collapsed tool summaries
distinguish the call outcome from unconfirmed or historical execution evidence.
The status view prioritizes held, read-only, ownership and unconfirmed termination/request
facts before ordinary activity, marks omitted facts, and avoids idle diagnostic noise.
Model discovery is recorded only when attempted; selection does not prove connectivity.
Tool arguments, raw tool output and
model response fragments are not progress messages. Model replies still appear
after the turn completes rather than as a token stream.

Known model-response failures keep the composer open only after settlement,
session ownership, hold and workflow checks succeed. They show a bounded error,
restore the failed draft only if the composer is still empty, and leave queued
input unadmitted until a manual submission. No retry or model switch is automatic.
Unknown failures and integrity/admission faults remain fail-closed. History read
failures instead quarantine the display: input, queues and decisions are blocked
while a visible diagnostic and safe exit remain available. This is not proof that
existing execution has stopped.

Required UX evidence is classified separately: the macOS native gate drives the
production TUI with the explicitly installed model and validates its current model
ID; the fixture matrix covers macOS local/tmux and Linux local/SSH/SSH+tmux PTY
transports. Fixture transport results are never reported as model inference, and
Linux-native inference is not part of this gate.

Progress is observational: it cannot approve work, acquire execution ownership or
change cancellation semantics. It is suspended while the human approval reader
owns the terminal. A cancellation request is not proof that a process has exited;
the existing execution settlement and recovery rules still apply.

Model names are native identifiers and examples, not a promise of account availability.
Models must follow Otter's JSON tool protocol and produce valid plans; malformed replies
are refused, never executed through a fallback. Selecting an installed local model does
not establish that it can complete the planning/execution workflow.
The worktree defaults to the current Git worktree; outside a repository the current folder is used as is (an
approved plan then has no plan worktree and asks before running in place). `--worktree PATH` selects another.
The terminal requires a TTY and uses existing vendor authentication. Model discovery
does not start Ollama, inspect credentials, install a model, or rewrite global
configuration. A manually entered local ID is not proof of installation; subsequent
inference uses the installed Ollama CLI's native `run` behavior.
The subprocess allowlist retains non-secret `USER`/`LOGNAME` for native keychain lookup and the variables that say
where the vendor CLI keeps its own sign-in and how it reaches its service (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*`,
proxy and CA-bundle variables), but does not forward API-key/token environment variables (`OPENAI_API_KEY`,
`CODEX_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`). `otter auth`, `/auth` and the
sign-in hint run the vendor status command with exactly this environment, so "signed in" means a model call finds the
same sign-in; a key that exists only in the environment is reported as "not signed in · `<VAR>` is set, but otter never
passes API keys to the CLI", and `/login` (which runs without those variables) stores the sign-in in the CLI itself.
These names do not establish execution authority. Vendor account quotas still apply.

All three engines use the same conversation → canonical plan → local human decision →
serial execution controller. Main/reviewer file tools are read-only. Otter owns the JSON
file-tool loop; native inference runs in a separate empty scratch directory rather than
the source worktree. Codex admission is currently Darwin-only and accepts CLI 0.159.3 or 0.163.0
with an exact bundled model slug. The model metadata remains pinned to the 0.159.3 catalogue.
An Otter-owned, hash-bound catalogue removes native patch, shell and code-mode tools, and native
goal tools are explicitly disabled; a named permission profile restricts residual filesystem
reads to the empty scratch workdir. The legacy `--sandbox` override is not used.
Version and catalogue checks precede inference; unknown models or drift refuse without
fallback. Unexpected native tool activity is an error. Workers do not receive a shell
tool; the existing queue owns verification.
Model output and previous approvals never approve a new plan.

File tools enforce application-level path policy, not OS filesystem containment.
Directory enumeration on macOS remains path-based: a concurrent local writer swapping
directories can expose filenames. It is not a defence against a hostile local process.

The terminal explicitly uses `estimated-input-reactive-output-v1`, separate from the
unchanged `legacy-unowned` containment profile. Input cutoffs are **estimated** at 8192
for main and 5120 for workers, including Otter's serialized instructions/tool schemas
and the separate Otter-authored Codex native instruction template.
Vendor-added context is unobserved. Output capture/cancellation is reactive, not a
native generation-token or billing ceiling. Neither assertion satisfies the strict
exact-token profile. Process-group quiescence is not escaped-descendant containment.

Conversation turns and worker runs record execution intents before dispatch, reuse
the existing execution lease, and retain unresolved ownership after failures instead
of replaying a completed or unknown process. The separate OpenCode imported-plan
commands below retain their own admission requirements.

### Intent routing (chat)

Before a plain chat line is sent, a code-owned heuristic (`classifyIntent`, classifier `otter-intent-v1`; no model call,
EN and KO keyword tables) proposes a route. It runs only after the same hold, ownership and workflow-occupancy checks an
explicit `/skill:<name>` start needs, never for slash commands, and never for `!<cmd>` (the shell escape).

| Class | Trigger | Route |
| --- | --- | --- |
| explicit | any `/...` line | unchanged; the classifier does not run |
| question | what/how/why/explain, 뭐/왜/어떻게/설명, trailing `?` without an imperative | answer-only turn; a plan JSON in the reply is **not** imported, a hint says to send `/plan` |
| implement | imperative with a concrete anchor (path, symbol, error, test), or no ambiguity signal | unchanged planning conversation |
| ambiguous | imperative with no anchor, or vague goals ("make it better", "개선해줘") | offer `Continue in chat` / `Start deep-interview` / `Cancel` |
| architecture | refactor, migrate, redesign, architecture, multi-module, ralplan, 계획부터 | offer `Continue in chat` / `Start ralplan` / `Start deep-interview first` / `Cancel` |

Offers use the terminal chooser, or a numbered readline menu without one; `Continue in chat` is always first, and only
workflows whose `startRefusal` is empty are listed. Dismissing or choosing `Cancel` sends nothing and restores the draft.
Starting from an offer goes through the same `workflowHost.start` path and builtin descriptor as typing `/skill:<name>`;
it is a start request, not consent to execute. Prefix a line with `force:` to skip the offer (the prefix is not sent).
Every decision is recorded as a transcript notice `Intent route {classifier, class, signals, offered, choice, route}`.
The classifier is a heuristic that proposes; it does not understand the request. Set `chat.intent` in
`otter.jsonc` to `"off"` to disable all of this (default `"offer"`; any other value is refused with `invalid-chat-intent`).
The OpenCode `chat.message` / `detectMode` path is unchanged.

### Plan worktree (chat)

An approved plan run executes in ONE linked git worktree named `wf-<workflowID>` (under the state root, outside the
repository). Every task's worker, verifier and reviewer uses it, later tasks see earlier tasks' unapplied changes, and
nothing is merged per task. Your checkout is byte-identical until you choose **Apply**. After the run Otter prints the
changed files, a diff stat and the patch path, then offers **Apply to my checkout | Keep worktree | Discard** (the choice is
recorded in the transcript). Apply runs `git apply --check` first, writes the apply marker, applies, then removes the
worktree. If the patch no longer applies (you edited the same lines meanwhile) the checkout stays untouched, the worktree
is kept, the patch is copied to `.otter/handoffs/<sid>/plan-<workflowID>.patch`, and `/continue` offers the choice again.
`diff_exclude` paths are not carried into the worktree.

With no commit yet or outside a git repository there is no silent fallback: Otter asks **Run in place in my checkout |
Cancel** before anything runs and records the answer. Ultragoal units share their workflow's worktree; their checkpoint
digest describes it (`worktree.isolatedAs`), and Apply is offered once, when the ultragoal completes.

Set `chat.worktree` in `otter.jsonc` to `"off"` to run in the checkout as before (default `"plan"`; any other value is
refused with `invalid-chat-worktree`). It lives under `chat`, outside policy identity, and does not touch
`delegate.worktree` (the per-task auto-merge mode used by OpenCode). Verify commands still run natively on the
`legacy-unowned` profile, so the worktree isolates repository edits, not side effects outside the repository.

### Interactive skills: where `/skill:<name>` comes from

Typing `/` in the TUI lists commands and skills together, fuzzy-matched by name (`/depp` finds
`skill:deep-interview`); Enter inserts `/skill:<name> ` and never invokes it. Skills are read from these roots, in
precedence order (the first root that has a name wins; two different directories in one tier are refused as
ambiguous, while the same directory reached through a symlink is one skill):

1. Project native: `.opencode/skills`, `.agents/skills`, `.gjc/skills` (GJC's project root; a symlink to
   `.agents/skills` adds nothing).
2. Home native: `~/.agents/skills`, `~/.claude/skills`, `~/.config/opencode/skills`, `~/.gjc/agent/skills`,
   `~/.gjc/skills`.
3. Import roots, filling only names no native root has: project `.claude/skills` and `.codex/skills`, then
   `~/.codex/skills` (GJC/oh-my-codex skills).

The four builtin workflow names below always win; a Codex/Claude copy of `ralplan`, `deep-interview`, `ultragoal`
or `autoresearch` is refused and hidden from the palette. A refused or unsafe GJC/import root is reported for that
root alone and never hides other skills.

Committed project skills are used directly. Other skills ask "Allow this content in this session" once per session
unless the operator trusts them in the **user** config (`~/.config/otter/otter.jsonc`):

```jsonc
{
  // skill names, or folders as absolute or ~/ paths
  "skill_trust": ["code-review", "~/.codex/skills", "~/.gjc/agent/skills"]
}
```

Trusted skills skip only that prompt, even when their content changes; tool permissions, path restrictions and
execution approvals are unchanged. `skill_trust` in a project's `.otter/otter.jsonc` is ignored, so a cloned repository
cannot approve skills for itself. An invalid list trusts nothing and is reported once per session; `/skills` marks
trusted entries and `/skills grants` shows `trusted by config`.

### Model-loaded skills (`skill_auto`)

Skill `allowed-tools` names are matched case-insensitively against Otter's tool registry. Unsupported names and
parameterized vendor entries such as `Bash(git:*)` are ignored; they cannot grant tools. Nonstring or empty entries
are rejected as malformed metadata. Automatic skill use retains the execution role's existing tool restrictions.

In a plain chat turn the main model sees a list of consent-free skills (name and description) and a `skill` tool. It
loads a skill when the request or the conversation calls for it, so a follow-up such as "write that up for the release"
can pull in a release-notes skill from context; nothing is preselected for it. Loading returns the captured
instructions as a tool result for that turn, with the same content checks as `/skill:<name>`; the role's tools,
read-only limits and approval rules are unchanged. The reply is preceded by `Skills used: <name>` and each load is
audited (`Skill tool load` notice, routing-log `skill_tool_load` event; no skill bytes or message text are stored).
Configured in the **user** config only:

```jsonc
{
  "skill_auto": {
    "mode": "auto",               // auto (default) | off
    "include": ["code-review"],   // import-tier (Claude/Codex convention) skills to admit by name
    "exclude": ["computer-use"]   // never list these
  }
}
```

- **Listed skills** are only those usable without any prompt: committed, unchanged project skills; home skills in
  `skill_trust` (by name or folder); project skills only under a trusted *folder* (name trust never lists a project
  skill, so a cloned repository cannot shadow a trusted home name). Grants from an earlier "Allow" prompt do not
  qualify. Native roots only, unless `include` names an import-tier skill; `exclude` always wins; protected workflows
  are never listed; a skill larger than the conversation's skill budget (about 14K characters) is skipped, and so is a
  skill with `disable-model-invocation: true` (explicit `/skill:` only). A declared `allowed-tools` never excludes a
  skill: automatic use runs with the planning role's own tools and does not bind it. Each turn lists at most 12, ranked against
  the request, with descriptions clipped to 160 characters; if even that would overflow the input limit, the turn runs
  without skills. `/skills auto` lists the candidates. By design, with the default `auto` a repository's committed
  skills are listed without any user action (tools and approvals are unchanged); set `exclude` or `mode: "off"` if
  that is not wanted.
- **Loads** re-check the current content and tool scope; anything that would need a prompt, is not listed, was already
  loaded this turn, or would not fit whole in the remaining input budget comes back as a tool error, never a prompt
  (a repeated refused call gets the same answer without reloading). Loaded instructions are never truncated: later
  tool results shrink first, and if the instructions themselves must go they are replaced by a notice that they no
  longer apply and are dropped from `Skills used`.
- **Opt-outs**: `force:` before a message (one message), `/skills auto off|on` (this session), `mode: "off"`.
  Explicit `/skill:` commands (which bind that skill instead), slash commands and turns during an active workflow get no
  `skill` tool. An invalid `skill_auto` block turns it off and is reported once per session.
- **Workflows** (`deep-interview`, `ralplan`, `ultragoal`, `autoresearch`) are never started automatically; the intent
  offer below remains the only non-explicit path to them. In `auto` mode, when the offer lists more than one workflow,
  the selector's pick is moved first and marked `(suggested)`; a failure or abstention keeps the fixed order. The
  selector judges with the same engine as memory recall (`memory.engine`, default `auto`: the Claude CLI, else Codex,
  run tool-free; claude-haiku-5-5 / gpt-5.6-luna unless `memory.model` is set), at most 15 s; OpenJev only when
  `memory.engine` is `jev`.
- **Live check**: `bun scripts/otter-skill-tool-smoke.ts local gemma4-26b-mtp:latest "<turn 1>" "<turn 2>"` runs the
  real host and engine in a scratch worktree with a fixed two-skill catalog. On 2026-10-19 (`artifacts/skill-tool-smoke/`
  plus five more runs) a context-only follow-up ("그거 정리해서 배포용 문서로 써줘") loaded the release-notes skill in
  5/5 conversations and the unrelated turns loaded nothing (10/10). One of 15 turns failed with a malformed JSON
  envelope (an unescaped code block in the final text), a local-model formatting failure rather than a skill call.
- **Load evaluation** (`bun scripts/otter-skill-load-eval.ts --engine local|claude|codex --model <id> [--exclude plan]
  [--none-every N] [--shard i/n] [--reps N] [--journal f] [--out f]`) measures the decision that matters: whether the main
  model in an ordinary chat turn loads the right skill, and only then. It runs the production plan-conversation and
  cli-host path in a scratch worktree whose committed skills mirror this repository's, with the operator's home roots and
  user `skill_trust`/`skill_auto`, the catalog from `SkillSession.autoCandidates`, and the real captured SKILL.md bytes.
  It reports recall (completed and end-to-end), precision, `none` false positives, wrong-skill picks, per-skill recall
  and failed turns by host reason. 2026-10-19, claude-haiku-5-5, 87 cases (no `plan`, every second `none`;
  `artifacts/skill-load-eval/`): the catalog wording "check these descriptions before inspecting files or answering;
  load every one that covers what the user wants done; not for a question that only asks what something is" raised
  end-to-end recall from 27/53 to 32/53 with precision 32/32 and 0/32 `none` false positives (old wording 1/34, a
  prompt injection). On gemma4 (30-case shard) loads went from 10/19 to 14/19 with the same false-positive count. A
  rerun of the final code (`claude-final-2026-10-19.json`) gave 29/53, precision 29/30, 1/34 `none` false positives,
  and 5/87 failed turns (4 CLI transport, 1 reply format), so expect a few cases of run-to-run spread.
- **Reply format**: a strict whole-body envelope (optionally fenced, any fence language; a tool name may be the type,
  `{"type":"skill","name":"x"}`) is read for every tool. From any other reply the host takes only **read-only** calls
  (read, list, glob, grep, memory, skill) — wrapped in pseudo-XML (`<invoke_tool>…`), behind a sentence, or batched (the
  first runs and the model is told the rest did not); a `write`/`edit` anywhere outside a strict envelope fails the reply,
  so prose that quotes or narrates a write never performs it. A final whose text has unescaped quotes or raw line breaks
  is repaired to final text only. The read-only main role keeps a plain-prose reply, or prose that merely mentions an
  envelope, as its answer. Unknown tools, a final mixed with calls, several finals and malformed shapes fail closed. Before this, 32% of claude-haiku turns in the load evaluation failed on the reply format; after it, 5-9%.
  A failed model turn now adds why after the fixed message (`… Reason: The model's reply was not in the required
  tool/answer format.`, input budget, deadline, tool rounds, …).
- **Telemetry**: each chat turn that offers the skill tool writes a `skill_turn` routing event (skills listed, loaded,
  refused, withdrawn, catalog dropped, outcome and failure reason); loads also write `skill_tool_load`. The routing
  reader and `otter wiki capture` report now include them ("Skill tool turns": per-skill listed vs loaded, turn outcomes
  by reason) and accept Claude/Codex-judged decisions, which they used to reject.
- **Router evaluation** (`bun scripts/otter-skill-route-eval.ts --engine auto|claude|codex|jev`) measures that selector.
  2026-10-19, 132 labeled cases (`artifacts/skill-route-eval/report-2026-10-19-{claude,codex}.json`): claude-haiku-5-5
  passed the gate (9 picks, all correct; 0/68 `none` false positives, 0 adversarial; p95 4.9 s) but is conservative
  (recall 14%). gpt-5.6-luna recalls 92% but failed the false-positive gate (3/68 `none` cases picked: a question about
  a skill, two OMX requests mapped to look-alike skills; p95 6.6 s). `auto` prefers Claude. Earlier OpenJev measurement: 2026-10-18 (`artifacts/skill-route-eval/`): after restarting a hung MLX server, 24 of 132 cases were answered
  (all positives: 22 correct, 2 abstained, 0 wrong); every `none`/adversarial case timed out, so its false-positive
  rate is unmeasured; answered latency was 63-90 s under memory pressure. It no longer decides which ordinary skill
  applies.

### Otter workflows: truth labels and the four kinds

Otter owns four workflow kinds on one authority (`workflow/workflow.json`) and never runs GJC. They are started only by
a submitted `/skill:<name>` command that matches a **builtin protected name** (or by choosing one in the intent offer); a project or home skill with the same
name cannot supply instructions or redirect the kind (it is shown as refused), and model output or text that merely
mentions `/skill:ralplan` starts nothing. **Invoking a name is not consent to execute anything.**

| Kind | Status in this build | What it is |
|---|---|---|
| `plan` | available | `/plan` → local human `APPROVE` → verified workers (unchanged). |
| `deep-interview` | available (P6a) | Code-owned interview: topology confirmation, one question per round, code-computed ambiguity, independent researcher/contrarian/simplifier (+architect) panels whose records must all verify, closure, restatement, then a verified `spec.md` with the final ambiguity and threshold. |
| `ralplan` | available (P6a) | Planner → independent architect/critic review → revision up to five openers; consensus needs Architect `CLEAR`/`APPROVE` and Critic `OKAY` on the **same plan hash**, re-derived from disk, then `pending-approval.md` + `consensus.json`. |
| `ultragoal` | available (P6b) | A direct start decomposes the objective and reviews one unit at a time. No implementation command runs until the current pending unit is approved with its exact `APPROVE-UNIT <workflow id> <subject sha>` receipt. |
| `autoresearch` | available (P6b) | A direct start runs the research mission. No experiment command runs until the current pending experiment is approved with its exact `RUN <workflow id> <subject sha>` receipt. A verified verdict can be productified into a fresh deep-interview; no execution consent is inherited. |

Usage in the terminal (`otter` / `otter chat`, TUI or readline):

```text
/skill:deep-interview <request>   start an interview (the TUI status line shows `deep-interview · <stage> · <phase>`)
/skill:ralplan <request>          start consensus planning on its own
/skill:ultragoal <objective>      start goal decomposition; units still need exact APPROVE-UNIT receipts
/skill:autoresearch <mission>     start research; experiments still need exact RUN receipts
/finish                           early-exit request; allowed from round 3 above the threshold, and closure + restatement still run
```

Workflow questions, the topology and restatement confirmations, stuck Retry/Keep, the round-cap choice and the
consensus choice are **inline chooser lists** (a numbered list under readline). Between choices the next chat line is
the answer to the open question (bounded to 10,000 characters). `/pause`, `/cancel`, `/status`, `/continue` and Escape
behave as for a plan: Escape interrupts the running step and leaves the committed state, `/pause` and `/cancel` are
requests labelled `pausing — termination unconfirmed` / `cancelling — termination unconfirmed` until the owner proves
quiescence, and `/continue` offers Keep/Resume.

**Preset (AC-W3).** A deep interview that reaches a *verified* `spec.md` connects to a ralplan in the same live
session epoch with exactly one committed handoff: the ralplan carries `lineage` (interview id, revision, spec path and
sha256) and its planner reads that exact spec. The connection is refused — and the verified spec is simply kept — when
the session is held, a pause/cancel is pending, the session is not the owner, or the spec changed. Cancelling the
ralplan keeps the interview's spec.

**Known edges (stated, not hidden).** When the connection to ralplan is refused, the interview still completes with its
verified `spec.md`, but the successor has no `lineage`: starting a ralplan by hand later is a fresh workflow seeded by
nothing. A crash before a commit's index publish can leave readable files under `.otter/workflows/<sid>/<wid>/` (a spec,
a round file, a plan iteration) that no committed revision references; they are orphans, never authority, and a status
read or the next commit ignores them. Interview completion re-verifies every panel, closure, topology, restatement and
early-exit record from disk at the commit, at the handoff, and on every display; a deleted or edited record refuses the
commit or shows `incomplete`. Failed-attempt counts are committed, so Escape + `/continue` or a restart cannot reset the
two-attempt limit.

**Consensus is not consent.** Reaching consensus shows `Architect CLEAR/APPROVE + Critic OKAY · execution pending`.
*Stop here* ends with `planning complete; not executed`. *Execute via ultragoal* needs the exact typed text
`EXECUTE <workflow id> <plan sha>` and then only connects the plan to ultragoal; each implementation unit still needs
its own exact `APPROVE-UNIT` receipt before anything runs. Direct `/skill:ultragoal` and `/skill:autoresearch` starts
follow the same rule: invoking a name creates or resumes the workflow, never execution or experiment consent. Planning
workflows run read-only roles only and create no ledger tasks.

**Truth labels.** Every claim above is computed from committed state: panel completeness, consensus and the `spec.md`
verification are recomputed from disk on every display and restore (a missing, edited or unverifiable artifact shows
as `incomplete`, never as remembered-verified). Fake-model tests prove the logic; they are not live-model proof. The
OpenCode host cannot start these workflows (it observes only), and the loopback-model PTY scenario `workflowDI`
proves dispatch, engines, status line and choosers with scripted replies, not model quality.

### Autoresearch and ultragoal: a verifier that timed out (operator recovery)

Autoresearch experiment commands (and ultragoal verify commands) run through the framework verifier. With the default
`legacy-unowned` verifier a command that exceeds `delegate.verify_timeout_ms` (120 s) or is killed is only known by its
parent shell: descendants cannot be proven stopped, so the execution stays **fenced** and the run claim is retained.
Autoresearch records the run (`runs/<n>.json`, `valid:false`, `invalid:"unsettled"`, plus its verification receipt), shows the
reason in the stuck state and refuses Retry while the fence exists. A pending pause or cancel keeps reporting `pausing` /
`cancelling` with the fence reason; it is never labelled `paused` or `cancelled` until termination is proven. A pause or
cancel issued while a legacy command is running does not kill it: it runs to exit or to its deadline, and the run is then
recorded as `interrupted` (autoresearch) or settles normally (queue). To recover: confirm no stray process from the
experiment remains (`ps`, check the worktree for stray files), then cancel the workflow and start a new one; the fenced
execution record and the recorded runs are retained as evidence. Use the Linux single-use verifier profile when
descendant containment is required.

### Read-only status dashboard

`status --json` emits schema version 1. Top-level `schemaVersion` and `generatedAt` identify
the contract and snapshot time. `workflow` is either null or a bounded workflow summary;
when present, its `engine` identifies the recorded host and `planSha` is the validated canonical
plan hash. `session` reports the selected ID, source (`arg`, `workflow`, or `none`), mode, task
counts, and queue projection; `execution` reports the unresolved count, generation, claim
liveness, and the deliberately unknown usage state. `freshness` contains source timestamps,
the 90-second stale threshold, workflow-owner heartbeat age, and whether the bounded event tail
was truncated. `events` contains only the last five concise events. It never includes plan
bodies, task details, verification output, review reasons, reports, handoffs, SQL, or answers.

Session selection is explicit `--session` first, then the current workflow's owning session,
then `no-session`. A missing session yields `queue: unknown` rather than claiming idle.
`status --detail` is a CLI-only allowlist: at most 50 newest tasks, 20 other sessions and 10
archived workflows. Task outcomes are enums; paths, command output, error text, review reasons,
handoff contents, and private task fields are excluded. Only approved workflow task titles are
shown; other tasks use a generic label. The full status document with detail is capped at 64 KiB.
Core input files are capped at 12 MiB + 384 KiB total; additional detail reads share an 8 MiB
budget, for a combined input cap of 20 MiB + 384 KiB. When that budget prevents remaining
session or archive reads, `detail.budgetExhausted` is true. Directory scans retain at most 500
session entries and 1,000 archive entries, with one lookahead to detect more entries. The
corresponding `detail.sessionsScanTruncated` and `detail.archivesScanTruncated` flags mean
newest-item selection is limited to the scanned subset. When the output cap is reached,
sections are dropped in this order: events, history, sessions, tasks, with counts in
`detail.truncated`; `detail.truncatedTasks` records tasks omitted by the initial 50-task limit.

Queue states are `idle`, `running_here`, `running_elsewhere`, `stale`, `blocked`, or `unknown`.
Classification uses both the in-process queue flag and durable ledger pointers, task state,
execution claim, and unresolved executions:

| State/evidence | Meaning |
| --- | --- |
| `running_here` / `in_process_flag` | This process reports a live queue. |
| `running_elsewhere` / `claim_pid_alive` (`+cancel_requested` when applicable) | A live pid holds the matching claim and task pointer; progress is not proven. |
| `stale` / `claim_retained_here_inactive`, `running_pointer_orphaned`, `claim_pid_dead`, `running_without_matching_claim` | A persisted pointer or claim does not prove active work. With no open tasks, `+no_open_tasks` shows that status leaves the stale pointer unchanged and does not suggest resume. |
| `blocked` / `claim_retained_unresolved`, `dead_owner_unresolved` | Execution is fenced or unresolved; status does not imply it is safe to retry. |
| `unknown` / `no_session`, `claim_alive_no_task`, `claim_alive_no_task+phase_reviewing` | The available evidence cannot classify queue activity. |
| `idle` / `no_running`, `claim_other_session`, `claim_pid_dead` | No active pointer is evidenced for the selected session; a dead claim notes that the next run takes over automatically. |

Evidence uses a primary identifier with zero or more modifiers (`primary(+modifier)*`); the
closed modifier set is `cancel_requested`, `phase_reviewing`, and `no_open_tasks`. When multiple
modifiers apply they appear in that order. `phase_reviewing` is emitted only for the selected
session's reviewing workflow.

Workflow-owner liveness and execution-claim liveness intentionally differ. Workflow-owner
liveness requires the owner session directory, a live PID, and either this plugin instance
or a heartbeat younger than 90 seconds. Execution-claim liveness uses the run-store's
`process.kill(pid, 0)` predicate and does not prove queue activity or descendant retirement.
Cross-file snapshots can skew while writers atomically replace individual files; timestamps
are surfaced per source and are not a transaction or authority grant.

`status --watch --json` emits NDJSON frames with `{type, seq, reason, status, error, meta}`.
`meta` (`tick`, `readMs`, `bytesRead`, `statCalls`) is watch-only and is not part of schema
version 1. `bytesRead` includes bytes consumed before a read failure; `statCalls` counts the
watcher's path-stat probes. Watch emits an initial frame, then only changed projections or
liveness changes; ages alone do not emit. Read failures emit one error frame per distinct
source/code and polling continues, retrying reads on changed stats or the tenth-tick forced
refresh. SIGINT/SIGTERM exits cleanly. Text `--watch` requires a TTY; `--interval` accepts
integer seconds from 1 to 60 (default 2). Invalid arguments retain CLI exit 2; runtime failures use exit 1. Status
read failures exit 3 and print only the source and code to stderr.

The dashboard is display-only. A stale/blocked hint, when present, names an existing resume
boundary but does not invoke it; status, watch, and detail never take over ownership or repair
pointers. The owning chat `/status` is also read-only, including a dead recorded owner. An
OpenCode TUI sidebar is not implemented: it remains gated on proving extension loading against
the pinned runtime and a separate decision. No GJC dashboard parity is claimed.

### Recovering a common-engine workflow from a new process

Read the active workflow and original session without constructing an engine runtime:

```sh
otter status --worktree /path/to/repo --json
```

Use the workflow ID and `sessionID` from that status. For approval or rejection, use the
`planRef.jsonSha` from the active workflow record (the canonical plan hash, not the rendered
Markdown hash); the original approval prompt also prints this value. If it was not retained,
the record is `workflow/workflow.json` under Otter's external control-plane state root. Specify the
original engine and exact model explicitly; Otter refuses missing or
mismatched engine/model/session evidence and never falls back to another selection:

```sh
otter pause --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID
otter cancel --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID
otter approve --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID \
  --workflow WORKFLOW_ID --sha PLAN_SHA
otter reject --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID \
  --workflow WORKFLOW_ID --sha PLAN_SHA
otter resume --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID
```

Approval and rejection still prompt the local operator for the exact workflow ID and plan SHA;
there is no automatic approval. The controller verifies persisted owner-session host intents against
the selected role policy before decisions or recovery. A settled resume retains completed tasks and
dispatches only open work. If any prior execution is unsettled, ownership proof is missing, or the
owner session/engine/model does not match, recovery refuses before changing durable workflow or
ledger state. It does not signal persisted PIDs, adopt or forcibly release an owner, delete state,
or replay an unknown execution. Cross-process cancellation can settle a pending approval once all
existing executions are settled; unresolved cancellation refuses without changing its existing
unknown/fence evidence.

## Foreground imported-plan runner (OpenCode)

**Currently refused:** foreground `import`, `run`, and `resume` cannot pass admission with
the existing OpenCode hook-control map. It lacks the required role-control statuses;
connecting a server or approving a plan does not bypass that gate. Read-only `status`
and help remain available. These commands do not yet provide a working standalone
Claude Code/Codex execution path.

The retained runner targets the real, already-running local OpenCode service with this project's
Otter plugin; it never starts a daemon or falls back to another engine or model. Its plan contract
requires canonical JSON inside the worktree (3–10 steps). The retained command syntax is:

```sh
otter status --worktree /path/to/repo
# Execution syntax only: currently refused at admission.
otter run --plan plan.json --worktree /path/to/repo --server http://127.0.0.1:4096
otter status --worktree /path/to/repo --json

# Equivalent source-tree syntax; run/resume are also currently refused:
bun src/hosts/cli.ts run --plan plan.json --worktree /path/to/repo --server http://127.0.0.1:4096
bun src/hosts/cli.ts status --worktree /path/to/repo --json
bun src/hosts/cli.ts resume --session SESSION_ID --worktree /path/to/repo --server http://127.0.0.1:4096
```

`otter --help` and `otter -h` print usage and exit 0 before accessing a worktree, configuration, state
or server. Bare `otter` launches interactive chat as described above. The supplied worktree must be an accessible directory. Mutating
commands require an already-running, trusted local OpenCode service and this project's Otter plugin;
`run --plan`, `approve` and `reject` also require an interactive local terminal for explicit human
decisions. Standalone commands do not start a server or provide interactive chat; the separate
chat command uses the common Otter terminal above. Neither path
auto-approves plans or establishes native-host qualification.

Exit codes: **0** means success or help; **1** is a fixed host-admission diagnostic or a
redacted runtime refusal/failure; **2** is
invalid command-line usage or an inaccessible worktree; **3** is a typed status read failure
or a `LinuxAdmissionRefused` admission refusal with bounded reason codes.

After successful admission, the `run --plan` contract validates and advisory-reviews the saved plan, shows its canonical file/hash, and
requires an interactive local terminal to type `APPROVE <workflow-id> <plan-sha>` or
`REJECT <workflow-id> <plan-sha> <reason>` before any task runs. No auto-yes or noninteractive
approval exists. The explicit loopback `--server` must be trusted by its operator; its API
inventory can reject conflicting plugin or reviewer configuration, but cannot authenticate a
malicious local service that lies about its own hooks. It creates one native parent session,
runs tasks serially with code-owned checks
and independent read-only reviewers, and preserves durable claim/fence state across processes.
`status` reads only local state, without an SDK client, credentials, or model request. `cancel`
and `resume` require the exact owner session ID. Cancellation preserves the owner and stays
pending while execution retirement is unproven; acknowledgement is not quiescence.
SIGINT/SIGTERM during a run requests cancellation. A detached
process from a worker shell command cannot currently be proven stopped by a prompt response:
such an execution remains fenced rather than verifying, merging, or releasing its claim.
After a coordinator crash, OpenCode recovery must match the persisted execution, child,
parent and request-message identity against a completed final SDK response. An idle status
alone, a completed intermediate tool-call step, or an abort acknowledgement is insufficient.
Incomplete tools, mismatched evidence and durable shell/process risk keep the execution fenced.
An inconclusive recovery leaves the interrupted ledger intact for a later explicit retry.
Code tasks retain their original private Git baseline outside the worktree across restart:
edits made before the crash remain part of verification and independent review, even if the
replacement worker changes nothing. Missing or invalid recovery baselines are refused rather
than replaced with a snapshot of already-modified files; this also applies to older interrupted
runs without retained baselines. Completed tasks are not dispatched again.
Interrupted `delegate.worktree: true` tasks reopen only their original owned linked worktree:
durable session/task identity, Git registration, original HEAD, exclusions and baseline must
still match. Recovery never deletes and recreates that worktree or imports a new baseline.
Verification, independent review and merge share the original private snapshot. Native hooks
in the linked directory resolve the authoritative owner execution record, including cancellation
and durable shell-risk checks. Conflicting destination edits, invalid ownership and ambiguous
interrupted applies refuse automatic completion and preserve work for inspection. Older isolated
tasks without ownership metadata cannot be silently adopted.
Trusted scripted fixtures can use read/write/edit tools and the code-owned verifier.
The current Darwin/shared-server verifier is `legacy-unowned`: its durable record states
`isolationEstablished=false`, `domainState=unknown`, `descendantRisk=unproven`, and status
renders `verification: passed (legacy-unowned, descendants unproven)` after a successful task.
Ordinary parent exits, including nonzero exits that permit a trusted retry, remain a weak
legacy completion policy, not descendant-retirement proof. Timeout, cancellation, observed
parent termination signals, unknown outcomes and fenced executions do not authorize another
attempt, review or merge. A dead coordinator does not retire its verifier descendants.
Verifier intents record an explicit pre-dispatch lifecycle; the dispatch marker is persisted
before invoking the executor. Only a proven never-dispatched intent can be retired without
running or replaying it. A crash after the dispatch marker remains ambiguous even if no
process actually started. Older verifier records without that lifecycle remain unresolved,
including historical parent-exit results; they are not automatically migrated or adopted.
Missing references or terminal records are not evidence of non-dispatch.
**Do not run untrusted work through this foreground runner yet.** The preserved
`worktree.test.ts` adversary demonstrates that a detached verifier child can still change a
protected test after the parent exits and the legacy task is accepted. The separate
`linux-single-use` strict control is blocked/not-run without an operator-provisioned local
systemd lab and fixed units; legacy success earns no F2/F3 safety credit. No Linux owned-host
profile or cloud provider egress is enabled by this Darwin work.

The explicit `createLinuxVerifierExecutor({ qualification: true })` path requires an
operator-installed root gate, dedicated verifier UID, systemd and unified cgroup v2.
The installer leaves `/etc/otter-verifier/profile.json` at `qualified: false`; production
preflight refuses it, and OpenCode runtime defaults remain legacy. Qualification scripts
must run in an isolated lab, not a workstation containing credentials or unrelated jobs.
Private Git inputs are exported exactly, without archive attribute transformations, with
a 16 MiB transport limit. Unsupported archives are refused rather than normalized.
The fixed systemd limits are 120 seconds, 512 MiB and 128 tasks; longer requested
deadlines are refused. Cancellation targets an identity-bound cgroup descriptor.
Retirement requires native cgroup deletion and exact PID1 journal correlation,
not parent exit or an empty-group observation.
Preparing a single-use ticket cannot launch the workload; durable dispatch precedes start.
Only a root-signed receipt bound to the exact ticket, boot, native invocation, cgroup and
result can authorize native retirement. Adapter booleans, matching JSON, test keys and
cancellation acknowledgements cannot grant that authority. Authentication precedes the
post-verifier snapshot, review, restoration or merge. Unknown ownership or retirement
preserves the ledger and original baseline without replay or rebaselining.
Unresolved bound tickets retain their input and pending-capacity allocation, even
across boots (16 pending tickets or 128 MiB of pending archives). Missing retirement-journal evidence remains
unproven and is retried; there is no automatic reset or reclamation of unknown state.
These availability limitations remain part of the unqualified, lab-only profile.
Pure crypto tests and manager probes are not native qualification; real-process and
real-queue qualification are separate from actual-model execution and whole-agent safety.

For actual-model qualification, `scripts/otter-live-core-queue.ts` has an explicit
`--verifier linux-qualification` route. Its default remains `legacy`. The driver
keeps the real OpenCode worker/reviewer host and recovery callbacks, replacing only
the verifier in a lab-local runtime copy. Run the server and driver as the installed
profile's non-sudo controller UID, with matching isolated `HOME`, XDG directories
and `OTTER_STATE_HOME`; keep framework sources and installed authority root-owned.
The fixture requires isolated task worktrees, enabled policy hooks, strict review,
three protected plan steps and explicitly allowlisted verification commands.

```sh
bun scripts/otter-live-core-queue.ts \
  --worktree /absolute/lab/work --server http://127.0.0.1:58355 \
  --scenario success --verifier linux-qualification \
  --receipt /absolute/lab/success.json
```

Use fresh fixtures for retry, review rejection, worker cancellation, active-verifier
cancellation, worker interruption, checkpoint interruption and active-verifier
interruption. Resume with
the original receipt, parent session ID and verifier mode; never substitute a new
ledger or baseline. Model access must use only the intended inference endpoint,
without shared host mounts, forwarded credentials or model-administration access.
Real model transcripts and authenticated verifier receipts are separate evidence;
neither establishes worker/reviewer OS containment.

Operational recovery stays fail-closed: preserve the ledger, private baseline,
ownership record and exact verifier reference before diagnosing a refusal. Restore
unavailable trusted journal access and inspect that same ticket; only an authenticated
receipt can authorize further queue recovery. Do not replace missing journal evidence
with parent exit, empty-group observations or operator-written JSON. If ownership or
retirement remains unknown, quarantine the guest and preserve its disk/records; use
a fresh guest for new qualification rather than deleting tickets to recover capacity.
Retire processes only through authenticated held domain descriptors or whole-guest
shutdown, never persisted PIDs or a mutable workload unit name.

The 2026-10-07 final-source actual-model lab run exercised all eight scenario families
with OpenCode 1.18.33 and local `gemma4:26b-a4b-it-mtp-q4_K_M`: nine separate
fixtures, 16 driver invocations and real independent reviewer sessions. The installed
authority reauthenticated 19 model-queue verifier results plus one journal probe.
An early busy-session refusal preserved the ledger, execution identities and attempts;
later recovery completed without replaying finished work. One active-verifier follow-up
failed with an OpenCode worker `MessageAbortedError`; its cause remains unestablished,
its task was not merged, and its evidence was retained. A separate unchanged-input
fixture recheck passed. Resumed reviewers received the original cumulative diff.
The journal probe refused retirement during lost journal access and authenticated the
same ticket after restoration without replay. These observations do not establish
unconditional model availability or resolve permanently missing evidence and
unknown-bound capacity retention. Admission remains **lab-only, `qualified: false`**,
with unchanged legacy runtime defaults.

### Single-boot operational admission

The historical run above does **not** qualify the newer admission implementation.
Operational eligibility still requires its own passing regressions, native fault
tests, actual production-path canary and strict model soak. No production deployment
or worker/reviewer OS containment is implied.

Select the verifier explicitly in the ordinary user/project Otter configuration:

```json
{ "delegate": { "verifier": "linux-single-use" } }
```

An absent selector retains `legacy-unowned`; project settings override user settings.
An invalid selector, malformed configuration or unreadable configuration (including
an inaccessible ancestor) is fatal, never a fallback to legacy. Diagnostics contain
the configuration path and error category, not its contents. This fail-closed loading
also applies when the intended configuration was legacy. Host worker/reviewer records
always remain `legacy-unowned`, regardless of the verifier selection.

The root-installed v2 profile pins `bootEpoch` to its installation boot. Older
profiles are refused rather than migrated; preserve their guests and evidence.
Any reboot, even with zero execution records, refuses new work before accessing
old controller state. Do not repair, move or rebaseline that state. Use a new guest.
Each guest retains its original signing key; key rotation and disk/memory snapshot
rollback are unsupported.

The installer leaves `qualified: false` and installs a hashed journald persistence
drop-in. Admission checks effective persistent storage, a current-boot entry in the
persistent journal, and journal readability. Persistence is not a guarantee against
vacuum, disk exhaustion or permanent evidence loss. Unknown bound tickets and
current-boot active tickets still unproven after `deadlineAt + 120 seconds` cause
permanent root-owned quarantine, as does an epoch mismatch. Restoring journal access
does not clear that quarantine. Same-ticket native inspection/cancellation and
same-boot reconciliation remain available, but cannot authorize new work on a
quarantined guest. Time, health, quarantine and controller bookkeeping never prove
retirement.

Capacity exhaustion alone is transient refusal: new reservations stop at the
existing 16-ticket/128-MiB limits, but an already-reserved ticket is not charged again
at start. Unknown bound records and inputs stay counted and preserved. Never delete
records or clear the quarantine file to reclaim capacity.

Admission refusals carry bounded reason codes through the tools/controller. The
foreground CLI prints those codes and exits **3**. Initial plan-submission refusal
does not write workflow state; a later pre-review refusal retains the already
submitted plan with `review_aborted`. The controller's single-use, session-bound
submission object prevents a redundant admission check between submission writes;
it cannot bypass the fresh review/worker checks or grant verifier authority.

Qualification uses at most two **new** isolated guests and checks free space for
each guest disk plus 20 GiB before allocation. Only the disposable canary may receive
`qualified: true`, after negative tests pass; existing guests, defaults and actual
production remain unchanged. `--verifier linux-production` uses ordinary runtime
configuration rather than a lab executor override. Eligibility requires three
independent fixtures for each of the eight scenario families, with zero unexpected
failures. Retain failures and stop eligibility on an unexplained model abort.
Quarantine/reboot handling is stop-and-preserve, not legacy fallback or rollback.

The host-side `scripts/otter-soak-supervisor.ts` owns evidence before provisioning:
exclusive writer lock, append-only events, a separate tail anchor and immutable
per-invocation receipt snapshots. Workloads receive no writable audit path.
`scripts/otter-soak-manifest.ts --check <evidence-root>` checks lineage completeness
and retained outcomes. This detects incomplete runs and accidental truncation,
not deliberate edits by the host owner; neither manifest nor anchor is native
retirement evidence.

Manifest events use `otter.soak-manifest.v2`. Each `invocation-end` records the driver's
own boolean `orderedTermination`; receipt-channel timeout or overflow errors cannot
establish that the driver was deliberately stopped. Restart and the checker use this
recorded flag, not merged diagnostic error names. Legacy v1 or incomplete events are
refused without migration. Preserve those historical directories unchanged; never
rewrite or rebaseline them to satisfy the new schema.

Each evidence directory also retains a private, immutable `soak-binding.json`:
`{schema:"otter.soak-binding.v1",vmC:"<SSH target>",fixtures:<normalized otter.soak-fixtures.v1>}`.
The normalized fixture object includes every provisioning and invocation argv,
working directory, timeout, lineage/fixture identity, receipt path and resume
policy. Its SHA-256 is recorded in the first `supervisor-start` event, then covered
by the manifest chain and tail anchor. The checker uses that retained object to
recompute each original effective argv hash, including the parent session ID
resolved from invocation 1's immutable snapshot. `--restart` requires the same
normalized fixture object and SSH target and refuses mismatches before lock
creation, tail recovery, evidence writes or child/SSH launches. This host-owned
hash binding detects accidental changes; it is not external authentication and
does not protect against deliberate edits by the host owner.

The parent-supplied remote driver transport must report the driver's planned
self-SIGKILL as remote numeric exit status `137` (`signal: null`) after preserving
the matching receipt assertions. A SIGKILL observed on the local transport/SSH
child remains `killed` and unexpected; the supervisor never upgrades a local
signal to the remote status. For timeout, SIGINT/SIGTERM and receipt overflow,
the supervisor signals only its directly owned `ChildProcess` handle; it does not
create or signal process groups and makes no claim that descendants were terminated
or retired. A direct child's exit releases its handle even if a descendant keeps a
receipt pipe open. Receipt capture gets a bounded drain window, then the owned read
stream is destroyed and incomplete output is reported as a failure; the supervisor
does not wait indefinitely or signal that descendant. PTY allocation and log capture
remain responsibilities of the parent transport, not claims made by the supervisor.

Cancellation failure receipts preserve the exact observed verifier reference before
bounded cleanup, retain the original error and cleanup outcomes, and keep retirement
unresolved unless native authentication succeeds. Main-worktree evidence includes
tracked diffs and raw-name/content/permission digests for Git-visible, non-ignored
untracked regular files. Ignored files are not covered.
Unsupported untracked links or special files are refused, not followed or normalized;
ACLs and extended attributes are outside this diagnostic digest.

The strict exact-token Claude and Codex coding profiles are not admitted. Choosing those
engines in the OpenCode imported-plan command path refuses before connecting to the server.
The common terminal instead declares its separate estimated/reactive control profile;
this does not qualify the strict profile or the held Linux VM profile.
Foreground import/run now also rejects incomplete role-control status maps; the legacy
OpenCode hook-control map does not satisfy that gate. Passing status checks alone would
still not establish the capability evidence below.

Strict CLI admission requires engine/version/model/profile-scoped evidence for every required
role control, including read-only main/reviewer execution and the Otter-owned serial worker
lease. It also requires proof of actual complete Otter-controlled input limits: **8192
tokens for main and 5120 for worker**, including system text, tool schemas, wrappers and
payloads. Generic estimates, UTF-8 byte counts and vendor usage do not establish these
limits; opaque vendor additions remain unobservable.

Claude Code's documented [`--safe-mode`](https://code.claude.com/docs/en/cli-reference)
preserves authentication while disabling
customizations, unlike `--bare`, but managed-policy hooks and commands may still run.
It is a discovery candidate, not an admitted isolation profile. Anthropic's documented
[token-counting endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting)
returns an estimate and is not a CLI-only tokenizer proof.
Neither documentation nor the offline process/reference-stream tests establish live
adapter readiness or escaped-descendant retirement. Missing controls or token proof
remain blockers; existing login must not be accessed or forwarded by Otter to bypass them.

## Plan workflow (harness M1) — `/plan` → `/approve` → workers

```text
/plan add an LRU cache module     (or: ralplan … / plan mode … / hyperplan … / 계획부터 … / 계획 모드 …)
  -> planning: main may only read (read/glob/grep/list + read-only bash argv policy); every other tool is refused
  -> main calls otter_flow op:"plan" once (goal, 3-10 steps {title, files, detail, verify}, 1-5 risks)
  -> code gates (verify_allow, paths inside the repo, no .git/.otter/knowledge/raw, gaming check) -> errors back to main
  -> advisory reviewer child inside the tool call (VERDICT OKAY|ITERATE; max 2 iterations; never a gate)
  -> pending_approval: .otter/plans/<id>.md (code-rendered; editing it blocks /approve)
/approve   -> steps become ledger tasks tagged with the plan sha (other open tasks are cancelled as superseded)
           -> main runs delegate resume:true; workers implement + verify + review; main itself cannot write
           -> settle -> done (or stuck(tasks_failed) / stuck(user_stop))
/reject <reason>   back to planning with your reason        /cancel   ends the workflow (keeps the plan file)
/status            code-rendered state, any phase            /stop     unchanged (stops the queue)
```

In the OpenCode chat workflow, approval comes from your typed `/approve` command (never from model text). Workflow state lives outside
the repo in `<stateRoot>/workflow/` (`workflow.json`, `archive/`, `events.jsonl`, `plans/<id>.json`); a new
`opencode` process restores the same session held, with epoch-validated reattachment and explicit owner Resume required before work. `flow.enabled: false` in `.otter/otter.jsonc`
restores the legacy suffix-only plan mode. Results and numbers: `docs/lca-harness-m1-2026-10-01.md`.

E2E: `scripts/otter-e2e.sh --flow plan --fixture plan3 [--entry keyword] [--seed-open-task]` (F01-F07) and
`--repeat 10 --stop-after pending_approval` (tool-call reliability, AC1.7). Doctor: D12a (otter_flow schema <= 300
tokens, main only), D12b (commands stop/status/plan/approve/reject/cancel), D12c (review template <= 350).

## otter harness M0 (pin, flow core, live `/status`) — ralplan M0

- **Pin:** `@opencode-ai/plugin`/`@opencode-ai/sdk` locked to `1.18.32` in both `framework/` and `.opencode/`;
  `scripts/otter-doctor.sh` **D12e** cross-checks `opencode --version`, both `package.json` declarations and both
  installed `node_modules` copies (WARN on any mismatch or missing source, D01 keeps its existing below-MIN WARN).
- **Flow core** (`framework/src/flow/{machine,state,owner,status}.ts`, `framework/src/flow/runtime.ts`): the plan
  workflow state machine, event log and ownership/authority rules from ralplan §5.2/§5.3 are implemented and unit
  tested; M0 had no user-facing entry (`/plan`, `/approve`, `otter_flow` and the reviewer shipped in M1, see above).
  Workflow state lives at `<stateRoot(worktree)>/workflow/` (`workflow.json` the single active workflow,
  `archive/<id>.json` terminal ones, `events.jsonl` an append-only global-seq event log) — outside the worktree,
  next to the ledger, so a worker cannot edit it. Tests create workflows directly via `flow/state.ts`/`flow/runtime.ts`.
- **`/status` (live, M0):** a code-rendered, read-only status command. `command.execute.before` marks the command
  turn with its literal name; `chat.message` consumes that mark and, only for `status`, rewrites the command's own
  text part in place (same proven path as the mode suffix, ARCH-08 — no `output.parts` replacement) to
  `renderStatus()` (≤ 25 lines: workflow id/phase/owner incl. "owner dead"/plan path/review/task counts, legacy
  mode, ledger counts, queue running, last 5 events) followed by `Reply only: ok`, starting with the marker
  `[otter status]` so e2e can prove the model never produced it. It never rewrites an owner, starts a
  heartbeat or repairs workflow state. A dead owner remains held until proven same-session
  reattachment and explicit Resume; another session may only observe it.
- **Config wiring (ARCH-13):** the `config` hook registers `status` (template `"Reply only: ok"`) only when
  `config.flow.enabled` and hook id `command.status` are both on, and records exactly the command names it wrote
  (a user-defined `status`/`stop` command of the same name wins and is left alone — `hooks/command.ts` never acts
  on a name it did not itself inject). `otter_flow` is **not** registered in M0 (ARCH-06/C2-03): M0 adds 0 main-prefix
  tokens. `chat.message` is registered when `mode.detect` **or** the flow feature is on; `command.execute.before` is
  registered when `command.stop`, `command.status`, or `mode.detect` is on. `repairOnLoad` (authority-free: T8 for
  an orphaned `reviewing`, finishing an interrupted approve, settle) runs once at plugin init inside a try/catch
  that never throws.
- New hook ids: `flow`, `command.status`, `guard.plan_boundary` (planning-phase tool allowlist + bash argv policy,
  M1-facing but present as of M0 step 2). New `config.flow` block: `enabled`, `max_code_invalid` (3),
  `max_review_iterations` (2), `nudge_max` (1), `review_max_tool_calls` (6).
- Live smoke: `scripts/otter-e2e.sh --smoke-command status` runs `opencode run --format json --agent main --command
  status` in the same isolated XDG env as `--check`, with a 120 s cap; PASS (exit 0) when the JSON transcript's
  user-role text contains `[otter status]`, FAIL (exit 2) otherwise. Doctor **D12b** checks the milestone's command
  set is present in the effective config (M0: `stop`, `status`; WARN if missing).

## Stage 3 scope (data layer: db_query, schema_lookup, EvoOntology) — 2026-09-23, first slice

- Off by default (`data.backend: "none"`). With `sqlite` or `postgres` the plugin registers two tools and two agents:
  `db_query(sql, max_rows?)` runs **one** `SELECT`/`WITH` statement (guard in `src/data/guard.ts`; forbidden
  keywords/functions, `FOR UPDATE`, multi-statements are refused before anything is spawned) and returns a tab table
  capped by rows / cell chars / estimated tokens plus a hint line; `schema_lookup(table?)` serves one table (or the
  table list) from a static JSON file (`scripts/otter-schema-extract.py` builds it from PostgreSQL DDL).
- sqlite backend: `src/data/sqlite_query.py` subprocess (`?mode=ro`, SELECT/READ-only authorizer, progress-handler
  timeout, `dist_m()` haversine) because `bun:sqlite` cannot register functions. postgres backend: `psql --csv` in
  `BEGIN READ ONLY` + `SET LOCAL statement_timeout`; the DSN comes **only** from the env var named by `data.pg_dsn_env`
  (default `OTTER_PG_DSN`), loopback hosts only unless `data.pg_allow_remote`, never logged or stored.
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
  advisory rules as code tasks; no snapshot, no files. Main's prompt gets rule 10 ("database question → delegate a
  kind data task") only when a backend is configured, and `data mode:` routes through delegate. The verifier never
  executes anything (the design's `data_check` tool became a queue step, for the same reason the reviewer has no bash).
- Acceptance (`scripts/otter-e2e-data.sh`, fixture `scripts/fixtures/data-vv`: a synthetic sqlite (places, vehicles,
  visits, risk, outbreaks) + code-generated `ontology_v0` + 10 representative questions with expected results): D01 the SQL the
  model reports, re-executed by the harness, matches the expected result (tier-1 >= 6/7), D02 uncached input + output
  <= 10K tokens per question, D03 <= 6 tool calls, D04 no repeated calls, D05 no write/bash, D06 wiring, D07 resolve
  called; `--via main` asks main instead (D08 ledger task done + checks pass, D09 main made 1 delegate call and 0 db
  calls). Measured on gemma4:26b: analyst direct 10/10, 2.1–4.6K tokens and 7–19 s per question (after three ontology
  fixes; each miss was a missing term/alias/convention, never a tool bug); via main 10/10 (one rows-only match),
  5.1–8.4K tokens (main + children) and 16–29 s. Results and design notes: `docs/lca-stage3-2026-09-23.md`.

## Stage 4 scope (ontology evolution batch) — 2026-09-23, first slice

- `scripts/otter-evo-evolve.py` (stdlib, imports the vendored EvoOntology API directly, no MCP): one EvoOntology
  evolution run per invocation. Parent evaluation = `scripts/otter-e2e-data.sh` on the active version (code judge:
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
  Failed and cancelled tasks are discarded with their worktree; main never sees them. `scripts/otter-e2e.sh --worktree`
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
- `scripts/otter-evo-nightly.sh` runs the driver only when `EvolutionTrigger` says an evolution is due (30 new
  trajectories or 7 days; `--force` skips), with a lock, an Ollama health check and a dated log under
  `~/.cache/otter/evo/`; `scripts/launchd/com.otter.evo-nightly.plist` is a 03:30 template (not installed).
- Doctor D11e runs the driver's `--self-test` (patch validation, judge decoding; no model).
- `OLLAMA_NUM_PARALLEL=2` is **not needed** for cache isolation: `scripts/otter-np-probe.py` (two ≈7K-token prefixes
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
  task/delegate/todo) -> diff of exactly this task's cumulative changes (`.otter/state`, `.otter/handoffs`, `__pycache__`,
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
- Ledger (control plane): `$XDG_STATE_HOME/otter/<sha1(worktree)[:12]>/sessions/<main>/ledger.json` (default
  `~/.local/state/otter/…`, override `OTTER_STATE_HOME`) — **outside the worktree**, so a worker with bash cannot edit it
  and no repository commits it; a corrupt file is moved aside, never overwritten. Handoffs (data plane, human-readable):
  `<worktree>/.otter/handoffs/<main>/task-<n>.md` (self-ignored via a generated `.gitignore`); the next worker's prompt
  gets a `<= delegate.handoff_context_chars` summary of earlier tasks (status, files, failure reason) and nothing else.
- Interrupted runs (crash, restart, Esc): open ledger tasks are offered back to main **once** — attached to the
  user's next message (`<otter-resume>` block) or injected on idle — as "call `delegate` with `resume: true`"; a delegate
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
- Acceptance (`scripts/otter-e2e.sh --fixture ulw3` / `--fixture ulw-fail`): E01-E04 as stage 1, E05 ledger statuses
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
- Modes (`ulw`, `plan`) as <= 300-char suffixes on the user message, state under `$XDG_STATE_HOME/otter/<repo-hash>/`.
- Acceptance: prefix <= 8K tokens, zero repeated identical calls, fib task done in < 5 min.

## Same-task probes (harness2-inspired)

`scripts/otter-probe.ts` runs one task several times in isolated worktrees and shows you the verify outcomes side by side, so you can see whether a short approach overlay changed what the deterministic check did. It is a script, not a workflow kind; nothing in it approves, merges or adopts anything.

```
bun scripts/otter-probe.ts propose --task "<title>" --detail "<text>" --verify "<allow-listed test cmd>" [--k 2] --engine local|codex|claude --model <id>
bun scripts/otter-probe.ts approve --wid <id> --sha <subject sha printed by propose>
bun scripts/otter-probe.ts run     --wid <id>
bun scripts/otter-probe.ts show    --wid <id>
bun scripts/otter-probe.ts apply   --wid <id> <label>      # base1.. | inv | dom
bun scripts/otter-probe.ts discard --wid <id>
```

- `propose` runs two read-only researcher turns: an INV overlay (how to work) and a DOM overlay (what a practitioner knows). A model may propose only that overlay text (at most 1200 bytes, no secrets, no absolute paths, no test-edit text); an empty or `KEEP_BASE` answer spends no probe and an invalid one is recorded and skipped. The overlay reaches the worker only as part of the task detail in its user message. System prompts, guardrails, tool guidance, roles, scripts, plugins, hooks and skills are not proposable, and role policy ids are identical across base, inv and dom. Newest admitted lessons (see `src/harness/lessons.ts`) are shown to these two turns as reference data, never to workers.
- `approve` writes a write-once receipt bound to the sha256 of the canonical subject (task, verify, overlays, HEAD and working-tree snapshot, harness profile fingerprint, `k`, routes). Any changed byte is a new subject and needs a new approval. `run` refuses without a matching receipt, and refuses if HEAD, the working tree or the profile changed since `propose`.
- `run` executes `k` unmodified bases, then `inv`, then `dom`, one at a time. Each is one worker session plus the verify command, in its own worktree `probe-<id>-<label>`, with one attempt, no earlier-task handoff, no reviewer and no merge. Commands run only through the framework verifier and `delegate.verify_allow`. A repository without a commit is refused; there is no in-place fallback. Your checkout is byte-identical until you `apply`. After the run, one read-only reflector turn may add at most one lesson; code admits it only if every cited row is a clean one-overlay contrast whose verify outcome differs from `k>=2` consistent base runs.
- `show` prints, per run: label, overlay, verify ok/exit, diff stat, duration, valid. `apply` applies exactly that probe's diff (only a valid run whose verify passed) and removes that worktree; `discard` removes the rest. Records under the state root stay as evidence.

Cost: each probe is one worker session (`task_ttl_ms`) plus one verify (`verify_timeout_ms`), and the default is `k=2`, so up to 4 probes plus 3 short read-only turns. No latency figure is claimed.

Not claimed: a passing probe does not show that the overlay caused the pass (one run per variant, sampling variance), a verify pass does not show correctness, and nothing here reproduces or supports the harness2 paper's results or any generality beyond this repository and task. Attribution is in `src/workflows/ATTRIBUTION`. `test/harness-probe.test.ts` uses a scripted fake host and is not live-model proof.

## Layout

```
framework/src/index.ts        plugin entry (assembly of hook factories)
framework/src/config.ts       otter config: ~/.config/otter/otter.jsonc -> <repo>/.otter/otter.jsonc (project wins)
framework/src/hooks/*.ts      config, chat.params, chat.message, tool-before, tool-after, event, compacting
framework/src/flow/*.ts       plan workflow core (M0): machine, state, owner, status, runtime, bash-policy
framework/src/agents/         prompts;  src/guards/  src/modes/  src/state/  src/tokens.ts
framework/src/state/ledger.ts task ledger + handoffs;  src/state/store.ts  state root (outside the worktree)
framework/src/orchestration/{queue,snapshot,shell}.ts  serial worker queue, temp-object-dir snapshots, process-group shell
framework/src/tools/delegate.ts  the `delegate` tool;  src/hooks/command.ts  `/stop`, `/status`;  src/loop/idle.ts  resume offer + todo loop
.opencode/plugins/otter.ts      project loader: re-exports framework/src/index.ts (OpenCode auto-loads it)
scripts/otter-*.{py,sh}         measurement / verification tooling (below)
```

## Commands

```sh
cd framework && bun install && bun test && bun run typecheck   # unit tests + types
bash scripts/otter-doctor.sh [--json]           # static checks D01-D10 (no GPU); exit 0 ok / 1 warn / 2 fail
python3 scripts/otter-baseline.py --top 10      # per-session prefix / cache-miss / compaction / repeat table
python3 scripts/otter-baseline.py --session <id>  # + per-call timeline   (--since YYYY-MM-DD, --json, --db PATH)
bash scripts/otter-e2e.sh --dry-run             # print the isolated stage-1 run plan
bash scripts/otter-e2e.sh --check               # verify isolation, no model call
bash scripts/otter-e2e.sh                       # real run: fib fixture, ~10 min budget, GPU
bash scripts/otter-e2e.sh --fixture ulw3        # stage-2 run: ulw -> delegate 3 tasks (E01-E14), ~2-4 min
bash scripts/otter-e2e.sh --fixture ulw-fail    # stage-2 negative run: [done, failed, done], queue continues
bash scripts/otter-e2e.sh --smoke-command status  # M0 live smoke: /status delivered, transcript has [otter status]
```

`otter-baseline.py` reads OpenCode's SQLite DB read-only (`~/.local/share/opencode/opencode.db`).
`otter-e2e.sh` runs under `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointing at a scratch dir (`~/.cache/otter/e2e`), with
`OPENCODE_CONFIG_DIR` unset, so neither the user's global config nor the user's session DB is used.

## Config file locations

| What | Path |
|---|---|
| OpenCode global config (user's, loads OMO today) | `~/.config/opencode/opencode.jsonc` |
| OpenCode project config / plugin loader | `<repo>/.opencode/opencode.json(c)`, `<repo>/.opencode/plugins/otter.ts` |
| Extra global dir (only if `OPENCODE_CONFIG_DIR` is set, e.g. by orca) | `$OPENCODE_CONFIG_DIR/opencode.json` |
| otter user / project config | `~/.config/otter/otter.jsonc`, `<repo>/.otter/otter.jsonc` (list only overrides) |
| otter workflow/session state (ledger, mode, abort marker, session map) | `$XDG_STATE_HOME/otter/<repo-hash>/sessions/<id>/` (default `~/.local/state/otter/…`; `OTTER_STATE_HOME` overrides) |
| otter execution claims and run records | `<OS-account-home>/.local/state/otter/<canonical-worktree-hash>/execution-runs/`; independent of `HOME`, `XDG_STATE_HOME`, and `OTTER_STATE_HOME` |
| otter handoffs (data plane) | `<repo>/.otter/handoffs/<session>/task-<n>.md` |
| otter update-check cache | `$XDG_STATE_HOME/otter/update-check.json` (`OTTER_STATE_HOME` overrides) |
| OpenCode session DB (read-only for us) | `~/.local/share/opencode/opencode.db` |

Execution authority requires an existing worktree owned by the operating-system user and
an authority path outside that worktree. Account discovery uses bounded native metadata
queries (`id`/`dscl`/`plutil` on macOS, `getent` on Linux); unavailable or inconsistent account metadata
refuses execution rather than trusting an environment-derived home. A distinct execution directory under the selected
configured legacy state root is refused and preserved, even when empty; there is no automatic
migration, deletion, or stale-owner takeover. Do not switch namespaces or erase records to
bypass a refusal. This gives cooperating current-protocol controllers one authority regardless
of state-directory overrides; it does not discover unselected historical namespaces or prove
that a terminated controller's descendants have stopped.

## Updates (installer-managed copies)

Modeled on GJC's startup check. `install.sh` records `repo=`, `ref=` and `bin=` in
`$OTTER_HOME/AgentFramework/.git/otter-installer`. An interactive start of such a copy compares the installed commit
with the remote branch head (`git ls-remote`, at most once a day per installed commit, cached in `update-check.json`)
in the background: it never blocks or fails startup, never installs, and a network failure or a pinned tag/commit
shows nothing. When the branch moved it shows `Update available: a newer otter is on master (<old> -> <new>). Run:
otter update` once (in the full-screen TUI it is also recorded into the new session so the rebuilt transcript keeps
it). `otter update` re-runs that copy's `install.sh` with the recorded repository, branch, install root and launcher
directory and never edits the shell rc file again; `otter update --check` only reports. A source checkout (no marker)
is never checked and `otter update` refuses it (use git). Disable the check with `"update": { "check": false }` in
`~/.config/otter/otter.jsonc` or `OTTER_NO_UPDATE_CHECK=1`; this setting is read on its own and is not part of role or
policy identity.

## OMO coexistence warning

`oh-my-openagent` and otter both overwrite `config.agent` and `default_agent`; the plugin loaded last
wins and the other's agents/guards silently vanish. Do not run both: remove `"oh-my-openagent@latest"`
from the `plugin` array in `~/.config/opencode/opencode.jsonc` (and from `$OPENCODE_CONFIG_DIR/opencode.json`
if set) before using otter. `otter-doctor.sh` reports this as `D05c WARN`. With OMO loaded, worker/reviewer also see OMO's
tools (`call_omo_agent`, `session_*`, …) in their prefix — another reason not to run both.

## Optional skill recommendations (OpenCode plugin)

This section covers the OpenCode plugin. In `otter chat` the model loads skills itself (`skill_auto`, see
"Model-loaded skills" above).

The judging engine is `memory.engine`, shared with memory recall: by default (`auto`) a tool-free Claude CLI run
(else Codex), with up to `min(memory.timeout_ms, 15 s)` per message; the local OpenJev server at `skill_router.endpoint`
only when `memory.engine` is `jev`, then within `skill_router.timeout_ms`. A CLI engine sends the message text and skill
names/descriptions to that vendor. The OpenJev-specific notes below apply to the `jev` engine.

`skill_router` is a per-turn recommendation layer, not a replacement for mode detection
or permission checks. Library defaults are **off**; this repository explicitly opts into
**suggest** mode in `.otter/otter.jsonc`. Recommendations now appear as optional per-turn
advice in the main agent's input. They never automatically load a skill, activate a mode,
or execute a task. `shadow` remains available for observation without affecting the input.
Routing outcomes are always persisted, independently of `OTTER_DEBUG`, as session-scoped
JSONL at `stateRoot(worktree)/routing/<sessionID>.jsonl` (normally
`~/.local/state/otter/<worktree-key>/routing/`). `OTTER_DEBUG=1` additionally prints
`skill.router` outcomes and latency to stderr.

Each `decision` event has `schemaVersion: 1`, an event/decision ID, session/message IDs,
timestamp, router mode, model alias, candidate names, configured probability/margin/timeout
thresholds, validated choice/probabilities/confidence/margin, final skill/reason, latency
and `requestSent`. Pre-inference refusals (including sensitive/oversized input, busy,
duplicates, off and invalid configuration) are recorded too; absent scores are `null`,
not fabricated probabilities. Invalid distributions and unknown labels are never retained.

An `advice_applied` event with the same `decisionID` is written **after** the hook adds
the optional advice to the message. A recommendation in `shadow` mode is not applied;
neither event proves that a skill was loaded or that the task succeeded. For later
self-evolution analysis, join by session/message IDs with the OpenCode transcript and
tool outcomes, and deduplicate by `eventID` (not message ID: retries are separate
decisions). This change stores observations only; it does not train models or change
routing policy automatically.

Logs exclude user text, skill descriptions, endpoints, raw responses and error bodies.
Files are append-only with mode `0600`; persistence errors are best-effort and cannot
block advice. They live outside disposable `sessions/` state, survive session deletion
and plugin restarts, and are not injected into model context. Retention is manual
(no automatic expiry). Turns that bypass the router entirely—commands, child agents,
active workflows/modes and synthetic input—do not create routing decisions.

`bun scripts/otter-wiki.ts capture` also imports these logs into the Wiki. It creates
`knowledge/raw/routing/<sha256>.json`, a `sources/routing-<sha256>.md` source page and
`wiki/reports/routing.md`, then updates the index and capture log. Routing sources appear
in `status` and can be compiled by `llm-wiki` just like tool-history and document sources.
This is an explicit capture step, not a per-message Wiki write or automatic learning.

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
- Candidates are project-local skill metadata, read from `.opencode/skills/<name>/SKILL.md`
  and also from `.agents/skills/<name>/SKILL.md`; if a name exists under both roots it is
  excluded as ambiguous. Both roots get identical realpath-containment, size and
  frontmatter checks. Candidates are intersected with `skills.allow` and the live
  main-agent permission rules returned by OpenCode. Missing, denied, ask-only,
  external-symlink and malformed skills are excluded. Global skill discovery is
  deliberately not a router catalog; installing a GJC skill alone does not make it
  eligible. Catalogs over 16 allowlisted names abstain.
- Only `name` and bounded frontmatter `description` are sent, never skill instructions
  or other repository file contents. Only the current user text is sent (maximum 2,000 characters);
  common credential patterns cause abstention. This is not a complete secret detector:
  keep confidential material out of routed messages or turn the router off.
- One HTTP call uses `jev-latest`, `samples: 1`, `steps: 1`, and an explicit `none`
  choice. Only literal HTTP loopback endpoints are accepted; redirects are refused.
  Timeout includes host permission lookup and the response body. One request per
  plugin instance is admitted, with no queue or retries (the single slot is
  client-side: after a timeout the server may still be computing). Errors, invalid
  responses, revoked permissions, low margins and stale turns yield no suggestion.
  An invalid `skill_router` block (e.g. `timeout_ms` over 3000) disables advice with
  reason `invalid_config` and a logged list of issues, never a silent `off`.
- Explicit slash commands, detected modes, active modes, resume offers, child agents
  and synthetic-only turns bypass inference. OpenCode expands a command's template
  before `chat.message`, so `command.execute.before` marks that turn and the router
  skips it; literal `/` text is also skipped. A newer main-agent turn cancels pending
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
message through the debug logger (`OTTER_DEBUG=1`) and does not interrupt tool/guard handling.
Stored-observation counts are therefore not a guarantee that every executed call was captured.

### Bounded skill evaluation (P1)

Skill observation is **off by default**. It distinguishes recommendations, actual
`skill` tool attempts, returned skill text, related task attempts and code-owned
verification. Returned text does not prove that the model read or followed it;
verification passing does not prove the skill caused an improvement.

One explicitly activated campaign belongs to one canonical project root:

```bash
bun scripts/otter-skill-observation.ts activate --root /absolute/project --campaign-id approved-campaign
bun scripts/otter-skill-observation.ts status --root /absolute/project
bun scripts/otter-skill-observation.ts stop --root /absolute/project --campaign-id approved-campaign
```

After explicit campaign activation, copy its `ownerBinding` receipt into that
project's `.otter/otter.jsonc` and opt in:

```json
{
  "skill_observation": {
    "enabled": true,
    "campaign_id": "approved-campaign",
    "owner_root": "/absolute/project",
    "owner_binding": "<64-hex ownerBinding from activation receipt>"
  }
}
```

Configuration alone never initializes a database or replenishes a budget.
The binding pins the canonical source and state location; retain it after stopping.
`disabled_hooks: ["tool.history"]` also disables the new observer. Do not change
state directories, copy campaign databases or create another root to evade limits.
Existing router settings, tool permissions and queue behavior remain independent.

The first committed **10th actual actor session or 100th unique skill call**
stops new admissions. Worker/reviewer sessions count separately; a chat-only tenth
session can close admission before any skill load. Pending exact keys may finish
for at most five minutes, then unresolved observations are censored. Manual stop
is immediate. Closed campaigns cannot restart or reset; a second campaign and
standing enablement require separate approval. Set `enabled` back to `false` after
closure. Observation failures or cutoff never stop user work.
Config flag changes require a host reload; the persisted CLI stop takes effect
across existing instances without changing their tool permissions or queue.

The private store is `stateRoot(owner_root)/skill-observations.sqlite`, separate
from disposable sessions. New raw facts expire after 30 days; quota controls and
closed tombstones survive expiry. Cleanup is bounded and requires process activity:
an offline machine cannot physically delete expired data on schedule. Export
excludes expired facts regardless. Session-boundary reconciliation processes at
most 1,024 pending keys; limits also include 50,000 total store rows, 64 MiB database
pages, 10,000 exported facts and a 25 ms SQLite busy timeout. No secure-erasure
guarantee is made.
Fixed health warnings remain visible without `OTTER_DEBUG`; missing, disabled,
partial, expired and closed coverage must not be described as zero utilization.

Fingerprints have separate meanings: terminal-output bytes, supported host-rendered
body bytes, and the safe current project `SKILL.md` file at observation time.
The originally loaded file bytes are **unavailable** in this plugin-only design.
Cached content and a subsequently edited file can differ; hashes with different
bases are not comparable versions. Secret-pattern, oversized, ambiguous, modified
or truncated data limits fingerprint coverage. Raw prompts, commands, arguments,
outputs, errors, credentials and absolute paths are not exported as evidence.

Task linkage uses explicit message/parent/task/attempt/child identities, never a
nearest timestamp. Main-agent exposure is orchestrator context, not a worker load.
Unsupported external child streams and unmanaged task outcomes remain unknown.
Reports distinguish completed/error/unresolved/conflicting calls, attempt and task
status, verification refusal/timeout/abort, and unknown/excluded/censored counts.
Rates show numerator/denominator; an empty denominator is `N/A`. Never sum overlapping
snapshots or interpret missing trigger evidence as confirmed autonomous choice.
Configuration strata hash bounded Otter routing/observation settings and skill
allowlisting, not the full host configuration, credentials or endpoints.

`bun scripts/otter-wiki.ts capture` manually adds `raw/skill-runs/<sha256>.json`,
its source page and `wiki/reports/skill-evaluation.md`. New skill snapshots are
bounded to 128 files and 64 MiB total (16 MiB per snapshot). Wiki evidence is retained
long-term: the raw observation store's 30-day expiry does **not** delete previously
captured immutable Wiki snapshots. Capture does not compile sources, modify skills,
train models or change routing policy. Review pending sources with `status`, compile
only with explicit source links and then run `lint`. Operational traffic must never
be manufactured to fill a campaign; a closed zero-observation campaign is not
evidence of effectiveness.

The isolated synthetic capability probe is
`bash scripts/otter-e2e.sh --skill-probe`. Its data is not operational utilization.
It checks real host tool identity, parent linkage and returned metadata.
OpenCode 1.18.33 with pinned plugin/SDK 1.18.32 also passed the serialized
`--skill-probe-off`, `--skill-probe-scenario missing-skill`, `advice-only`,
`worker-denied`, `worker-allowed`, and `verify-failure` cases. Advice-only also
passes with observation off and uses a local synthetic router, not production Jev.
The verification-failure case records a completed worker skill call, an exact
child-prompt association, and a separate code-owned exit-2 failure/final failed task;
it does not turn successful loading into successful verification. Worker permission
overrides and verifier fixtures exist only in isolated test roots. Use
`--probe-timeout 900` for that longer case. Unsupported renderer
shapes remain unknown rather than being promoted to exact loaded-source hashes.

`bun scripts/otter-skill-bench.ts` measures 1,000 synthetic adapter callbacks in fresh
scratch projects, separately checking the disabled path, quota counters, terminal
facts, database pages, RSS/heap and sampled rollback-journal size. The generated
receipt at `artifacts/skill-evaluation-p1/benchmark.json` records the measurements
and limitations for one local uncontended run; the initial added p95 target is
10 ms, not a hard realtime promise. Memory high-water
and journal peaks are sampled, not strict allocation or peak-disk guarantees.
These fixtures never populate an operational campaign.

This checkout's single approved `skill-evaluation-p1-20261002` campaign was manually
closed with zero recorded actor sessions and skill calls; its binding is retained
and configuration is off. No synthetic traffic was inserted and no existing host
was force-reloaded. Operational-use and effectiveness evidence remains unavailable,
not confirmed zero population use. The closure receipt is not an efficacy verdict.

The CLI implementation lives at `framework/src/wiki/wiki.ts` (moved from the old
`framework/src/telemetry/wiki.ts`). From the repository root:

```bash
bun scripts/otter-wiki.ts capture|lint|status|unlock [--root DIR]
bun scripts/otter-wiki.ts register <file> [--title T] [--root DIR]
```

Exit 0 is success; 1 is a refusal or failure (stderr `Wiki operation failed: <reason>`);
2 is a usage error. `--root` defaults to the repository root.

`capture` writes separate content-addressed immutable raw snapshots for tool outcomes,
Jev routing events and admitted skill observations, source pages, generated aggregate reports, and updates the
index/append-only activity log. Routing import validates and projects only approved
metadata, deduplicates event IDs, rejects conflicting replays and unsafe filesystem
inputs, and reports malformed records and bounded-scan coverage. Check that coverage
before treating counts as complete history. A routing scan is capped at 256 log files,
10,000 records, 1 MiB per file and 16 MiB overall. Directories exceeding 4,096 entries
produce an explicitly bounded empty scan instead of an arbitrary subset.
The routing report separates recommendations,
verified advice insertion and unmatched application events; none prove skill execution
or task success. Capture does not pretend to
be an LLM ingest. `register <file>` admits a local `.md`/`.txt` document (non-empty, at
most 131072 bytes, valid UTF-8, no NUL, no detected secret) the same way: it hashes the
bytes (sha256), writes an immutable `knowledge/raw/documents/<sha256>.<ext>` and a
generated `knowledge/wiki/sources/documents-<sha256>.md` source page, then updates the
index and log. Re-registering identical bytes is idempotent and never duplicates the log
entry; if the raw path for that id already holds different bytes, registration is refused
with "Immutable raw source hash mismatch". `status` is read-only: it reports
registered sources, which are compiled (linked from an `ingest` log entry), which are
still pending, and structural problems, without writing anything.

The coding agent follows [the wiki schema](../knowledge/AGENTS.md) and the `llm-wiki`
skill (`.agents/skills/llm-wiki/SKILL.md`) to read sources, maintain cross-linked
concepts/entities, answer with citations, and record semantic ingest/query/lint
operations. Start at [the index](../knowledge/wiki/index.md). The structural `lint`
checks local links (skipping `knowledge/raw/`), orphan pages, raw/source-page pairing in
both directions, content-hash integrity, allowed extensions, the log heading grammar, and
that every `ingest` entry links at least one existing source page; contradictions, stale
claims and causal conclusions still require agent review. Existing raw files and enriched
source pages are never overwritten; aggregate reports are explicitly generated.

The pattern follows [Karpathy's original LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
not a separate hosted product. A single `knowledge/.wiki.lock` file (created `wx`,
containing `{pid, at}`) is shared by `capture` and `register` to prevent concurrent
writers; `lint` and `status` report and refuse (exit 1) while it exists. The owner
process removes only the lock it created, in a `finally` block; writers never remove a
lock they did not create. A lock whose recorded PID has exited is reported as stale by
`lint`/`status`; `bun scripts/otter-wiki.ts unlock` removes it (refusing live, unreadable or
changed locks). Git settings remain unchanged.

### Wiki as agent memory (`memory` tool)

The wiki is the agent's long-term memory, linked to the request by an inference engine. `memory(query)` is a
read-only tool for `main` and the read-only planning/workflow roles (OpenCode plugin tool and the codex/claude/local
CLI host tool set alike; worker, reviewer, data agents and OpenCode's `build`/`plan` have it denied).

- Engines (`memory.engine`). The default is `auto` with `prefetch: true`, so memory works for users with no
  local model server: `auto` uses the Claude CLI when it is on PATH (`claude-haiku-5-5`, what the `haiku` alias
  resolves to), else the Codex CLI (`gpt-5.6-luna`), else reports `engine_missing`. It picks by installation
  only; a failed run (login, usage limit) never silently switches vendors. `claude` / `codex` pin one vendor
  (unset `memory.model` uses those same defaults), `local` runs an Ollama model (`memory.model` required), `jev`
  is the local OpenJev server (same loopback transport rules as the skill router, `src/routing/jev.ts`), `off`
  disables recall. CLI engines run tool-free through the hardened Otter CLI transport (the one combo routes use);
  the model returns a JSON probability per label (an omitted label counts as 0; the sum must be 1 within 0.1,
  then renormalized; unknown labels are refused). `auto`/`claude`/`codex` send the request text and the index
  titles/descriptions to Anthropic or OpenAI; `jev`/`local` stay on this machine.
- Select it in the Otter terminal with `/memory` (show the resolved engine, e.g. `auto → claude /
  claude-haiku-5-5`), `/memory test` (one fresh fixed-request recall with its time), `/memory auto`,
  `/memory claude [model]`, `/memory codex [slug]`, `/memory local <ollama-model>`, `/memory jev` or
  `/memory off`. It writes the user config
  (`~/.config/otter/otter.jsonc`), works before a model is selected and while held, dispatches no model turn,
  and says when the project `.otter/otter.jsonc` overrides it. Recall re-reads the config on every call, so the
  switch applies to the next `memory` call in the terminal and in the OpenCode plugin alike. `memory` is outside
  role-policy identity (like `chat` and `skill_trust`), so switching never changes policy IDs.

- Catalog: the `concepts/` and `entities/` links of `knowledge/wiki/index.md` (title + description, index
  order, deduplicated, at most 16, real non-symlink pages only). Source and report pages are evidence, not
  candidates. Only the request text (at most 2000 characters) and index titles/descriptions are sent; page
  bodies never are. Credential-like input is refused before inference.
- One `/v1/systemone` call: `jev-latest`, `samples: 1`, `steps: 1`, a `choice` question over the page paths
  plus an explicit `none`. Every page with probability `>= memory.min_probability` **and** above `none` is
  linked (memory is spread across pages, unlike a single skill), highest first, at most `memory.max_pages`.
  Invalid responses/distributions, unknown labels, timeouts and a second concurrent recall (`busy`; one
  inference per process, no queue or retries) link nothing and say so; there is no keyword fallback.
- Output: path, title, probability, index description and the page opening (after the H1), within 6000
  bytes, under a header labelling the notes as reference data, not instructions. Main's prompt rule 7 has it
  call `memory` once with the request before nontrivial work or questions about past decisions.
- Latency measured on this machine (2026-10-17, 11 candidates): `jev` (local MLX diffusiongemma 26B) 43-72 s;
  the default `auto → claude-haiku-5-5` 2.7-6.2 s and 8/8 answered on eight Korean/English requests, each linked
  to the expected page (p=0.70-0.93) and `none` for an unrelated login-page request. `codex / gpt-5.6-luna` was
  not measured: the account was over its usage limit, which recall reports as unavailable. Probabilities are model
  output, not calibrated relevance.
- Why Jev is slow here (measured, not the model): OpenJev's own README puts an MLX read at ~0.4 s on an M4 Max.
  On this 64 GiB M4 Pro, 46 GiB was wired (Ollama keeps `qwen3.6:35b` ~22 GB and gemma resident with
  `keep_alive: Forever`), swap was 21.0/21.5 GiB, and the Jev process (26.9 GB footprint) had its weights
  compressed/swapped out. One 2-label read caused ~15 GiB of swap-ins and took 59 s; latency grew on identical
  repeats (44 → 64 → 71 s), and prompt size did not matter (3 vs 11 candidates, both ~60 s). Fix the memory, not
  the code: unload idle Ollama models (`ollama stop <model>`, shorter `OLLAMA_KEEP_ALIVE`), or use `auto`.
  `/memory test` measures the engine and names this cause when swap is ≥ 80% used.
- Hiding latency (any engine): an identical request reuses its scores from a 32-entry, 10-minute in-process
  cache keyed by engine, model/endpoint, the index-derived candidate text and the request (an index edit
  re-infers; page openings are re-read every call; failures are never cached). `memory.prefetch: true` starts
  recall of the user's message when the turn reaches main (plugin `chat.message`, terminal planning turn), in
  parallel with the model's first step; the turn's first `memory` call takes it, later calls run fresh, a newer
  turn cancels it, and a failed prefetch falls back to the agent's query. It is on by default and costs one
  inference per main turn (also turns that never call memory); set `"prefetch": false` to pay only per call.
  Measured with `claude-haiku-5-5` and 3 s of main work before the tool call: tool wait 0-1.8 s instead of
  3-6 s. `/memory show` reports the latency observed in this process.
- Recall never writes the wiki or its log: new memory still enters through `capture`/`register` and the
  `llm-wiki` ingest flow below. Implementation: `src/wiki/recall.ts`, `src/tools/memory.ts` (plugin),
  `src/hosts/cli-tools.ts` + `cli-host.ts` (CLI, the one asynchronous CLI tool).

```json
{ "memory": { "engine": "auto", "prefetch": true, "endpoint": "http://127.0.0.1:8080", "timeout_ms": 30000, "min_probability": 0.3, "max_pages": 3 } }
```

That is the default. A local-only setup is `{ "memory": { "engine": "jev", "timeout_ms": 120000 } }` (raise the
timeout: Jev under memory pressure took up to 72 s). Validated at use (`engine` one of the six, `model` a native ID and for codex a bundled slug, `timeout_ms`
1000..300000, `min_probability` 0.05..1, `max_pages` 1..5); an invalid block turns recall off with a stated reason.

The `guard.wiki_raw` hook (`tool.execute.before`) refuses edit/write/multiedit and
`apply_patch`/`patch` targets under `knowledge/raw/` (case variants and symlink aliases
included; patch targets are read from `*** Add/Update/Delete File:` and `*** Move to:`
lines). It does not parse bash; `lint`'s byte-hash integrity check is the backstop.

## SkillOpt pilot — blocked before inference

The separate, explicitly authorized Microsoft/SkillOpt pilot is **not a completed
optimization or deployment**. The production `llm-wiki` skill and closed/off P1
campaign remain unchanged. No candidate or efficacy result exists.

```sh
bun scripts/otter-skillopt.ts snapshot
bun scripts/otter-skillopt.ts preflight
```

`snapshot` emits bounded hash-only source metadata, including the immutable research
note and its separate A13 correction. `preflight` checks installed launchers and a
minimal sandbox primitive without starting inference; the observed environment
returns exit 1 with `isolation_unavailable`. This primitive check is not proof of
actual-role containment or a live skill load.

Ollama 0.34.3 chooses an ephemeral internal runner port. Fixing its public
`OLLAMA_HOST` does not satisfy the approved fixed/reserved internal-route boundary.
Broad loopback access, replacing its renderer, or patching/upgrading the host is
not authorized by this pilot. `optimize` and `apply` are deliberately not exposed
by this CLI; unsupported commands fail, rather than reporting a no-op success.
The full experiment, independent qualification, exact-candidate approval and
verified production application remain unmet. See the
[pilot runbook and capability boundary](../docs/lca-skillopt-pipeline-2026-10-03.md).

## Delegate config (`.otter/otter.jsonc` → `delegate`)

| key | default | meaning |
|---|---|---|
| `review` | `true` | run the reviewer child session on each task's diff + verify output |
| `worktree` | `false` | stage 4: each code task runs in a linked git worktree under the state root (worker session + verify bound to it via the SDK's per-request `directory`); its diff is applied to the main worktree only when accepted (`git apply --check` first — a patch that no longer applies fails the task and stays in `.otter/handoffs/<session>/task-N.patch`). Falls back to in-place without a commit. Measured (ulw3): 3/3 done, verify + review in the worktrees, files merged, 88 s vs 64 s in place — each worker's system prompt embeds its own directory, so worker prefixes are no longer shared (3 worker cache misses instead of 1; E07 reports it). Isolation costs one prefill per task. |
| `review_strict` | `false` | `true`: a REJECT / no verdict on the last attempt fails the task even when verify passed |
| `max_attempts` | `2` | worker attempts per task (failed verify / REJECT re-runs once with the reason) |
| `task_ttl_ms` / `review_ttl_ms` | `900000` / `180000` | wall-clock cap per worker / reviewer session; on expiry the child is aborted and the attempt fails |
| `queue_ttl_ms` | `7200000` | cap for a whole delegate call; remaining tasks are cancelled |
| `verify_timeout_ms` | `120000` | cap for the task's `verify` command (own process group, SIGTERM then SIGKILL) |
| `verify_allow` | test/check runners (see `config.ts`) | regexes a verify command must match; everything else is refused before it can run |
| `handoff_context_chars` | `600` | earlier-task summary prepended to the next worker prompt |
| `report_max_chars` / `verify_output_chars` | `1200` / `1500` | trimming of the worker report and the verify output tail |
| `diff_max_chars` | `6000` | maximum complete task diff accepted for scanning and review; a truncated diff fails the attempt before verification or review, even when review is disabled. Narrow the task or explicitly increase this bound. |
| `diff_exclude` | `__pycache__`, `.pytest_cache`, `node_modules`, `.venv`, `*.pyc`, `.env`, `*.pem`, … | globs never counted as task changes (any depth); `.otter/state` and `.otter/handoffs` are always excluded (`.otter/otter.jsonc` edits do show up). Without this the reviewer rejects "files outside the task" for test-run artifacts (seen in the first e2e) |

Hook ids for `disabled_hooks`: `tool.delegate` (drops the tool; main's prompt and the `ulw` suffix then fall back to the
stage-1 direct task list), `command.stop`, `command.status` (drops `/status`), `flow` (drops the plan workflow core
and its `/status` and boundary integration; `config.flow.enabled` is the master switch, checked together with this
hook id everywhere the flow feature is gated), `guard.plan_boundary` (drops the planning-phase tool allowlist).
Full list in `src/hooks/types.ts` (`HOOK_IDS`).

Known limits (from the reviews, not addressed): a plugin tool's `ctx.metadata()` is a no-op on OpenCode 1.18.32, so
the TUI shows only the tool name while the queue runs (the child sessions' titles `otter task N: …` are the progress
signal); execution claims now serialize the shared queue and review across processes, but an unresolved execution
retains its fence; test gaming
that no pattern catches (a clever worker) is only stopped by the reviewer, which on a 26B with thinking off is weak —
verify commands and protected files are the real gate, so write task-local tests.

## Data config (`.otter/otter.jsonc` → `data`)

| key | default | meaning |
|---|---|---|
| `backend` | `"none"` | `"sqlite"` / `"postgres"` enables db_query, schema_lookup and the data agents |
| `sqlite_path` | `data/app.sqlite` | sqlite file (relative to the worktree), opened read-only |
| `schema_file` | `data/schema.json` | static schema served by schema_lookup |
| `pg_dsn_env` / `pg_allow_remote` / `psql_path` | `OTTER_PG_DSN` / `false` / `psql` | env var holding the DSN; non-loopback hosts refused unless allowed; psql binary |
| `max_rows` / `max_cell_chars` / `max_output_tokens` | `50` / `80` / `1500` | result caps (hint line says what was cut) |
| `statement_timeout_ms` | `15000` | per query (sqlite progress handler / `SET LOCAL statement_timeout`) |
| `max_queries_per_session` | `6` | executed db_query calls per session (refused calls do not count) |
| `checks_dir` | `data/checks` | data-task check suites (`<suite>.json`) named by a data task's `verify`; `default` is built in |
| `evo.enabled` / `evo.workspace` / `evo.python` / `evo.server` | `true` / `.evoontology` / `python3` / vendored | EvoOntology MCP injection; `server` overrides the vendored `mcp_server.py` |

Hook ids: `tool.data` (drops db_query/schema_lookup and the data agents), `mcp.evo` (no MCP injection).

## Stage 5 scope (model comparison) — 2026-09-23, first slice

- `scripts/otter-e2e-data.sh --model ollama/<id>` and `OTTER_E2E_MODEL=ollama/<id> scripts/otter-e2e.sh` run the same
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
  otter sets `permission.skill` so main sees only the allowlist; worker/reviewer have the skill tool off.
  This project overrides the list in `.otter/otter.jsonc` to `["ulw","plan","llm-wiki"]` (arrays replace
  defaults; `DEFAULT_CONFIG.skills` in `config.ts` is unchanged) to enable the `llm-wiki` skill at
  `.agents/skills/llm-wiki/SKILL.md`.
- `guards.read_max_tokens` (default 2500) and `guards.relativize_paths` (default true): tool outputs are cut by
  estimated tokens, not just bytes, and worktree-absolute paths are made relative before the model sees them.
- The `delegate` tool schema costs ~257 est. tokens (doctor D09c and the unit test cap it at 400).
- Stage-1 e2e results: `docs/lca-stage1-2026-09-22.md`.
