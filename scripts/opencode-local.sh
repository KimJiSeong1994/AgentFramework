#!/usr/bin/env bash
# OpenCode + Ollama gemma4:31b 로컬 코딩 에이전트 런처
#
#   scripts/opencode-local.sh            # 현재 디렉터리에서 OpenCode TUI 실행 (기본 모델: LOCAL_MODEL 또는 26B)
#   scripts/opencode-local.sh run "..."  # 추가 인자는 opencode에 그대로 전달
#
# 사전 점검: Ollama 서버 응답, 모델 존재, 서버 컨텍스트 길이가 OpenCode 설정(65536)과 일치하는지.
# 실행 전에 gemma4:31b를 keep_alive=-1로 워밍(로드)해서 첫 프롬프트에서 로드 대기가 없게 함.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MODEL="${LOCAL_MODEL:-gemma4:26b-a4b-it-mtp-q4_K_M}"
SMALL_MODEL="${LOCAL_SMALL_MODEL:-llama3.2:3b-ctx8k}"
EXPECTED_CTX="${EXPECTED_CTX:-65536}"
LOG="$HOME/.ollama/logs/server.log"

command -v opencode >/dev/null || { echo 'opencode CLI가 필요합니다.' >&2; exit 1; }

if ! curl -sf "$HOST/api/version" >/dev/null; then
  echo "Ollama 서버($HOST)가 응답하지 않습니다. Ollama.app을 실행하거나 scripts/ollama-env.sh apply 를 먼저 실행하세요." >&2
  exit 1
fi

ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$MODEL" || { echo "모델 $MODEL 이(가) 없습니다: ollama pull $MODEL" >&2; exit 1; }
if ! ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$SMALL_MODEL"; then
  # small_model은 제목 생성용이라 8K 컨텍스트로 고정한 변형을 사용 (전역 65536을 받으면 3B가 12GB를 점유)
  echo "small model $SMALL_MODEL 생성 중 (FROM llama3.2:3b, num_ctx 8192)..."
  ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "llama3.2:3b" || ollama pull llama3.2:3b
  printf 'FROM llama3.2:3b\nPARAMETER num_ctx 8192\n' | ollama create "$SMALL_MODEL" -f -
fi

if [[ -f "$LOG" ]]; then
  ctx=$(grep 'msg="server config"' "$LOG" | tail -1 | grep -oE 'OLLAMA_CONTEXT_LENGTH:[0-9]+' | cut -d: -f2 || true)
  if [[ "${ctx:-0}" != "$EXPECTED_CTX" ]]; then
    echo "경고: Ollama 서버 OLLAMA_CONTEXT_LENGTH=${ctx:-<unset>} (OpenCode 설정은 $EXPECTED_CTX)." >&2
    echo "      ${ctx:-0} = 0 이면 262144 기본값이 적용되어 KV 캐시 23.5GB를 예약합니다. scripts/ollama-env.sh apply 권장." >&2
  fi
fi

# 워밍 로드 (백그라운드). 이미 로드돼 있으면 즉시 반환.
curl -s "$HOST/api/generate" -d "{\"model\":\"$MODEL\",\"keep_alive\":-1}" >/dev/null 2>&1 &

# LOCAL_MODEL을 실제 OpenCode 모델 선택에 반영 (이전에는 워밍에만 쓰여 README 설명과 불일치했음)
exec opencode --model "ollama/$MODEL" "$@"
