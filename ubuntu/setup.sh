#!/usr/bin/env bash
# ============================================================
# 로컬 코딩 에이전트 설치기 / 검사기 (Ubuntu 22.04+ / systemd)
#
#   ubuntu/setup.sh install             # deps → ollama → env → models → opencode → doctor
#   ubuntu/setup.sh deps|ollama|env|models|opencode   # 단계별 실행 (모두 멱등)
#   ubuntu/setup.sh doctor [--runtime]  # 정적 검사 (+ GPU 를 쓰는 런타임 검사)
#   ubuntu/setup.sh bench [model]       # 생성 속도 / thinking 비용 / 프리픽스 캐시 측정
#   ubuntu/setup.sh status              # 현재 상태 요약
#   ubuntu/setup.sh env-remove          # systemd drop-in 제거 후 재시작
#
# 공통 옵션: --dry-run (변경 명령을 출력만) --yes (확인 생략) --config <file> --json (doctor)
#
# 설계 원칙: 각 단계는 "검출 → 다르면 변경 → 확인". 이미 만족하면 아무것도 하지 않는다.
# 요구: bash 4+, sudo, curl, jq, python3. GPU 는 NVIDIA(CUDA) 기준으로 감지, 없으면 CPU 경고.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config/local-agent.env"
DRY_RUN=0
ASSUME_YES=0
JSON_OUT=0
RUNTIME=0
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/local-coding-agent"
DROPIN_DIR="/etc/systemd/system/ollama.service.d"
DROPIN_FILE="$DROPIN_DIR/10-local-agent.conf"

# ---------- 로깅 ----------
c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
[[ -t 1 ]] || { c_red=""; c_grn=""; c_ylw=""; c_dim=""; c_off=""; }
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s[ok]%s %s\n' "$c_grn" "$c_off" "$*"; }
warn()  { printf '%s[warn]%s %s\n' "$c_ylw" "$c_off" "$*" >&2; }
die()   { printf '%s[error]%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
step()  { (( JSON_OUT )) || printf '\n%s== %s ==%s\n' "$c_dim" "$*" "$c_off"; }

# 변경을 일으키는 명령은 모두 run 으로 감싼다 (--dry-run 지원)
run() {
  if (( DRY_RUN )); then printf '%s[dry-run]%s %s\n' "$c_dim" "$c_off" "$*"; return 0; fi
  "$@"
}
# stdin 내용을 root 소유 파일에 쓴다 (dry-run 이면 내용 미리보기)
write_root_file() { # path
  local path="$1" content; content="$(cat)"
  if (( DRY_RUN )); then printf '%s[dry-run]%s write %s:\n%s\n' "$c_dim" "$c_off" "$path" "$content"; return 0; fi
  printf '%s\n' "$content" | $SUDO tee "$path" >/dev/null
}
confirm() { # message
  (( ASSUME_YES )) && return 0
  (( DRY_RUN )) && return 0
  local a; read -r -p "$1 [y/N] " a </dev/tty || return 1
  [[ "$a" == [yY]* ]]
}
have() { command -v "$1" >/dev/null 2>&1; }
ver_ge() { # a b  → a >= b ?
  python3 - "$1" "$2" <<'PY'
import sys
v=lambda s: tuple(int(x) for x in s.strip().lstrip('v').split('.')[:3])
sys.exit(0 if v(sys.argv[1])>=v(sys.argv[2]) else 1)
PY
}
with_timeout() { # seconds cmd...  (coreutils timeout 가 없을 때 perl 로 대체)
  local s="$1"; shift
  if have timeout; then timeout "$s" "$@"; else perl -e 'alarm shift; exec @ARGV' "$s" "$@"; fi
}

# ---------- 설정 ----------
load_config() {
  [[ -f "$CONFIG_FILE" ]] || die "설정 파일이 없습니다: $CONFIG_FILE"
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  : "${LA_OLLAMA_HOST:=http://127.0.0.1:11434}"
  : "${LA_CTX:=auto}" "${LA_KEEP_ALIVE:=-1}" "${LA_FLASH_ATTENTION:=1}" "${LA_KV_CACHE_TYPE:=f16}" "${LA_NUM_PARALLEL:=1}"
  : "${LA_MAIN_MODEL:?LA_MAIN_MODEL 필요}" "${LA_SMALL_BASE:=llama3.2:3b}" "${LA_SMALL_MODEL:=llama3.2:3b-ctx8k}" "${LA_SMALL_CTX:=8192}"
  : "${LA_OUTPUT_LIMIT:=8192}" "${LA_MAIN_THINKING:=on}" "${LA_EXTRA_MODELS:=}" "${LA_EXTRA_THINKING:=off}" "${LA_MODEL_ALIASES:=}"
  : "${LA_OPENCODE_CONFIG:=$HOME/.config/opencode/opencode.jsonc}" "${LA_TASK_TOOL:=false}" "${LA_OPENCODE_PLUGINS:=}"
  : "${LA_MIN_TOKPS:=20}" "${LA_E2E_TIMEOUT:=180}" "${LA_EXTRA_ENV:=}" "${LA_OLLAMA_VERSION:=}" "${LA_OPENCODE_VERSION:=}"
  if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
  mkdir -p "$STATE_DIR"
}

# ---------- 감지 ----------
gpu_vram_mib() { # NVIDIA 총 VRAM(MiB). GPU 없으면 0
  if have nvidia-smi; then
    nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END{print s+0}'
  else echo 0; fi
}
resolve_ctx() { # LA_CTX=auto 를 VRAM 기준 숫자로
  if [[ "$LA_CTX" != "auto" ]]; then echo "$LA_CTX"; return; fi
  local v; v=$(gpu_vram_mib)
  if   (( v >= 40000 )); then echo 65536
  elif (( v >= 20000 )); then echo 32768
  elif (( v > 0 ));      then echo 16384
  else echo 8192; fi
}
api() { curl -sf --max-time "${2:-5}" "$LA_OLLAMA_HOST$1"; }
api_post() { curl -sf --max-time "${3:-600}" "$LA_OLLAMA_HOST$1" -d "$2"; }
ollama_version_installed() { ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -1; }
ollama_version_server() { api /api/version 2>/dev/null | jq -r .version 2>/dev/null; }
systemd_running() { have systemctl && [[ "$(systemctl is-system-running 2>/dev/null || true)" =~ ^(running|degraded)$ ]]; }
service_mainpid() { systemctl show -p MainPID --value ollama 2>/dev/null || echo 0; }
effective_env() { # 실행 중인 ollama 프로세스의 OLLAMA_* env (root 권한 필요할 수 있음)
  local pid; pid=$(service_mainpid); [[ "${pid:-0}" -gt 0 ]] || return 1
  $SUDO tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep '^OLLAMA_' | sort
}
model_exists() { ollama show "$1" >/dev/null 2>&1; }
model_digest() { api /api/tags | jq -r --arg n "$1" '.models[] | select(.name==$n or .name==($n+":latest")) | .digest' | sed -n 1p; }
desired_env_lines() { # Environment= 줄 목록
  local ctx; ctx=$(resolve_ctx)
  printf 'Environment="OLLAMA_CONTEXT_LENGTH=%s"\n' "$ctx"
  printf 'Environment="OLLAMA_KEEP_ALIVE=%s"\n' "$LA_KEEP_ALIVE"
  printf 'Environment="OLLAMA_FLASH_ATTENTION=%s"\n' "$LA_FLASH_ATTENTION"
  printf 'Environment="OLLAMA_KV_CACHE_TYPE=%s"\n' "$LA_KV_CACHE_TYPE"
  printf 'Environment="OLLAMA_NUM_PARALLEL=%s"\n' "$LA_NUM_PARALLEL"
  local kv; for kv in $LA_EXTRA_ENV; do printf 'Environment="%s"\n' "$kv"; done
}
desired_env_kv() { desired_env_lines | sed -E 's/^Environment="(.*)"$/\1/' | sort; }
wait_server() { # seconds
  local i; for i in $(seq 1 "${1:-60}"); do api /api/version 3 >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}

# ---------- 단계: deps ----------
cmd_deps() {
  step "deps"
  [[ "$(uname -s)" == "Linux" ]] || warn "Linux 가 아닙니다 ($(uname -s)). --dry-run 검토 용도로만 실행하세요."
  local missing=() c
  for c in curl jq python3 ca-certificates; do
    case "$c" in ca-certificates) [[ -e /etc/ssl/certs/ca-certificates.crt ]] || missing+=("$c") ;; *) have "$c" || missing+=("$c") ;; esac
  done
  if (( ${#missing[@]} )); then
    info "설치 필요: ${missing[*]}"
    run $SUDO apt-get update -qq
    run $SUDO apt-get install -y -qq "${missing[@]}"
  else ok "curl jq python3 ca-certificates 준비됨"; fi
  local v; v=$(gpu_vram_mib)
  if (( v > 0 )); then ok "NVIDIA GPU VRAM 합계 ${v} MiB"; else warn "nvidia-smi 없음 → CPU 추론. 26B q4 는 RAM 24GB 이상 필요, 속도는 GPU 대비 크게 낮음"; fi
}

# ---------- 단계: ollama ----------
cmd_ollama() {
  step "ollama"
  local cur; cur=$(ollama_version_installed || true)
  if [[ -n "$cur" && ( -z "$LA_OLLAMA_VERSION" || "$cur" == "$LA_OLLAMA_VERSION" ) ]]; then
    ok "ollama $cur 설치됨 (핀: ${LA_OLLAMA_VERSION:-latest})"
  else
    info "ollama 설치/변경: 현재 '${cur:-없음}' → '${LA_OLLAMA_VERSION:-latest}'"
    confirm "https://ollama.com/install.sh 를 실행합니다 (sudo 필요)." || die "중단"
    if (( DRY_RUN )); then info "[dry-run] curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=$LA_OLLAMA_VERSION sh"
    else curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION="$LA_OLLAMA_VERSION" sh; fi
  fi
  if systemd_running; then
    if ! systemctl is-active --quiet ollama; then run $SUDO systemctl enable --now ollama; fi
  else
    warn "systemd 가 실행 중이 아닙니다 (WSL/컨테이너?). 서비스 대신 다음처럼 직접 띄우세요:"
    info "  $(desired_env_kv | tr '\n' ' ') nohup ollama serve > ~/ollama.log 2>&1 &"
  fi
  if ! (( DRY_RUN )); then wait_server 60 || die "Ollama 서버($LA_OLLAMA_HOST)가 응답하지 않습니다"; fi
  ok "서버 버전: $(ollama_version_server 2>/dev/null || echo '?')"
}

# ---------- 단계: env (systemd drop-in) ----------
cmd_env() {
  step "env (systemd drop-in)"
  local ctx; ctx=$(resolve_ctx)
  info "컨텍스트 길이: $ctx (LA_CTX=$LA_CTX, VRAM $(gpu_vram_mib) MiB)"
  if ! have systemctl; then warn "systemctl 없음 → drop-in 을 쓸 수 없습니다. 위 env 를 셸에서 export 하고 ollama serve 를 직접 실행하세요."; desired_env_kv; return 0; fi
  local desired; desired="$(printf '[Service]\n'; desired_env_lines)"
  local changed=0
  if [[ -f "$DROPIN_FILE" ]] && [[ "$($SUDO cat "$DROPIN_FILE")" == "$desired" ]]; then
    ok "drop-in 이미 일치: $DROPIN_FILE"
  else
    run $SUDO mkdir -p "$DROPIN_DIR"
    write_root_file "$DROPIN_FILE" <<<"$desired"
    changed=1; ok "drop-in 작성: $DROPIN_FILE"
  fi
  # 실행 중인 프로세스의 실효 env 와 비교해 필요할 때만 재시작
  local eff; eff="$(effective_env 2>/dev/null || true)"
  local want; want="$(desired_env_kv)"
  local need_restart=0
  if (( changed )); then need_restart=1
  elif [[ -z "$eff" ]]; then warn "실효 env 를 읽지 못함 (서비스 미기동 또는 권한). 재시작으로 반영합니다."; need_restart=1
  else
    local k; while IFS= read -r k; do grep -qxF "$k" <<<"$eff" || { need_restart=1; info "불일치: 원함 '$k'"; }; done <<<"$want"
  fi
  if (( need_restart )); then
    run $SUDO systemctl daemon-reload
    run $SUDO systemctl restart ollama
    if ! (( DRY_RUN )); then wait_server 60 || die "재시작 후 서버가 응답하지 않습니다 (journalctl -u ollama 확인)"; fi
    ok "ollama 재시작 완료"
  else ok "실효 env 이미 일치 → 재시작 생략 (로드된 모델/캐시 유지)"; fi
  if ! (( DRY_RUN )); then
    local line; line=$(journal_server_config || true)
    [[ -n "$line" ]] && info "서버가 읽은 값: $(grep -oE 'OLLAMA_(CONTEXT_LENGTH|KEEP_ALIVE|FLASH_ATTENTION|KV_CACHE_TYPE|NUM_PARALLEL):[^ ]*' <<<"$line" | tr '\n' ' ')"
  fi
}
journal_server_config() {
  have journalctl || return 1
  $SUDO journalctl -u ollama -b --no-pager -o cat 2>/dev/null | grep 'msg="server config"' | tail -1
}
cmd_env_remove() {
  step "env-remove"
  [[ -f "$DROPIN_FILE" ]] || { ok "drop-in 없음"; return 0; }
  run $SUDO rm -f "$DROPIN_FILE"; run $SUDO systemctl daemon-reload; run $SUDO systemctl restart ollama
  ok "제거 및 재시작 완료 (Ollama 기본값으로 복귀: 컨텍스트 VRAM 기반 자동, keep_alive 5m)"
}

# ---------- 단계: models ----------
cmd_models() {
  step "models"
  local m
  for m in "$LA_MAIN_MODEL" $LA_EXTRA_MODELS "$LA_SMALL_BASE"; do
    case "$m" in *-mlx*) warn "$m 은 Apple MLX 전용 태그라 Linux 에서 건너뜁니다"; continue ;; esac
    if model_exists "$m"; then ok "존재: $m"
    else info "pull: $m (수 GB, 시간이 걸립니다)"; run ollama pull "$m"; fi
  done
  # 소형 모델: num_ctx 고정 변형
  local want="PARAMETER num_ctx $LA_SMALL_CTX"
  if model_exists "$LA_SMALL_MODEL" && ollama show "$LA_SMALL_MODEL" --modelfile 2>/dev/null | grep -x "$want" >/dev/null; then
    ok "존재: $LA_SMALL_MODEL ($want)"
  else
    local tmp; tmp=$(mktemp)
    sed -e "s|@@SMALL_BASE@@|$LA_SMALL_BASE|" -e "s|@@SMALL_CTX@@|$LA_SMALL_CTX|" "$SCRIPT_DIR/config/modelfiles/small.Modelfile.tmpl" > "$tmp"
    info "create: $LA_SMALL_MODEL (FROM $LA_SMALL_BASE, num_ctx $LA_SMALL_CTX)"
    run ollama create "$LA_SMALL_MODEL" -f "$tmp"; rm -f "$tmp"
  fi
  # 별칭
  local pair src dst
  for pair in $LA_MODEL_ALIASES; do
    src="${pair%%=*}"; dst="${pair#*=}"
    if [[ -n "$(model_digest "$dst" 2>/dev/null)" && "$(model_digest "$dst")" == "$(model_digest "$src")" ]]; then ok "별칭 일치: $dst → $src"
    else info "alias: ollama cp $src $dst"; run ollama cp "$src" "$dst"; fi
  done
  # 락파일(선택): name digest12
  local lock="$SCRIPT_DIR/config/models.lock"
  if [[ -f "$lock" ]] && ! (( DRY_RUN )); then
    local name dg cur
    while read -r name dg _; do
      [[ -z "$name" || "$name" == \#* ]] && continue
      cur=$(model_digest "$name" 2>/dev/null | cut -c1-12)
      if [[ -z "$cur" ]]; then warn "락파일 모델 없음: $name"
      elif [[ "$cur" != "${dg:0:12}" ]]; then warn "digest 불일치: $name 로컬 $cur ≠ 락 ${dg:0:12} (태그가 갱신됐을 수 있음)"
      else ok "digest 일치: $name $cur"; fi
    done < "$lock"
  fi
}

# ---------- 단계: opencode ----------
opencode_bin() { command -v opencode 2>/dev/null || { [[ -x "$HOME/.opencode/bin/opencode" ]] && echo "$HOME/.opencode/bin/opencode"; }; }
render_opencode_config() { # → stdout (JSONC)
  local ctx; ctx=$(resolve_ctx)
  local main_opts="" extra_opts=""
  [[ "$LA_MAIN_THINKING" == "off" ]]  && main_opts=',
          "options": { "reasoningEffort": "none" }'
  [[ "$LA_EXTRA_THINKING" == "off" ]] && extra_opts=',
          "options": { "reasoningEffort": "none" }'
  local plugins="" p; for p in $LA_OPENCODE_PLUGINS; do plugins+="\"$p\", "; done; plugins="${plugins%, }"
  cat <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  // generated-by: local-coding-agent ubuntu/setup.sh — 값은 ubuntu/config/local-agent.env 에서 바꾸고 'setup.sh opencode' 재실행
  // limit.context 는 Ollama 서버의 OLLAMA_CONTEXT_LENGTH($ctx) 와 일치해야 함 (Ollama /v1 API 는 num_ctx 를 무시)
  "model": "ollama/$LA_MAIN_MODEL",
  "small_model": "ollama/$LA_SMALL_MODEL",
  "plugin": [$plugins],
  "tools": { "task": $LA_TASK_TOOL },
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "$LA_OLLAMA_HOST/v1" },
      "models": {
        "$LA_MAIN_MODEL": {
          "name": "$LA_MAIN_MODEL (local, default, thinking $LA_MAIN_THINKING)",
          "reasoning": true,
          "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": $ctx, "output": $LA_OUTPUT_LIMIT }$main_opts
        },
EOF
  local m; for m in $LA_EXTRA_MODELS; do
    case "$m" in *-mlx*) continue ;; esac
    cat <<EOF
        "$m": {
          "name": "$m (local, thinking $LA_EXTRA_THINKING)",
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": $ctx, "output": $LA_OUTPUT_LIMIT }$extra_opts
        },
EOF
  done
  cat <<EOF
        "$LA_SMALL_MODEL": {
          "name": "$LA_SMALL_MODEL (local, small tasks)",
          "tool_call": true,
          "limit": { "context": $LA_SMALL_CTX, "output": 2048 }
        }
      }
    }
  }
}
EOF
}
jsonc_to_json() { # file → stdout (문자열 안의 // 는 보존)
  python3 - "$1" <<'PY'
import json,sys
s=open(sys.argv[1]).read(); o=[]; i=0; instr=False
while i<len(s):
    c=s[i]
    if instr:
        o.append(c)
        if c=='\\': o.append(s[i+1]); i+=1
        elif c=='"': instr=False
    elif c=='"': instr=True; o.append(c)
    elif s.startswith('//',i): j=s.find('\n',i); i=len(s) if j<0 else j; continue
    elif s.startswith('/*',i): i=s.find('*/',i)+1
    else: o.append(c)
    i+=1
print(json.dumps(json.loads(''.join(o))))
PY
}
cmd_opencode() {
  step "opencode"
  local bin; bin=$(opencode_bin || true)
  local cur=""; [[ -n "$bin" ]] && cur=$("$bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [[ -n "$cur" && ( -z "$LA_OPENCODE_VERSION" || "$cur" == "$LA_OPENCODE_VERSION" ) ]]; then ok "opencode $cur 설치됨"
  else
    info "opencode 설치/변경: '${cur:-없음}' → '${LA_OPENCODE_VERSION:-latest}'"
    if (( DRY_RUN )); then info "[dry-run] curl -fsSL https://opencode.ai/install | bash -s -- ${LA_OPENCODE_VERSION:+--version $LA_OPENCODE_VERSION}"
    else curl -fsSL https://opencode.ai/install | bash -s -- ${LA_OPENCODE_VERSION:+--version "$LA_OPENCODE_VERSION"}; fi
    bin=$(opencode_bin || true)
  fi
  [[ ":$PATH:" == *":$HOME/.opencode/bin:"* ]] || warn "PATH 에 ~/.opencode/bin 이 없습니다. 새 셸을 열거나: export PATH=\$HOME/.opencode/bin:\$PATH"
  # 설정 렌더링
  local rendered; rendered="$(render_opencode_config)"
  local tmp; tmp=$(mktemp); printf '%s\n' "$rendered" > "$tmp"
  jsonc_to_json "$tmp" >/dev/null || { rm -f "$tmp"; die "렌더링된 설정이 JSON 으로 파싱되지 않습니다"; }
  if [[ -f "$LA_OPENCODE_CONFIG" ]] && cmp -s "$tmp" "$LA_OPENCODE_CONFIG"; then ok "설정 이미 일치: $LA_OPENCODE_CONFIG"
  else
    if [[ -f "$LA_OPENCODE_CONFIG" ]]; then
      local bak="$LA_OPENCODE_CONFIG.backup-$(date +%Y%m%d-%H%M%S)"
      if ! grep -q 'generated-by: local-coding-agent' "$LA_OPENCODE_CONFIG"; then
        warn "기존 설정은 이 스크립트가 만든 것이 아닙니다. 백업 후 덮어씁니다: $bak"
        confirm "덮어쓸까요?" || { rm -f "$tmp"; die "중단 (기존 설정 유지)"; }
      fi
      run cp "$LA_OPENCODE_CONFIG" "$bak"
    fi
    run mkdir -p "$(dirname "$LA_OPENCODE_CONFIG")"
    if (( DRY_RUN )); then info "[dry-run] write $LA_OPENCODE_CONFIG"; diff -u "$LA_OPENCODE_CONFIG" "$tmp" 2>/dev/null | head -60 || true
    else cp "$tmp" "$LA_OPENCODE_CONFIG"; fi
    ok "설정 작성: $LA_OPENCODE_CONFIG"
  fi
  rm -f "$tmp"
}

# ---------- doctor ----------
declare -a D_LINES=(); D_PASS=0; D_WARN=0; D_FAIL=0; D_SKIP=0
report() { # STATUS id name observed [fix]
  local st="$1" id="$2" name="$3" obs="$4" fix="${5:-}"
  case "$st" in PASS) ((D_PASS++));; WARN) ((D_WARN++));; FAIL) ((D_FAIL++));; SKIP) ((D_SKIP++));; esac
  D_LINES+=("$st|$id|$name|$obs|$fix")
  if ! (( JSON_OUT )); then
    local col="$c_grn"; [[ $st == WARN ]] && col="$c_ylw"; [[ $st == FAIL ]] && col="$c_red"; [[ $st == SKIP ]] && col="$c_dim"
    printf '%s[%s]%s %-4s %-24s %s%s\n' "$col" "$st" "$c_off" "$id" "$name" "$obs" "${fix:+  fix: $fix}"
  fi
}
doctor_static() {
  local ctx; ctx=$(resolve_ctx)
  # S01 도구
  local miss="" c; for c in curl jq python3; do have "$c" || miss+="$c "; done
  [[ -z "$miss" ]] && report PASS S01 tools "curl jq python3" || report FAIL S01 tools "missing: $miss" "setup.sh deps"
  # S02 버전
  local vi vs; vi=$(ollama_version_installed || true); vs=$(ollama_version_server || true)
  if [[ -z "$vi" ]]; then report FAIL S02 ollama.version "ollama 미설치" "setup.sh ollama"
  elif [[ -z "$vs" ]]; then report FAIL S02 ollama.version "cli=$vi server 응답 없음" "systemctl start ollama"
  elif [[ "$vi" != "$vs" ]]; then report WARN S02 ollama.version "cli=$vi ≠ server=$vs (재시작 전 드리프트)" "systemctl restart ollama"
  elif [[ -n "$LA_OLLAMA_VERSION" && "$vi" != "$LA_OLLAMA_VERSION" ]]; then report WARN S02 ollama.version "$vi (핀 $LA_OLLAMA_VERSION)" "setup.sh ollama"
  else report PASS S02 ollama.version "$vi"; fi
  local server_up=0; [[ -n "$vs" ]] && server_up=1
  # S03 서비스
  if have systemctl; then
    if systemctl is-active --quiet ollama 2>/dev/null; then report PASS S03 systemd.service "active, enabled=$(systemctl is-enabled ollama 2>/dev/null || echo ?)"
    else report FAIL S03 systemd.service "$(systemctl is-active ollama 2>/dev/null || echo inactive)" "sudo systemctl enable --now ollama"; fi
  else report SKIP S03 systemd.service "systemctl 없음"; fi
  # S04 drop-in
  if [[ -f "$DROPIN_FILE" ]]; then
    local want; want="$(printf '[Service]\n'; desired_env_lines)"
    [[ "$($SUDO cat "$DROPIN_FILE" 2>/dev/null)" == "$want" ]] && report PASS S04 env.dropin "$DROPIN_FILE" || report FAIL S04 env.dropin "내용 불일치" "setup.sh env"
  else report FAIL S04 env.dropin "없음 → Ollama 기본값(VRAM≥48GiB면 ctx 262144, keep_alive 5m)" "setup.sh env"; fi
  # S05 실효 env
  local eff; eff="$(effective_env 2>/dev/null || true)"
  if [[ -n "$eff" ]]; then
    local bad="" k; while IFS= read -r k; do grep -qxF "$k" <<<"$eff" || bad+="$k "; done < <(desired_env_kv)
    [[ -z "$bad" ]] && report PASS S05 env.process "$(desired_env_kv | tr '\n' ' ')" || report FAIL S05 env.process "누락/불일치: $bad" "setup.sh env"
  else report SKIP S05 env.process "프로세스 env 읽기 불가 (sudo/서비스 없음)"; fi
  # S06 저널 server config
  local line; line=$(journal_server_config 2>/dev/null || true)
  if [[ -n "$line" ]]; then
    local got; got=$(grep -oE 'OLLAMA_CONTEXT_LENGTH:[0-9]+' <<<"$line" | cut -d: -f2)
    local ka; ka=$(grep -oE 'OLLAMA_KEEP_ALIVE:[^ ]+' <<<"$line" | cut -d: -f2)
    if [[ "$got" == "$ctx" ]]; then report PASS S06 env.journal "CONTEXT_LENGTH=$got KEEP_ALIVE=$ka"
    else report FAIL S06 env.journal "CONTEXT_LENGTH=${got:-?} (원함 $ctx)" "setup.sh env"; fi
  else report SKIP S06 env.journal "journalctl 에서 server config 줄을 찾지 못함"; fi
  # S07 모델
  if (( server_up )); then
    local m; for m in "$LA_MAIN_MODEL" $LA_EXTRA_MODELS "$LA_SMALL_MODEL"; do
      case "$m" in *-mlx*) continue;; esac
      model_exists "$m" && report PASS S07 "model:$m" "$(model_digest "$m" | cut -c1-12)" || report FAIL S07 "model:$m" "없음" "setup.sh models"
    done
    if model_exists "$LA_SMALL_MODEL"; then
      ollama show "$LA_SMALL_MODEL" --modelfile 2>/dev/null | grep -x "PARAMETER num_ctx $LA_SMALL_CTX" >/dev/null \
        && report PASS S08 small.num_ctx "$LA_SMALL_CTX" || report FAIL S08 small.num_ctx "num_ctx 미고정 → 전역 ctx 상속으로 메모리 낭비" "setup.sh models"
    fi
    # S09 MTP 드래프터 (정적): show 의 draft_num_predict
    if ollama show "$LA_MAIN_MODEL" --parameters 2>/dev/null | grep 'draft_num_predict' >/dev/null; then report PASS S09 mtp.draft "$(ollama show "$LA_MAIN_MODEL" --parameters 2>/dev/null | grep draft_num_predict | tr -s ' ') (MTP 드래프터 내장)"
    else report WARN S09 mtp.draft "드래프터 파라미터 없음 (MTP 미적용 태그일 수 있음)" "MTP 태그 확인: ollama.com/library/gemma4/tags"; fi
    # S10 로드 상태
    local ps; ps=$(api /api/ps 2>/dev/null || echo '{"models":[]}')
    local big; big=$(jq -r '.models[] | select(.context_length>=262144) | .name' <<<"$ps" | tr '\n' ' ')
    [[ -z "$big" ]] && report PASS S10 loaded.ctx "$(jq -r '[.models[] | "\(.name):\(.context_length)"] | join(" ")' <<<"$ps")" \
      || report FAIL S10 loaded.ctx "262144 로 로드됨: $big" "setup.sh env && ollama stop <model>"
    # S11 러너 플래그
    local cmdline; cmdline=$(ps -eo args 2>/dev/null | grep -E 'llama-server|ollama runner' | grep -v grep | head -1 || true)
    if [[ -n "$cmdline" ]]; then
      local f=""; grep -q -- "--spec-type draft-mtp" <<<"$cmdline" && f+="draft-mtp "; grep -qE -- "(-c|--ctx-size) $ctx\b" <<<"$cmdline" && f+="ctx=$ctx "
      [[ "$f" == *draft-mtp* ]] && report PASS S11 runner.flags "$f" || report WARN S11 runner.flags "${f:-플래그 미확인} (MTP 러너 아님 또는 다른 모델 로드됨)"
    else report SKIP S11 runner.flags "러너 프로세스 없음 (모델 미로드)"; fi
  else report SKIP S07 models "서버 응답 없음"; fi
  # S12 opencode
  local bin; bin=$(opencode_bin || true)
  if [[ -n "$bin" ]]; then
    report PASS S12 opencode.bin "$("$bin" --version 2>/dev/null | head -1)"
    if [[ -f "$LA_OPENCODE_CONFIG" ]]; then
      local js; if js=$(jsonc_to_json "$LA_OPENCODE_CONFIG" 2>/dev/null); then
        local model small lim
        model=$(jq -r .model <<<"$js"); small=$(jq -r .small_model <<<"$js")
        lim=$(jq -r --arg m "$LA_MAIN_MODEL" '.provider.ollama.models[$m].limit.context // empty' <<<"$js")
        [[ "$model" == "ollama/$LA_MAIN_MODEL" ]] && report PASS S13 opencode.model "$model" || report FAIL S13 opencode.model "$model (원함 ollama/$LA_MAIN_MODEL)" "setup.sh opencode"
        [[ "$small" == "ollama/$LA_SMALL_MODEL" ]] && report PASS S14 opencode.small "$small" || report WARN S14 opencode.small "$small" "setup.sh opencode"
        [[ "$lim" == "$ctx" ]] && report PASS S15 opencode.limit "context=$lim == 서버 $ctx" || report FAIL S15 opencode.limit "context=${lim:-없음} ≠ 서버 $ctx (compaction 불일치)" "setup.sh opencode"
        local ro; ro=$(jq -r --arg m "$LA_MAIN_MODEL" '.provider.ollama.models[$m].options.reasoningEffort // "unset"' <<<"$js")
        if [[ "$LA_MAIN_THINKING" == "off" ]]; then [[ "$ro" == "none" ]] && report PASS S16 opencode.thinking "off" || report FAIL S16 opencode.thinking "reasoningEffort=$ro (원함 none)" "setup.sh opencode"
        else [[ "$ro" == "unset" ]] && report PASS S16 opencode.thinking "on" || report FAIL S16 opencode.thinking "reasoningEffort=$ro (원함 미설정)" "setup.sh opencode"; fi
      else report FAIL S13 opencode.config "JSONC 파싱 실패: $LA_OPENCODE_CONFIG" "setup.sh opencode"; fi
    else report FAIL S13 opencode.config "설정 파일 없음" "setup.sh opencode"; fi
  else report FAIL S12 opencode.bin "opencode 미설치" "setup.sh opencode"; fi
  # S17 잔류 opencode run (stdin 대기 행)
  local stale; stale=$(ps -eo pid,etimes,tty,args 2>/dev/null | awk '/[o]pencode run/ && $3=="?" && $2>600 {print $1}' | tr '\n' ' ' || true)
  [[ -z "$stale" ]] && report PASS S17 stale.runs "없음" || report WARN S17 stale.runs "10분 이상 멈춘 opencode run: $stale" "kill $stale (비대화식 호출은 </dev/null 필수)"
  # S18 디스크
  local free; free=$(df -BG --output=avail /usr/share/ollama 2>/dev/null | tail -1 | tr -dc '0-9' || df -g / 2>/dev/null | awk 'NR==2{print $4}')
  if [[ -n "$free" ]]; then (( free >= 25 )) && report PASS S18 disk "${free}G free" || report WARN S18 disk "${free}G free (모델 1개 재pull 에 ~20G)"; fi
}
doctor_runtime() {
  local ctx; ctx=$(resolve_ctx); local M="$LA_MAIN_MODEL"
  api /api/version >/dev/null 2>&1 || { report SKIP R00 runtime "서버 응답 없음"; return; }
  # R01 로드
  local before; before=$(api /api/ps | jq -r '.models[].name' | sort | tr '\n' ' ')
  local r; r=$(api_post /api/generate "{\"model\":\"$M\",\"keep_alive\":-1}" 300 2>/dev/null || true)
  local ps; ps=$(api /api/ps)
  local dg; dg=$(model_digest "$M")
  local lc; lc=$(jq -r --arg d "$dg" '.models[] | select(.digest==$d) | .context_length' <<<"$ps" | sed -n 1p)
  [[ "$lc" == "$ctx" ]] && report PASS R01 load "ctx=$lc" || report FAIL R01 load "ctx=${lc:-미로드} (원함 $ctx)" "setup.sh env"
  # R02 생성 속도 + MTP 통계
  local body; body=$(jq -nc --arg m "$M" '{model:$m,stream:false,think:false,messages:[{role:"user",content:"Write a Python function that parses ISO8601 dates and returns a datetime; include 3 pytest tests."}],options:{temperature:0,num_predict:300}}')
  local out; out=$(api_post /api/chat "$body" 600 2>/dev/null || echo '{}')
  local ec ed tps; ec=$(jq -r '.eval_count // 0' <<<"$out"); ed=$(jq -r '.eval_duration // 0' <<<"$out")
  tps=$(python3 -c "print(round($ec/($ed/1e9),1) if $ed else 0)")
  if (( ec < 100 )); then report FAIL R02 gen.tokps "eval_count=$ec (생성 실패?)" "journalctl -u ollama"
  elif python3 -c "import sys; sys.exit(0 if $tps >= $LA_MIN_TOKPS else 1)"; then report PASS R02 gen.tokps "$tps tok/s ($ec tok)"
  else report WARN R02 gen.tokps "$tps tok/s < 하한 $LA_MIN_TOKPS" "GPU 오프로드/MTP 확인: journalctl -u ollama | grep -E 'offloaded|draft'"; fi
  local acc; acc=$($SUDO journalctl -u ollama -b --no-pager -o cat 2>/dev/null | grep -oE 'draft acceptance = [0-9.]+|acceptance=[0-9.]+' | tail -1 || true)
  [[ -n "$acc" ]] && report PASS R03 mtp.accept "$acc" || report WARN R03 mtp.accept "저널에 MTP 수락률 없음 (MTP 비활성 또는 권한)"
  # R04 thinking on/off (/v1)
  local q='{"role":"user","content":"What is 17*23? Reply with the number only."}'
  local a b; a=$(curl -sf --max-time 120 "$LA_OLLAMA_HOST/v1/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"$M\",\"messages\":[$q],\"max_tokens\":300}" | jq -r '.choices[0].message.reasoning // .choices[0].message.reasoning_content // "" | length' 2>/dev/null || echo -1)
  b=$(curl -sf --max-time 120 "$LA_OLLAMA_HOST/v1/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"$M\",\"messages\":[$q],\"max_tokens\":300,\"reasoning_effort\":\"none\"}" | jq -r '.choices[0].message.reasoning // .choices[0].message.reasoning_content // "" | length' 2>/dev/null || echo -1)
  if (( a > 0 && b == 0 )); then report PASS R04 thinking.toggle "default=${a}자, none=0"
  else report WARN R04 thinking.toggle "default=${a} none=${b} (기대: default>0, none=0)"; fi
  # R05 프리픽스 캐시
  local sysp; sysp=$(python3 -c "print(('You are a careful coding agent. Follow the repository conventions strictly. Read before editing, keep diffs minimal, run tests after changes, and report results plainly. '*60))")
  local pb; pb=$(jq -nc --arg m "$M" --arg s "$sysp" '{model:$m,stream:false,think:false,messages:[{role:"system",content:$s},{role:"user",content:"Reply with exactly: OK"}],options:{temperature:0,num_predict:8}}')
  api_post /api/chat "$pb" 600 >/dev/null 2>&1 || true
  local d2; d2=$(api_post /api/chat "$pb" 600 2>/dev/null | jq -r '.prompt_eval_duration // 0')
  local d2s; d2s=$(python3 -c "print(round($d2/1e9,2))")
  python3 -c "import sys; sys.exit(0 if $d2 < 5e8 else 1)" && report PASS R05 prefix.cache "2회차 prompt_eval ${d2s}s" || report FAIL R05 prefix.cache "2회차 prompt_eval ${d2s}s (캐시 미동작: NUM_PARALLEL>1 또는 keep_alive)" "setup.sh env"
  # R06 OpenCode e2e
  local bin; bin=$(opencode_bin || true)
  if [[ -n "$bin" ]]; then
    local t0 t1 outp rc; t0=$(date +%s)
    outp=$(cd "$(mktemp -d)" && with_timeout "$LA_E2E_TIMEOUT" "$bin" run --pure "Reply with exactly: OK" </dev/null 2>&1) && rc=0 || rc=$?
    t1=$(date +%s)
    if (( rc == 0 )) && grep -q "OK" <<<"$outp"; then report PASS R06 opencode.e2e "$((t1-t0))s"
    else report FAIL R06 opencode.e2e "rc=$rc $((t1-t0))s: $(tail -1 <<<"$outp" | cut -c1-80)" "setup.sh opencode"; fi
  else report SKIP R06 opencode.e2e "opencode 없음"; fi
  # 로드 상태 안내
  local after; after=$(api /api/ps | jq -r '.models[].name' | sort | tr '\n' ' ')
  [[ "$before" == "$after" ]] || report WARN R07 model.state "로드 상태 변경: [$before] → [$after]" "ollama stop <model> 로 정리 가능"
}
cmd_doctor() {
  step "doctor (static)"; doctor_static
  if (( RUNTIME )); then step "doctor (runtime, GPU 사용)"; doctor_runtime; fi
  local rc=0; (( D_FAIL )) && rc=2
  if (( JSON_OUT )); then
    printf '{"pass":%d,"warn":%d,"fail":%d,"skip":%d,"checks":[' "$D_PASS" "$D_WARN" "$D_FAIL" "$D_SKIP"
    local i first=1; for i in "${D_LINES[@]}"; do IFS='|' read -r st id nm obs fix <<<"$i"
      (( first )) || printf ','; first=0
      jq -nc --arg st "$st" --arg id "$id" --arg nm "$nm" --arg obs "$obs" --arg fix "$fix" '{status:$st,id:$id,name:$nm,observed:$obs,fix:$fix}' | tr -d '\n'
    done; printf '],"exit_code":%d}\n' "$rc"
  else printf '\nSummary: PASS %d  WARN %d  FAIL %d  SKIP %d  exit=%d\n' "$D_PASS" "$D_WARN" "$D_FAIL" "$D_SKIP" "$rc"; fi
  return $rc
}

# ---------- bench / status ----------
cmd_bench() {
  local b="$SCRIPT_DIR/../scripts/bench-ollama.sh"; [[ -x "$b" ]] || b="$SCRIPT_DIR/bench-ollama.sh"
  [[ -x "$b" ]] || die "bench-ollama.sh 를 찾을 수 없습니다"
  OLLAMA_HOST="$LA_OLLAMA_HOST" bash "$b" "${1:-$LA_MAIN_MODEL}"
}
cmd_status() {
  step "status"
  info "ollama: cli=$(ollama_version_installed || echo -) server=$(ollama_version_server || echo -)  host=$LA_OLLAMA_HOST"
  info "ctx: $(resolve_ctx) (LA_CTX=$LA_CTX, VRAM $(gpu_vram_mib) MiB)"
  have systemctl && info "service: $(systemctl is-active ollama 2>/dev/null || echo -) / drop-in: $([[ -f $DROPIN_FILE ]] && echo present || echo absent)"
  local j; j=$(journal_server_config 2>/dev/null || true); [[ -n "$j" ]] && info "server config: $(grep -oE 'OLLAMA_(CONTEXT_LENGTH|KEEP_ALIVE|NUM_PARALLEL):[^ ]*' <<<"$j" | tr '\n' ' ')"
  ollama list 2>/dev/null | grep -E "^($LA_MAIN_MODEL|$LA_SMALL_MODEL|$(echo "$LA_EXTRA_MODELS" | tr ' ' '|'))" || true
  ollama ps 2>/dev/null || true
  info "opencode: $($(opencode_bin || echo echo) --version 2>/dev/null | head -1 || echo -)  config: $LA_OPENCODE_CONFIG"
}

# ---------- main ----------
usage() { sed -n '2,15p' "$0"; exit 64; }
main() {
  local cmd="${1:-}"; [[ -n "$cmd" ]] || usage; shift
  while (( $# )); do
    case "$1" in
      --dry-run) DRY_RUN=1;; --yes|-y) ASSUME_YES=1;; --json) JSON_OUT=1;; --runtime) RUNTIME=1;;
      --config) CONFIG_FILE="$2"; shift;; -h|--help) usage;;
      *) set -- "$@"; break;;
    esac; shift
  done
  load_config
  case "$cmd" in
    install) cmd_deps; cmd_ollama; cmd_env; cmd_models; cmd_opencode; cmd_doctor ;;
    deps) cmd_deps;; ollama) cmd_ollama;; env) cmd_env;; env-remove) cmd_env_remove;;
    models) cmd_models;; opencode) cmd_opencode;; doctor) cmd_doctor;; bench) cmd_bench "$@";; status) cmd_status;;
    *) usage;;
  esac
}
main "$@"
