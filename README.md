# AgentFramework — local-first coding agent

> **lca (자체 에이전트 프레임워크)**: `framework/README.md` (사용법·설정), 설계 `docs/agent-framework-review-2026-09-22.md`,
> 구현 결과 `docs/lca-stage1-2026-09-22.md`, `docs/lca-stage2-2026-09-23.md`, `docs/lca-stage3-2026-09-23.md`(데이터 레이어), `docs/lca-stage4-2026-09-23.md`(온톨로지 진화 배치), `docs/lca-stage5-2026-09-23.md`(모델 비교). 아래는 OpenCode/Ollama 및 선택적 Strata 연동 환경 설정 문서입니다.

## LCA 공통 선택

`lca`는 OpenCode를 자동으로 열지 않고 로컬(Ollama CLI)·Codex·Claude 엔진과 모델을 선택합니다.
`lca chat --engine codex --model gpt-5.6-sol`처럼 직접 지정할 수도 있습니다.
현재 실행한 환경의 Git 작업 디렉터리에서 동작하며, 기본 사용에는 VM이 필요하지 않습니다.
모델 선택 화면은 Ollama의 설치 모델, Codex의 고정 지원 목록, Claude의 모델 별칭을 구분해 표시합니다.
목록 번호 또는 네이티브 모델 ID로 선택할 수 있으며, 목록이 계정별 사용 권한이나 모델의 작업 성공을 보장하지는 않습니다.
대화 중 `/model`로 다시 선택하거나 `/model claude sonnet`처럼 전환하고, `/help`로 명령을 확인합니다.
실제 전환은 새 대화 세션을 만들며 이전 대화 문맥은 이어받지 않습니다. 진행 중인 워크플로·손상된 상태·미해결 실행이 있으면 전환하지 않습니다.
대화·계획·명시적 사용자 승인·직렬 실행은 공통 LCA 컨트롤러가 담당합니다.
지원 터미널에서는 기록·상태·입력의 전체 화면 TUI를 사용합니다. `LCA_TUI=0`으로 스크롤형 입력을 선택합니다.
`/sessions`는 보관된 세션을 표시하고 `/resume <sid>`는 실행하지 않은 채 세션을 복원합니다. 작업 재개는 `/continue`에서 별도로 확인합니다.
진행 표시는 실제 관측한 상태만 사용하며, 모델 응답은 토큰 스트리밍 대신 완료된 턴 단위로 표시합니다.
승인 입력 중에는 진행 출력을 멈추며, 표시 기능이 승인·취소·실행 소유권 규칙을 바꾸지는 않습니다.
입력 추정치와 출력 사후 중단을 사용하는 별도 프로필이며, 정확한 토큰 상한이나 OS 격리를 보장하지 않습니다.
기존 로그인은 각 CLI가 사용하고, Ollama 서비스나 전역 설정은 자동 변경하지 않습니다.
Linux 검증기 qualification은 별도 선택 기능이며, 일반 로컬 사용의 선행조건이 아닙니다.
자세한 제약과 기존 OpenCode 명령의 차이는 `framework/README.md`를 참고하세요.

`lca` 실행 명령이 설치되지 않은 경우 저장소 루트에서 직접 실행할 수 있습니다.

```sh
bun framework/src/hosts/cli.ts
bun framework/src/hosts/cli.ts chat --engine local --model llama3.2:3b
```

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

## 선택적 Strata 백엔드 (OpenCode/GJC)

**현재 배포 상태: 로컬 호환 패치로 실제 생성·API 도구 왕복·제한된 OpenCode/GJC 작업 확인, 전체 실사용 검증은 미완료.** macOS 15.3.1 / SDK 15.5에서 아래 커밋의 엔진을 빌드하고 Q2_0 모델을 다운로드했습니다. 초기 생성 요청은 `MetalPerformancePrimitives/MetalPerformancePrimitives.h` 부재로 HTTP 503을 반환했습니다. 두 prompt 설정만으로는 일반 디코딩의 레이아웃 탐지가 `mm_bench.metal`을 컴파일하는 문제가 남았습니다.

`STRATA_METAL_PROMPT=window`·`STRATA_METAL_PROMPT_GEMM=0`·`COOP_K4=0`의 세 설정으로 짧은 추론이 성공한 뒤, 설치된 Strata의 호스트 코드를 수정했습니다. Metal 기능 검사에 따라 기존 window 경로를 자동 선택하고, 두 레이아웃 탐지 및 prompt 초기화 진입점을 보호하며, 지원되지 않는 기능의 강제 지정은 명시적으로 거부합니다. GPU 수치 연산 커널이나 OS는 바꾸지 않았습니다. 세 진단 설정 없이도 같은 18토큰 입력에 HTTP 200과 `OK.` 응답을 확인했습니다.

사용자의 기준 완화 승인에 따라 **감시된 제한 검증에서** 사전 여유를 8 GiB에서 1 GiB로 낮추고 경고 수준 메모리 압력을 허용했습니다. 엔진 자체 메모리 보호, 1 Hz 외부 감시, 심각한 압력·스왑 급증·시간 초과 중단은 유지했습니다. 수치 비교, 제한된 API/client 요청과 아래 30분 시험에 적용했으며, 시험 서버는 모두 종료했습니다. 기존 Ollama/openjev는 종료하지 않았습니다. 이것이 무제한 장시간 사용이나 전체 32K 문맥의 안전성 보장은 아닙니다.

최종 소스에 대해 입력·환경·빌드·모델 식별 정보를 실행 전에 고정한 별도 수치 비교를 완료했습니다. 기준 엔진(고정 커밋 + SDK 가드 + 동일 진단 계측, 세 설정 사용)과 수정 엔진의 고정된 짧은 입력 **20/20건 모두** 전체 raw logits 등을 포함한 스냅샷과 직렬화된 체크포인트가 바이트 단위로 일치했습니다. 실사용 빌드에는 덤프 기능을 남기지 않았습니다. 첫 기준 실행의 정리 단계 경고는 보존했고, 원인을 고친 뒤 이미 성공한 기준 실행은 반복하지 않았습니다. 일부 출력은 16토큰 한도에서 잘렸으므로 의미적 정답률로 해석하지 않습니다.

기능 선택·강제 지정 거부·캐시 키 정책 및 `qsa_parity`의 3000 문맥 검사가 통과했습니다. 별도 직접 Window fixture에서도 `(2050,1)`, `(2050,2)`, `(2044,8)`의 실제 cache miss/hit을 관찰하고 수정 엔진의 행별 logits·체크포인트 배열·다음 토큰 logits 동등성을 확인했습니다. 다만 이 과거 fixture의 전체 빌드 이력 연결은 불완전하고, 원본 기준 엔진은 prefix 실행 중 layer 23에서 슬롯 부족으로 종료했습니다. 따라서 이 결과는 수정 엔진 내부 캐시 일관성의 제한된 증거이지, 해당 경계의 기준/수정 엔진 동등성이나 모든 KV·중간 버퍼 검증은 아닙니다.

후속 도구 시험에서 실제 `no free slot` 오류를 재현했습니다. 8행 × top-10 경로가 최대 80개 expert를 요구하는데 기존 최소 슬롯은 64개였습니다. 필요한 슬롯 수를 도출하도록 수정하고, 예산 부족은 할당 전에 거부하며, 잘못 예측된 진행 중 prefetch의 일시 점유는 현재 행의 pin을 보호한 채 완료를 기다려 회수하도록 보완했습니다. 회귀 테스트와 수정 후 **JSON 5/5·SSE 5/5·실제 함수 도구 왕복 3/3**이 통과했습니다. 이 API 시험은 1024 입력/128 출력 토큰 및 시간 제한 안에서 같은 메모리 감시를 유지했습니다.

최종 일반 빌드에서 실제 `scripts/opencode-strata.sh run`도 검증했습니다. 임시 git 작업 폴더의 단일 fixture 읽기만 허용한 agent가 실제 `read` 호출과 내용에 맞는 최종 답변을 냈고, 클라이언트는 **269.733초**, exit 0으로 종료했습니다. 별도 시험 감독기의 종료 처리 오류는 기능 성공과 구분해 보존했으며, 작은 무모델 회귀 테스트로 수정 확인했습니다. 일반 OpenCode agent 전체나 코딩 속도의 보장은 아닙니다.

최종 빌드에서 실제 생성 내용 수신 후 SSE 연결 취소, 서버의 취소·idle 상태, 정상 후속 응답도 확인했습니다. 워밍업 후 **정확한 1800초 관찰 구간에 364건**, 이미 시작된 마지막 요청을 마친 1807.775초까지 **365건**이 성공했습니다. 서버·엔진 합산 physical footprint의 최대 증가는 **4.52 MiB**였고, 스왑 증가·GPU 오류·엔진 재시작은 없었습니다. RSS와 physical footprint는 따로 측정했습니다.

**미완료:** 지원되는 MPP 하드웨어의 무회귀, 긴 prefix에서 실패한 원본 엔진과의 경계 동등성, 전체 32K 검증. 약 2K/4K 실제 지연으로는 승인된 1800초 이내의 near-32K 실행을 예상할 수 없어 시작하지 않았습니다. 최종 근거는 Strata 작업 세션 `01a13dfe-546a-7313-a4cf-e728b6d21e35`의 `ultragoal/evidence/final-qualification/`에 보존했습니다(`prospective/`, `soak/`, `client/`, `direct/`, `transfer-manifest.json`). 최종 일반 엔진 SHA-256은 `de93e12c7cc75cadeb5f5395ef90e740871d195301e8203f8724d3bdea7fabfe`입니다. 전체 목표나 상시 배포 준비 완료를 주장하지 않습니다.

기존 Ollama 기본값과 `lca chat`, `scripts/opencode-local.sh`는 바꾸지 않습니다. Strata는 upstream commit `296b59d2f73c8f04a805df29c2fa97655adace78`을 `~/.local/share/strata`에 별도로 설치하고, Q2_0·32K 컨텍스트·vision off로 설정해 `127.0.0.1:18080`에서 먼저 실행해야 합니다. 런처는 `/v1/models`에서 첫 text 입력·출력 모델 ID를 찾아 사용합니다. 8080 포트의 다른 서비스는 건드리거나 종료하지 않습니다.

이 Mac 배포는 메모리 압박을 줄이기 위해 `STRATA_METAL_STREAM=1` SSD streaming을 선택하고 MTP를 쓰지 않습니다. 이는 성능 벤치마크 결과나 성능 보장이 아닙니다. 설치 중 인증서 검증 오류가 나면 설치 명령에 `SSL_CERT_FILE="$(.venv/bin/python -m certifi)"`를 지정합니다. macOS 26보다 낮은 SDK로 빌드할 때는 `~/.local/share/strata/metal/src/mtl_rt.mm`의 `Context::supports_metal4()`에서 `MTLGPUFamilyMetal4` 참조를 `#if __MAC_OS_X_VERSION_MAX_ALLOWED >=260000`으로 가드해야 합니다.

```bash
# 충분한 메모리 여유를 확보한 뒤 별도 터미널에서 실행 (전체 실사용 검증 미완료)
~/.local/share/strata/run-q2_0.sh
# 저장소 루트의 다른 터미널에서
scripts/opencode-strata.sh                 # OpenCode TUI
scripts/opencode-strata.sh run "..."        # 나머지 인자를 OpenCode에 그대로 전달
```

런처는 최대 1 MiB·4초 제한으로 `/v1/models`를 확인할 뿐 Strata 설치·다운로드·시작·중지는 하지 않습니다. 발견한 같은 모델 ID를 main/`small_model`/OpenCode `--model`에 쓰고 내장 `task` 위임을 거부합니다. OpenAI 호환 provider는 function tool calling을 켭니다. Strata `/v1/chat/completions`는 OpenAI `tools` 요청을 처리하고 `tool_calls` 응답을 반환하는 경로를 제공합니다. OpenCode `--pure`로 모든 외부 플러그인(전역 oh-my-openagent 및 프로젝트 플러그인 포함)을 끕니다. 전역·프로젝트 설정 전체를 격리하는 것은 아니며, 여기서 덮어쓰지 않은 설정은 적용될 수 있습니다.

필요한 경우 `STRATA_BASE_URL`(loopback `http://127.0.0.1:<port>/v1`만 허용), `STRATA_CONTEXT`, `STRATA_OUTPUT`으로 endpoint와 한도를 덮어쓸 수 있습니다. 기본값은 `http://127.0.0.1:18080/v1`, 32768, 8192입니다. 별도 OpenCode 프로세스나 클라이언트와의 동시 요청을 직렬화하지는 않습니다.

### GJC에서 Strata 선택 사용

이 로컬 환경의 `~/.gjc/agent/models.yml`에 `strata` provider와 프로필을 등록했습니다. 권장 실행은 별도 설정·기록을 사용하는 `~/.gjc/strata-agent/`입니다. 등록만으로 서버가 시작되지는 않으므로 별도 터미널에서 위의 `~/.local/share/strata/run-q2_0.sh`로 `127.0.0.1:18080` 서버를 먼저 시작한 뒤 실행합니다.

```sh
GJC_CODING_AGENT_DIR="$HOME/.gjc/strata-agent" gjc --mpreset strata --thinking off --no-title --no-mcp
```

이 설정은 Chat Completions의 Qwen chat-template에서 non-thinking을 선택합니다. GJC의 기본 첫 응답 제한 100초로는 긴 prefill을 기다릴 수 없어, 전용 설정만 첫 의미 있는 토큰을 최대 30분 기다리도록 하고 자동 재시도는 끕니다. 이는 속도나 성공의 보장이 아닙니다. 전역 프로필만 선택하면 대기 시간이 늘어나지 않으며, 기존 GJC 기본 설정과 Ollama/`gemma-mtp`는 그대로입니다.

`Connection error. (transport=ConnectionRefused url=http://127.0.0.1:18080/v1/chat/completions)`는 Strata 서버가 실행 중이 아니라는 뜻입니다. GJC는 서버를 띄우지 않으므로 다른 터미널에서 `~/.local/share/strata/run-q2_0.sh`를 실행하고 `curl -s http://127.0.0.1:18080/v1/models`가 응답한 뒤 다시 요청합니다.

**제한된 실제 GJC 도구 왕복은 통과했습니다.** 임시 설정 복사본에서 짧은 시스템 프롬프트·`read`만 사용하고 출력은 요청당 128토큰으로 제한했습니다. GJC가 실제 파일을 한 번 읽고, 프롬프트에 넣지 않은 무작위 파일 내용을 정확히 반환했습니다(328.4초, 종료 코드 0; 두 요청의 실제 입력 2456/2558토큰, thinking off). 60초 사전 확인과 1 Hz 감시에서 중단·스왑 증가·정리 오류가 없었고 시험 서버는 종료했습니다. 등록된 문맥 32768·출력 4096은 설정 한도이며, 전체 32K·기본 전체 도구 세션·병렬 하위 에이전트까지 검증한 것은 아닙니다.

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
