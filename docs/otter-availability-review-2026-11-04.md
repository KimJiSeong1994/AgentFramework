# otter 가용성 점검·고도화 — 2026-11-04

기준: master `c703a06`(브랜치 `feat/otter-availability-hardening`). 참조 프레임워크 4종(OMC·OMO·OMX·GJC)의 구성요소를 읽기 전용으로 심층 검토하고, otter의 실제 동작 제약을 코드 위치와 함께 감사한 뒤, 가장 체감이 큰 가용성 결함을 코드로 고쳤다. 상세 보고서는 [`docs/reviews/2026-11-04/`](reviews/2026-11-04/)에 있다.

| 보고서 | 내용 |
|---|---|
| [otter-limits-audit.md](reviews/2026-11-04/otter-limits-audit.md) | otter 제약 전수 목록(영역별, `file:line`), README-코드 불일치, 설정 상태 문제, 체감 Top 10 |
| [omc-review.md](reviews/2026-11-04/omc-review.md) | oh-my-claudecode 5.7.31 인벤토리·가용성 판정·OMC 자체가 겪은 문제·추천 5 |
| [omo-review.md](reviews/2026-11-04/omo-review.md) | oh-my-openagent 5.1.60(설치본 4.19.4) 인벤토리·**설치 충돌 실측**·추천 5 |
| [omx-review.md](reviews/2026-11-04/omx-review.md) | oh-my-codex 0.21.6 인벤토리·**otter Codex 프롬프트 누수 실측**·추천 5 |
| [gjc-review.md](reviews/2026-11-04/gjc-review.md) | GJC 0.18.0(바이너리) 관찰 가능한 기능·세션 데이터 활용 가능성·추천 5 |

## 요약

1. **Codex 엔진이 이 머신에서 전면 불가였다.** 설치된 Codex CLI 0.165.0이 otter 승인 목록(0.159.3, 0.163.0)에 없어 사용자 기본 모델 `codex/gpt-6-astra`와 콤보 프리셋 4종 모두 시작 시 거부됐다(`framework/src/hosts/codex-profile.ts`, `cli-transport.ts:947`). → 0.165.0을 적격 처리했다(아래 §3-1).
2. **Codex 0.165.0은 otter의 격리 플래그를 뚫고 외부 지시문을 모델에 넣는다.** `--ignore-user-config`·`project_doc_max_bytes=0`에도 `~/.codex/AGENTS.md`(OMX가 설치한 25 KB "허락 묻지 말고 자율 실행")가 user 메시지로, `~/.codex/skills`의 OMX 스킬 24개 목록이 developer 메시지로, 권한 프로파일 설명이 또 하나의 developer 메시지로 **매 호출** 들어갔다(합계 ≈9K 토큰, 승인 계약과 정면 충돌). → otter 소유 CODEX_HOME + 설정 키 2개로 제거했다(§3-2). 호출당 고정 오버헤드는 약 10.6K자에서 약 1K자(otter 지시문)로 줄었다.
3. **OpenCode 경로에서 OMO가 otter를 밀어낸다.** 전역 플러그인 OMO 4.19.4가 otter보다 먼저 로드돼 `default_agent`를 Sisyphus로 바꾸고, otter의 main/worker/reviewer에 OMO 도구 10개를 끼워 넣어 reviewer의 읽기 전용 계약을 깼다(doctor D09b FAIL). → otter 설정 훅이 OMO 도구를 거부하고 `default_agent`를 되찾도록 했다(§3-3). 플러그인 목록 자체는 건드리지 않는다.
4. **README가 코드와 어긋난 곳**: 읽기 전용 명령 자동 허용(커밋 `11c9de8`에서 제거됐으나 문서에 남음), 콤보 템플릿 표(3행·모델명 불일치), ask 모드 도구 목록, `memory.prefetch` 기본값 주석. → 모두 코드 기준으로 고쳤다.
5. **참조 프레임워크의 핵심 메커니즘은 대부분 otter에 축소판으로 이미 있다.** 키워드 감지·sanitizer, idle 루프 브레이커, 반복 호출 차단, 체크포인트/`/undo`, 역할·콤보 라우팅, 세션 다이제스트→위키. 이식 가치가 있는 것은 §4의 권고로 남겼고, tmux 팀·백그라운드 병렬·LSP 데몬·MCP 자동 로드·바이너리 다운로드형 기능은 otter의 전제(원샷 CLI·단일 Ollama 슬롯·무의존·행동별 승인)와 맞지 않아 이식 대상이 아니다.

## 1. 참조 프레임워크 가용성 판정 (요약)

| 프레임워크 | 이 머신 상태 | otter와의 간섭 | 이식 가치 높음 | 이식 불가·불필요 |
|---|---|---|---|---|
| **OMC** 5.7.31 (Claude Code 플러그인) | 미설치(클론 검토) | 없음 | 엔진 실패 분류+전환 제안, CLI 채팅 미완료 이어가기, 파괴적 git 규칙 제외, notepad 우선 컨텍스트, 상태줄 예산 표시 | Claude Code 훅 수명주기, CLAUDE.md 오버레이, tmux 팀, rate-limit 데몬, Jev, 에이전트 19종 |
| **OMO** 4.19.4 설치 / 5.1.60 업스트림 (OpenCode 플러그인) + Senpi | 전역 `plugin[]`에 로드됨 | **있음**: default_agent 탈취, 도구 10개 주입, `ulw` 키워드·idle 재프롬프트 이중 발화 | read-before-overwrite 가드, 경로 범위 규칙 주입, 턴 단위 think 토글, 엔진 오류 분류, 해시 앵커 편집(opt-in) | 백그라운드 병렬·team, `call_omo_agent`/`session_*`, tmux `interactive_bash`, LSP·ast-grep·ripgrep 다운로드, memory-core |
| **OMX** 0.21.6 (Codex CLI 플러그인) | 설치, `~/.codex`에 훅·AGENTS.md·스킬 24개 | **있음**: 훅은 `--ignore-user-config`로 차단되나 AGENTS.md·스킬이 프롬프트로 누수(§3-2에서 해결) | 도구 루프 지문 가드, 사용량 기록+검색, 문서 갱신 규칙, 승인 대기 알림 | 네이티브 goal·서브에이전트·MCP·team(tmux)·sidecar·Rust 크레이트 |
| **GJC** 0.18.0 (폐쇄 바이너리) | 설치, 프로젝트 `.gjc/`에 세션 370개 | 없음(`.gjc/`는 보호 디렉터리) | GJC 세션 임포터(이력→자산), 프로필 레지스트리+effort·폴백 체인, 사용량·비용 기록, 크래시 저널, 세션 제목·포크 | MCP 자동 로드, PTY bash, 상주 브로커 |

## 2. otter 실제 동작 제약 (체감 Top 10, 감사 결과)

| # | 제약 | 위치 | 상태 |
|---|---|---|---|
| 1 | Codex 0.165.0 미지원 → 기본 엔진 시작 불가 | `codex-profile.ts:16` | **해결** |
| 2 | 모든 명령이 승인 필요(읽기 전용 자동 허용 제거) + README 모순 | `chat-actions.ts`, `11c9de8` | 정책 유지, README 정정 |
| 3 | 응답당 도구 1개, 턴당 24라운드(main 3회 연장) | `cli-host.ts:59-61, 1413` | 읽기 전용 묶음 실행으로 완화(§7) |
| 4 | 입력 예산 vendor 49K·Gemma 휴리스틱, 벤더 usage 폐기 | `cli-host.ts:51-58`, `cli-transport.ts:35-42` | 미해결(§4 P1) |
| 5 | Codex/Claude 네이티브 기능 전부 OFF(세션·캐시 연속성 없음) | `cli-transport.ts:445-462` | 설계 유지 |
| 6 | 엔진 폴백·재시도 없음 | `cli-host.ts:263, 1314` | 미해결(§4 P1) |
| 7 | edit는 정확 1회 일치 치환만 | `cli-tools.ts:463-469` | 미해결(§4 P2) |
| 8 | 로컬 thinking 강제 OFF | `cli-transport.ts:466` | 미해결(§4 P2) |
| 9 | 매 main 턴 memory prefetch(haiku 1회) | `config.ts:387` | 주석 정정, 기본값 유지 |
| 10 | 프로젝트 `.otter/otter.jsonc`의 `skill_router`·`skills.allow`는 OpenCode 전용 키 | — | 안내 |

전체 목록(실행/승인·도구·예산·엔진·워크플로·스킬·세션·설정 권한·플랫폼)은 [otter-limits-audit.md](reviews/2026-11-04/otter-limits-audit.md).

## 3. 이번에 고도화한 것

### 3-1. Codex 0.165.0 적격 처리
- `CODEX_SUPPORTED_VERSIONS`에 0.165.0 추가. 번들 카탈로그 비교: 슬러그는 0.159.3 핀 11개 + `gpt-6.1-terra`(신규) , 키 5개 추가, 삭제 없음 → 핀 카탈로그 그대로 유효(`codex debug models --bundled`로 확인). `exec` 플래그 전부 존재.
- 네이티브 적격 테스트(`OTTER_NATIVE_CODEX_TEST=1 bun test test/codex-native.test.ts`, 로컬 픽스처·격리 홈·자격 증명 미사용) 통과: `tools: []`, otter 지시문 전달.
- `otter engines`: `codex: 0.165.0 (otter-supported)`.

### 3-2. Codex 프롬프트 누수 차단 (otter 소유 CODEX_HOME)
- 새 모듈 `framework/src/hosts/codex-home.ts`: `$XDG_STATE_HOME/otter/codex-home`(또는 `OTTER_STATE_HOME`)에 `auth.json → <실제 CODEX_HOME>/auth.json` 심볼릭 링크만 두는 홈을 만들고 추론 프로세스의 `CODEX_HOME`으로 넘긴다(`vendor-process.ts` `codexHome` 옵션). Codex는 링크를 통해 토큰을 갱신한다(`codex login --with-api-key`로 확인). `auth.json`이 일반 파일이 되거나 `AGENTS.md`/`config.toml`/`hooks.json`/`rules`가 생기면 실행을 거부한다.
- 0.165.0에 한해 `-c skills.include_instructions=false`, `-c include_permissions_instructions=false`를 추가(`CODEX_PROMPT_OPT_OUT_VERSIONS`). 와이어 캡처로 확인: AGENTS.md·스킬·권한 설명 메시지 모두 사라지고 otter 지시문(2회, 원인 미확인 ≈260토큰)과 사용자 메시지만 남는다. 네거티브 컨트롤(옵트아웃 제거 시 누수 재현) 통과.
- 테스트: `test/codex-home.test.ts`(신규), `cli-transport.test.ts`(0.165.0 argv·CODEX_HOME 단언), `codex-native.test.ts`(AGENTS.md·스킬·권한 누수 부재 단언).

### 3-3. OpenCode 경로: OMO 공존 방어
- `hooks/config.ts`: OMO가 로드되면 otter 에이전트의 permission에 `OMO_TOOL_DENIES`(session_*, call_omo_agent, interactive_bash, look_at, skill_mcp, hashline_edit, lsp_*, codegraph_*, goal_*, team_*, monitor_* …)를 deny로 넣고, OMO가 바꾼 `default_agent`(Sisyphus)를 `main`으로 되돌린다. 사용자가 명시한 다른 값은 유지.
- doctor: D09b FAIL → PASS, D05a `default_agent=main`. D05c(OMO 동시 로드 경고)는 정보성으로 남겨 둔다.
- doctor D09b가 otter 자체 도구 `otter_flow`를 외부 도구로 오인하던 것을 수정.

### 3-4. 승인 규칙: 파괴적 명령은 "항상 허용" 불가
- `chat-actions.ts` `alwaysAsk()`: 재귀 삭제(`rm -r`), `git reset --hard|--merge`, `git clean`, `git checkout`/`restore`의 경로 복원, `git branch -D`, `git stash drop|clear`, `git push --delete`는 규칙을 제안하지도, 저장된 규칙(`rm`, `git checkout` 등)에 매치되지도 않는다. 매번 사람이 결정한다(OMC `git-guardrails` 차용).

### 3-5. 문서·설정 정합성
- README: 읽기 전용 자동 허용 문구 삭제(현 정책 서술), ask/plan 도구 목록에 `multiread`·`skill`, 콤보 템플릿 표 4행으로 코드와 일치, 0.165.0·소유 홈 설명 추가.
- `config.ts` `memory.prefetch` 주석을 기본값(on)과 일치.
- OpenCode 핀 1.18.32 → 1.18.35(설치본과 일치; doctor D12e PASS). `.opencode/skills/plan`·`ulw` 설명에 트리거 문구(doctor D13).
- `test/review2.test.ts`가 `XDG_STATE_HOME`에 문자열 "undefined"를 남겨 `framework/undefined/otter/…`를 만들던 문제 수정.

### 3-6. 승인 규칙의 워크트리 범위 지정
- `chat.allow` 항목이 문자열(어디서나) 또는 `{ "command", "worktree" }`(그 워크트리에서만)를 받는다. 승인 메뉴가 "Always allow `rule` in this worktree" / "… everywhere"를 따로 제안하고, `/permissions`가 범위를 함께 보여 준다. 인터프리터 인라인 코드(`python3 -c`, `node -e`, `sh -c`)는 규칙을 제안하지도 매치되지도 않는다.
- 사용자 설정의 `python3` 규칙을 이 저장소 워크트리로 한정했다(결정 사항 3).

### 3-7. 검증
- 변경 전 전체 스위트: 3,668 pass / 0 fail / 33 skip (202파일, 19분).
- 변경 후 영향 스위트: codex-profile·cli-transport·codex-home·cli-host·engine-auth·vendor-process·chat-actions·config-hook·opencode-* 전부 통과, `tsc --noEmit` 오류 0.
- 변경 후 전체 스위트: 3,677 pass / 0 fail / 33 skip (203파일, 18.5분). 중간 실행에서 실패한 4건은 모두 테스트에 하드코딩된 옛 값(doctor 핀 1.18.32, "supported: 0.159.3, 0.163.0" 메시지)이었고 현재 값으로 갱신했다.
- doctor: 21 pass/3 warn/1 fail → 24 pass/1 warn/0 fail(남은 WARN은 외부 스킬 typesafe-ai 설명 문구).

## 4. 남은 권고 (우선순위)

| 순위 | 항목 | 출처 | 크기 | 메모 |
|---|---|---|---|---|
| P0 | 사용자 설정 정리(§5) | 감사·OMX | — | 코드 밖. 사용자 확인 후 |
| P1 | ~~벤더 usage 기록 → 다이제스트·`/status`·`/usage`~~ | 감사·OMX·GJC | S | **완료(§7)** |
| P1 | ~~엔진 실패 분류 + "이 턴을 다른 엔진으로" 제안(조용한 교체 없음)~~ | OMC·OMO·로드맵 3-A | M | **완료(§7)** |
| P1 | ~~엄격 엔벨로프 안의 읽기 전용 도구 배열 순차 실행~~ | 감사 | M | **완료(§7)**; main 기본 라운드 상향은 미적용 |
| P1 | ~~도구 루프 지문 가드~~ | OMX | S | **이미 있음**: 공용 실행 정책의 `RepeatGuard`(`hosts/tool-policy.ts:128-171`, `guards.repeat_limit`)가 CLI 경로에도 적용됨 |
| P1 | ~~상태줄 입력 예산 사용률·툴 카운터~~ | OMC | S | **완료(§8)** |
| P2 | ~~read-before-overwrite 가드~~ | OMO | S | **완료(§8)** |
| P2 | ~~로컬 think 토글~~ | OMO | S | **완료(§8)**: `/local think on|off`(세션·턴 단위 키워드 대신 설정 토글) |
| P2 | 엔진별 토큰 계수 + usage 보정, vendor 예산 상향 | 감사 | M | 미적용(비용·품질 결정 필요; 이제 `/usage`로 실측 가능) |
| P2 | CLI 채팅 "미완료 이어가기" | OMC | M | 해당 없음: CLI 채팅에는 todo 도구가 없음 |
| P2 | GJC 세션 임포터 | GJC | M | 보류: 포맷이 추론치이고 표본 세션에 `token-logs`·`audit.jsonl`이 없어 스키마 확정 후 진행 |
| P2 | 크래시 저널·오류 지문 / 세션 제목·포크 | GJC | S–M | 실패 기록은 **완료(§8)**(다이제스트 `failures`); 제목·포크는 보류 |
| P2 | ~~edit occurrence 인자~~ | 감사·OMO | M/L | **완료(§8)**: `occurrence`·`replaceAll`; 해시 앵커는 보류 |
| P2 | ~~GitHub Actions CI(샤딩)~~·릴리스 요약 | 로드맵 5 | M | CI **완료(§8)**; 릴리스 요약은 보류 |

## 5. 사용자 환경 변경 (사용자 승인 후 2026-11-04 적용, 백업 `*.backup-20261104-*`)

1. `~/.config/otter/otter.jsonc` `skill_trust`에서 `~/.codex/skills` 제거(OMX 스킬 24개가 동의 없이 로드되던 상태 해소). `~/.gjc/agent/skills`, `~/.gjc/skills`는 존재하지 않는 경로라 그대로 둠.
2. `~/.config/opencode/opencode.jsonc` 전역 `plugin[]`에서 `oh-my-openagent@latest` 제거(doctor D05c PASS, `ulw`·idle 이중 발화 해소). 다른 프로젝트에서 필요하면 그 프로젝트의 `.opencode/opencode.jsonc`에 추가. 설치본 4.19.4는 업스트림 5.1.60 대비 오래됨.
3. `chat.allow`의 `python3`를 `{ "command": "python3", "worktree": "/Users/gimjiseong/orca/projects/AgentFramework" }`로 한정(§3-6).
4. OMX의 `~/.codex/AGENTS.md`·훅은 otter 추론에 더 이상 닿지 않지만, 사용자가 직접 쓰는 `codex` TUI에는 그대로 적용된다.

## 6. 미확인·한계

- 0.163.0에서도 같은 누수가 있었는지(미설치라 미측정). 새 설정 키는 0.165.0에만 내보낸다.
- otter 지시문이 developer 메시지로 2회 들어가는 원인(`instructions`·`developer_instructions` 설정으로는 제거 불가, ≈260토큰).
- Codex 토큰 갱신(ChatGPT 로그인)이 항상 심볼릭 링크를 통해 쓰는지는 API 키 로그인 경로로만 확인했다. 링크가 일반 파일로 바뀌면 otter가 거부하고 안내한다.
- `.agents/skills/typesafe-ai`의 설명은 외부 스킬이라 손대지 않았다(D13 WARN 잔존).

## 7. 후속 반영 (2026-11-04, 브랜치 `feat/otter-p1-recommendations`)

§4의 P1 세 항목을 구현했다. 모두 "사람이 결정한다"와 "메타데이터만 기록한다" 원칙을 지킨다.

1. **벤더 사용량 기록**. 전송 계층이 이미 파싱하던 Codex `turn.completed`·Claude `result` 토큰 수를 `model-returned` 활동(엔진·모델·숫자만)에 실어 턴 타이밍 레코드의 모델 항목에 남기고, 세션 다이제스트가 전체·`엔진/모델`별로 합산한다. `/usage`와 `/status` 끝에 세션 누계가 보이고 `/history`가 토큰 합계를 표시한다. 로컬 모델은 보고값이 없다. `knowledge/AGENTS.md` 허용 목록에 추가했다.
2. **엔진 실패 분류·전환 제안**. 실패한 호출에 `failureClass`(rate_limited·quota·auth·transient)를 벤더 진단문의 패턴으로만 붙인다(문구는 버림). 채팅 턴이 그 분류로 실패하면 세션 콤보 경로 중 다른 엔진의 경로를 "Retry on <engine> / <model>"로 제안한다. 선택하면 일반 `/model` 전환(대화 이어짐) 뒤 같은 메시지를 다시 보내며 notice로 남긴다. 대안 경로가 없으면 수동 전환 안내만 한다. 자동 전환은 없다.
3. **읽기 전용 도구 묶음 실행**. 한 응답의 읽기 전용 엔벨로프(read·list·glob·grep·memory·skill·repo_search) 여러 개를 모델 재호출 없이 순서대로 실행한다(응답당 최대 8개, 초과분은 "실행되지 않음"으로 보고). 호출마다 정책·리스 검사와 라운드 회계는 그대로이고, 쓰기·명령이 섞인 응답은 종전처럼 거부한다. 도구 실행 본문을 `runToolCall`로 묶어 재사용했다.

## 8. 후속 반영 2 (2026-11-04, 브랜치 `feat/otter-p2-recommendations`)

1. **로컬 think 토글**: `local_model.think`(사용자·프로젝트 설정)와 `/local think on|off|default`. 기본 off(`--think=false`). 켜면 다음 로컬 추론부터 `ollama run --think=true`.
2. **read-before-overwrite**: 실행 중 read/multiread한 경로를 추적해, 읽지 않은 기존 파일을 덮어쓰는 `write`는 승인 제목에 표시하고 auto-edit 모드에서도 묻는다.
3. **실패 턴 기록**: 트랜스크립트 `failure` 레코드(카테고리·사유·엔진 실패 등급·엔진/모델 열거값만)와 다이제스트 `failures` 집계, `/history`에 실패 턴 수 표시.
4. **edit `occurrence`/`replaceAll`**: 정확 1회 일치 외에 N번째 일치만 또는 전부 치환. 겹치는 일치는 항상 거부. multiedit도 동일.
5. **상태줄 예산 표시**: 메인 모델 호출마다 `ctx 6.1k/8.2k 74% · tools 3/24`(90% 이상이면 ✂). 추정치임을 전제.
6. **GitHub Actions CI**: `.github/workflows/ci.yml` — 타입체크 + Ubuntu·macOS 4분할 샤딩 테스트(`scripts/test-shard.sh`). 네이티브 엔진 테스트는 비활성.
7. **확인만**: 도구 루프 반복 가드는 공용 실행 정책에 이미 있어 CLI에도 적용됨.

보류·미적용: 벤더 입력 예산 상향과 토큰 계수 보정(비용 결정 필요), GJC 세션 임포터(포맷 미확정), 세션 제목·포크, 릴리스 요약, main 기본 라운드 상향.

