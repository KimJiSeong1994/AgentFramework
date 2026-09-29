#!/usr/bin/env bash
# Ollama.app 런타임 환경변수 적용/확인 스크립트 (gemma4:31b 코딩 에이전트용)
#
#   scripts/ollama-env.sh apply    # launchctl setenv + 로그인 시 재적용용 LaunchAgent 설치 + Ollama.app 재시작
#   scripts/ollama-env.sh show     # 현재 launchctl 값과 Ollama 서버가 실제로 읽은 값 출력
#   scripts/ollama-env.sh restart  # Ollama.app만 재시작
#
# 값 근거 (2026-09-18 실측):
#   OLLAMA_CONTEXT_LENGTH=65536  기본 262144는 KV 캐시 23.5GB 예약(총 47GB). 64K면 약 6~9GB. 속도 차이 없음.
#   OLLAMA_KEEP_ALIVE=-1         5분 idle 언로드 → 프리픽스 캐시 전부 소실(8K 토큰 재프리필 = 80초) 방지.
#   OLLAMA_FLASH_ATTENTION=1     현재 Auto로 이미 켜짐. 끄면 생성 -13%. 명시해 둠.
#   OLLAMA_KV_CACHE_TYPE=f16     q8_0는 생성 -9~15%로 손해. 메모리 부족할 때만 q8_0.
#   OLLAMA_NUM_PARALLEL=1        >1이면 KV 슬롯 분할로 프리픽스 캐시 히트율 저하.
set -euo pipefail

# macOS 기본 bash 3.2 호환 (연관 배열 미사용)
V_OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-65536}"
V_OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"
V_OLLAMA_FLASH_ATTENTION="${OLLAMA_FLASH_ATTENTION:-1}"
V_OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-f16}"
V_OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
val() { eval "printf '%s' \"\$V_$1\""; }
ORDER=(OLLAMA_CONTEXT_LENGTH OLLAMA_KEEP_ALIVE OLLAMA_FLASH_ATTENTION OLLAMA_KV_CACHE_TYPE OLLAMA_NUM_PARALLEL)
PLIST="$HOME/Library/LaunchAgents/com.local-coding-agent.ollama-env.plist"
HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
LOG="$HOME/.ollama/logs/server.log"

wait_server() {
  for _ in $(seq 1 60); do
    curl -sf "$HOST/api/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "Ollama 서버가 60초 안에 응답하지 않습니다." >&2
  return 1
}

restart_app() {
  echo "Ollama.app 재시작 중..."
  osascript -e 'tell application "Ollama" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -f "Ollama.app/Contents/MacOS/Ollama" >/dev/null || break
    sleep 1
  done
  pkill -f "Ollama.app/Contents/MacOS/Ollama" >/dev/null 2>&1 || true
  sleep 1
  open -a Ollama
  wait_server
  echo "Ollama $(curl -s "$HOST/api/version" | sed -E 's/.*"version":"([^"]+)".*/\1/') 기동 완료"
}

show() {
  echo "== launchctl 사용자 환경 =="
  for k in "${ORDER[@]}"; do printf '  %-24s %s\n' "$k" "$(launchctl getenv "$k" 2>/dev/null || echo '<unset>')"; done
  echo "== Ollama 서버가 읽은 값 (server.log 최신 server config) =="
  if [[ -f "$LOG" ]]; then
    line=$(grep 'msg="server config"' "$LOG" | tail -1)
    for k in "${ORDER[@]}"; do
      v=$(printf '%s' "$line" | grep -oE "$k:[^ ]*" | head -1)
      printf '  %s\n' "${v:-$k:<not found>}"
    done
  else
    echo "  $LOG 없음"
  fi
  echo "== 로드된 모델 =="
  ollama ps 2>/dev/null || true
}

apply() {
  echo "== launchctl setenv =="
  for k in "${ORDER[@]}"; do
    launchctl setenv "$k" "$(val "$k")"
    printf '  %-24s %s\n' "$k" "$(val "$k")"
  done

  echo "== 로그인 시 재적용용 LaunchAgent: $PLIST =="
  mkdir -p "$(dirname "$PLIST")"
  {
    cat <<'HDR'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local-coding-agent.ollama-env</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
HDR
    printf '    <string>'
    for k in "${ORDER[@]}"; do printf 'launchctl setenv %s %s; ' "$k" "$(val "$k")"; done
    printf '</string>\n'
    cat <<'FTR'
  </array>
</dict>
</plist>
FTR
  } > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "  설치 완료"

  restart_app
  echo
  show
}

case "${1:-show}" in
  apply) apply ;;
  show) show ;;
  restart) restart_app ;;
  *) echo "usage: $0 apply|show|restart" >&2; exit 2 ;;
esac
