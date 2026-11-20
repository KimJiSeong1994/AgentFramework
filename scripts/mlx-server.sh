#!/usr/bin/env bash
# otter's MLX server (scripts/mlx-server.py) for the `local` engine (`local_model.server: "mlx"`): greedy decoding and
# exact prefix-state reuse, so repeated otter prompts only prefill their new tail. Binds 127.0.0.1 only.
#
#   scripts/mlx-server.sh start | run | stop | status | logs
#   scripts/mlx-server.sh install-agent   start at login via ~/Library/LaunchAgents/com.otter.mlx.plist
#   scripts/mlx-server.sh remove-agent
#
# Environment: MLX_PYTHON (default: the SGLang venv's python, which has mlx and mlx_lm), MLX_MODEL
# (default mlx-community/Qwen3.8-27B-4bit), MLX_SERVED_NAME (default qwen3.8-27b), MLX_PORT (default 30000),
# MLX_PREFIX_CACHE_GB (default 8), MLX_EXTRA_ARGS (e.g. --no-prefix-cache).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${MLX_PYTHON:-$HOME/.local/share/sglang/venv/bin/python}"
MODEL="${MLX_MODEL:-mlx-community/Qwen3.8-27B-4bit}"
NAME="${MLX_SERVED_NAME:-qwen3.8-27b}"
PORT="${MLX_PORT:-30000}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/otter"
LOG="$STATE/mlx-server.log"
PIDFILE="$STATE/mlx-server.pid"
LABEL="com.otter.mlx"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$STATE"

running_pid() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && cat "$PIDFILE"; }
ready() { curl -fsS -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; }
serve() {
  [ -x "$PY" ] || { echo "python with mlx_lm not found at $PY (set MLX_PYTHON)" >&2; exit 1; }
  # shellcheck disable=SC2086
  exec "$PY" -I "$HERE/mlx-server.py" --model "$MODEL" --served-model-name "$NAME" --port "$PORT" \
    --prefix-cache-gb "${MLX_PREFIX_CACHE_GB:-8}" ${MLX_EXTRA_ARGS:-}
}
wait_ready() {
  for _ in $(seq 1 300); do
    ready && { echo "MLX server ready on http://127.0.0.1:$PORT (model $NAME)"; return 0; }
    sleep 2
  done
  echo "MLX server did not become ready; see $LOG" >&2; tail -20 "$LOG" >&2; return 1
}

case "${1:-status}" in
  run) serve ;;
  start)
    if pid="$(running_pid)"; then echo "already running (pid $pid)"; exit 0; fi
    nohup "$0" run >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"; echo "started pid $(cat "$PIDFILE"); loading $MODEL (log: $LOG)"; wait_ready ;;
  stop)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    if pid="$(running_pid)"; then kill "$pid" 2>/dev/null || true; fi
    pkill -f "mlx-server.py.*--port $PORT" 2>/dev/null || true
    rm -f "$PIDFILE"; echo "stopped" ;;
  status)
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/v1/models" 2>/dev/null; then echo; curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null; echo
    else echo "not reachable on 127.0.0.1:$PORT"; exit 1; fi ;;
  logs) tail -n 50 "$LOG" ;;
  install-agent)
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$HERE/mlx-server.sh</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>MLX_PYTHON</key><string>$PY</string>
    <key>MLX_MODEL</key><string>$MODEL</string>
    <key>MLX_SERVED_NAME</key><string>$NAME</string>
    <key>MLX_PORT</key><string>$PORT</string>
    <key>MLX_PREFIX_CACHE_GB</key><string>${MLX_PREFIX_CACHE_GB:-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $PLIST (starts at login; restarts on crash)"; wait_ready ;;
  remove-agent)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "removed $PLIST" ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
