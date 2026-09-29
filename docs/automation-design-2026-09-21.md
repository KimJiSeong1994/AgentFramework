# 로컬 코딩 에이전트 설치·설정 자동화 설계

- 일자: 2026-09-21
- 목적: 2026-09-18~21에 수동으로 적용한 Ollama/OpenCode/모델/OMO 설정을 **멱등(idempotent) 설치기 + doctor**로 재현·검증·롤백할 수 있게 한다.
- 근거: 에이전트 팀 3개(현재 상태 감사 / 자동화 방식 설계 / 검증 절차 설계)의 읽기 전용 조사 결과를 종합.

---

## 1. 지금 상태에서 드러난 문제

설치 상태 자체는 정상이고 재부팅 후에도 유지됨을 확인했습니다 (2026-09-21 08:57 재시작 후 LaunchAgent 1회 실행, 서버가 65536/KEEP_ALIVE 무제한을 그대로 읽음). 그러나 자동화 관점에서는 다음이 문제입니다.

| 심각도 | 문제 | 근거 |
|---|---|---|
| 높음 | 컨텍스트 길이 65536이 **4곳에 하드코딩** (ollama-env.sh, opencode-local.sh, opencode.jsonc의 모델 4개, ~/.omo/agent/models.json) | 한 곳만 바꾸면 OpenCode compaction과 서버 컨텍스트가 어긋남 |
| 높음 | 런처의 `LOCAL_MODEL`이 워밍에만 쓰이고 OpenCode에 전달되지 않음 | README의 "LOCAL_MODEL=gemma4:31b-mlx"가 실제로는 26B로 실행됨. **이 문서 작성 시점에 수정 완료** (`--model ollama/$MODEL`, `cd $ROOT` 제거) |
| 높음 | `ollama-env.sh apply`가 이미 반영된 상태에서도 **무조건 앱을 재시작**해 로드된 모델과 프리픽스 캐시를 날림 | 멱등이 아님 |
| 높음 | 신규 머신 미대응: Ollama/OpenCode 미설치 시 오진, 앱 설치 단계 없음, 모델 pull 실패 메시지 없음 | 재현 불가 |
| 중간 | OpenCode 설정을 **다른 도구와 공동 관리**: 09-21에 oh-my-openagent(OMO) 설치기가 `plugin` 키와 `tui.json`을 썼고 `tools.task`가 다시 켜짐. OpenCode 자체도 `$schema`가 없으면 파일을 재작성함 | 전체 덮어쓰기 방식은 위험 |
| 중간 | `set -eo pipefail` 아래 `grep \| tail` 무매치로 `show`가 중단될 수 있음, `pkill` 후 잔존 확인 없음, plist 값 무인용부호 삽입 | 스크립트 결함 |
| 중간 | Ollama 앱 자동 업데이트가 켜져 있음(`auto_update_enabled=1`). `--fast-startup` 없이 앱을 열면(로그인 항목, Finder) 스테이징된 새 버전이 조용히 설치됨 | 버전 핀과 충돌, 환경변수·러너 플래그 재검증 필요 |
| 중간 | 모델 태그 pull은 가중치가 조용히 바뀔 수 있고, digest 지정 pull은 서버·레지스트리 모두 미지원 | 재현성 |
| 낮음 | `ollama ps`가 26B MoE를 1.6GB로 오표시(실제 RSS 17.5GiB). 메타데이터 읽기 오류(`ffn_down_exps size overflows`)가 원인 | 메모리 판단에 `ollama ps` 사용 금지, 스케줄러 과적재 가능 |
| 낮음 | `opencode run`이 stdin이 열린 비TTY 소켓이면 EOF를 기다리며 멈춤 | 비대화식 호출은 `</dev/null` 필수 |

또한 09-21에 추가된 상태도 자동화 대상에 포함해야 합니다: OMO 플러그인(`~/.omo/omo.jsonc`, `~/.omo/agent/settings.json`, `models.json`), Senpi 에디션이 콜론을 thinking 레벨로 해석해 만든 콜론 없는 별칭 `gemma4-26b-mtp`(`ollama cp`), `~/.bun/bin/omo`.

---

## 2. 레이어별 결정

| 레이어 | 결정 | 이유 (검토한 대안) |
|---|---|---|
| Ollama 앱 설치/업그레이드 | **GitHub 릴리스 `Ollama-darwin.zip` 직접 다운로드 + `sha256sum.txt`·`codesign`(TeamID 3MU9H2V9Y9)·`spctl` 검증 + 버전 접미사 백업**. `config/versions.env`에 버전·해시 핀 | brew cask는 같은 zip을 받지만 `auto_updates true`라 핀이 약하고 구버전 설치가 번거로움. brew formula는 GUI 없음 + MLX 자체 패치본. 앱 내장 업데이터는 CLI 트리거 수단이 없음. 백업 이름을 `~/.ollama/backup/Ollama.app`으로 두면 업데이터가 "이전 업그레이드 실패"로 오인하므로 반드시 버전 접미사 |
| 환경변수 영속화 | **현행 `launchctl setenv` + RunAtLoad LaunchAgent 유지**, 재부팅 생존 실증됨. 보강: 이미 반영돼 있으면 재시작 생략, 로그인 자동시작을 켤 경우 LaunchAgent 끝에 `open -j -a Ollama --args --fast-startup`을 붙이는 옵션 | 앱 설정 UI는 `context_length`만 다루고 나머지 4개는 env 전용. 앱은 `os.Environ()` 위에 UI의 `context_length>0`을 덮어쓰므로 doctor가 sqlite를 읽기 전용으로 확인. `ollama serve` LaunchAgent 방식은 메뉴바·업데이터·`ollama launch` UI를 잃고 앱과 포트 충돌 |
| `ollama launch opencode` | **설치 파이프라인에서 사용하지 않음** | 파일을 쓰지 않고 `OPENCODE_CONFIG_CONTENT`로 최상위 오버라이드를 주입해 우리 `model`·`provider.name`을 덮고 `variants`를 추가함. `--config`는 대화형 필수. 사용자가 편의로 쓰는 것은 무해하므로 README에 주의만 기록 |
| OpenCode 설정 | **저장소가 원본을 소유**: `config/opencode/opencode.jsonc`를 git 추적하고 `~/.config/opencode/opencode.jsonc`를 이 파일로 **심볼릭 링크** (기존 파일은 타임스탬프 백업). 컨텍스트 값은 렌더링하지 않고 doctor가 `limit.context == OLLAMA_CONTEXT_LENGTH`를 강제 | JSON merge는 주석을 잃음. 프로젝트 파일은 다른 디렉터리에서 provider가 사라짐. `OPENCODE_CONFIG`는 orca가 이미 `OPENCODE_CONFIG_DIR`를 쓰고 런처 없이 실행하면 무효. 링크면 OMO/OpenCode의 자체 쓰기가 repo 파일에 기록돼 git diff로 보임 |
| 다른 도구 소유 파일 | `tui.json`(OMO), `$OPENCODE_CONFIG_DIR/opencode.json`(orca)은 **읽고 보고만**. `~/.omo/agent/settings.json`은 런타임이 계속 덮어쓰므로 **키 단위 jq 병합만** | 전체 교체 금지 |
| 설치 도구 | **bash 3.2 호환 `scripts/setup.sh` + 서브커맨드** (`install`, `doctor`, `bench`, `models`, `rollback`, `pin`) + `--dry-run`/`--yes`/`--json`. JSONC 파싱·락파일 비교만 `scripts/lib/jsonc.py`(표준 라이브러리). 얇은 `Makefile` 래퍼 | 기존 스크립트가 이미 bash 3.2 호환. `just`·coreutils(`timeout`) 미설치. 타임아웃은 `perl -e 'alarm N; exec @ARGV'`로 통일 |
| 모델 프로비저닝 | **`config/models.lock`(태그 → manifest sha256)** 로 "없으면 pull, 받은 뒤 검증". 갱신은 `models --update`가 `ollama cp`로 스냅샷 별칭을 만든 뒤 pull. small model은 `config/modelfiles/*.Modelfile`에서 `show --parameters`로 검사 후 `ollama create` | 모델 ID = manifest 파일 sha256(`/api/tags`의 digest). digest 지정 pull은 불가(레지스트리 HEAD 404). `ollama create` 재실행은 blob 공유라 비용 미미 |
| OMO 레이어 | **선택 단계(`--with-omo`)** 로 분리. `~/.omo/omo.jsonc`는 repo 템플릿에서 모델 ID를 주입해 렌더링, `settings.json`·`models.json`은 jq 병합 | OMO 미사용 환경에서도 설치기가 동작해야 함 |

---

## 3. 저장소 레이아웃 (제안)

```
AgentFramework/
├── Makefile                          # make setup | doctor | bench | rollback → scripts/setup.sh
├── config/
│   ├── versions.env                  # OLLAMA_VERSION=0.34.2  OLLAMA_DARWIN_ZIP_SHA256=…  OPENCODE_VERSION=1.18.31
│   ├── local-agent.env               # 머신/정책 값 (아래 4절)
│   ├── models.lock                   # gemma4:26b-a4b-it-mtp-q4_K_M  08ae7ec1744b…  18.6GB / gemma4:31b-mlx  a22a3630… / …
│   ├── modelfiles/llama3.2-3b-ctx8k.Modelfile
│   ├── opencode/opencode.jsonc       # ~/.config/opencode/opencode.jsonc 의 원본 (심볼릭 링크 대상)
│   ├── omo/omo.jsonc.tmpl            # (선택) OMO 에이전트→모델 매핑 템플릿
│   └── launchagents/com.local-coding-agent.ollama-env.plist.tmpl
├── scripts/
│   ├── setup.sh                      # install | doctor | bench | models | rollback | pin  [--dry-run] [--yes] [--json] [--runtime]
│   ├── lib/{log.sh,ollama.sh,opencode.sh,models.sh,doctor.sh}   # bash 3.2 호환
│   ├── lib/jsonc.py                  # JSONC 파싱/검증, 락파일 비교
│   ├── opencode-local.sh             # 런처 유지 (사전 점검은 setup.sh doctor --quick 호출로 대체)
│   ├── bench-ollama.sh               # 유지
│   └── local-agent.sh                # Codex용, 범위 밖
└── docs/
```

### 4. 설정 파일 스키마 (`config/local-agent.env`, bash 3.2에서 `source`)

```sh
# 서버
LA_OLLAMA_APP=/Applications/Ollama.app
LA_OLLAMA_HOST=http://127.0.0.1:11434
LA_CTX=65536                 # 64GB/48GiB Metal 기준. auto면 hw.memsize로 산출
LA_KEEP_ALIVE=-1
LA_FLASH_ATTENTION=1
LA_KV_CACHE_TYPE=f16
LA_NUM_PARALLEL=1
LA_LAUNCHAGENT_LABEL=com.local-coding-agent.ollama-env
LA_AUTOSTART_OLLAMA=0        # 1이면 LaunchAgent가 setenv 후 앱을 --fast-startup으로 기동
# 모델
LA_MAIN_MODEL=gemma4:26b-a4b-it-mtp-q4_K_M
LA_QUALITY_MODEL=gemma4:31b-mlx
LA_EXTRA_MODELS="gemma4:31b"
LA_NOTHINK_MODELS="gemma4:31b-mlx gemma4:31b"
LA_SMALL_BASE=llama3.2:3b
LA_SMALL_MODEL=llama3.2:3b-ctx8k
LA_SMALL_CTX=8192
LA_OUTPUT_LIMIT=8192
LA_MODEL_ALIASES="gemma4:26b-a4b-it-mtp-q4_K_M=gemma4-26b-mtp"
# OpenCode / OMO
LA_OPENCODE_CONFIG_MODE=symlink   # symlink | copy
LA_TASK_POLICY=omo                # off | omo (omo면 plugin 존재 + concurrency 1 요구)
LA_WITH_OMO=1
```

이 파일 하나에서 plist, 환경변수, Modelfile, 락파일 검증값, OMO 템플릿이 모두 나오고, `opencode.jsonc`는 doctor가 값 일치를 검사합니다.

---

## 5. `install` 실행 순서 (각 단계 "검출 → 다르면 변경 → 확인")

1. 도구 확인: curl, jq, sqlite3, perl, plutil, python3. 없으면 Xcode CLT 안내.
2. Ollama 앱: `Info.plist` 버전 == 핀이면 건너뜀. 아니면 zip 다운로드(캐시된 업데이터 zip이 같은 해시면 재사용) → sha256 → codesign/spctl → 앱 종료(pgrep 루프로 잔존 확인) → `~/.ollama/backup/Ollama-<old>.app` 이동 → `ditto -xk` → `open -a /Applications/Ollama.app` → `/api/version` 대기. sudo 불필요(앱이 사용자 소유, CLI 심링크는 경로 유지).
3. 환경변수: `launchctl setenv` 5개, plist 렌더 후 `cmp`로 다를 때만 교체·`bootstrap`. **서버 프로세스의 실효 env(`ps -E`)가 이미 일치하면 재시작 생략**, 아니면 재시작 후 `server config` 로그로 확인.
4. 모델: 락파일 순회. `ollama show`로 존재 확인 → 없으면 `/api/pull` 스트리밍(진행률) → manifest sha 비교. small model은 `show --parameters`에 `num_ctx 8192` 없을 때만 `ollama create -f <임시파일>`. 별칭은 `/api/tags` digest 비교 후 `ollama cp`.
5. OpenCode: `opencode --version` ≥ 핀. `~/.config/opencode/opencode.jsonc`가 링크가 아니면 타임스탬프 백업 후 링크. 기존 파일의 `plugin` 배열과 알 수 없는 최상위 키가 repo 원본에 없으면 경고(수동 병합 유도).
6. (선택) OMO: `~/.bun/bin/omo` 존재 확인, `omo.jsonc` 렌더, `settings.json`/`models.json` jq 병합(모델 ID, contextWindow=LA_CTX).
7. `doctor` 정적 검사 → `pin`으로 `~/.local/state/local-coding-agent/expected.json` 갱신.

`rollback --ollama <ver>`는 앱 종료 → 번들 스왑 → 기동, `rollback --opencode`는 링크 제거 후 최신 백업 복원.

---

## 6. `doctor` 설계 요약

세 층으로 나눕니다. **S(정적, GPU 미사용, 3~6초)** 는 항상, **G(회귀 가드)** 는 S의 조합, **R(런타임, GPU 사용, 1~2분)** 은 `--runtime` 옵트인.

핵심 검사 (전체 카탈로그는 에이전트 보고서 기준 S01~S31, R00~R10, G1~G9):

| 구분 | 검사 | 판정 소스 |
|---|---|---|
| 버전 | plist / `/api/version` / CLI 세 값 일치, 핀과 비교(불일치 = 드리프트 경고) | S02 |
| env 3중 교차 | `launchctl getenv` ↔ **서버 프로세스 실효 env(`ps -p PID -E`)** ↔ `server.log` "server config" | S06~S08. `KEEP_ALIVE=-1`은 로그에 `2562047h47m…`로 표시 |
| LaunchAgent | `launchctl print`의 `last exit code = 0`, `state = not running`은 정상 | S10 |
| 모델 | 4개 존재, 양자화(26B Q4_K_M, 31b-mlx nvfp4), small model `num_ctx 8192`, 락파일 digest 일치, 별칭 digest 일치 | S11~S14 |
| MTP 정적 증거 | 26B manifest의 `image.draft` 레이어 + `draft_num_predict 3`; 31b-mlx의 `draft.*` 텐서 | S12 |
| 러너 플래그 | llama-server cmdline: `-c 65536 -np 1 --flash-attn on --cache-type-k f16`, 26B는 `--spec-type draft-mtp` | S24 (GPU 없이 MTP 활성 확정) |
| OpenCode | `opencode debug config --pure`로 해석된 값: model/small_model/limit/reasoningEffort/plugin/tools.task 정책 | S16~S19 |
| 업데이터 | sqlite `auto_update_enabled`, 앱보다 새 스테이징 zip, app.log | S29 (드리프트 예고) |
| 런타임 | 로드 후 ctx 65536/Forever, 로그 블록에서 `draft-mtp` 초기화, 생성 tok/s 임계(26B ≥ 50, 31b-mlx ≥ 22), `/v1` thinking on/off, 6K 프리픽스 2회차 < 0.5초, small model RSS < 4GiB, `opencode run --pure` e2e(`</dev/null`, 120초), 툴 호출 1회, **종료 시 로드 상태 복원** | R01~R10 |

출력은 `[PASS/WARN/FAIL/SKIP] id 이름  관측값 (기대값)  fix: <서브커맨드>` 한 줄 형식, `--json`은 단일 객체. 종료 코드 0/1(strict WARN)/2(FAIL)/3(선행 실패)/4(상태 복원 실패).

주의 규칙: 무인 모드에서는 OpenCode가 사용 중이면 R 전체 SKIP(단일 슬롯이라 시간 측정이 오염됨). 메모리 판단은 `ollama ps`가 아니라 러너 RSS. `opencode run`은 항상 `</dev/null` + alarm.

---

## 7. 리스크와 대응

1. **앱 자동 업데이트 vs 버전 핀**: 설정 UI에서 자동 업데이트를 1회 수동으로 끄는 것을 권장(sqlite 직접 수정은 비공식이라 하지 않음). doctor가 켜짐/스테이징 zip을 경고하고, 업그레이드를 수락하면 `doctor --runtime && pin`으로 재검증.
2. **앱 UI의 context_length 슬라이더**가 env를 덮어씀: doctor가 sqlite 값 0을 확인.
3. **로그인 자동시작 순서 경합**: 현재는 꺼져 있어 무관. 켜면 `LA_AUTOSTART_OLLAMA=1`로 LaunchAgent가 앱 기동까지 맡게 함.
4. **`ollama launch opencode`** 사용 시 `model` 오버라이드·`variants` 추가: README에 기록.
5. **심볼릭 링크 설정**: OMO/OpenCode의 자체 쓰기가 repo 파일을 더럽힘(의도된 가시성). 원치 않으면 `LA_OPENCODE_CONFIG_MODE=copy`.
6. **Gatekeeper/sudo**: curl 다운로드는 quarantine이 붙지 않고 앱은 사용자 소유라 둘 다 불필요.
7. **26B 메모리 오표시**: 26B + 31b-mlx 동시 적재 시 스케줄러가 과적재할 수 있음. doctor가 러너 RSS 합 ≤ 40GiB를 경고.

---

## 8. 구현 계획

| 단계 | 내용 | 산출물 |
|---|---|---|
| 1 | `config/` 도입(versions.env, local-agent.env, models.lock, Modelfile, opencode.jsonc 이관), `setup.sh` 골격 + `doctor` 정적 검사, 기존 스크립트 결함 수정(무조건 재시작, pipefail, pkill 잔존, plist 인용) | `make doctor`가 현재 머신에서 전부 PASS |
| 2 | Ollama 앱 설치/업그레이드/롤백, 모델 락 동기화, OpenCode 링크, `pin` | 새 머신 재현 가능 |
| 3 | `doctor --runtime`(R 스위트 + 상태 복원), `bench` 통합, OMO 선택 단계 | 성능 회귀 탐지 |
| 4 | launchd 주기 실행(`doctor --ci --json`, 1시간 간격으로 업데이터 주기와 맞춤), README 갱신 | 드리프트 1시간 내 탐지 |

검증하지 못한 항목: `ollama create -f -`(stdin) 지원 여부(임시파일 사용으로 회피), MLX 러너 프로세스명(31b-mlx 적재 시 확정 필요), `sfltool dumpbtm`이 항상 sudo 없이 동작하는지.
