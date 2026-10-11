# AgentFramework — local coding agent (OpenCode + Ollama Gemma 4)

> **lca (자체 에이전트 프레임워크)**: `framework/README.md` (사용법·설정), 설계 `docs/agent-framework-review-2026-09-22.md`,
> 구현 결과 `docs/lca-stage1-2026-09-22.md`, `docs/lca-stage2-2026-09-23.md`, `docs/lca-stage3-2026-09-23.md`(데이터 레이어), `docs/lca-stage4-2026-09-23.md`(온톨로지 진화 배치), `docs/lca-stage5-2026-09-23.md`(모델 비교). 아래는 OpenCode/Ollama 환경 설정 문서입니다.

## LCA 공통 선택

`lca`는 OpenCode를 자동으로 열지 않고 로컬(Ollama CLI)·Codex·Claude 엔진과 모델을 선택합니다.
`lca chat --engine codex --model gpt-5.6-sol`처럼 직접 지정할 수도 있습니다.
대화·계획·명시적 사용자 승인·직렬 실행은 공통 LCA 컨트롤러가 담당합니다.
입력 추정치와 출력 사후 중단을 사용하는 별도 프로필이며, 정확한 토큰 상한이나 OS 격리를 보장하지 않습니다.
기존 로그인은 각 CLI가 사용하고, Ollama 서비스나 전역 설정은 자동 변경하지 않습니다.
자세한 제약과 기존 OpenCode 명령의 차이는 `framework/README.md`를 참고하세요.

## 기존 OpenCode/Ollama 환경

Mac mini M4 Pro 64GB에서 Ollama(0.34.2)의 Gemma 4를 OpenCode의 백엔드로 쓰는 설정입니다.
기본 모델은 **`gemma4:26b-a4b-it-mtp-q4_K_M`**(MoE + MTP 투기적 디코딩, 생성 66 tok/s, thinking ON)이고, 품질 우선일 때는 **`gemma4:31b-mlx`**(dense + MTP, 27 tok/s)를 선택할 수 있습니다.
2026-09-18 속도 검토 결과를 반영했습니다. Codex용 `scripts/local-agent.sh`는 그대로 두었습니다.

## Ubuntu 자동 설치

`ubuntu/setup.sh install` 로 같은 구성을 Ubuntu(systemd + NVIDIA)에 재현합니다. 자세한 내용은 `docs/ubuntu-setup.md`.

## 빠른 시작 (macOS)

```bash
scripts/ollama-env.sh apply      # 최초 1회: Ollama 환경변수 적용 + LaunchAgent 설치 + Ollama.app 재시작
scripts/opencode-local.sh        # OpenCode TUI 실행 (사전 점검 + 모델 워밍 로드)
scripts/bench-ollama.sh          # 전후 비교용 간이 벤치마크
scripts/ollama-env.sh show       # 현재 적용 상태 확인
```

## 무엇을 바꿨나

| 항목 | 이전 | 이후 | 이유 |
|---|---|---|---|
| `OLLAMA_CONTEXT_LENGTH` | 미설정 → 262144 | 65536 | KV 캐시 23.5GB(총 47GB) → 8.5GB(총 30GB). 속도 차이 없음 |
| `OLLAMA_KEEP_ALIVE` | 5m | -1 | 5분 idle 언로드로 프리픽스 캐시 전부 소실되던 문제 제거 |
| `OLLAMA_FLASH_ATTENTION` | 미설정(Auto=on) | 1 | 명시. 끄면 생성 -13% |
| `OLLAMA_KV_CACHE_TYPE` | 미설정(f16) | f16 | q8_0는 생성 -9~15%라 채택 안 함 |
| OpenCode `small_model` | gemma4:31b | llama3.2:3b-ctx8k | 제목 생성이 31B 슬롯을 점유하며 캐시를 밀어내던 문제 제거. Modelfile `num_ctx 8192` 고정 (전역 65536이면 3B가 12GB 점유) |
| OpenCode gemma4 `options` | 없음(thinking ON) | 31B: `reasoningEffort: none`, 26B: thinking ON 유지 | 31B는 thinking이 +53% 지연. 26B는 62 vs 66 tok/s로 비용이 작아 켜 둠 |
| OpenCode `limit.context/output` | 262144 / 16384 | 65536 / 8192 | 서버 컨텍스트와 일치시켜 자동 compaction 동작, 30분짜리 폭주 생성 방지 |
| OpenCode `tools.task` | 활성 | 비활성 | 서브에이전트가 단일 슬롯에서 직렬 대기 + 캐시 스래싱 |

OpenCode 설정 파일: `~/.config/opencode/opencode.jsonc` (백업: `opencode.jsonc.backup-20260918-before-speedup`).
Ollama 환경변수는 `launchctl setenv`와 `~/Library/LaunchAgents/com.local-coding-agent.ollama-env.plist`로 관리합니다.
Ollama의 `/v1` API는 요청별 `num_ctx`를 무시하므로 컨텍스트 길이는 서버 환경변수(전역) 또는 Modelfile `PARAMETER num_ctx`(모델별)로 잡아야 합니다.
`llama3.2:3b-ctx8k`는 `scripts/opencode-local.sh`가 없으면 자동 생성합니다.

## 모델 비교 실측 (2026-09-18, Ollama 0.34.2, thinking OFF)

| 모델 | 생성 tok/s (온도 0 / 1) | 프롬프트 처리 tok/s | 8K 콜드 프리필 | MTP 수락률 | 메모리 |
|---|---|---|---|---|---|
| gemma4:31b (GGUF Q4_K_M) | 12.0 / 12.0 | 92 | 63초 | 없음 | 30GB |
| **gemma4:31b-mlx** (nvfp4, 품질 우선) | **27.3 / 27.8** | 96 | 60초 | 63~81% | 19~24GB |
| **gemma4:26b-a4b-it-mtp-q4_K_M** (MoE 3.8B active, 기본) | **66 / 68** | **739** | **7.8초** | 76~100% | 약 20GB |
| llama3.2:3b-ctx8k (제목 생성용) | 약 99 | 331 | - | - | 3GB |

- 31B는 dense라 생성이 메모리 대역폭에 묶여 있고, MTP가 그 상한을 2.3배 끌어올립니다. 프롬프트 처리 속도는 MTP와 무관하게 그대로라 콜드 프리필 비용(8K당 60초)은 캐시 유지로만 줄일 수 있습니다.
- 26B MoE는 활성 파라미터가 3.8B라 생성과 프리필 모두 압도적으로 빠릅니다(OpenCode 툴 호출 1회 작업 79초 → 13초). 에이전틱 코딩 품질은 31B보다 낮다는 커뮤니티 벤치가 있으므로, 품질이 아쉬우면 OpenCode 모델을 `ollama/gemma4:31b-mlx`로 바꾸거나 `LOCAL_MODEL=gemma4:31b-mlx scripts/opencode-local.sh`로 실행하세요.
- `gemma4:31b-coding-mtp-bf16`(64GB)는 본체가 bf16이라 이 머신의 GPU 한도(48GiB)에 올라가지 않으며, 드래프터는 31b-mlx에 내장된 것과 동일합니다.
- 세 모델을 동시에 올릴 수는 없습니다(단일 GPU 메모리). 모델을 바꾸면 Ollama가 이전 모델을 내리고 프리픽스 캐시도 사라집니다.

## 1단계 실측 (2026-09-18, Ollama 0.20.5, GGUF 31b 기준)

| 측정 | 값 |
|---|---|
| 생성 속도 | 약 12 tok/s (M4 Pro 대역폭 상한 약 14) |
| 프롬프트 처리 | 약 92 tok/s |
| OpenCode 첫 호출 (콜드 프리필 약 7.5K 토큰) | 101초 → 74초 (task 툴 제거로 스키마 축소) |
| OpenCode 두 번째 호출 (프리픽스 캐시 히트) | 1.95초 |
| 이전 실제 세션 호출당 지연 | 중앙값 78~86초, 최대 30분 |

체감 지연은 거의 전부 "캐시되지 않은 프롬프트 토큰 수"로 결정됩니다 (8K 토큰당 약 80초).
따라서 세션 중간에 시스템 프롬프트나 툴 목록이 바뀌는 플러그인/설정 변경을 피하세요.

## 2단계 적용 내역 (2026-09-18)

- Ollama 0.20.5 → 0.34.2 수동 업그레이드 (이전 앱 번들 백업: `~/.ollama/backup/Ollama-0.20.5.app`). 환경변수는 그대로 유지됨.
- `gemma4:31b-mlx`, `gemma4:26b-a4b-it-mtp-q4_K_M` 다운로드. GGUF `gemma4:31b`는 fallback으로 보관(MTP 없음, 12 tok/s).
- OpenCode 기본 모델을 `ollama/gemma4:26b-a4b-it-mtp-q4_K_M`로 전환. 31B MLX와 GGUF 31B는 모델 선택 목록에 남겨 둠.

## 다음 단계 (미적용)

- **`qwen3.6:35b-a3b`** 검토: MoE라 26B급 속도가 기대되고 에이전틱 코딩 벤치(SWE-bench Verified 73.4)는 Gemma 4보다 높다는 보고가 있습니다. MTP 지원 여부는 별도 확인 필요.
- 26B 기본값의 작업 품질을 며칠 겪어 보고, 부족하면 31B MLX로 되돌리세요.
