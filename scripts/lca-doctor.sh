#!/bin/bash
# lca-doctor.sh — static (no GPU, no model load) health checks for the lca OpenCode plugin.
#
#   scripts/lca-doctor.sh            # human-readable, one line per check
#   scripts/lca-doctor.sh --json     # single JSON object
#
# Line format (docs/automation-design-2026-09-21.md §6):
#   [PASS/WARN/FAIL/SKIP] id name  observed (expected)  fix: <what to do>
# Exit codes: 0 all PASS/SKIP, 1 at least one WARN, 2 at least one FAIL.
#
# Checks
#   D01 opencode binary + version        D05 effective config (opencode debug config from repo root):
#   D02 bun present                          D05a agents main/worker/reviewer, D05b permission.task=deny, D05c plugin list / OMO
#   D03 framework/ installed             D06 prompt prefix budget per agent (main 1500 / worker 800 / reviewer 600 est. tokens)
#   D04 .opencode/plugins/lca.ts         D07 Ollama server env (scripts/ollama-env.sh show)
#                                        D08 configured model present in `ollama ls`
#   D09 stage-2 wiring: /stop command in effective config, effective tools of worker/reviewer/main (opencode debug
#       agent: task/delegate/todowrite hidden, steps set), delegate tool schema <= 400 est. tokens
#   D12a lca_flow tool schema <= 300 est. tokens and only visible on main; D12b M1 command set: effective config
#       contains stop,status,plan,approve,reject,cancel (WARN if missing); D12c PLAN_REVIEW_TEMPLATE <= 350 est. tokens
#   D10 chat.params option keys are AI-SDK camelCase keys also used by the user's model options (reasoningEffort)
#   D11 stage-3 data layer: vendored EvoOntology MCP server answers initialize/tools/list (python3, stdio), the sqlite
#       query helper runs a read-only query, and the fixture ontology validates; D11d = effective config when the
#       project enables a data backend (data-analyst agent + evo-semantic MCP present), SKIP when backend is none;
#       D11e = stage-4 evolution driver self-test (scripts/lca-evo-evolve.py --self-test)
#   D12e opencode pin: OPENCODE_PIN vs opencode --version, framework/package.json plugin+sdk, installed
#       framework/node_modules plugin+sdk, .opencode/package.json plugin, installed .opencode/node_modules plugin.
#       Any mismatch or missing source = WARN (D01 keeps its semantics: below MIN = WARN, no binary = FAIL).
#
# Env: LCA_DOCTOR_ONLY=<id,id>  run only these check ids (supported early exit for D01,D12e; other ids are
#      filtered from the output).   LCA_DOCTOR_ROOT=<dir>  repo root override (tests).
#
# Notes (verified 2026-09-22, opencode 1.18.32):
#   * `opencode debug config` output is TRUNCATED at 64 KiB when stdout is a pipe; always redirect to a file.
#   * OPENCODE_CONFIG_DIR (set by orca in some shells) adds another global config dir. The doctor unsets it so
#     the result matches a plain terminal; set LCA_DOCTOR_KEEP_ENV=1 to keep it.
#   * Token estimate ports framework/src/tokens.ts estimateTokens() (Gemma-calibrated char classes);
#     if that file is missing the fallback is chars/4.
# bash 3.2 compatible (no associative arrays, no mapfile). `set -e` is deliberately NOT used.
set -uo pipefail

ROOT="${LCA_DOCTOR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ONLY="${LCA_DOCTOR_ONLY:-}"
# want ID: true when no filter is set or ID is in the comma list.
want() { [ -z "$ONLY" ] || case ",$ONLY," in *",$1,"*) return 0;; *) return 1;; esac; }
JSON=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

OPENCODE_MIN="1.18.32"
OPENCODE_PIN="1.18.32"
BUDGET_MAIN=1500; BUDGET_WORKER=800; BUDGET_REVIEWER=600
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lca-doctor.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
RESULTS="$TMP/results.tsv"; : > "$RESULTS"
N_WARN=0; N_FAIL=0

with_timeout() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }
clean() { printf '%s' "$1" | tr '\n\t' '  ' | sed 's/  */ /g'; }

report() { # status id name observed expected [fix]
  want "$2" || return 0
  local st="$1" id="$2" name="$3" obs fix
  obs="$(clean "$4")"; local exp="$(clean "$5")"; fix="$(clean "${6:-}")"
  case "$st" in WARN) N_WARN=$((N_WARN+1));; FAIL) N_FAIL=$((N_FAIL+1));; esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$st" "$id" "$name" "$obs" "$exp" "$fix" >> "$RESULTS"
  if [ "$JSON" = 0 ]; then
    if [ -n "$fix" ]; then printf '[%s] %-4s %-22s %s (%s)  fix: %s\n' "$st" "$id" "$name" "$obs" "$exp" "$fix"
    else printf '[%s] %-4s %-22s %s (%s)\n' "$st" "$id" "$name" "$obs" "$exp"; fi
  fi
}

# Python helper: config parsing + token estimate (port of framework/src/tokens.ts).
cat > "$TMP/cfg.py" <<'PY'
import json, math, sys
CJK = [(0x1100,0x11ff),(0x3040,0x30ff),(0x3130,0x318f),(0x3400,0x4dbf),(0x4e00,0x9fff),(0xa960,0xa97f),
       (0xac00,0xd7af),(0xd7b0,0xd7ff),(0xf900,0xfaff),(0xff00,0xffef),(0x20000,0x2ffff)]
def est_gemma(t):
    w=p=c=o=n=0
    for ch in t:
        cp=ord(ch)
        if cp==0x0a: n+=1
        elif cp==0x0d: continue
        elif cp<0x80:
            if cp in (0x20,0x09) or 0x30<=cp<=0x39 or 0x41<=cp<=0x5a or 0x61<=cp<=0x7a: w+=1
            else: p+=1
        elif any(lo<=cp<=hi for lo,hi in CJK): c+=1
        else: o+=1
    return math.ceil(w/4+p/2+c/1.3+o/2+n)
def est(t, mode): return est_gemma(t) if mode=="gemma" else math.ceil(len(t)/4)
cmd=sys.argv[1]; path=sys.argv[2]
if cmd=="jsonc":  # model= from a JSONC file (comments + trailing commas stripped)
    import re
    t=open(path).read(); t=re.sub(r"/\*[\s\S]*?\*/","",t); t=re.sub(r"(^|[^:\"\\])//.*$",r"\1",t,flags=re.M); t=re.sub(r",(\s*[}\]])",r"\1",t)
    d=json.loads(t); print("model="+str(d.get("model",""))); print("small_model="+str(d.get("small_model",""))); sys.exit(0)
try:
    d=json.load(open(path))
except Exception as e:
    print("valid=0"); print("error="+str(e).replace("\n"," ")); sys.exit(0)
print("valid=1")
if cmd=="summary":
    ag=d.get("agent") or {}
    names=["main","worker","reviewer"]
    print("agents_present="+",".join(n for n in names if n in ag))
    print("agents_missing="+",".join(n for n in names if n not in ag))
    print("agents_all="+",".join(ag.keys()))
    perm=d.get("permission") or {}
    print("perm_task="+json.dumps(perm.get("task","<unset>")))
    plugins=[p if isinstance(p,str) else p[0] for p in (d.get("plugin") or [])]
    print("plugins="+" ".join(plugins))
    print("omo="+("1" if any("oh-my-openagent" in p for p in plugins) else "0"))
    print("lca_plugin="+("1" if any(p.rstrip("/").endswith("lca.ts") for p in plugins) else "0"))
    print("model="+str(d.get("model")))
    print("small_model="+str(d.get("small_model")))
    print("default_agent="+str(d.get("default_agent")))
    print("global_tools="+" ".join(f"{k}={v}" for k,v in tools.items()))
elif cmd=="prompt":
    name=sys.argv[3]; mode=sys.argv[4]
    a=(d.get("agent") or {}).get(name)
    if a is None: print("present=0"); sys.exit(0)
    pr=str(a.get("prompt") or "")
    print("present=1"); print("chars=%d"%len(pr)); print("tokens=%d"%est(pr,mode))
    t=a.get("tools") or {}
    print("tools_on=%d"%sum(1 for v in t.values() if v)); print("tools_off=%d"%sum(1 for v in t.values() if not v))
    print("mode="+str(a.get("mode"))); print("model="+str(a.get("model")))
PY
val() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }

# ---------------------------------------------------------------- D01 opencode
if command -v opencode >/dev/null 2>&1; then
  ver="$(with_timeout 20 opencode --version 2>/dev/null | head -1)"
  if [ -z "$ver" ]; then
    report FAIL D01 opencode-binary "opencode --version produced no output" "version >= $OPENCODE_MIN" "reinstall opencode"
  elif python3 -c "import sys; a=[int(x) for x in '$ver'.split('.')[:3]]; b=[int(x) for x in '$OPENCODE_MIN'.split('.')]; sys.exit(0 if a>=b else 1)" 2>/dev/null; then
    report PASS D01 opencode-binary "$(command -v opencode) $ver" ">= $OPENCODE_MIN"
  else
    report WARN D01 opencode-binary "$ver" ">= $OPENCODE_MIN" "upgrade opencode (plugin API pinned to @opencode-ai/plugin $OPENCODE_MIN)"
  fi
else
  report FAIL D01 opencode-binary "not in PATH" "opencode >= $OPENCODE_MIN" "curl -fsSL https://opencode.ai/install | bash"
fi

# ---------------------------------------------------------------- D12e opencode pin
pkg_version() { # file -> "version" field, empty when missing/unreadable
  [ -f "$1" ] && python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('version',''))" "$1" 2>/dev/null
}
dep_version() { # package.json dependency-name -> declared spec, empty when missing
  [ -f "$1" ] && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print({**d.get('devDependencies',{}),**d.get('dependencies',{})}.get(sys.argv[2],''))" "$1" "$2" 2>/dev/null
}
if want D12e; then
  pin_bad=""; pin_seen=""
  pin_src() { # label value
    pin_seen="$pin_seen $1=${2:-missing}"
    if [ -z "$2" ]; then pin_bad="$pin_bad $1:not-installed"
    elif [ "$2" != "$OPENCODE_PIN" ]; then pin_bad="$pin_bad $1:$2"; fi
  }
  bin_ver=""; command -v opencode >/dev/null 2>&1 && bin_ver="$(with_timeout 20 opencode --version 2>/dev/null | head -1)"
  pin_src opencode "$bin_ver"
  pin_src framework/package.json:plugin "$(dep_version "$ROOT/framework/package.json" @opencode-ai/plugin)"
  pin_src framework/package.json:sdk "$(dep_version "$ROOT/framework/package.json" @opencode-ai/sdk)"
  pin_src framework/node_modules:plugin "$(pkg_version "$ROOT/framework/node_modules/@opencode-ai/plugin/package.json")"
  pin_src framework/node_modules:sdk "$(pkg_version "$ROOT/framework/node_modules/@opencode-ai/sdk/package.json")"
  pin_src .opencode/package.json:plugin "$(dep_version "$ROOT/.opencode/package.json" @opencode-ai/plugin)"
  pin_src .opencode/node_modules:plugin "$(pkg_version "$ROOT/.opencode/node_modules/@opencode-ai/plugin/package.json")"
  if [ -z "$pin_bad" ]; then report PASS D12e opencode-pin "all sources $OPENCODE_PIN" "= $OPENCODE_PIN"
  else report WARN D12e opencode-pin "mismatch:$pin_bad" "all = $OPENCODE_PIN" "align versions (opencode upgrade $OPENCODE_PIN / cd framework && bun install)"; fi
fi

finish() { # emit results and exit
  if [ "$N_FAIL" -gt 0 ]; then EXIT=2; elif [ "$N_WARN" -gt 0 ]; then EXIT=1; else EXIT=0; fi
  if [ "$JSON" = 1 ]; then
    python3 - "$RESULTS" "$EXIT" "$N_WARN" "$N_FAIL" <<'PY'
import json, sys
rows=[]
for line in open(sys.argv[1]):
    f=line.rstrip("\n").split("\t")
    while len(f)<6: f.append("")
    rows.append(dict(zip(("status","id","name","observed","expected","fix"),f)))
print(json.dumps({"ok": int(sys.argv[2])==0, "exit": int(sys.argv[2]), "warn": int(sys.argv[3]), "fail": int(sys.argv[4]),
                  "pass": sum(1 for r in rows if r["status"]=="PASS"), "skip": sum(1 for r in rows if r["status"]=="SKIP"),
                  "checks": rows}, ensure_ascii=False, indent=1))
PY
  else
    echo
    echo "doctor: $(grep -c '^PASS' "$RESULTS") pass, $N_WARN warn, $N_FAIL fail, $(grep -c '^SKIP' "$RESULTS") skip -> exit $EXIT"
  fi
  exit "$EXIT"
}
# Fast path: a filter that only names cheap early checks skips the slow config/model probes below. An empty/unset
# ONLY means no filter (every check runs); only a NON-empty filter naming only D01/D12e short-circuits here.
if [ -n "$ONLY" ]; then
  rest="$(printf '%s' "$ONLY" | tr ',' '\n' | grep -v -x -e D01 -e D12e -e '')"
  [ -z "$rest" ] && finish
fi

# ---------------------------------------------------------------- D02 bun
if command -v bun >/dev/null 2>&1; then
  report PASS D02 bun "$(command -v bun) $(bun --version 2>/dev/null)" "present"
else
  report FAIL D02 bun "not in PATH" "bun present (OpenCode plugins run under bun)" "brew install oven-sh/bun/bun"
fi

# ---------------------------------------------------------------- D03 framework installed
if [ -d "$ROOT/framework/node_modules/@opencode-ai/plugin" ]; then
  pv="$(python3 -c "import json;print(json.load(open('$ROOT/framework/node_modules/@opencode-ai/plugin/package.json'))['version'])" 2>/dev/null)"
  report PASS D03 framework-installed "framework/node_modules/@opencode-ai/plugin ${pv:-?}" "present"
else
  report FAIL D03 framework-installed "framework/node_modules/@opencode-ai/plugin missing" "present" "cd framework && bun install"
fi

# ---------------------------------------------------------------- D04 project plugin loader
LOADER="$ROOT/.opencode/plugins/lca.ts"
if [ -f "$LOADER" ]; then
  if grep -q "framework/src/index.ts" "$LOADER"; then
    report PASS D04 plugin-loader ".opencode/plugins/lca.ts -> framework/src/index.ts" "present"
  else
    report WARN D04 plugin-loader ".opencode/plugins/lca.ts present but does not import framework/src/index.ts" "re-export from ../../framework/src/index.ts" "check .opencode/plugins/lca.ts"
  fi
else
  report FAIL D04 plugin-loader ".opencode/plugins/lca.ts missing" "present" "echo 'export { LcaPlugin } from \"../../framework/src/index.ts\"' > .opencode/plugins/lca.ts"
fi

# ---------------------------------------------------------------- D05 effective config
CFG="$TMP/config.json"; CFGERR="$TMP/config.err"; CFG_OK=0
if command -v opencode >/dev/null 2>&1; then
  if [ "${LCA_DOCTOR_KEEP_ENV:-0}" = 1 ]; then ENVCMD="env"; else ENVCMD="env -u OPENCODE_CONFIG_DIR -u ORCA_OPENCODE_CONFIG_DIR"; fi
  ( cd "$ROOT" && with_timeout 90 $ENVCMD opencode debug config > "$CFG" 2> "$CFGERR" </dev/null )
  rc=$?
  python3 "$TMP/cfg.py" summary "$CFG" > "$TMP/summary.txt" 2>&1
  if [ "$rc" -ne 0 ] || [ "$(val "$TMP/summary.txt" valid)" != 1 ]; then
    err="$(grep -iE 'error|fail|cannot|unexpected' "$CFGERR" | head -2 | tr '\n' ' ')"
    [ -z "$err" ] && err="$(tail -2 "$CFGERR" | tr '\n' ' ')"
    [ -z "$err" ] && err="$(val "$TMP/summary.txt" error)"
    report FAIL D05 effective-config "opencode debug config rc=$rc: ${err:-no output}" "valid JSON" "LCA_DEBUG=1 opencode debug config --print-logs  (plugin import error?)"
  else
    CFG_OK=1
    present="$(val "$TMP/summary.txt" agents_present)"; missing="$(val "$TMP/summary.txt" agents_missing)"
    if [ -z "$missing" ]; then
      report PASS D05a agents "main,worker,reviewer present; default_agent=$(val "$TMP/summary.txt" default_agent)" "lca agents injected by config hook"
    else
      report FAIL D05a agents "present: ${present:-none}; missing: $missing; all: $(val "$TMP/summary.txt" agents_all)" "main,worker,reviewer" "check framework/src/hooks/config.ts and lca_plugin=$(val "$TMP/summary.txt" lca_plugin) in plugin list"
    fi
    tt="$(val "$TMP/summary.txt" perm_task)"
    if [ "$tt" = '"deny"' ]; then
      report PASS D05b task-denied "permission.task=deny" "deny (built-in task tool ~2.5K prefix tokens; config.tools is ignored post-decode)"
    else
      report FAIL D05b task-denied "permission.task=$tt" "deny" "config hook must set config.permission.task=deny (agent/global tools keys are ignored by the running config)"
    fi
    plugins="$(val "$TMP/summary.txt" plugins)"
    if [ "$(val "$TMP/summary.txt" omo)" = 1 ]; then
      report WARN D05c plugins "oh-my-openagent loaded with lca: [$plugins]" "lca only; OMO and lca both overwrite config.agent (last wins)" "remove oh-my-openagent from ~/.config/opencode/opencode.jsonc plugin[] before using lca"
    elif [ "$(val "$TMP/summary.txt" lca_plugin)" = 1 ]; then
      report PASS D05c plugins "[$plugins]" "lca loader present, no oh-my-openagent"
    else
      report WARN D05c plugins "[${plugins:-none}]" "lca loader in plugin list" "run from the repo root; .opencode/plugins/lca.ts is project-scoped"
    fi
  fi
else
  report SKIP D05 effective-config "opencode missing" "" ""
fi

# ---------------------------------------------------------------- D06 prompt budget
if [ "$CFG_OK" = 1 ]; then
  if [ -f "$ROOT/framework/src/tokens.ts" ]; then MODE=gemma; NOTE="tokens.ts heuristic"; else MODE=chars4; NOTE="chars/4 (tokens.ts absent)"; fi
  for pair in main:$BUDGET_MAIN:D06a worker:$BUDGET_WORKER:D06b reviewer:$BUDGET_REVIEWER:D06c; do
    name="${pair%%:*}"; rest="${pair#*:}"; budget="${rest%%:*}"; id="${rest#*:}"
    python3 "$TMP/cfg.py" prompt "$CFG" "$name" "$MODE" > "$TMP/p.txt" 2>&1
    if [ "$(val "$TMP/p.txt" present)" != 1 ]; then
      report SKIP "$id" "prompt-budget-$name" "agent $name not in effective config" "<= $budget est. tokens" ""
      continue
    fi
    tok="$(val "$TMP/p.txt" tokens)"; ch="$(val "$TMP/p.txt" chars)"
    ton="$(val "$TMP/p.txt" tools_on)"; toff="$(val "$TMP/p.txt" tools_off)"
    obs="~$tok tok ($ch chars, $NOTE), tools: $ton on/$toff off, mode=$(val "$TMP/p.txt" mode)"
    if [ "$tok" -le "$budget" ]; then report PASS "$id" "prompt-budget-$name" "$obs" "<= $budget"
    else report FAIL "$id" "prompt-budget-$name" "$obs" "<= $budget" "shorten framework/src/agents/prompts.ts ${name} prompt"; fi
  done
else
  report SKIP D06 prompt-budget "effective config unavailable" "" ""
fi

# ---------------------------------------------------------------- D07 Ollama server env
ENVSH="$ROOT/scripts/ollama-env.sh"
if [ -x "$ENVSH" ] || [ -f "$ENVSH" ]; then
  with_timeout 30 bash "$ENVSH" show > "$TMP/env.txt" 2>&1 </dev/null
  lc_ctx="$(grep -E '^\s*OLLAMA_CONTEXT_LENGTH\s' "$TMP/env.txt" | awk '{print $2}' | head -1)"
  lc_np="$(grep -E '^\s*OLLAMA_NUM_PARALLEL\s' "$TMP/env.txt" | awk '{print $2}' | head -1)"
  lc_ka="$(grep -E '^\s*OLLAMA_KEEP_ALIVE\s' "$TMP/env.txt" | awk '{print $2}' | head -1)"
  sv_ctx="$(grep -oE 'OLLAMA_CONTEXT_LENGTH:[^ ]*' "$TMP/env.txt" | head -1 | cut -d: -f2)"
  sv_np="$(grep -oE 'OLLAMA_NUM_PARALLEL:[^ ]*' "$TMP/env.txt" | head -1 | cut -d: -f2)"
  sv_ka="$(grep -oE 'OLLAMA_KEEP_ALIVE:[^ ]*' "$TMP/env.txt" | head -1 | cut -d: -f2)"
  obs="launchctl ctx=${lc_ctx:-unset} keep_alive=${lc_ka:-unset} np=${lc_np:-unset}; server.log ctx=${sv_ctx:-?} np=${sv_np:-?} keep_alive=${sv_ka:-?}"
  if [ -z "$lc_ctx" ] || [ "$lc_ctx" = "<unset>" ]; then
    report WARN D07 ollama-env "$obs" "launchctl OLLAMA_CONTEXT_LENGTH=65536 NUM_PARALLEL=1 KEEP_ALIVE=-1" "scripts/ollama-env.sh apply"
  elif [ -z "$sv_ctx" ] || [ "$sv_ctx" = "<not" ]; then
    report WARN D07 ollama-env "$obs" "server.log 'server config' line present and matching" "start Ollama.app (or scripts/ollama-env.sh restart)"
  elif [ "$sv_ctx" != "$lc_ctx" ] || [ "$sv_np" != "$lc_np" ]; then
    report WARN D07 ollama-env "$obs" "server values == launchctl values" "scripts/ollama-env.sh restart"
  else
    report PASS D07 ollama-env "$obs" "ctx/np consistent"
  fi
else
  report SKIP D07 ollama-env "scripts/ollama-env.sh not found" "" ""
fi

# ---------------------------------------------------------------- D08 model presence
if command -v ollama >/dev/null 2>&1; then
  if [ "$CFG_OK" = 1 ]; then
    main_model="$(val "$TMP/summary.txt" model)"; small_model="$(val "$TMP/summary.txt" small_model)"
  else
    python3 "$TMP/cfg.py" jsonc "$HOME/.config/opencode/opencode.jsonc" > "$TMP/jsonc.txt" 2>/dev/null
    main_model="$(val "$TMP/jsonc.txt" model)"; small_model="$(val "$TMP/jsonc.txt" small_model)"
  fi
  with_timeout 20 ollama ls > "$TMP/models.txt" 2>&1 </dev/null; rc=$?
  if [ "$rc" -ne 0 ]; then
    report WARN D08 model-present "ollama ls failed: $(tail -1 "$TMP/models.txt")" "server reachable" "open -a Ollama"
  else
    mm="${main_model#ollama/}"; sm="${small_model#ollama/}"
    have_main=0; have_small=0
    awk 'NR>1{print $1}' "$TMP/models.txt" | grep -qx "$mm" && have_main=1
    [ -n "$sm" ] && [ "$sm" != "None" ] && awk 'NR>1{print $1}' "$TMP/models.txt" | grep -qx "$sm" && have_small=1
    n="$(awk 'NR>1' "$TMP/models.txt" | wc -l | tr -d ' ')"
    if [ "$have_main" = 1 ] && { [ -z "$sm" ] || [ "$sm" = "None" ] || [ "$have_small" = 1 ]; }; then
      report PASS D08 model-present "main=$mm small=${sm:-n/a} ($n models installed)" "configured models in ollama ls"
    elif [ "$have_main" = 1 ]; then
      report WARN D08 model-present "main=$mm ok; small_model $sm missing" "both present" "scripts/opencode-local.sh creates $sm, or ollama pull"
    else
      report FAIL D08 model-present "main model ${mm:-<unset>} not in ollama ls ($n models)" "configured model installed" "ollama pull $mm"
    fi
  fi
else
  report FAIL D08 model-present "ollama CLI not in PATH" "ollama installed" "install Ollama.app"
fi

# ---------------------------------------------------------------- D09 stage-2 wiring (ledger / delegate / stop)
DELEGATE_BUDGET=400
if [ "$CFG_OK" = 1 ]; then
  python3 - "$CFG" <<'PY' > "$TMP/s2.txt" 2>&1
import json, sys
d = json.load(open(sys.argv[1]))
cmd = (d.get("command") or {}).get("stop") or {}
print("stop=" + ("1" if cmd.get("template") else "0"))
print("stop_template=" + str(cmd.get("template", ""))[:60])
names = sorted((d.get("command") or {}).keys())
print("commands=" + ",".join(names))
PY
  # effective tool visibility per agent (permission-based; agent `tools` keys are ignored post-decode)
  for a in worker reviewer main; do ( cd "$ROOT" && with_timeout 60 $ENVCMD opencode debug agent "$a" > "$TMP/agent-$a.json" 2>/dev/null </dev/null ); done
  python3 - "$TMP" <<'PY' > "$TMP/s2b.txt" 2>&1
import json, os, sys
tmp = sys.argv[1]
def load(a):
    try: return json.load(open(os.path.join(tmp, f"agent-{a}.json")))
    except Exception: return None
bad = []
warn = []
expected = {
    "worker": {"bash", "edit", "glob", "grep", "read", "write"},
    "reviewer": {"glob", "grep", "read"},
    "main": {"bash", "delegate", "edit", "glob", "grep", "read", "skill", "todowrite", "todoread", "write"},
}
for a, hidden, steps in (("worker", ("task", "delegate", "todowrite", "webfetch", "skill"), 40), ("reviewer", ("task", "delegate", "todowrite", "bash", "write", "edit"), 15), ("main", ("task", "webfetch"), None)):
    d = load(a)
    if not d: bad.append(f"{a}: debug agent failed"); continue
    tools = d.get("tools") or {}
    for t in hidden:
        if tools.get(t) is not False: bad.append(f"{a}: {t} visible")
    if steps is not None and d.get("steps") != steps: bad.append(f"{a}: steps={d.get('steps')} (expected {steps})")
    if a == "main" and tools.get("delegate") is not True: bad.append("main: delegate hidden")
    visible = {k for k, v in tools.items() if v and k != "invalid"}
    foreign = sorted(visible - expected[a])
    # a reviewer that can run anything (interactive_bash, call_omo_agent, ...) breaks the read-only contract
    if a == "reviewer" and any(("bash" in t) or ("agent" in t) or ("session" in t) for t in foreign): bad.append(f"reviewer: foreign tools break the read-only contract: {','.join(foreign)}")
    elif foreign: warn.append(f"{a}: +{','.join(foreign)} (another plugin, e.g. OMO, adds tools to the prefix)")
    print(f"{a}_tools=" + ",".join(sorted(visible)))
print("bad=" + "; ".join(bad))
print("warn=" + "; ".join(warn))
PY
  if [ "$(val "$TMP/s2.txt" stop)" = 1 ]; then report PASS D09a stop-command "command.stop present: '$(val "$TMP/s2.txt" stop_template)'" "registered by config hook"
  else report FAIL D09a stop-command "command.stop missing in effective config" "registered by config hook" "check disabled_hooks in .lca/lca.jsonc (command.stop)"; fi
  # D12b: the milestone's command set must be a subset of the effective config's registered commands.
  # M1: flow is on by default, so the full set is stop,status,plan,approve,reject,cancel.
  present_cmds=",$(val "$TMP/s2.txt" commands),"
  missing_cmds=""
  for c in stop status plan approve reject cancel; do case "$present_cmds" in *",$c,"*) ;; *) missing_cmds="$missing_cmds $c";; esac; done
  if [ -z "$missing_cmds" ]; then report PASS D12b commands "effective command set: [$(val "$TMP/s2.txt" commands)]" "contains stop,status,plan,approve,reject,cancel"
  else report WARN D12b commands "missing:$missing_cmds (present: [$(val "$TMP/s2.txt" commands)])" "contains stop,status,plan,approve,reject,cancel" "check disabled_hooks (command.stop/command.status) and config.flow.enabled"; fi
  if [ -n "$(val "$TMP/s2b.txt" bad)" ]; then report FAIL D09b agent-tools "$(val "$TMP/s2b.txt" bad)" "task/delegate/todowrite hidden via permission; reviewer read-only" "framework/src/agents/prompts.ts denied_tools / hooks/config.ts; remove other plugins (OMO) when using lca"
  elif [ -n "$(val "$TMP/s2b.txt" warn)" ]; then report WARN D09b agent-tools "$(val "$TMP/s2b.txt" warn)" "only lca + built-in tools visible" "remove oh-my-openagent from the plugin list before using lca (extra tool schemas cost prefix)"
  else report PASS D09b agent-tools "worker=[$(val "$TMP/s2b.txt" worker_tools)] reviewer=[$(val "$TMP/s2b.txt" reviewer_tools)] main has delegate, steps 40/15" "task/delegate/todowrite hidden via permission"; fi
else
  report SKIP D09a stop-command "effective config unavailable" "" ""
  report SKIP D09b delegate-scope "effective config unavailable" "" ""
fi
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT/framework/src/tools/delegate.ts" ]; then
  ( cd "$ROOT/framework" && with_timeout 60 bun -e '
import { z } from "zod";
import { DELEGATE_DESCRIPTION, delegateArgs } from "./src/tools/delegate.ts";
import { estimateToolSchemaTokens } from "./src/tokens.ts";
const json = z.toJSONSchema(z.object(delegateArgs));
console.log("tokens=" + estimateToolSchemaTokens(DELEGATE_DESCRIPTION, json));
console.log("desc_chars=" + DELEGATE_DESCRIPTION.length);
' > "$TMP/dt.txt" 2>&1 </dev/null )
  dtok="$(val "$TMP/dt.txt" tokens)"
  if [ -n "$dtok" ] && [ "$dtok" -le "$DELEGATE_BUDGET" ] 2>/dev/null; then report PASS D09c delegate-schema "~$dtok est. tokens (description $(val "$TMP/dt.txt" desc_chars) chars)" "<= $DELEGATE_BUDGET"
  elif [ -n "$dtok" ]; then report FAIL D09c delegate-schema "~$dtok est. tokens" "<= $DELEGATE_BUDGET" "shorten DELEGATE_DESCRIPTION / arg descriptions in framework/src/tools/delegate.ts"
  else report WARN D09c delegate-schema "bun eval failed: $(tail -1 "$TMP/dt.txt")" "schema measurable" "cd framework && bun install"; fi
else
  report SKIP D09c delegate-schema "bun or framework/src/tools/delegate.ts missing" "" ""
fi

# ---------------------------------------------------------------- D12a lca_flow schema budget + main-only visibility
FLOW_BUDGET=300
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT/framework/src/tools/lca-flow.ts" ]; then
  ( cd "$ROOT/framework" && with_timeout 60 bun -e '
import { z } from "zod";
import { LCA_FLOW_DESCRIPTION, lcaFlowArgs } from "./src/tools/lca-flow.ts";
import { estimateToolSchemaTokens } from "./src/tokens.ts";
const json = z.toJSONSchema(z.object(lcaFlowArgs));
console.log("tokens=" + estimateToolSchemaTokens(LCA_FLOW_DESCRIPTION, json));
' > "$TMP/lf.txt" 2>&1 </dev/null )
  lftok="$(val "$TMP/lf.txt" tokens)"
  lf_ok=1
  if [ "$CFG_OK" = 1 ]; then
    # lca_flow must only be visible on main (worker/reviewer/data agents deny it; build/plan deny it too)
    for a in worker reviewer; do
      d="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(1 if (d.get('tools') or {}).get('lca_flow') else 0)" "$TMP/agent-$a.json" 2>/dev/null || echo 0)"
      [ "$d" = 1 ] && lf_ok=0
    done
  fi
  if [ -n "$lftok" ] && [ "$lftok" -le "$FLOW_BUDGET" ] 2>/dev/null && [ "$lf_ok" = 1 ]; then
    report PASS D12a flow-tool-schema "~$lftok est. tokens, only on main" "<= $FLOW_BUDGET, main-only"
  elif [ -n "$lftok" ]; then
    report FAIL D12a flow-tool-schema "~$lftok est. tokens, main-only=$lf_ok" "<= $FLOW_BUDGET, main-only" "shorten LCA_FLOW_DESCRIPTION / lcaFlowArgs in framework/src/tools/lca-flow.ts, or check denied_tools for worker/reviewer"
  else
    report WARN D12a flow-tool-schema "bun eval failed: $(tail -1 "$TMP/lf.txt")" "schema measurable" "cd framework && bun install"
  fi
else
  report SKIP D12a flow-tool-schema "bun or framework/src/tools/lca-flow.ts missing" "" ""
fi

# ---------------------------------------------------------------- D12c PLAN_REVIEW_TEMPLATE budget
REVIEW_TEMPLATE_BUDGET=350
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT/framework/src/flow/review.ts" ]; then
  ( cd "$ROOT/framework" && with_timeout 60 bun -e '
import { PLAN_REVIEW_TEMPLATE } from "./src/flow/review.ts";
import { estimateTokens } from "./src/tokens.ts";
console.log("tokens=" + estimateTokens(PLAN_REVIEW_TEMPLATE));
' > "$TMP/prt.txt" 2>&1 </dev/null )
  prtok="$(val "$TMP/prt.txt" tokens)"
  if [ -n "$prtok" ] && [ "$prtok" -le "$REVIEW_TEMPLATE_BUDGET" ] 2>/dev/null; then
    report PASS D12c review-template "~$prtok est. tokens" "<= $REVIEW_TEMPLATE_BUDGET"
  elif [ -n "$prtok" ]; then
    report FAIL D12c review-template "~$prtok est. tokens" "<= $REVIEW_TEMPLATE_BUDGET" "shorten PLAN_REVIEW_TEMPLATE in framework/src/flow/review.ts"
  else
    report WARN D12c review-template "bun eval failed: $(tail -1 "$TMP/prt.txt")" "template measurable" "cd framework && bun install"
  fi
else
  report SKIP D12c review-template "bun or framework/src/flow/review.ts missing" "" ""
fi

# ---------------------------------------------------------------- D10 chat.params option keys
# output.options -> AI-SDK providerOptions: keys must be camelCase SDK names (reasoningEffort). The user's model
# `options` in opencode.jsonc use the same names, so any key we set must also appear there or in the known list.
if [ -f "$ROOT/framework/src/hooks/chat-params.ts" ]; then
  # multi-line safe: take everything from `output.options = {` to the next `}` even across lines
  keys="$(tr '\n' ' ' < "$ROOT/framework/src/hooks/chat-params.ts" | grep -oE 'output\.options = \{[^}]*\}' | grep -oE '[A-Za-z_]+: "' | sed 's/: "//' | sort -u | tr '\n' ' ')"
  known="reasoningEffort reasoningSummary textVerbosity parallelToolCalls"
  userkeys="$(grep -oE '"[A-Za-z_]+": *"(none|low|medium|high)"' "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null | grep -oE '^"[A-Za-z_]+"' | tr -d '"' | sort -u | tr '\n' ' ')"
  badk=""
  for k in $keys; do case " $known $userkeys " in *" $k "*) ;; *) badk="$badk $k";; esac; done
  if [ -z "$keys" ]; then report FAIL D10 chat-params-keys "no output.options assignment found in chat-params.ts" "reasoningEffort set for children" "restore the reasoningEffort:none assignment for worker/reviewer"
  elif [ -z "$badk" ]; then report PASS D10 chat-params-keys "keys [$keys] are AI-SDK camelCase (user config uses: ${userkeys:-n/a})" "camelCase SDK keys"
  else report FAIL D10 chat-params-keys "unknown/snake_case option keys:$badk" "camelCase SDK keys (reasoningEffort)" "rename in framework/src/hooks/chat-params.ts; snake_case keys are silently ignored"; fi
else
  report SKIP D10 chat-params-keys "chat-params.ts missing" "" ""
fi

# ---------------------------------------------------------------- D11 stage-3 data layer (no model)
EVO_SERVER="$ROOT/framework/vendor/evoontology/evoontology/runtime/mcp_server.py"
if [ -f "$EVO_SERVER" ] && command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | with_timeout 30 python3 "$EVO_SERVER" --store "$TMP/evo-empty" > "$TMP/evo.out" 2> "$TMP/evo.err" </dev/stdin
  ntools="$(python3 -c "
import json,sys
n=0
for line in open('$TMP/evo.out'):
    j=json.loads(line)
    if j.get('id')==2: n=len(j['result']['tools'])
print(n)" 2>/dev/null)"
  if [ "${ntools:-0}" -ge 2 ] 2>/dev/null; then report PASS D11a evo-mcp "vendored evo-semantic server: $ntools tools (browse/resolve exposed to data-analyst only)" "initialize + tools/list over stdio"
  else report FAIL D11a evo-mcp "server did not answer: $(tail -1 "$TMP/evo.err")" "initialize + tools/list over stdio" "python3 >= 3.10 required; re-copy framework/vendor/evoontology"; fi
else
  report SKIP D11a evo-mcp "vendored server or python3 missing" "" ""
fi
HELPER_PY="$ROOT/framework/src/data/sqlite_query.py"
if [ -f "$HELPER_PY" ]; then
  out="$(printf '{"path":":memory:","sql":"SELECT 1 AS one, dist_m(126.7,35.7,126.8,35.8) AS d","timeout_ms":2000,"max_rows":5}' | with_timeout 20 python3 "$HELPER_PY" 2>&1)"
  if printf '%s' "$out" | grep -q '"columns": \["one", "d"\]'; then report PASS D11b sqlite-helper "read-only helper + dist_m() work ($(printf '%s' "$out" | head -c 60)...)" "JSON rows"
  else report FAIL D11b sqlite-helper "$(printf '%s' "$out" | head -c 160)" "JSON rows" "python3 sqlite3 module missing?"; fi
else
  report SKIP D11b sqlite-helper "helper missing" "" ""
fi
FIX="$ROOT/scripts/fixtures/data-vv"
if [ -f "$FIX/make_fixture.py" ]; then
  if [ -f "$FIX/.evoontology/active.json" ] || ( cd "$FIX" && with_timeout 60 python3 make_fixture.py >/dev/null 2>&1 ); then
    v="$(cd "$ROOT/framework/vendor/evoontology" && with_timeout 30 python3 -c "from evoontology.validate import validate; import json; r=validate('$FIX/.evoontology'); print('ok' if r['passed'] else 'fail: '+'; '.join(r.get('errors',[])[:3]))" 2>&1)"
    [ "$v" = ok ] && report PASS D11c fixture-ontology "scripts/fixtures/data-vv ontology_v0 validates (validate_semantics)" "passed" || report FAIL D11c fixture-ontology "$v" "passed" "python3 scripts/fixtures/data-vv/make_fixture.py"
  else report FAIL D11c fixture-ontology "make_fixture.py failed" "fixture built" "python3 scripts/fixtures/data-vv/make_fixture.py"; fi
else
  report SKIP D11c fixture-ontology "fixture missing" "" ""
fi
if [ "$CFG_OK" = 1 ]; then
  python3 - "$CFG" <<'PY' > "$TMP/d11.txt" 2>&1
import json, sys
d = json.load(open(sys.argv[1]))
ag = d.get("agent") or {}
print("analyst=" + ("1" if "data-analyst" in ag else "0"))
print("mcp=" + ("1" if "evo-semantic" in (d.get("mcp") or {}) else "0"))
PY
  if [ "$(val "$TMP/d11.txt" analyst)" = 1 ]; then
    [ "$(val "$TMP/d11.txt" mcp)" = 1 ] && report PASS D11d data-config "data-analyst agent + evo-semantic MCP in the effective config" "both present when data.backend != none" || report WARN D11d data-config "data-analyst present but evo-semantic MCP missing (workspace without active.json?)" "both present" "create the EvoOntology workspace or set data.evo.enabled=false"
  else report SKIP D11d data-config "data.backend is none in this project (no data agents)" "" ""; fi
fi

EVOLVE="$ROOT/scripts/lca-evo-evolve.py"
if [ -f "$EVOLVE" ] && command -v python3 >/dev/null 2>&1; then
  out="$(with_timeout 60 python3 "$EVOLVE" --self-test 2>&1)"
  [ "$out" = "self-test ok" ] && bash -n "$ROOT/scripts/lca-evo-nightly.sh" 2>/dev/null && report PASS D11e evo-evolve "ontology evolution driver + nightly wrapper: self-test ok (patch validation, judge decoding)" "self-test ok" || report FAIL D11e evo-evolve "$(printf '%s' "$out" | tail -1 | head -c 160)" "self-test ok" "python3 scripts/lca-evo-evolve.py --self-test"
else
  report SKIP D11e evo-evolve "driver or python3 missing" "" ""
fi

# ---------------------------------------------------------------- result
finish
