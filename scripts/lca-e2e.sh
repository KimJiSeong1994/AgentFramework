#!/bin/bash
# lca-e2e.sh — ISOLATED acceptance run for the lca plugin (docs/agent-framework-review §6).
#   --fixture fib   (default) stage 1: main alone implements fib.py            criteria E01-E04
#   --fixture ulw3            stage 2: ulw -> delegate 3 tasks to worker sessions  criteria E01-E14
#   --fixture ulw-fail        stage 2 negative: one task's test cannot pass -> [done, failed, done], queue goes on
#
#   scripts/lca-e2e.sh --dry-run     # print every step and the exact command; touches nothing
#   scripts/lca-e2e.sh --check       # build the isolated env and verify isolation; NO model call
#   scripts/lca-e2e.sh               # full run: opencode run ... (loads the model, GPU, up to --timeout s)
#
# Options: --fixture NAME (fib)  --scratch DIR (default ~/.cache/lca/e2e, env LCA_E2E_SCRATCH)
#          --timeout S (fib 600 / ulw3 1800)  --max-wall S (fib 300 / ulw3 900)  --budget-tokens N (8000)
#          --worker-budget N / --reviewer-budget N (defaults: DEFAULT_CONFIG.budget)  --prompt "..."  --agent NAME (main)
#          --no-auto (do not pass --auto to opencode run)  --keep (keep the work dir on success)
# Exit: 0 all criteria met, 1 warnings only (check mode), 2 a criterion/check failed, 3 setup failed.
#
# Isolation design (verified on opencode 1.18.32, 2026-09-22 — `opencode debug paths` / `opencode debug config`):
#   * XDG_CONFIG_HOME and XDG_DATA_HOME ARE honoured: config -> $XDG_CONFIG_HOME/opencode, data (opencode.db,
#     log, repos) -> $XDG_DATA_HOME/opencode. The user's ~/.config/opencode/opencode.jsonc (loads oh-my-openagent)
#     and ~/.local/share/opencode/opencode.db are therefore never touched. XDG_STATE_HOME is isolated too;
#     XDG_CACHE_HOME is left alone (it only holds the opencode binary cache).
#   * OPENCODE_CONFIG_DIR is an ADDITIONAL global config dir (orca sets it in this shell and its opencode.json
#     also loads oh-my-openagent). It, ORCA_OPENCODE_CONFIG_DIR, OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT
#     are unset for every opencode call here.
#   * ~/.opencode/opencode.json(c) is also probed by OpenCode and is NOT covered by XDG; --check warns if it exists.
#   * --pure is NOT used: it would drop the project plugin (lca) as well.
#   * The lca plugin is loaded per project via <work>/.opencode/plugins/lca.ts re-exporting the absolute path of
#     framework/src/index.ts (same mechanism as the repo's own loader). No `plugin` key in the scratch config.
#   * `opencode debug config` truncates at 64 KiB when stdout is a pipe -> always redirected to a file.
#   * `opencode run` blocks on an open stdin -> always `</dev/null`; timeout via `perl -e 'alarm N; exec @ARGV'`.
#   * `--auto` (auto-approve permissions not explicitly denied) is passed by default so an unattended run cannot
#     hang on a permission prompt; the work dir is a throwaway git repo under the scratch dir. Use --no-auto to drop it.
#
# Success criteria (stage 1): tests pass after the run, wall < --max-wall, first-call input <= --budget-tokens,
# repeated identical tool calls == 0 (measured with scripts/lca-baseline.py on the isolated DB).
# Stage 2 (ulw3 / ulw-fail) adds: E05 ledger statuses match the fixture, E06 each task's worker session is a child
# of main with agent=worker (every attempt), E07 main cache misses <= 1 (GGUF reports 1, MLX 0), worker misses <= 1 (reviewer misses reported), E08 worker/reviewer prefix within
# their own budgets (DEFAULT_CONFIG.budget), E09 every review ACCEPT (ulw3) / skipped for the failed task (ulw-fail),
# E10 no reasoning parts in child sessions (thinking off), E11 no length stops anywhere, E12 per-task wall <= 120 s,
# E13 a handoff file per task, E14 main made no write/edit calls (it delegated). Plugin state (ledger) is read from
# XDG_STATE_HOME (control plane lives outside the worktree since the stage-2 review).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH_DEFAULT="$HOME/.cache/lca/e2e"
SCRATCH="${LCA_E2E_SCRATCH:-$SCRATCH_DEFAULT}"
MODE=run; TIMEOUT=""; MAX_WALL=""; BUDGET=8000; WORKER_BUDGET=""; REVIEWER_BUDGET=""; AGENT=main; AUTO=1; KEEP=0
FIXTURE_NAME=fib; PROMPT=""; WORKTREE=0
USER_JSONC="$HOME/.config/opencode/opencode.jsonc"
BASELINE="$ROOT/scripts/lca-baseline.py"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry ;;
    --check) MODE=check ;;
    --fixture) FIXTURE_NAME="$2"; shift ;;
    --scratch) SCRATCH="$2"; shift ;;
    --worker-budget) WORKER_BUDGET="$2"; shift ;;
    --reviewer-budget) REVIEWER_BUDGET="$2"; shift ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --max-wall) MAX_WALL="$2"; shift ;;
    --budget-tokens) BUDGET="$2"; shift ;;
    --prompt) PROMPT="$2"; shift ;;
    --agent) AGENT="$2"; shift ;;
    --no-auto) AUTO=0 ;;
    --keep) KEEP=1 ;;
    --worktree) WORKTREE=1 ;;
    -h|--help) sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 3 ;;
  esac
  shift
done

# per-fixture defaults
FIXTURE="$ROOT/scripts/fixtures/$FIXTURE_NAME"
N_TASKS=0; EXPECT_STATUS=""; EXPECT_REVIEWS=""; TASK_WALL=120
case "$FIXTURE_NAME" in
  fib)
    : "${PROMPT:=Implement fib(n) in fib.py so that test_fib.py passes. Run the tests.}"
    : "${TIMEOUT:=600}"; : "${MAX_WALL:=300}" ;;
  ulw3)
    : "${PROMPT:=ulw: Implement circle.py, rect.py and triangle.py so that test_circle.py, test_rect.py and test_triangle.py pass. One module per task; verify each with 'python3 -m pytest -q <its test file>'.}"
    : "${TIMEOUT:=1800}"; : "${MAX_WALL:=900}"; N_TASKS=3; EXPECT_STATUS="done,done,done"; EXPECT_REVIEWS="accept,accept,accept" ;;
  ulw-fail)
    : "${PROMPT:=ulw: Implement circle.py, rect.py and triangle.py so that test_circle.py, test_rect.py and test_triangle.py pass. One module per task; verify each with 'python3 -m pytest -q <its test file>'.}"
    : "${TIMEOUT:=1800}"; : "${MAX_WALL:=900}"; N_TASKS=3; EXPECT_STATUS="done,failed,done"; EXPECT_REVIEWS="accept,skipped,accept"; TASK_WALL=240 ;;
  *)
    [ -d "$FIXTURE" ] || { echo "unknown fixture: $FIXTURE_NAME ($FIXTURE missing)" >&2; exit 3; }
    : "${PROMPT:=Make the tests in this directory pass.}"; : "${TIMEOUT:=1800}"; : "${MAX_WALL:=900}" ;;
esac

E2E="$SCRATCH/lca-e2e"
CFG_HOME="$E2E/config"; DATA_HOME="$E2E/data"; STATE_HOME="$E2E/state"; LOGS="$E2E/logs"
SCRATCH_CFG="$CFG_HOME/opencode/opencode.json"
ISO_DB="$DATA_HOME/opencode/opencode.db"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$E2E/work/$FIXTURE_NAME-$STAMP"
AUTO_FLAG=""; [ "$AUTO" = 1 ] && AUTO_FLAG="--auto"

N_WARN=0; N_FAIL=0
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
res()  { # status id text
  case "$1" in WARN) N_WARN=$((N_WARN+1));; FAIL) N_FAIL=$((N_FAIL+1));; esac
  printf '[%s] %-4s %s\n' "$1" "$2" "$3"
}
with_timeout() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }
# every opencode invocation goes through here
oc() {
  env -u OPENCODE_CONFIG_DIR -u ORCA_OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT \
      XDG_CONFIG_HOME="$CFG_HOME" XDG_DATA_HOME="$DATA_HOME" XDG_STATE_HOME="$STATE_HOME" "$@"
}
RUN_CMD="perl -e 'alarm $TIMEOUT; exec @ARGV' opencode run --format json --agent $AGENT $AUTO_FLAG \"$PROMPT\" </dev/null"

# ------------------------------------------------------------------ dry run
if [ "$MODE" = dry ]; then
  say "lca-e2e dry run (nothing is created)"
  say "  repo root        : $ROOT"
  say "  scratch          : $E2E"
  say "  XDG_CONFIG_HOME  : $CFG_HOME   -> writes $SCRATCH_CFG"
  say "  XDG_DATA_HOME    : $DATA_HOME    -> isolated DB $ISO_DB"
  say "  XDG_STATE_HOME   : $STATE_HOME"
  say "  unset            : OPENCODE_CONFIG_DIR ORCA_OPENCODE_CONFIG_DIR OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT"
  say "  scratch config   : provider.ollama + model + small_model copied from $USER_JSONC; NO plugin key"
  say "  fixture          : $FIXTURE_NAME ($FIXTURE) -> $WORK (git init + commit; .opencode/plugins/lca.ts -> $ROOT/framework/src/index.ts)"
  say "  command          : cd $WORK && $RUN_CMD"
  say "  outputs          : $LOGS/run-$STAMP.jsonl / .err / .meta"
  say "  verify           : python3 -m pytest -q; wall < ${MAX_WALL}s;"
  say "                     python3 $BASELINE --db $ISO_DB  -> prefix <= $BUDGET, repeated identical calls == 0"
  [ "$N_TASKS" -gt 0 ] && say "  stage 2          : ledger statuses [$EXPECT_STATUS], reviews [$EXPECT_REVIEWS], main miss == 1, worker miss <= 1 (reviewers reported), per-agent prefix budgets, no reasoning parts, no length stops, task wall <= ${TASK_WALL}s, handoffs, main write calls == 0"
  say "  cleanup          : work dir removed on success unless --keep; config/data kept for inspection"
  exit 0
fi

# ------------------------------------------------------------------ setup (check + run)
step "setup: isolated XDG dirs under $E2E"
mkdir -p "$CFG_HOME/opencode" "$DATA_HOME" "$STATE_HOME" "$LOGS" "$E2E/work" || { echo "cannot create $E2E" >&2; exit 3; }
[ -f "$USER_JSONC" ] || { echo "user config $USER_JSONC not found (need provider.ollama block)" >&2; exit 3; }
python3 - "$USER_JSONC" "$SCRATCH_CFG" "${LCA_E2E_MODEL:-}" <<'PY' || exit 3
import json, re, sys
src, dst, model_override = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read()
t = re.sub(r"/\*[\s\S]*?\*/", "", t)                      # block comments
t = re.sub(r'(^|[^:"\'\\])//.*$', r"\1", t, flags=re.M)     # line comments (not inside URLs)
t = re.sub(r",(\s*[}\]])", r"\1", t)                       # trailing commas
u = json.loads(t)
prov = (u.get("provider") or {}).get("ollama")
if not prov:
    sys.exit("provider.ollama missing in " + src)
if model_override and model_override.startswith("ollama/") and model_override[7:] not in (prov.get("models") or {}):
    base = (prov.get("models") or {}).get(str(u.get("model", ""))[7:], {})
    prov.setdefault("models", {})[model_override[7:]] = {"name": model_override[7:] + " (e2e)", "tool_call": True, "reasoning": bool(base.get("reasoning", True)), "limit": base.get("limit", {"context": 65536, "output": 8192}), "options": base.get("options", {})}
    print(f"registered {model_override} in the scratch config (not in {src})")
cfg = {
    "$schema": "https://opencode.ai/config.json",
    "model": model_override or u.get("model", "ollama/gemma4:26b-a4b-it-mtp-q4_K_M"),
    "small_model": u.get("small_model", u.get("model")),
    "provider": {"ollama": prov},
    # no "plugin": lca is loaded per project from <work>/.opencode/plugins/lca.ts
}
json.dump(cfg, open(dst, "w"), indent=2)
print(f"wrote {dst}: model={cfg['model']} small_model={cfg['small_model']} plugin=<absent>")
PY

step "setup: work dir from fixture"
[ -d "$FIXTURE" ] || { echo "fixture missing: $FIXTURE" >&2; exit 3; }
mkdir -p "$WORK/.opencode/plugins" && cp -R "$FIXTURE/." "$WORK/" || exit 3
rm -rf "$WORK/__pycache__" "$WORK/.pytest_cache"
printf '// e2e loader: lca plugin from the repo under test (absolute path).\nexport { LcaPlugin } from "%s/framework/src/index.ts"\n' "$ROOT" > "$WORK/.opencode/plugins/lca.ts"
if [ "$WORKTREE" = 1 ]; then mkdir -p "$WORK/.lca" && printf '{ "delegate": { "worktree": true } }\n' > "$WORK/.lca/lca.jsonc"; fi
( cd "$WORK" && git init -q && git add -A && git -c user.name=lca-e2e -c user.email=lca-e2e@localhost commit -q -m "fixture: $FIXTURE_NAME" ) || exit 3
say "work dir: $WORK"

# ------------------------------------------------------------------ check mode
if [ "$MODE" = check ]; then
  step "check: isolation (no model call)"
  for t in perl python3 bun opencode git; do command -v "$t" >/dev/null 2>&1 && res PASS C00 "$t present" || res FAIL C00 "$t missing"; done

  oc opencode debug paths > "$LOGS/paths.txt" 2>&1 </dev/null
  pc="$(awk '$1=="config"{print $2}' "$LOGS/paths.txt")"; pd="$(awk '$1=="data"{print $2}' "$LOGS/paths.txt")"
  [ "$pc" = "$CFG_HOME/opencode" ] && res PASS C01 "config path honours XDG_CONFIG_HOME: $pc" || res FAIL C01 "config path is '$pc', expected $CFG_HOME/opencode (XDG_CONFIG_HOME ignored?)"
  [ "$pd" = "$DATA_HOME/opencode" ] && res PASS C02 "data path honours XDG_DATA_HOME: $pd" || res FAIL C02 "data path is '$pd', expected $DATA_HOME/opencode"

  if [ -f "$HOME/.opencode/opencode.json" ] || [ -f "$HOME/.opencode/opencode.jsonc" ]; then
    res WARN C03 "~/.opencode/opencode.json(c) exists and is NOT isolated by XDG; its keys leak into the run"
  else res PASS C03 "no ~/.opencode/opencode.json(c) (legacy global config not present)"; fi

  udb_before="$(stat -f %m "$HOME/.local/share/opencode/opencode.db" 2>/dev/null || echo 0)"
  ( cd "$WORK" && oc perl -e 'alarm 90; exec @ARGV or exit 127' opencode debug config > "$LOGS/config.json" 2> "$LOGS/config.err" </dev/null ); rc=$?
  python3 - "$LOGS/config.json" "$rc" "$ROOT" <<'PY' > "$LOGS/config.summary" 2>&1
import json, sys
path, rc, root = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"valid=0\nerror=rc={rc} {e}"); sys.exit(0)
print("valid=1")
plugins = [p if isinstance(p, str) else p[0] for p in (d.get("plugin") or [])]
print("plugins=" + " ".join(plugins))
print("omo=" + ("1" if any("oh-my-openagent" in p for p in plugins) else "0"))
print("lca=" + ("1" if any(p.endswith("/.opencode/plugins/lca.ts") for p in plugins) else "0"))
print("foreign=" + " ".join(p for p in plugins if not p.endswith("/.opencode/plugins/lca.ts")))
print("model=" + str(d.get("model")))
print("provider_ollama=" + ("1" if "ollama" in (d.get("provider") or {}) else "0"))
ag = d.get("agent") or {}
print("agents=" + ",".join(n for n in ("main", "worker", "reviewer") if n in ag))
print("agents_all=" + ",".join(ag.keys()))
print("tools_task=" + json.dumps((d.get("permission") or {}).get("task", "<unset>")))
print("default_agent=" + str(d.get("default_agent")))
PY
  v() { grep "^$1=" "$LOGS/config.summary" | head -1 | cut -d= -f2-; }
  if [ "$(v valid)" != 1 ]; then
    res FAIL C04 "opencode debug config failed under the isolated env: $(v error) $(tail -1 "$LOGS/config.err" 2>/dev/null)"
  else
    res PASS C04 "opencode debug config valid under isolated env ($(wc -c < "$LOGS/config.json" | tr -d ' ') bytes)"
    if [ "$(v omo)" = 1 ]; then res FAIL C05 "oh-my-openagent still in plugin list: [$(v plugins)]"
    elif [ -n "$(v foreign)" ]; then res WARN C05 "unexpected plugins beside lca: [$(v foreign)]"
    else res PASS C05 "plugin list = [$(v plugins)] (no oh-my-openagent, no global plugins)"; fi
    [ "$(v lca)" = 1 ] && res PASS C06 "lca project loader picked up" || res FAIL C06 "lca loader not in plugin list: [$(v plugins)]"
    [ "$(v provider_ollama)" = 1 ] && res PASS C07 "provider.ollama present, model=$(v model)" || res FAIL C07 "provider.ollama missing in effective config"
    if [ "$(v agents)" = "main,worker,reviewer" ]; then res PASS C08 "lca agents injected: $(v agents); permission.task=$(v tools_task); default_agent=$(v default_agent)"
    else res WARN C08 "lca agents incomplete: [$(v agents)] all=[$(v agents_all)] (plugin still being written?) stderr: $(grep -iE 'error|lca' "$LOGS/config.err" | head -1)"; fi
    [ "$(v default_agent)" = "$AGENT" ] && res PASS C09 "default_agent=$AGENT" || res WARN C09 "default_agent=$(v default_agent) (run uses --agent $AGENT explicitly)"
  fi
  [ -f "$ISO_DB" ] && res PASS C10 "isolated DB created: $ISO_DB" || res WARN C10 "isolated DB not created yet (appears on first run)"
  udb_after="$(stat -f %m "$HOME/.local/share/opencode/opencode.db" 2>/dev/null || echo 0)"
  [ "$udb_before" = "$udb_after" ] && res PASS C11 "user DB ~/.local/share/opencode/opencode.db untouched (mtime unchanged)" || res WARN C11 "user DB mtime changed during check (another OpenCode instance running?)"

  ( cd "$WORK" && python3 -m pytest -q >/dev/null 2>&1 ); [ $? -ne 0 ] && res PASS C12 "fixture $FIXTURE_NAME fails before the run (modules absent)" || res FAIL C12 "fixture already passes; modules present?"
  if curl -sf "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/version" >/dev/null 2>&1; then
    m="$(v model)"; m="${m#ollama/}"
    if with_timeout 20 ollama ls 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$m"; then res PASS C13 "ollama up, model $m installed"; else res FAIL C13 "model $m not in ollama ls"; fi
  else res WARN C13 "ollama server not reachable (start Ollama.app before the real run)"; fi
  [ -f "$BASELINE" ] && res PASS C14 "baseline script present" || res FAIL C14 "$BASELINE missing"

  say ""; say "would run: cd $WORK && $RUN_CMD"
  if [ "$KEEP" = 1 ]; then say "work dir kept: $WORK"; else rm -rf "$WORK"; fi
  say "check: $N_WARN warn, $N_FAIL fail (logs: $LOGS)"
  [ "$N_FAIL" -gt 0 ] && exit 2; [ "$N_WARN" -gt 0 ] && exit 1; exit 0
fi

# ------------------------------------------------------------------ run mode
step "run: opencode ($AGENT) on fixture $FIXTURE_NAME, timeout ${TIMEOUT}s"
OUT="$LOGS/run-$STAMP.jsonl"; ERR="$LOGS/run-$STAMP.err"; META="$LOGS/run-$STAMP.meta"
say "cd $WORK && $RUN_CMD"
t0="$(date +%s)"
( cd "$WORK" && oc perl -e "alarm $TIMEOUT; exec @ARGV or exit 127" opencode run --format json --agent "$AGENT" $AUTO_FLAG "$PROMPT" </dev/null > "$OUT" 2> "$ERR" )
rc=$?
t1="$(date +%s)"; wall=$((t1 - t0))
say "opencode exit=$rc wall=${wall}s events=$(wc -l < "$OUT" | tr -d ' ') stderr=$(wc -l < "$ERR" | tr -d ' ') lines"
[ "$rc" -eq 142 ] && say "  (exit 142 = SIGALRM: timed out after ${TIMEOUT}s)"

step "verify"
if [ "$FIXTURE_NAME" = ulw-fail ]; then
  # negative fixture: exactly the impossible test fails, everything else passes
  ( cd "$WORK" && python3 -m pytest -q > "$LOGS/pytest-$STAMP.txt" 2>&1 )
  if grep -qE '^1 failed, [0-9]+ passed' "$LOGS/pytest-$STAMP.txt" && grep -q test_impossible "$LOGS/pytest-$STAMP.txt"; then res PASS E01 "only test_impossible fails ($(tail -1 "$LOGS/pytest-$STAMP.txt"))"
  else res FAIL E01 "unexpected pytest result: $(tail -1 "$LOGS/pytest-$STAMP.txt")"; fi
elif ( cd "$WORK" && python3 -m pytest -q > "$LOGS/pytest-$STAMP.txt" 2>&1 ); then res PASS E01 "tests pass ($(tail -1 "$LOGS/pytest-$STAMP.txt"))"
elif [ "$FIXTURE_NAME" = fib ] && ( cd "$WORK" && python3 test_fib.py > "$LOGS/pytest-$STAMP.txt" 2>&1 ); then res PASS E01 "tests pass (python3 test_fib.py)"
else res FAIL E01 "tests fail: $(grep -E 'FAIL|Error|failed|passed' "$LOGS/pytest-$STAMP.txt" | head -2 | tr '\n' ' ')"; fi
[ "$wall" -lt "$MAX_WALL" ] && res PASS E02 "wall ${wall}s < ${MAX_WALL}s" || res FAIL E02 "wall ${wall}s >= ${MAX_WALL}s"

if [ -f "$ISO_DB" ]; then
  python3 "$BASELINE" --db "$ISO_DB" --json > "$LOGS/baseline-$STAMP.json" 2>&1
  python3 - "$LOGS/baseline-$STAMP.json" "$t0" "$WORK" <<'PY' > "$META" 2>&1
import json, sys
d = json.load(open(sys.argv[1])); t0 = int(sys.argv[2]) * 1000; work = sys.argv[3].rstrip("/")
roots = [s for s in d["sessions"] if s["kind"] == "root" and s["time_created"] >= t0 - 5000 and (s.get("directory") or "").rstrip("/") == work]
if not roots:
    print("found=0"); sys.exit(0)
s = sorted(roots, key=lambda r: r["time_created"])[0]
print("found=1"); print("id=" + s["id"]); print("agent=" + str(s["agent"]))
print("prefix=" + str(s["prefix_tokens"])); print("dup=" + str(s["repeated_identical_tool_calls"]))
print("run=" + str(s["max_identical_run"])); print("miss=" + str(s["cache_miss_calls"]))
print("comp=" + str(s["compaction_count"])); print("len=" + str(s["length_stops"]))
print("tools=" + str(s["n_tool_calls"])); print("amsg=" + str(s["n_assistant_msgs"]))
print("main_writes=" + str(s.get("write_calls", 0))); print("main_reasoning=" + str(s.get("reasoning_parts", 0)))
children = [c for c in d["sessions"] if c["parent_id"] == s["id"]]
print("children=" + str(len(children)))
print("child_prefix_max=" + str(max([c["prefix_tokens"] or 0 for c in children] or [0])))
for ag in ("worker", "reviewer"):
    print(f"{ag}_prefix_max=" + str(max([c["prefix_tokens"] or 0 for c in children if c["agent"] == ag] or [0])))
print("child_miss_total=" + str(sum(c["cache_miss_calls"] or 0 for c in children)))
print("worker_miss=" + str(sum(c["cache_miss_calls"] or 0 for c in children if c["agent"] == "worker")))
print("reviewer_miss=" + str(sum(c["cache_miss_calls"] or 0 for c in children if c["agent"] == "reviewer")))
print("child_reasoning=" + str(sum(c.get("reasoning_parts", 0) for c in children)))
print("child_len=" + str(sum(c["length_stops"] or 0 for c in children)))
print("child_dup=" + str(sum(c["repeated_identical_tool_calls"] or 0 for c in children)))
print("child_agents=" + ",".join(f"{c['agent']}:{c['prefix_tokens']}" for c in children))
print("child_ids=" + ",".join(f"{c['id']}:{c['agent']}" for c in children))
PY
  m() { grep "^$1=" "$META" | head -1 | cut -d= -f2-; }
  if [ "$(m found)" = 1 ]; then
    say "session $(m id): agent=$(m agent) assistant msgs=$(m amsg) tools=$(m tools) cache-miss=$(m miss) compactions=$(m comp) length stops=$(m len) children=$(m children)"
    p="$(m prefix)"; [ "$p" != None ] && [ "$p" -le "$BUDGET" ] && res PASS E03 "first-call prefix $p <= $BUDGET tokens" || res FAIL E03 "first-call prefix $p > $BUDGET tokens"
    [ "$(m dup)" = 0 ] && res PASS E04 "repeated identical tool calls = 0" || res FAIL E04 "repeated identical tool calls = $(m dup) (longest streak $(m run))"
    python3 "$BASELINE" --db "$ISO_DB" --session "$(m id)" > "$LOGS/timeline-$STAMP.txt" 2>&1; say "timeline: $LOGS/timeline-$STAMP.txt"
    if [ "$N_TASKS" -gt 0 ]; then
      # ---- stage 2 criteria: ledger (outside the worktree, under XDG_STATE_HOME) + child sessions
      LEDGER="$(find "$STATE_HOME/lca" -path "*/sessions/$(m id)/ledger.json" 2>/dev/null | head -1)"
      if [ -n "$LEDGER" ] && [ -f "$LEDGER" ]; then
        cp "$LEDGER" "$LOGS/ledger-$STAMP.json"; [ -d "$WORK/.lca/handoffs" ] && cp -R "$WORK/.lca/handoffs" "$LOGS/handoffs-$STAMP"
        python3 - "$LEDGER" "$WORK" "$(m child_ids)" <<'PY' > "$LOGS/ledger-$STAMP.summary"
import json, os, sys
l = json.load(open(sys.argv[1])); work = sys.argv[2]
kids = dict(x.split(":") for x in sys.argv[3].split(",") if x)
ts = l["tasks"]
print("n=" + str(len(ts)))
print("status=" + ",".join(t["status"] for t in ts))
print("attempts=" + ",".join(str(t["attempts"]) for t in ts))
print("detail=" + ",".join(f"{t['n']}:{t['status']}/{t['attempts']}" for t in ts))
print("workers_ok=" + ("1" if all(kids.get(s) == "worker" for t in ts for s in (t.get("childSessions") or [t.get("workerSessionID")]) if s) and all(t.get("workerSessionID") for t in ts if t.get("attempts")) else "0"))
print("reviews=" + ",".join(str((t.get("review") or {}).get("verdict")) for t in ts))
print("reviewers_ok=" + ("1" if all(kids.get((t.get("review") or {}).get("sessionID") or "") == "reviewer" for t in ts if (t.get("review") or {}).get("verdict") in ("accept", "reject")) else "0"))
print("verify=" + ",".join(str((t.get("verify_result") or {}).get("ok")) for t in ts))
print("task_wall_max=" + str(max([int(((t.get("finishedAt") or 0) - (t.get("startedAt") or 0)) / 1000) for t in ts] or [0])))
# a handoff exists for every task that was started (cancelled-before-start tasks have none)
print("handoffs_ok=" + ("1" if all(t.get("handoff") and os.path.isfile(os.path.join(work, t["handoff"])) and f"- status: {t['status']}" in open(os.path.join(work, t["handoff"])).read() for t in ts if t.get("attempts")) else "0"))
print("files=" + ";".join(",".join(t.get("filesChanged") or []) for t in ts))
print("running=" + ("1" if l.get("running") else "0"))
PY
        lv() { grep "^$1=" "$LOGS/ledger-$STAMP.summary" | head -1 | cut -d= -f2-; }
        say "ledger: tasks=$(lv detail) reviews=$(lv reviews) verify=$(lv verify) files=$(lv files) task-wall-max=$(lv task_wall_max)s"
        [ "$(lv status)" = "$EXPECT_STATUS" ] && [ "$(lv running)" = 0 ] && res PASS E05 "ledger statuses [$(lv status)] as expected, attempts [$(lv attempts)]" || res FAIL E05 "ledger statuses [$(lv status)] expected [$EXPECT_STATUS] (running=$(lv running); see $LOGS/ledger-$STAMP.json)"
        [ "$(lv workers_ok)" = 1 ] && [ "$(lv reviewers_ok)" = 1 ] && res PASS E06 "every task ran in its own worker child of main; verdicts came from reviewer children ($(m child_agents))" || res FAIL E06 "worker/reviewer session cross-check failed (workers_ok=$(lv workers_ok) reviewers_ok=$(lv reviewers_ok); children: $(m child_ids))"
        [ "$(lv reviews)" = "$EXPECT_REVIEWS" ] && res PASS E09 "reviews [$(lv reviews)]" || res FAIL E09 "reviews [$(lv reviews)] expected [$EXPECT_REVIEWS]"
        [ "$(lv task_wall_max)" -le "$TASK_WALL" ] && res PASS E12 "slowest task $(lv task_wall_max)s <= ${TASK_WALL}s" || res FAIL E12 "slowest task $(lv task_wall_max)s > ${TASK_WALL}s"
        [ "$(lv handoffs_ok)" = 1 ] && res PASS E13 "a handoff file with the final status exists for every task" || res FAIL E13 "handoff files missing or stale (see $LOGS/handoffs-$STAMP)"
      else res FAIL E05 "no ledger for session $(m id) under $STATE_HOME/lca (delegate never called? see $LOGS/timeline-$STAMP.txt)"; for id in E06 E09 E12 E13; do res FAIL $id "no ledger"; done; fi
      # main: exactly the first call. Workers share one prefix -> only the first worker prefills. Reviewers alternate
      # with workers on a single Ollama slot and their (shorter) prefix is evicted each time, so every reviewer session
      # is a miss by construction: reported, not judged (a retry adds a reviewer session, so "<= N" would be a false FAIL).
      mm="$(m miss)"; wm="$(m worker_miss)"; rm_="$(m reviewer_miss)"
      # main: exactly one miss on the GGUF runner; the MLX runner reports the first call as a cache read (0) — both are a
      # single prefill, so 0..1 is the honest bound (stage-5 31B-mlx run)
      [ "$mm" -le 1 ] && [ "$wm" -le 1 ] && res PASS E07 "cache misses: main $mm <= 1, workers $wm <= 1 (reviewers $rm_, one per session by construction)" || res FAIL E07 "cache misses: main $mm (expected <= 1), workers $wm (expected <= 1); reviewers $rm_"
      budget_of() { (cd "$ROOT/framework" && bun -e "import {DEFAULT_CONFIG} from './src/config.ts'; console.log(DEFAULT_CONFIG.budget.$1)" 2>/dev/null); }
      if [ -z "$WORKER_BUDGET" ]; then WORKER_BUDGET="$(budget_of worker)"; [ -n "$WORKER_BUDGET" ] || res WARN E08 "could not read DEFAULT_CONFIG.budget.worker via bun; using 5000"; fi
      if [ -z "$REVIEWER_BUDGET" ]; then REVIEWER_BUDGET="$(budget_of reviewer)"; [ -n "$REVIEWER_BUDGET" ] || res WARN E08 "could not read DEFAULT_CONFIG.budget.reviewer via bun; using 3000"; fi
      wp="$(m worker_prefix_max)"; rp="$(m reviewer_prefix_max)"
      [ "$wp" -le "${WORKER_BUDGET:-5000}" ] && [ "$rp" -le "${REVIEWER_BUDGET:-3000}" ] && res PASS E08 "prefix worker $wp <= ${WORKER_BUDGET:-5000}, reviewer $rp <= ${REVIEWER_BUDGET:-3000}" || res FAIL E08 "prefix worker $wp (budget ${WORKER_BUDGET:-5000}), reviewer $rp (budget ${REVIEWER_BUDGET:-3000})"
      [ "$(m child_reasoning)" = 0 ] && res PASS E10 "no reasoning parts in child sessions (thinking off; main: $(m main_reasoning))" || res FAIL E10 "$(m child_reasoning) reasoning parts in child sessions (reasoningEffort not applied?)"
      [ "$(m len)" = 0 ] && [ "$(m child_len)" = 0 ] && res PASS E11 "no length stops (main $(m len), children $(m child_len))" || res FAIL E11 "length stops: main $(m len), children $(m child_len)"
      [ "$(m main_writes)" = 0 ] && res PASS E14 "main made no write/edit calls (delegated)" || res FAIL E14 "main made $(m main_writes) write/edit calls instead of delegating"
    fi
  else res FAIL E03 "no session recorded in $ISO_DB for this run (see $ERR)"; fi
else res FAIL E03 "isolated DB $ISO_DB missing after the run"; fi

say ""
if [ "$N_FAIL" -eq 0 ]; then
  say "e2e: PASS (logs: $LOGS, run $STAMP)"; [ "$KEEP" = 1 ] && say "work dir kept: $WORK" || rm -rf "$WORK"; exit 0
else
  say "e2e: FAIL ($N_FAIL criteria) — work dir kept: $WORK ; logs: $LOGS"; exit 2
fi
