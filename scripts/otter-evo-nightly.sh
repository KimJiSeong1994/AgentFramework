#!/usr/bin/env bash
# Nightly ontology evolution (stage 4): run scripts/otter-evo-evolve.py only when EvoOntology's trigger says an
# evolution is due (default thresholds: 30 new trajectories since the last checkpoint OR 7 days), unattended, with
# a lock and a dated log. Never activates a version: an accepted candidate ends up as a proposal (see the driver).
#
#   scripts/otter-evo-nightly.sh                       # fixture workspace, due-check, ground truth
#   scripts/otter-evo-nightly.sh --force               # skip the due-check
#   scripts/otter-evo-nightly.sh --workspace W --questions Q.jsonl --protocol llm_judge
#   OTTER_EVO_LOG_DIR=~/.cache/otter/evo                 # log dir (default)
#
# launchd: copy scripts/launchd/com.otter.evo-nightly.plist to ~/Library/LaunchAgents/, edit the paths, then
#   launchctl load ~/Library/LaunchAgents/com.otter.evo-nightly.plist      (03:30 daily; the Ollama server must be up)
# The run needs the GPU for ~5-10 minutes (two e2e passes per round); schedule it when no interactive session runs.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${OTTER_EVO_LOG_DIR:-$HOME/.cache/otter/evo}"
WORKSPACE="$ROOT/scripts/fixtures/data-vv/.evoontology"
FORCE=0; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --workspace) WORKSPACE="$2"; ARGS+=("--workspace" "$2"); shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
mkdir -p "$LOG_DIR" || exit 3
LOG="$LOG_DIR/evo-$(date +%Y%m%d-%H%M%S).log"
LOCK="$LOG_DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another evolution run holds $LOCK; exiting" | tee -a "$LOG"; exit 4
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

{
  echo "== otter evo nightly $(date -Iseconds) workspace=$WORKSPACE force=$FORCE"
  if [ "$FORCE" = 0 ]; then
    due="$(cd "$ROOT/framework/vendor/evoontology" && python3 -c "
import json, sys
from evoontology import EvolutionTrigger
t = EvolutionTrigger('$WORKSPACE'); t.initialize(); r = t.check()
print(json.dumps(r, ensure_ascii=False))
print('DUE' if r['evolution_due'] else 'NOT_DUE', file=sys.stderr)" 2>&1)"
    echo "$due"
    case "$due" in *DUE*) case "$due" in *NOT_DUE*) echo "not due; exiting (use --force)"; exit 0 ;; esac ;; *) echo "trigger check failed"; exit 3 ;; esac
  fi
  if ! curl -fsS --max-time 5 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    echo "Ollama is not reachable on 127.0.0.1:11434; exiting"; exit 3
  fi
  python3 "$ROOT/scripts/otter-evo-evolve.py" "${ARGS[@]}"
  rc=$?
  echo "== exit=$rc $(date -Iseconds)"
  exit "$rc"
} 2>&1 | tee -a "$LOG"
exit "${PIPESTATUS[0]}"
