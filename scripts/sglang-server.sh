#!/usr/bin/env bash
# Local SGLang server (MLX backend on Apple Silicon) for otter's `local` engine (`local_model.server: "sglang"`).
#
#   scripts/sglang-server.sh start [model]   start in the background (default model: mlx-community/Qwen3.8-27B-4bit)
#   scripts/sglang-server.sh run [model]     run in the foreground (used by the launchd agent)
#   scripts/sglang-server.sh stop | status | logs
#   scripts/sglang-server.sh install-agent   start at login via ~/Library/LaunchAgents/com.otter.sglang.plist
#   scripts/sglang-server.sh remove-agent
#
# Binds 127.0.0.1 only; otter refuses non-loopback local endpoints. Environment overrides:
#   SGLANG_HOME (default ~/.local/share/sglang: venv/ and the sglang/ source checkout)
#   SGLANG_MODEL, SGLANG_SERVED_NAME (default qwen3.8-27b), SGLANG_PORT (default 30000), SGLANG_CONTEXT (optional)
#   SGLANG_MAX_TOTAL_TOKENS (KV pool size, default 65536; without it SGLang sizes the pool to about half of RAM)
#   SGLANG_REASONING_PARSER (default auto: split <think> into reasoning_content so answers stay clean)
set -euo pipefail

SGLANG_HOME="${SGLANG_HOME:-$HOME/.local/share/sglang}"
PY="$SGLANG_HOME/venv/bin/python"
MODEL="${2:-${SGLANG_MODEL:-mlx-community/Qwen3.8-27B-4bit}}"
NAME="${SGLANG_SERVED_NAME:-qwen3.8-27b}"
PORT="${SGLANG_PORT:-30000}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/otter"
LOG="$STATE/sglang.log"
PIDFILE="$STATE/sglang.pid"
PLIST="$HOME/Library/LaunchAgents/com.otter.sglang.plist"
mkdir -p "$STATE"

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE")"
  kill -0 "$pid" 2>/dev/null && echo "$pid"
}

serve() {
  [ -x "$PY" ] || { echo "SGLang venv not found at $SGLANG_HOME/venv (see docs/otter-sglang-local-server.md)" >&2; exit 1; }
  local extra=()
  [ -n "${SGLANG_CONTEXT:-}" ] && extra+=(--context-length "$SGLANG_CONTEXT")
  SGLANG_USE_MLX=1 exec "$PY" -m sglang.launch_server \
    --model-path "$MODEL" --served-model-name "$NAME" \
    --host 127.0.0.1 --port "$PORT" \
    --max-total-tokens "${SGLANG_MAX_TOTAL_TOKENS:-65536}" \
    --reasoning-parser "${SGLANG_REASONING_PARSER:-auto}" \
    --disable-decode-cuda-graph --disable-prefill-cuda-graph \
    ${extra[@]+"${extra[@]}"}
}

wait_ready() {
  for _ in $(seq 1 300); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then echo "SGLang ready on http://127.0.0.1:$PORT (model $NAME)"; return 0; fi
    running_pid >/dev/null || { echo "SGLang exited; see $LOG" >&2; tail -20 "$LOG" >&2; return 1; }
    sleep 2
  done
  echo "SGLang did not become ready within 10 minutes; see $LOG" >&2; return 1
}

case "${1:-status}" in
  run) serve ;;
  start)
    if pid="$(running_pid)"; then echo "already running (pid $pid)"; exit 0; fi
    nohup "$0" run "$MODEL" >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    echo "started pid $(cat "$PIDFILE"); loading $MODEL (log: $LOG)"
    wait_ready ;;
  stop)
    if pid="$(running_pid)"; then kill "$pid"; for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; kill -9 "$pid" 2>/dev/null || true; fi
    rm -f "$PIDFILE"; pkill -f "sglang.launch_server.*--port $PORT" 2>/dev/null || true; echo "stopped" ;;
  status)
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/v1/models" 2>/dev/null; then echo; else echo "not reachable on 127.0.0.1:$PORT"; exit 1; fi ;;
  logs) tail -n 50 "$LOG" ;;
  install-agent)
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.otter.sglang</string>
  <key>ProgramArguments</key><array><string>$(cd "$(dirname "$0")" && pwd)/sglang-server.sh</string><string>run</string><string>$MODEL</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>SGLANG_HOME</key><string>$SGLANG_HOME</string>
    <key>SGLANG_SERVED_NAME</key><string>$NAME</string>
    <key>SGLANG_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/com.otter.sglang" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $PLIST (starts at login; restarts on crash)"
    for _ in $(seq 1 300); do curl -fsS -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && { echo "SGLang ready on http://127.0.0.1:$PORT"; exit 0; }; sleep 2; done
    echo "agent installed; still loading (see $LOG)" ;;
  remove-agent)
    launchctl bootout "gui/$(id -u)/com.otter.sglang" 2>/dev/null || true
    rm -f "$PLIST"; echo "removed $PLIST" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
