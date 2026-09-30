# Ubuntu 자동 설치 가이드 (ubuntu/setup.sh)

macOS에서 수동으로 적용했던 Ollama + OpenCode + Gemma 4 설정을 **Ubuntu 22.04/24.04(systemd)** 에서 한 번의 명령으로 재현·검증하는 스크립트입니다. 모든 단계는 멱등이라 여러 번 실행해도 차이만 반영합니다.

## macOS 와의 차이

| 항목 | macOS (이 저장소의 scripts/) | Ubuntu (ubuntu/setup.sh) |
|---|---|---|
| Ollama 설치 | Ollama.app 번들 교체 | `install.sh` + `OLLAMA_VERSION` 핀 → systemd `ollama.service` (User=ollama) |
| 환경변수 영속화 | `launchctl setenv` + LaunchAgent | `/etc/systemd/system/ollama.service.d/10-local-agent.conf` (`Environment=`) |
| GPU | Metal 통합 메모리 48GiB 한도 | NVIDIA CUDA. `nvidia-smi` VRAM 합계로 컨텍스트 자동 결정 |
| 러너 | MLX 러너(`*-mlx`, nvfp4) 사용 가능 | **MLX 태그 사용 불가.** GGUF만. 26B MoE는 GGUF에 MTP 드래프터가 내장돼 llama.cpp `draft-mtp`로 동작, 31B dense GGUF는 MTP 없음 |
| 실효 env 확인 | 서버 로그 | `/proc/<MainPID>/environ` + `journalctl -u ollama` |

## 사용법

```bash
git clone <this repo> && cd AgentFramework
vi ubuntu/config/local-agent.env        # 필요 시 버전/모델/컨텍스트 조정
ubuntu/setup.sh install --dry-run       # 무엇을 바꿀지 먼저 확인
ubuntu/setup.sh install                 # deps → ollama → env → models → opencode → doctor
ubuntu/setup.sh doctor --runtime        # GPU 를 써서 속도/thinking/캐시/OpenCode e2e 까지 검사
ubuntu/setup.sh bench                   # 상세 벤치 (scripts/bench-ollama.sh 재사용)
ubuntu/setup.sh status
```

단계별: `deps`, `ollama`, `env`, `models`, `opencode`, `env-remove`(drop-in 제거). 옵션: `--dry-run`, `--yes`, `--config <file>`, `--json`(doctor), `--runtime`(doctor).

## 설정 (`ubuntu/config/local-agent.env`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `LA_OLLAMA_VERSION` / `LA_OPENCODE_VERSION` | 0.34.2 / 1.18.31 | 빈 값이면 최신. 다르면 재설치 |
| `LA_CTX` | auto | VRAM ≥40GiB→65536, ≥20GiB→32768, 그 외 16384, GPU 없음→8192. Ollama 기본값은 VRAM≥48GiB면 262144(KV 20GB+ 예약) |
| `LA_KEEP_ALIVE` | -1 | 언로드 금지 → 프리픽스 캐시 유지 |
| `LA_FLASH_ATTENTION` / `LA_KV_CACHE_TYPE` / `LA_NUM_PARALLEL` | 1 / f16 / 1 | q8_0는 생성 -9~15%, parallel>1은 캐시 히트율 저하 |
| `LA_MAIN_MODEL` | gemma4:26b-a4b-it-mtp-q4_K_M | 기본 모델 (thinking `LA_MAIN_THINKING`) |
| `LA_EXTRA_MODELS` | gemma4:31b | 추가 모델(공백 구분, thinking `LA_EXTRA_THINKING`) |
| `LA_SMALL_BASE` / `LA_SMALL_MODEL` / `LA_SMALL_CTX` | llama3.2:3b / llama3.2:3b-ctx8k / 8192 | 제목 생성용. Modelfile로 num_ctx 고정 |
| `LA_MODEL_ALIASES` | (없음) | `원본=별칭` 목록. 콜론 없는 이름이 필요한 도구용 (`ollama cp`) |
| `LA_TASK_TOOL` / `LA_OPENCODE_PLUGINS` | false / (없음) | OpenCode task 툴, 플러그인 목록 |
| `LA_MIN_TOKPS` / `LA_E2E_TIMEOUT` | 20 / 180 | doctor 런타임 임계값 |

컨텍스트 길이는 이 파일 한 곳에서만 정하고, systemd drop-in과 OpenCode의 `limit.context`는 여기서 렌더링됩니다. doctor가 두 값의 일치를 검사합니다.

## 각 단계가 하는 일

1. **deps**: `curl jq python3 ca-certificates` apt 설치, `nvidia-smi`로 VRAM 감지(없으면 CPU 경고).
2. **ollama**: `ollama --version`이 핀과 다를 때만 `install.sh`를 `OLLAMA_VERSION=<핀>`으로 실행. systemd가 없으면(WSL/컨테이너) 수동 실행 명령을 안내.
3. **env**: drop-in 파일을 렌더링해 내용이 다를 때만 씀. 그 다음 **실행 중인 프로세스의 실효 env**(`/proc/PID/environ`)와 비교해 다를 때만 `daemon-reload` + `restart`. 이미 일치하면 재시작하지 않아 로드된 모델과 캐시를 보존.
4. **models**: `ollama show`로 존재 확인 후 없는 것만 pull. small model은 `--modelfile`에 `PARAMETER num_ctx`가 없을 때만 `ollama create`. 별칭은 digest 비교 후 `ollama cp`. `config/models.lock`(선택, `이름 digest12`)이 있으면 digest 드리프트 경고.
5. **opencode**: 버전 핀 확인 후 필요 시 `install | bash -s -- --version`. 설정을 렌더링해 기존 파일과 다를 때만 타임스탬프 백업 후 교체. 이 스크립트가 만들지 않은 설정이면 확인을 요구(`--yes`로 생략).
6. **doctor**: 아래 표.

## doctor 검사 항목

| id | 내용 | 실패 시 |
|---|---|---|
| S01 | curl/jq/python3 | `setup.sh deps` |
| S02 | ollama CLI/서버 버전 일치, 핀 비교 | `setup.sh ollama`, 드리프트면 restart |
| S03 | `ollama.service` active | `systemctl enable --now ollama` |
| S04 | drop-in 내용 일치 | `setup.sh env` |
| S05 | 프로세스 실효 env 5개 일치 | `setup.sh env` |
| S06 | `journalctl` "server config"의 CONTEXT_LENGTH | `setup.sh env` |
| S07/S08 | 모델 존재, small model num_ctx 고정 | `setup.sh models` |
| S09 | 기본 모델에 `draft_num_predict`(MTP 드래프터) | MTP 태그 확인 |
| S10 | 로드된 모델 중 ctx 262144 없음 | `setup.sh env` |
| S11 | 러너 cmdline에 `--spec-type draft-mtp`, `-c <ctx>` | (정보) |
| S12~S16 | OpenCode 설치, 설정 파싱, model/small_model/limit.context/thinking 일치 | `setup.sh opencode` |
| S17 | 10분 이상 멈춘 `opencode run` 없음 | kill (비대화식은 `</dev/null` 필수) |
| S18 | 디스크 여유 ≥ 25G | 모델 정리 |
| R01 | 기본 모델 로드 후 ctx == 설정값 (digest로 판정, 별칭 포함) | `setup.sh env` |
| R02 | 생성 속도 ≥ `LA_MIN_TOKPS` | GPU 오프로드/MTP 확인 |
| R03 | 저널의 MTP 수락률 | (정보) |
| R04 | `/v1` thinking 기본 ON, `reasoning_effort=none`이면 OFF | `setup.sh opencode` |
| R05 | 동일 프리픽스 2회차 prompt_eval < 0.5초 | `setup.sh env` |
| R06 | `opencode run --pure "Reply with exactly: OK" </dev/null` 이 제한 시간 내 완료 | `setup.sh opencode` |
| R07 | 검사 전후 로드 상태 변화 안내 | `ollama stop` |

종료 코드: 0 = FAIL 없음, 2 = FAIL 있음. `--json`은 단일 JSON 객체를 출력합니다.

## 검증 상태 (2026-09-21)

- **이 저장소를 만든 Mac에는 Docker/VM이 없어 Ubuntu에서의 엔드투엔드 실행은 아직 하지 않았습니다.** 대신 다음을 확인했습니다: bash 문법 검사, `install --dry-run` 전체 경로 실행, `doctor --runtime`을 Mac의 실제 Ollama 0.34.2에 대고 실행해 API 기반 검사(모델, 로드 ctx, 러너 플래그, 생성 속도 68.8 tok/s, thinking 토글, 프리픽스 캐시 0.04초, OpenCode e2e 15초)가 모두 PASS. systemd/journal 검사는 Mac에서 SKIP.
- Ubuntu에서 처음 실행할 때 확인할 것: `sudo` 비밀번호 프롬프트(`--yes`는 확인만 생략), `~/.opencode/bin` PATH 추가 후 새 셸, `nvidia-smi`가 보이는지, 26B pull(18GB) 시간.
- WSL2에서는 systemd를 켜야 drop-in 방식이 동작합니다. 아니면 `env` 단계가 출력하는 변수를 export 하고 `ollama serve`를 직접 실행하세요.
