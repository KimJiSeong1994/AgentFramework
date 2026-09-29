# 로컬 코딩 에이전트 가속화 적용 보고서

- 일자: 2026-09-18
- 환경: Mac mini, Apple M4 Pro (10P+4E), 64GB 통합 메모리, Metal GPU 한도 48GiB, macOS 15.3
- 대상: OpenCode 1.18.31 + Ollama (0.20.5 → 0.34.2) + Gemma 4
- 결과 요약: **OpenCode 툴 호출 1회 작업이 약 80초에서 3~13초로 단축** (캐시 상태에 따라). 생성 속도는 12 tok/s에서 66 tok/s로.

---

## 1. 문제 진단

원래 구성은 Ollama 0.20.5에서 `gemma4:31b`(GGUF Q4_K_M, 19GB)를 OpenCode가 OpenAI 호환 API(`/v1/chat/completions`)로 호출하는 형태였습니다. 실제 세션 로그(2026-09-17)에서 호출당 지연이 중앙값 78~86초, 최대 30분 22초였고, 5분 타임아웃 500 에러가 2건 있었습니다.

세 개의 분석 에이전트(웹 리서치, 클라이언트 오버헤드 분석, 실측 벤치마크)로 원인을 나눠 조사한 결과입니다.

| 순위 | 원인 | 근거 |
|---|---|---|
| 1 | **프리픽스 캐시가 계속 깨짐** | `OLLAMA_KEEP_ALIVE=5m`으로 5분 idle마다 언로드(하루 5회 재로드). 제목 생성용 `small_model`까지 31B라 단일 슬롯을 번갈아 점유. 8K 토큰 프리픽스 캐시 히트 0.09초 vs 미스 79.5초 |
| 2 | **thinking ON + 출력 한도 16384** | OpenCode 경로에 think 옵션이 없어 기본 ON. 세션에서 reasoning 31,781자 생성. 한 요청이 16,384토큰 반복 생성으로 30분 독점 |
| 3 | **Ollama 0.20.5가 낡음** | 최신 0.34.2. 그 사이에 MLX 러너, Gemma 4 MTP 투기적 디코딩, prefill restore point가 추가됨 |
| 4 | **컨텍스트 262144 기본값** | 48GiB VRAM 감지 시 자동 262K. KV 캐시만 23.5GB 예약(총 47GB), 속도 이득은 0 |
| 5 | 31B dense 모델의 구조적 한계 | M4 Pro 대역폭 273GB/s에서 생성 상한 약 14 tok/s, 프롬프트 처리 92 tok/s |
| 6 | OMX/Orca 훅 | 툴 호출당 약 350ms, 전체의 1~2%로 무시 가능 |

검증에서 배제한 것: flash attention은 이미 Auto로 켜져 있었고, KV q8_0 양자화는 오히려 9~15% 느려졌으며, `num_batch` 2048은 효과가 없었습니다.

---

## 2. 적용 내역

### 2.1 Ollama 서버 환경변수

`launchctl setenv`로 즉시 적용하고, 로그인 시 재적용되도록 `~/Library/LaunchAgents/com.local-coding-agent.ollama-env.plist`를 설치했습니다. 관리 스크립트는 `scripts/ollama-env.sh`입니다.

| 변수 | 이전 | 이후 | 효과 |
|---|---|---|---|
| `OLLAMA_CONTEXT_LENGTH` | 미설정 → 262144 | 65536 | 31B KV 캐시 23.5GB → 8.5GB (상주 47GB → 30GB) |
| `OLLAMA_KEEP_ALIVE` | 5m | -1 | idle 언로드 금지, 프리픽스 캐시 유지 |
| `OLLAMA_FLASH_ATTENTION` | 미설정(Auto) | 1 | 명시. 끄면 생성 -13% |
| `OLLAMA_KV_CACHE_TYPE` | 미설정(f16) | f16 | q8_0는 손해라 채택 안 함 |
| `OLLAMA_NUM_PARALLEL` | 1 | 1 | 슬롯 분할 방지 |

Ollama의 `/v1` API는 요청별 `num_ctx`를 무시하므로 컨텍스트 길이는 서버 환경변수(전역) 또는 Modelfile `PARAMETER num_ctx`(모델별)로만 제어됩니다.

### 2.2 OpenCode 설정 (`~/.config/opencode/opencode.jsonc`)

백업: `opencode.jsonc.backup-20260918-before-speedup`

| 항목 | 이전 | 이후 |
|---|---|---|
| `model` | ollama/gemma4:31b | **ollama/gemma4:26b-a4b-it-mtp-q4_K_M** |
| `small_model` | ollama/gemma4:31b | **ollama/llama3.2:3b-ctx8k** (제목 생성 등 보조 호출 분리) |
| `limit.context` / `limit.output` | 262144 / 16384 | 65536 / 8192 (서버 컨텍스트와 일치, 자동 compaction 동작) |
| 26B `options` | - | 없음 → thinking ON |
| 31B(mlx, GGUF) `options` | 없음(thinking ON) | `reasoningEffort: none` (31B는 thinking이 +53% 지연) |
| `tools.task` | 활성 | false (서브에이전트가 단일 슬롯에서 직렬 대기 + 캐시 스래싱) |

등록된 모델 목록:

| 모델 ID | 용도 |
|---|---|
| gemma4:26b-a4b-it-mtp-q4_K_M | 기본. MoE + MTP, thinking ON |
| gemma4:31b-mlx | 품질 우선 대안. dense nvfp4 + MTP, thinking OFF |
| gemma4:31b | GGUF fallback. MTP 없음, thinking OFF |
| llama3.2:3b-ctx8k | 보조 호출용. Modelfile로 `num_ctx 8192` 고정 (전역 65536을 받으면 3B가 12GB 점유) |

실증한 사항: OpenCode의 모델 `options.reasoningEffort`는 요청 본문의 `reasoning_effort`로 매핑되고, Ollama는 `none`을 받으면 Gemma 4 thinking을 끕니다. `id` 오버라이드로 만든 별칭 항목은 기본 항목의 옵션을 물려받아 thinking 토글용으로 쓸 수 없어 제거했습니다.

### 2.3 Ollama 업그레이드 및 모델 추가

- Ollama.app 0.20.5 → 0.34.2. 앱이 받아둔 번들을 수동 설치했고, 이전 앱은 `~/.ollama/backup/Ollama-0.20.5.app`에 보관. 업그레이드 후 환경변수 유지 확인.
- `gemma4:31b-mlx` (19GB, nvfp4, MTP 드래프터 내장) 다운로드.
- `gemma4:26b-a4b-it-mtp-q4_K_M` (18GB, GGUF, 별도 draft 레이어 0.46GB) 다운로드. 기본 태그 `gemma4:26b`와 구성이 동일합니다.
- `llama3.2:3b-ctx8k` 생성 (`FROM llama3.2:3b` + `PARAMETER num_ctx 8192`).

`gemma4:31b-coding-mtp-bf16`(63GB)는 본체가 bf16이라 GPU 한도 48GiB에 올라가지 않고, 드래프터는 31b-mlx에 내장된 것과 동일해 불필요합니다.

### 2.4 프로젝트 스크립트

| 파일 | 역할 |
|---|---|
| `scripts/ollama-env.sh` | `apply` (환경변수 + LaunchAgent + 앱 재시작), `show`, `restart` |
| `scripts/opencode-local.sh` | 사전 점검(서버, 모델, 컨텍스트 일치) → 모델 워밍 로드 → `opencode` 실행. `LOCAL_MODEL=...`로 모델 변경. small model이 없으면 자동 생성 |
| `scripts/bench-ollama.sh` | 생성 tok/s, thinking 비용, 8K 프리픽스 캐시 히트/미스 측정. `TEMP=1`로 온도 지정 |
| `scripts/local-agent.sh` | Codex용, 변경 없음 |

macOS 기본 bash가 3.2라 스크립트에서 연관 배열을 쓰지 않았습니다.

---

## 3. 실측 결과

### 3.1 모델 비교 (Ollama 0.34.2, `scripts/bench-ollama.sh`)

| 모델 | 생성 tok/s (온도 0 / 1) | 프롬프트 처리 | 8K 콜드 프리필 | MTP 수락률 | 상주 메모리 |
|---|---|---|---|---|---|
| gemma4:31b GGUF | 12.0 / 12.0 | 92 tok/s | 63초 | 없음 | 30GB |
| gemma4:31b-mlx (MTP) | 27.3 / 27.8 | 96 tok/s | 60초 | 63~81% | 19~24GB |
| **gemma4:26b MoE (MTP)** | **66 / 68** | **739 tok/s** | **7.8초** | 76~100% | 약 20GB |
| llama3.2:3b-ctx8k | 약 99 | 331 tok/s | - | - | 3GB |

- 26B thinking ON 비용: 생성 66 → 62 tok/s, 호출당 thinking 약 400~500 토큰. 31B는 thinking ON 시 +53% 지연이라 OFF 유지.
- MTP는 생성만 가속합니다. 프롬프트 처리 속도는 그대로라 31B의 콜드 프리필 비용은 캐시 유지로만 줄일 수 있습니다.
- 8K 프리픽스 캐시: 히트 0.04~0.12초, 앞부분 1글자만 바뀌어도 전량 재계산. 세션 중간에 시스템 프롬프트나 툴 목록을 바꾸는 설정 변경을 피해야 합니다.

### 3.2 OpenCode 엔드투엔드 (툴 호출 1회 포함 작업)

| 구성 | 총 시간 |
|---|---|
| 1단계 이전 (실제 세션 호출당 중앙값) | 78~86초 |
| 31B GGUF, 1단계 적용, 콜드 | 74~80초 |
| 31B GGUF, 프리픽스 캐시 히트 | 1.95초 (단순 응답) |
| 31B MLX + MTP, 콜드 | 79초 |
| 26B MoE + MTP, 콜드 | 13초 |
| 26B MoE + MTP, 캐시 히트 | 3.2초 |

thinking ON 상태에서 OpenCode가 reasoning 파트를 정상 기록하는 것과, 툴 스키마가 있어도 thinking이 억제되지 않는 것을 확인했습니다.

---

## 4. 운영 방법

```bash
scripts/ollama-env.sh show        # 환경변수와 서버 반영 상태 확인
scripts/opencode-local.sh         # OpenCode 실행 (기본 26B)
LOCAL_MODEL=gemma4:31b-mlx scripts/opencode-local.sh   # 품질 우선 시
scripts/bench-ollama.sh [model]   # 전후 비교
```

- 모델을 바꾸면 Ollama가 GPU 메모리에 맞춰 이전 모델을 내리고 프리픽스 캐시도 사라집니다. 26B(약 20GB), 31B MLX(19~24GB), 3B(3GB)를 함께 올리면 한도(48GiB)에 근접합니다.
- thinking 토글을 바꾸면 시스템 프롬프트의 제어 토큰이 바뀌어 첫 호출에서 캐시가 한 번 빠집니다.
- 26B thinking을 끄려면 OpenCode 설정의 26B 항목에 `"options": { "reasoningEffort": "none" }`을 추가합니다.
- `ollama list`가 26B의 MoE 텐서 메타데이터를 읽지 못한다는 에러를 서버 로그에 남기지만, 로드와 추론에는 영향이 없었습니다.
- `opencode run`을 스크립트에서 stdin이 열린 채 호출하면 입력 EOF를 기다리며 멈출 수 있습니다. 비대화식 호출은 `</dev/null`을 붙이세요. 터미널 사용에는 해당 없습니다.

---

## 5. 미적용 및 후속 후보

1. **`qwen3.6:35b-a3b` 검토.** MoE라 26B급 속도가 기대되고, 에이전틱 코딩 벤치(SWE-bench Verified 73.4)가 Gemma 4보다 높다는 보고가 있습니다. Ollama MTP 지원 여부는 별도 확인 필요.
2. **26B 기본값의 품질 판단.** 커뮤니티 벤치에서 에이전틱 코딩 품질은 31B보다 낮다고 보고됩니다. 며칠 실제 작업 후 부족하면 `gemma4:31b-mlx`로 되돌리세요.
3. **Codex 경로.** `scripts/local-agent.sh`는 그대로이며, Codex 고정 프리픽스(약 23K 토큰: 시스템 21K자 + skills 14K자 + AGENTS.md 25KB)를 줄이는 작업은 하지 않았습니다.
4. 프로젝트의 새 파일(README, scripts, docs)은 아직 커밋하지 않았습니다.
