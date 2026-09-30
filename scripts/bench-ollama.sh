#!/usr/bin/env bash
# 전후 비교용 간이 벤치마크: 생성 tok/s, thinking 유무 비용, 프리픽스 캐시 히트/미스.
#   scripts/bench-ollama.sh [model]   (기본 gemma4:26b-a4b-it-mtp-q4_K_M)
#   TEMP=1 scripts/bench-ollama.sh   (샘플링 온도 지정, 기본 0. MTP 수락률은 온도에 민감)
set -euo pipefail
HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MODEL="${1:-gemma4:26b-a4b-it-mtp-q4_K_M}"
TEMP="${TEMP:-0}"
TMP="$(mktemp -d)"

run() { # name payload-file
  curl -s --max-time 900 "$HOST/api/chat" -d @"$2" -o "$TMP/$1.json"
  python3 - "$1" "$TMP/$1.json" <<'PY'
import json,sys
n,f=sys.argv[1],sys.argv[2]; r=json.load(open(f))
pe,pd,ec,ed=r.get('prompt_eval_count',0),r.get('prompt_eval_duration',0),r.get('eval_count',0),r.get('eval_duration',0)
th=len((r.get('message') or {}).get('thinking') or '')
print(f"{n:<28} load {r.get('load_duration',0)/1e9:6.2f}s | prompt {pe:6d} tok {pd/1e9:7.2f}s ({(pe/(pd/1e9)) if pd else 0:6.1f} tok/s) | gen {ec:5d} tok {ed/1e9:7.2f}s ({(ec/(ed/1e9)) if ed else 0:5.2f} tok/s) | thinking {th} chars")
PY
}

Q='Write a Python function that parses ISO8601 dates and returns a datetime; include 3 pytest tests.'
python3 - "$MODEL" "$Q" "$TMP" "$TEMP" <<'PY'
import json,sys
m,q,t,temp=sys.argv[1:]
base={"model":m,"stream":False,"options":{"temperature":float(temp)}}
json.dump({**base,"think":False,"messages":[{"role":"user","content":q}],"options":{**base["options"],"num_predict":400}},open(f"{t}/nothink.json","w"))
json.dump({**base,"think":True, "messages":[{"role":"user","content":q}],"options":{**base["options"],"num_predict":400}},open(f"{t}/think.json","w"))
sysp=("You are a careful coding agent. Follow the repository conventions strictly. "
      "Read before editing, keep diffs minimal, run tests after changes, and report results plainly. ")*180
for name,s in (("prefix_cold",sysp),("prefix_hit",sysp),("prefix_miss",sysp.replace("strictly.","strictlY.",1))):
    json.dump({**base,"think":False,"messages":[{"role":"system","content":s},{"role":"user","content":"Reply with exactly: OK"}],"options":{**base["options"],"num_predict":8}},open(f"{t}/{name}.json","w"))
PY

VER=$(curl -s "$HOST/api/version" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("version","?"))')
echo "model=$MODEL host=$HOST temperature=$TEMP ollama=$VER"; ollama ps | tail -n +2
run "gen think=false"  "$TMP/nothink.json"
run "gen think=true"   "$TMP/think.json"
run "8K prefix cold"   "$TMP/prefix_cold.json"
run "8K prefix cache hit" "$TMP/prefix_hit.json"
run "8K prefix 1-char miss" "$TMP/prefix_miss.json"
rm -rf "$TMP"
