#!/bin/bash
# lca-e2e-data.sh — ISOLATED stage-3 acceptance run: the `data-analyst` agent answers the example questions of
# the fixture question set (queries.jsonl) on the synthetic sqlite through the EvoOntology semantic layer.
#
#   scripts/lca-e2e-data.sh --check            # build the isolated env, verify agent/tools/MCP wiring; NO model call
#   scripts/lca-e2e-data.sh                    # tier-1 questions (7), one `opencode run --agent data-analyst` each
#   scripts/lca-e2e-data.sh --tier 2           # tier-1 + tier-2 (PostGIS-style + 3-way joins)
#   scripts/lca-e2e-data.sh --only TEXT-001    # a single question id
#   scripts/lca-e2e-data.sh --evo-workspace D  # use another EvoOntology workspace (candidate version evaluation)
#   scripts/lca-e2e-data.sh --model ollama/gemma4:31b-mlx   # another model from the user's provider list (stage 5)
#   scripts/lca-e2e-data.sh --questions F.jsonl # another question file; records without `expected` get match=-1
#                                              #   (no ground truth: the SQL + first rows are still captured for a judge)
#   scripts/lca-e2e-data.sh --via main         # ask `main` ("data mode: <question>"): main must delegate a kind:"data"
#                                              #   task; the analyst answers, the framework re-executes + checks, the
#                                              #   data-verifier judges; the SQL is read from the ledger (D08, D09)
#
# Options: --scratch DIR (default ~/.cache/lca/e2e, env LCA_E2E_SCRATCH)  --timeout S per question (300)
#          --token-budget N (10000)  --tool-budget N (6)  --min-pass N (6 of the tier-1 set)  --keep
# Exit: 0 all criteria met, 1 warnings only, 2 a criterion failed, 3 setup failed.
#
# Isolation: identical to scripts/lca-e2e.sh (XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME under the scratch dir,
# OPENCODE_CONFIG_DIR unset, plugin loaded from <work>/.opencode/plugins/lca.ts). The work dir is a copy of
# scripts/fixtures/data-vv (sqlite file, schema.json, .evoontology workspace) plus a project .lca/lca.jsonc that turns
# the data backend on. The evo-semantic MCP server is the vendored copy under framework/vendor/evoontology.
#
# Criteria (per question, then aggregated):
#   D01 result match: the final SQL (the `SQL:` block of the last assistant message, else the last db_query argument)
#       is re-executed on the fixture by code and compared with the expected rows (scalars: values; row sets: the
#       `compare` columns, ordered when the question says so). Aggregate: >= --min-pass of tier-1 questions.
#   D02 tokens per question <= --token-budget: uncached prompt tokens (sum of tokens.input over the session's assistant
#       calls; cache reads are excluded because a prefix hit is not re-prefilled) + output tokens. The largest context
#       of the session (last call's input + cache_read) is reported alongside.
#   D03 tool calls per question <= --tool-budget           D04 repeated identical calls == 0
#   D05 no write/edit/bash calls (analyst is read-only)    D06 exactly 2 evo-semantic tools visible (check mode)
#   D07 at least one resolve_semantics call per question (the ontology was used, not just the schema)
#   D10 the SQL in the answer was actually executed: a `SQL:` block with zero db_query calls means the RESULT was made
#       up (qwen3.6 did this on 3/10 questions; the delegate pipeline re-executes SQL, the direct call has no such guard)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${LCA_E2E_SCRATCH:-$HOME/.cache/lca/e2e}"
MODE=run; TIER=1; ONLY=""; VIA=analyst; EVO_WS=""; MODEL="${LCA_E2E_MODEL:-}"; QFILE=""; TIMEOUT=300; TOKEN_BUDGET=10000; TOOL_BUDGET=6; MIN_PASS=6; KEEP=0
USER_JSONC="$HOME/.config/opencode/opencode.jsonc"
FIXTURE="$ROOT/scripts/fixtures/data-vv"
BASELINE="$ROOT/scripts/lca-baseline.py"
HELPER="$ROOT/framework/src/data/sqlite_query.py"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --tier) TIER="$2"; shift ;;
    --only) ONLY="$2"; shift ;;
    --via) VIA="$2"; shift ;;
    --evo-workspace) EVO_WS="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --questions) QFILE="$2"; shift ;;
    --scratch) SCRATCH="$2"; shift ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --token-budget) TOKEN_BUDGET="$2"; shift ;;
    --tool-budget) TOOL_BUDGET="$2"; shift ;;
    --min-pass) MIN_PASS="$2"; shift ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 3 ;;
  esac
  shift
done

E2E="$SCRATCH/lca-e2e"
CFG_HOME="$E2E/config"; DATA_HOME="$E2E/data"; STATE_HOME="$E2E/state"; LOGS="$E2E/logs"
SCRATCH_CFG="$CFG_HOME/opencode/opencode.json"
ISO_DB="$DATA_HOME/opencode/opencode.db"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$E2E/work/data-vv-$STAMP"
N_WARN=0; N_FAIL=0
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
res()  { case "$1" in WARN) N_WARN=$((N_WARN+1));; FAIL) N_FAIL=$((N_FAIL+1));; esac; printf '[%s] %-4s %s\n' "$1" "$2" "$3"; }
oc() {
  env -u OPENCODE_CONFIG_DIR -u ORCA_OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT \
      XDG_CONFIG_HOME="$CFG_HOME" XDG_DATA_HOME="$DATA_HOME" XDG_STATE_HOME="$STATE_HOME" "$@"
}

# ------------------------------------------------------------------ setup
step "setup: isolated XDG dirs under $E2E, fixture -> $WORK"
mkdir -p "$CFG_HOME/opencode" "$DATA_HOME" "$STATE_HOME" "$LOGS" "$E2E/work" || exit 3
[ -f "$USER_JSONC" ] || { echo "user config $USER_JSONC not found (need provider.ollama)" >&2; exit 3; }
python3 - "$USER_JSONC" "$SCRATCH_CFG" "$MODEL" <<'PY' || exit 3
import json, re, sys
src, dst, model = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read()
t = re.sub(r"/\*[\s\S]*?\*/", "", t); t = re.sub(r'(^|[^:"\'\\])//.*$', r"\1", t, flags=re.M); t = re.sub(r",(\s*[}\]])", r"\1", t)
u = json.loads(t)
prov = (u.get("provider") or {}).get("ollama") or sys.exit("provider.ollama missing")
model = model or u.get("model")
if model and model.startswith("ollama/") and model[7:] not in (prov.get("models") or {}):
    # a model that is pulled but not in the user's provider list (stage-5 comparisons): register it in the ISOLATED
    # config only, with the default model's limits/options (thinking off is set per agent by the plugin anyway)
    base = (prov.get("models") or {}).get(str(u.get("model", ""))[7:], {})
    prov.setdefault("models", {})[model[7:]] = {"name": model[7:] + " (e2e)", "tool_call": True, "reasoning": bool(base.get("reasoning", True)), "limit": base.get("limit", {"context": 65536, "output": 8192}), "options": base.get("options", {})}
    print(f"registered {model} in the scratch config (not in {src})")
json.dump({"$schema": "https://opencode.ai/config.json", "model": model, "small_model": u.get("small_model", model), "provider": {"ollama": prov}}, open(dst, "w"), indent=2)
print(f"wrote {dst}: model={model}")
PY
[ -f "$FIXTURE/data/vehicle_visit.sqlite" ] || python3 "$FIXTURE/make_fixture.py" >/dev/null || exit 3
mkdir -p "$WORK/.opencode/plugins" "$WORK/.lca" && cp -R "$FIXTURE/data" "$WORK/" && cp "${QFILE:-$FIXTURE/queries.jsonl}" "$WORK/queries.jsonl" || exit 3
cp -R "${EVO_WS:-$FIXTURE/.evoontology}" "$WORK/.evoontology" || exit 3
[ -n "$EVO_WS" ] && say "evo workspace: $EVO_WS (active: $(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('active_version') or json.load(open(sys.argv[1])).get('version'))" "$WORK/.evoontology/active.json" 2>/dev/null))"
printf 'export { LcaPlugin } from "%s/framework/src/index.ts"\n' "$ROOT" > "$WORK/.opencode/plugins/lca.ts"
cat > "$WORK/.lca/lca.jsonc" <<'EOF'
{
  "data": { "backend": "sqlite", "sqlite_path": "data/vehicle_visit.sqlite", "schema_file": "data/schema.json",
            "evo": { "enabled": true, "workspace": ".evoontology" } }
}
EOF
( cd "$WORK" && git init -q && git add -A && git -c user.name=lca-e2e -c user.email=lca-e2e@localhost commit -q -m "fixture: data-vv" ) || exit 3
say "work dir: $WORK"

# ------------------------------------------------------------------ check (no model)
step "check: wiring (no model call)"
( cd "$WORK" && oc perl -e 'alarm 90; exec @ARGV or exit 127' opencode debug agent data-analyst > "$LOGS/data-agent-$STAMP.json" 2> "$LOGS/data-agent-$STAMP.err" </dev/null )
python3 - "$LOGS/data-agent-$STAMP.json" <<'PY' > "$LOGS/data-agent-$STAMP.summary" 2>&1
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("valid=0"); print(f"error={e}"); sys.exit(0)
t = d.get("tools") or {}
on = sorted(k for k, v in t.items() if v and k != "invalid")
evo = [k for k in on if k.startswith("evo-semantic_")]
print("valid=1"); print("mode=" + str(d.get("mode"))); print("steps=" + str(d.get("steps")))
print("tools=" + ",".join(on)); print("evo=" + ",".join(evo)); print("nevo=" + str(len(evo)))
print("bad=" + ",".join(k for k in ("bash", "edit", "write", "read", "glob", "grep", "task", "delegate", "todowrite") if t.get(k)))
print("data_ok=" + ("1" if t.get("db_query") and t.get("schema_lookup") else "0"))
PY
v() { grep "^$1=" "$LOGS/data-agent-$STAMP.summary" | head -1 | cut -d= -f2-; }
if [ "$(v valid)" != 1 ]; then res FAIL D06 "opencode debug agent data-analyst failed: $(v error) $(tail -1 "$LOGS/data-agent-$STAMP.err")"
else
  [ "$(v data_ok)" = 1 ] && [ -z "$(v bad)" ] && res PASS D06a "data-analyst tools: [$(v tools)] mode=$(v mode) steps=$(v steps)" || res FAIL D06a "data-analyst tools wrong: db/schema=$(v data_ok) unexpected=[$(v bad)] all=[$(v tools)]"
fi
# MCP tools are not part of `debug agent` output (they are attached per request); check the server connects and the
# analyst's permission keys expose exactly browse/resolve (the deny-all wildcard comes first, last match wins).
( cd "$WORK" && oc perl -e 'alarm 90; exec @ARGV or exit 127' opencode mcp list > "$LOGS/data-mcp-$STAMP.txt" 2>&1 </dev/null )
( cd "$WORK" && oc perl -e 'alarm 90; exec @ARGV or exit 127' opencode debug config > "$LOGS/data-config-$STAMP.json" 2>/dev/null </dev/null )
python3 - "$LOGS/data-config-$STAMP.json" <<'PY' > "$LOGS/data-perm-$STAMP.txt" 2>&1
import json, sys
d = json.load(open(sys.argv[1]))
p = ((d.get("agent") or {}).get("data-analyst") or {}).get("permission") or {}
keys = list(p.keys())
allow = [k for k in keys if k.startswith("evo-semantic_") and p[k] == "allow"]
print("allow=" + ",".join(allow))
print("wildcard_first=" + ("1" if "evo-semantic_*" in keys and all(keys.index("evo-semantic_*") < keys.index(a) for a in allow) else "0"))
print("mcp=" + ("1" if "evo-semantic" in (d.get("mcp") or {}) else "0"))
PY
pv() { grep "^$1=" "$LOGS/data-perm-$STAMP.txt" | head -1 | cut -d= -f2-; }
if grep -q "evo-semantic" "$LOGS/data-mcp-$STAMP.txt" && grep -qi "connected" "$LOGS/data-mcp-$STAMP.txt" && [ "$(pv mcp)" = 1 ]; then res PASS D06b "evo-semantic MCP registered by the config hook and connected (opencode mcp list)"
else res FAIL D06b "evo-semantic MCP not connected: $(grep -v '^\[lca\]' "$LOGS/data-mcp-$STAMP.txt" | tr '\n' ' ' | head -c 200)"; fi
[ "$(pv allow)" = "evo-semantic_browse_semantics,evo-semantic_resolve_semantics" ] && [ "$(pv wildcard_first)" = 1 ] && res PASS D06c "analyst permission exposes exactly browse+resolve after the evo-semantic_* deny" || res FAIL D06c "analyst evo permission wrong: allow=[$(pv allow)] wildcard_first=$(pv wildcard_first)"
if [ "$MODE" = check ]; then
  say ""; [ "$KEEP" = 1 ] || rm -rf "$WORK"; say "check: $N_WARN warn, $N_FAIL fail"; [ "$N_FAIL" -gt 0 ] && exit 2; [ "$N_WARN" -gt 0 ] && exit 1; exit 0
fi

# ------------------------------------------------------------------ run
step "run: $( [ "$VIA" = main ] && echo "main -> delegate(kind data) -> data-analyst -> checks -> data-verifier" || echo "data-analyst directly" ) on the fixture questions (tier <= $TIER)"
[ "$VIA" = main ] && TIMEOUT=$((TIMEOUT * 2)) && TOOL_BUDGET=$((TOOL_BUDGET + 4))
RESULTS="$LOGS/data-results-$STAMP.tsv"; : > "$RESULTS"
python3 - "$WORK/queries.jsonl" "$TIER" "$ONLY" <<'PY' > "$LOGS/data-questions-$STAMP.tsv"
import json, sys
tier, only = int(sys.argv[2]), sys.argv[3]
for line in open(sys.argv[1], encoding="utf-8"):
    q = json.loads(line)
    if only and q["id"] != only: continue
    if q.get("tier", 1) > tier: continue
    print(q["id"] + "\t" + q["question"])
PY
N_Q=0; N_OK=0; N_T1=0; N_T1_OK=0
while IFS=$'\t' read -r QID QUESTION; do
  [ -n "$QID" ] || continue
  N_Q=$((N_Q+1))
  OUT="$LOGS/data-$STAMP-$QID.jsonl"; ERR="$LOGS/data-$STAMP-$QID.err"
  t0="$(date +%s)"
  if [ "$VIA" = main ]; then AGENT=main; PROMPT="data mode: $QUESTION"; else AGENT=data-analyst; PROMPT="$QUESTION"; fi
  ( cd "$WORK" && oc perl -e "alarm $TIMEOUT; exec @ARGV or exit 127" opencode run --format json --agent "$AGENT" --auto "$PROMPT" </dev/null > "$OUT" 2> "$ERR" )
  rc=$?; wall=$(( $(date +%s) - t0 ))
  python3 - "$ISO_DB" "$WORK" "$t0" "$QID" "$OUT" "$WORK/queries.jsonl" "$WORK/data/vehicle_visit.sqlite" "$HELPER" "$TOKEN_BUDGET" "$TOOL_BUDGET" "$VIA" "$STATE_HOME" <<'PY' >> "$RESULTS"
import glob, json, re, sqlite3, subprocess, sys
db, work, t0, qid, out, qfile, sqlite_path, helper, tok_budget, tool_budget, via, state_home = sys.argv[1:13]
t0 = int(t0) * 1000; tok_budget = int(tok_budget); tool_budget = int(tool_budget)
q = next(json.loads(l) for l in open(qfile, encoding="utf-8") if json.loads(l)["id"] == qid)
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
row = con.execute("select id from session where parent_id is null and time_created >= ? and directory = ? order by time_created desc limit 1", (t0 - 5000, work)).fetchone()
res = {"id": qid, "tier": q.get("tier", 1), "session": row[0] if row else None, "match": 0, "tokens": 0, "ctx": 0, "tools": 0, "dup": 0, "writes": 0, "resolve": 0, "sql": "", "note": "", "ledger": "", "unresolved": "[]", "rows": "", "db_calls": 0}
if row:
    sid = row[0]
    msgs = [json.loads(d) for (d,) in con.execute("select data from message where session_id=? order by time_created", (sid,))]
    parts = [json.loads(d) for (d,) in con.execute("select data from part where session_id=? order by time_created", (sid,))]
    if via == "main":
        # main's own calls: exactly one delegate, no db tools (D09); the analyst/verifier children carry the rest
        mcalls = [p.get("tool") for p in parts if p.get("type") == "tool"]
        ledger = {}
        for f in glob.glob(f"{state_home}/lca/*/sessions/{sid}/ledger.json"):
            ledger = json.load(open(f))
        tasks = [t for t in ledger.get("tasks", [])]
        dtask = next((t for t in tasks if t.get("kind") == "data"), None)
        res["ledger"] = json.dumps({"delegate": mcalls.count("delegate"), "main_db": sum(1 for c in mcalls if c in ("db_query", "schema_lookup")), "tasks": len(tasks),
                                    "status": dtask.get("status") if dtask else None, "checks": (dtask.get("verify_result") or {}).get("ok") if dtask else None,
                                    "review": (dtask.get("review") or {}).get("verdict") if dtask else None, "attempts": dtask.get("attempts") if dtask else None,
                                    "answer": (dtask.get("answer") or "")[:80] if dtask else None}, ensure_ascii=False)
        for m in msgs:
            if m.get("role") == "assistant":
                t = m.get("tokens") or {}
                res["tokens"] += int(t.get("input") or 0) + int(t.get("output") or 0)
                res["ctx"] = max(res["ctx"], int(t.get("input") or 0) + int((t.get("cache") or {}).get("read") or 0))
        kids = [k for (k,) in con.execute("select id from session where parent_id=? order by time_created", (sid,))]
        msgs, parts = [], []
        for k in kids:
            msgs += [json.loads(d) for (d,) in con.execute("select data from message where session_id=? order by time_created", (k,))]
            parts += [json.loads(d) for (d,) in con.execute("select data from part where session_id=? order by time_created", (k,))]
    for m in msgs:
        if m.get("role") == "assistant":
            t = m.get("tokens") or {}
            res["tokens"] += int(t.get("input") or 0) + int(t.get("output") or 0)
            res["ctx"] = max(res["ctx"], int(t.get("input") or 0) + int((t.get("cache") or {}).get("read") or 0))
    calls = [(p.get("tool"), json.dumps((p.get("state") or {}).get("input"), sort_keys=True)) for p in parts if p.get("type") == "tool"]
    res["tools"] = len(calls)
    res["dup"] = sum(1 for i, c in enumerate(calls) if c in calls[:i])
    res["writes"] = sum(1 for c in calls if c[0] in ("write", "edit", "patch", "bash"))
    res["resolve"] = sum(1 for c in calls if c[0] and c[0].endswith("resolve_semantics"))
    res["db_calls"] = sum(1 for c in calls if c[0] == "db_query")
    # mentions the ontology could not resolve (evolution input): from the resolve_semantics tool outputs
    unresolved = []
    for p in parts:
        if p.get("type") == "tool" and (p.get("tool") or "").endswith("resolve_semantics"):
            try:
                body = json.loads(((p.get("state") or {}).get("output") or "").strip() or "{}")
                for r in body.get("resolutions") or body.get("results") or []:
                    if r.get("status") == "unresolved" and r.get("query"): unresolved.append(r["query"])
            except Exception:
                pass
    res["unresolved"] = json.dumps(sorted(set(unresolved)), ensure_ascii=False)
    texts = [p.get("text") or "" for p in parts if p.get("type") == "text"]
    final = texts[-1] if texts else ""
    # fenced or bare `SQL:` block (the old pattern required two backticks, so a bare block was only found through the
    # last db_query call — a model that skips db_query, as qwen3.6 did, looked like "no SQL")
    m = re.search(r"SQL:\s*(?:```(?:sql)?\s*)?([\s\S]*?)\s*(?:```|\nRESULT:|\nANSWER:|$)", final)
    sql = m.group(1).strip() if m else ""
    if via == "main":
        sql = (dtask or {}).get("sql") or ""   # the ledger's SQL is what the framework re-executed and checked
    if not sql:
        for c in reversed(calls):
            if c[0] == "db_query":
                sql = (json.loads(c[1]) or {}).get("sql", ""); break
    res["sql"] = sql.replace("\n", " ")[:2000]  # long enough for the judge / evolver to see whole queries (MAP-002 ≈ 600 chars)
    if sql:
        try:
            r = subprocess.run([sys.executable, helper], input=json.dumps({"path": sqlite_path, "sql": sql, "timeout_ms": 15000, "max_rows": 500}), capture_output=True, text=True, timeout=30)
            got = json.loads(r.stdout)
            if "error" in got:
                res["note"] = "sql error: " + got["error"][:120]
            else:
                res["rows"] = json.dumps({"columns": got["columns"], "rows": got["rows"][:5]}, ensure_ascii=False, default=str)[:600]
                exp = q.get("expected")
                norm = lambda v: round(v, 5) if isinstance(v, float) else v
                if exp is None:
                    res["match"] = -1; res["note"] = "no ground truth (rows captured)"
                elif q["kind"] == "scalar":
                    ok = len(got["rows"]) >= 1 and len(exp) >= 1 and norm(got["rows"][0][0]) == norm(exp[0][0])
                else:
                    cmp = q.get("compare") or []
                    # compare on the named columns by position in the expected SQL; in the model's SQL find them by name
                    gcols = [c.lower() for c in got["columns"]]
                    ecols = re.findall(r"select\s+(.*?)\s+from", q["sql"], re.I | re.S)[0].split(",")
                    ecols = [re.sub(r".*\bas\s+", "", c.strip(), flags=re.I).split(".")[-1].strip().lower() for c in ecols]
                    try:
                        gi = [gcols.index(c) for c in cmp]; ei = [ecols.index(c) for c in cmp]
                        g = [tuple(norm(r[i]) for i in gi) for r in got["rows"]]
                        e = [tuple(norm(r[i]) for i in ei) for r in exp]
                        ok = (g == e) if q.get("ordered") else (sorted(map(str, g)) == sorted(map(str, e)))
                    except ValueError:
                        # the model listed other columns of the same rows (e.g. names instead of ids): judge by row
                        # count only and say so (weaker than a column match, still a real check of the WHERE clause)
                        ok = len(got["rows"]) == len(exp) and len(exp) > 0
                        res["note"] = f"rows-only match ({len(got['rows'])} rows; columns {cmp} not in result {gcols})" if ok else f"columns {cmp} not in result {gcols}"
                if exp is not None:
                    res["match"] = 1 if ok else 0
                    if not ok and not res["note"]: res["note"] = f"got {str(got['rows'][:3])[:100]} expected {str(exp[:3])[:100]}"
        except Exception as e:
            res["note"] = f"re-exec failed: {e}"[:150]
    else:
        res["note"] = "no SQL found in the final message or db_query calls"
else:
    res["note"] = "no session recorded"
print("\t".join(str(res[k]) for k in ("id", "tier", "match", "tokens", "tools", "dup", "writes", "resolve", "session", "note", "sql", "ctx", "ledger", "unresolved", "rows", "db_calls")))
PY
  L="$(tail -1 "$RESULTS")"
  match="$(echo "$L" | cut -f3)"; toks="$(echo "$L" | cut -f4)"; tools="$(echo "$L" | cut -f5)"; dup="$(echo "$L" | cut -f6)"; writes="$(echo "$L" | cut -f7)"; resolve="$(echo "$L" | cut -f8)"; note="$(echo "$L" | cut -f10)"; tier="$(echo "$L" | cut -f2)"; ctx="$(echo "$L" | cut -f12)"
  [ "$tier" = 1 ] && N_T1=$((N_T1+1))
  if [ "$match" = 1 ]; then N_OK=$((N_OK+1)); [ "$tier" = 1 ] && N_T1_OK=$((N_T1_OK+1)); st=PASS; elif [ "$match" = -1 ]; then N_Q=$((N_Q-1)); [ "$tier" = 1 ] && N_T1=$((N_T1-1)); st=SKIP; else st=FAIL; fi
  ledger="$(echo "$L" | cut -f13)"
  say "$QID: match=$match tokens=$toks(max ctx $ctx) tools=$tools dup=$dup writes=$writes resolve=$resolve wall=${wall}s rc=$rc ${note:+($note)}${ledger:+ ledger=$ledger}"
  if [ "$VIA" = main ]; then
    lv() { printf '%s' "$ledger" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1'))" 2>/dev/null; }
    [ "$(lv status)" = done ] && [ "$(lv checks)" = True ] && res PASS "D08" "$QID ledger: data task done, checks pass, review=$(lv review), attempts=$(lv attempts)" || res FAIL "D08" "$QID ledger: status=$(lv status) checks=$(lv checks) review=$(lv review) attempts=$(lv attempts)"
    [ "$(lv delegate)" = 1 ] && [ "$(lv main_db)" = 0 ] && res PASS "D09" "$QID main: 1 delegate call, 0 db tool calls" || res FAIL "D09" "$QID main: delegate=$(lv delegate) db calls=$(lv main_db)"
  fi
  [ "$toks" -le "$TOKEN_BUDGET" ] 2>/dev/null || res FAIL "D02" "$QID uncached+output tokens $toks > $TOKEN_BUDGET (max context $ctx)"
  [ "$tools" -le "$TOOL_BUDGET" ] 2>/dev/null || res FAIL "D03" "$QID tool calls $tools > $TOOL_BUDGET"
  [ "$dup" = 0 ] || res FAIL "D04" "$QID repeated identical calls = $dup"
  [ "$writes" = 0 ] || res FAIL "D05" "$QID write/edit/bash calls = $writes"
  [ "$resolve" -ge 1 ] 2>/dev/null || res WARN "D07" "$QID never called resolve_semantics"
  dbc="$(echo "$L" | cut -f16)"; sqlcol="$(echo "$L" | cut -f11)"
  if [ "$VIA" != main ] && [ -n "$sqlcol" ] && [ "${dbc:-0}" = 0 ]; then res FAIL "D10" "$QID answered with SQL but never called db_query (result made up)"; fi
done < "$LOGS/data-questions-$STAMP.tsv"

step "verify"
say "results: $RESULTS"
if [ -n "$ONLY" ]; then
  [ "$N_OK" = "$N_Q" ] && res PASS D01 "$N_OK/$N_Q matched" || res FAIL D01 "$N_OK/$N_Q matched"
elif [ "$N_Q" -eq 0 ]; then
  res PASS D01 "no ground truth in the question file (SQL + rows captured for a judge)"
else
  [ "$N_T1_OK" -ge "$MIN_PASS" ] && res PASS D01 "tier-1 results matched $N_T1_OK/$N_T1 (>= $MIN_PASS); all tiers $N_OK/$N_Q" || res FAIL D01 "tier-1 results matched $N_T1_OK/$N_T1 (< $MIN_PASS); all tiers $N_OK/$N_Q"
fi
say ""
if [ "$N_FAIL" -eq 0 ]; then
  say "e2e-data: PASS (logs: $LOGS, run $STAMP)"; [ "$KEEP" = 1 ] && say "work dir kept: $WORK" || rm -rf "$WORK"; exit 0
else
  say "e2e-data: FAIL ($N_FAIL criteria) — work dir kept: $WORK ; logs: $LOGS"; exit 2
fi
