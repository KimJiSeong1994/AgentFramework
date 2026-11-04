# oh-my-claudecode(OMC) 구성요소 검토 — otter 이식 판정

- 일자: 2026-11-04
- 대상: OMC v5.7.31 (`<clone>/omc`, 읽기 전용, 커밋 `0564555`), otter master+`feat/otter-intro-motion-video` (`/Users/gimjiseong/orca/projects/AgentFramework/framework`, `src/` 90,846줄).
- 이전 비교(`docs/agent-framework-review-2026-09-22.md`)는 OMC 5.5 기준이었다. 이 문서는 5.7.31 소스와 OMC 자체 문서(CHANGELOG, MIGRATION, docs/issues, docs/adr, docs/design)를 직접 읽고, "otter에 이미 있음" 주장은 모두 `framework/src/...:줄`로 확인했다. 확인 못 한 것은 **[미확인]**으로 표시한다.
- 규모 [검증]: OMC `src/` 비테스트 TS 623파일 204,122줄 + 테스트 816파일, `hooks/hooks.json` 11개 이벤트에 30개 커맨드 항목(`docs/HOOKS.md`는 "21 hooks"라 적어 문서 드리프트), 스킬 48개, 에이전트 md 19개, 커맨드 md 21개, 훅 스크립트 `scripts/*.mjs` 69개.
- 토큰 비용은 파일 바이트/4로 추정한 값이다(영문 기준, 측정값 아님). 실제 주입 여부는 "상시"(매 턴)와 "호출 시"(스킬·에이전트 로드 시)로 구분했다.

---

## 1. OMC 구성요소 인벤토리

| 구성요소 | 메커니즘 (Claude Code 훅 이벤트 / 파일) | 의존성 | 프롬프트 토큰 비용(추정) | 클론 내 경로 |
|---|---|---|---|---|
| **훅 러너** | `hooks/hooks.json` → `node scripts/run.cjs <script>.mjs`. UserPromptSubmit 2, SessionStart 7, PreToolUse 2, PermissionRequest 1, PostToolUse 4, PostToolUseFailure 1, SubagentStart 1, SubagentStop 2, PreCompact 3, Stop 5, SessionEnd 2. 두 UserPromptSubmit 훅만 Worker 스레드(8s/12s)로, 나머지는 자식 프로세스(3~60s 타임아웃). 출력은 `<system-reminder>`/`additionalContext` | Node, `CLAUDE_PLUGIN_ROOT`, `DISABLE_OMC`/`OMC_SKIP_HOOKS` | 훅 자체는 0; 주입 텍스트가 비용(아래 각 항목) | `hooks/hooks.json`, `scripts/run.cjs`, `docs/HOOKS.md` |
| **CLAUDE.md 오버레이** | `<!-- OMC:START -->…<!-- OMC:END -->` 마커로 프로젝트 CLAUDE.md에 삽입. 위임 규칙·모델 티어·스킬 표·상태 경로 | 설치기 | 6,002B ≈ **1.5K 상시** | `CLAUDE.md`, `src/installer/` |
| **에이전트(19)** | `agents/*.md` frontmatter(모델 티어 haiku/sonnet/opus). `Task(subagent_type="oh-my-claudecode:executor", model=…)`로 스폰 | Claude Code Task 툴, 모델 티어 | 4.4~22.3KB → **1.1~5.6K/스폰**(critic 22.3KB, code-reviewer 15.2KB) | `agents/`, `docs/ARCHITECTURE.md` |
| **스킬/커맨드(48/21)** | `skills/<name>/SKILL.md` + `commands/<name>.md`(커맨드는 SKILL.md를 읽으라는 디스패치 스텁; 세션마다 긴 설명을 싣지 않으려는 장치) | Claude Code 스킬 시스템 | 호출 시: team 63KB ≈ 16K, deep-interview 52KB ≈ 13K, ralph 30KB ≈ 7.5K, plan 25KB ≈ 6.3K, cancel 18.5KB ≈ 4.6K, autopilot 17.6KB ≈ 4.4K, ralplan 13KB ≈ 3.3K | `skills/`, `commands/` |
| **키워드/모드 감지 + sanitizer** | UserPromptSubmit `keyword-detector.mjs`. 우선순위 배열(cancel > ralph > autopilot > … > antigravity), 한/일어 alias, 코드블록·인라인코드·인용·표 행·파일경로 제거, 정보성 질문(“what is / 뭐야 / とは”) ±80자 창 억제, 인용 안 키워드는 실행 지시어 동반 시만 인정, 설정 `keywordDetector.disabled`. **team 키워드는 무한 스폰 사고 후 비활성(`/(?!x)x/`)** | 없음 | `[MAGIC KEYWORD: …]` + 스킬 호출 안내(사용자 요청 1,200자 에코) ≈ **0.3~0.5K/턴(매치 시)** | `src/hooks/keyword-detector/index.ts`(1,205줄, `removeCodeBlocks` :185, `sanitizeForKeywordDetection` :371), `src/features/magic-keywords.ts`, `scripts/keyword-detector.mjs` |
| **상태 레이아웃 `.omc/`** | `OmcPaths`: `.omc/state/`, `.omc/state/sessions/<sid>/<mode>-state.json`, `plans/`, `research/`, `notepad.md`, `project-memory.json`, `logs/`, `handoffs/`, `ultragoal/`, `skills/`(커밋 가능한 유일 예외). 루트 해석: git toplevel → `.omc-workspace` 마커 → `OMC_STATE_DIR/<project-id>` → 비-git은 `~/.omc/`. 원자 쓰기 + 변경 락(better-sqlite3, 실패 시 파일 락) | **better-sqlite3 네이티브 바인딩**(선택), git | 0 | `src/lib/worktree-paths.ts`(2,409줄), `src/lib/mode-state-io.ts`(2,080줄), `src/lib/mode-names.ts`, `src/lib/atomic-write.ts` |
| **HUD/statusline** | Claude Code `statusLine` 커맨드 `omc hud`: stdin JSON(모델·컨텍스트%·rate limit) + 트랜스크립트 파싱 + `.omc/state` 읽기 → 한 줄 렌더. 요소: 컨텍스트 바, ralph/autopilot 상태, 에이전트 관측, todos, 마지막 스킬, rate limit(Anthropic usage API 폴링 90s), 업데이트 힌트 | Claude Code statusline, (선택) usage API HTTPS | **0**(프롬프트 밖) | `src/hud/index.ts`, `src/hud/render.ts`, `src/hud/elements/*`, `src/hud/usage-api.ts`(2,614줄), `src/hud/types.ts:730 HudConfig` |
| **세션 연속성/핸드오프** | SessionStart: 상태 복원·stale run 보고·runs 조정. PreCompact: `CompactCheckpoint`(활성 모드, todo 요약, PRD/boulder 포인터) + 위키 요약 주입. SessionEnd: 메트릭·정리(2s 예산, 비동기 워커). 팀/launch는 `.omc/handoffs/<stage>.md`(10~20줄, 취소 후에도 보존). 워크스페이스 체크포인트는 git shadow commit `refs/omc/checkpoints/` | git | PreCompact 주입 소량(미측정) | `src/hooks/pre-compact/index.ts`, `src/hooks/session-end/index.ts`, `src/features/checkpoint/index.ts`, `skills/team/SKILL.md:161-199` |
| **메모리/notepad/프로젝트 메모리/위키** | `.omc/notepad.md` 3층(Priority Context ≤500자 상시, Working Memory 7일 자동 삭제, MANUAL 영구). `project-memory.json`(환경 자동 탐지 + 사용자 지시 + hot path, PostToolUse 비동기 갱신). `wiki`(세션 시작 시 페이지 주입, 종료 시 append-only 캡처, PreCompact 요약). `/remember` | 없음 | notepad ≤ **0.13K 상시**; project-memory 요약·위키 주입량 **[미측정]** | `src/hooks/notepad/index.ts`, `src/hooks/project-memory/`, `src/hooks/wiki/session-hooks.ts`, `skills/remember/SKILL.md` |
| **팀/병렬** | runtime-v2: tmux pane에 워커 CLI(claude/codex) 스폰, 파일 메일박스(inbox/outbox), heartbeat, task 파일, 인스턴스 소유권·프로세스 생성시각 바인딩, 워크트리 모드(opt-in), merge orchestrator. MCP 팀 브리지는 5.7.31에서 "아무것도 스폰하지 않는" 이유로 제거 | **tmux**(또는 cmux), git worktree, 네이티브 addon(macOS 프로세스 신원) | 워커 부트스트랩 프롬프트 + 리더 넛지(미측정) | `src/team/runtime-v2.ts`(6,744줄), `src/team/tmux-session.ts`(4,688줄), `docs/TEAM-WORKTREE-MODE.md`, `docs/MIGRATION.md` "Team Instance Ownership" |
| **ralph/지속 루프** | Stop 훅 `persistent-mode.mjs`: 활성 모드(ralph/autopilot/ralplan/team/skill-active/todo)면 `continue:false`로 종료 차단 + 강화 메시지. 브레이커: todo 5회, ralplan 45분, team-pipeline 5분, 취소 신호 TTL 30s, stale 2h, thinking-only streak, "awaiting confirmation" 2분. ralph는 PRD(`prd-*.md`) 스토리 단위 + architect 검증 + 실패 서명 지문(pytest/vitest 출력 정규화). `context-guard-stop.mjs` 75% 경고(최대 2회 차단, context_limit 중단은 절대 차단 안 함). `budget-guard.mjs` 런 토큰 예산 | 없음(Jev는 선택) | 강화 메시지 ≈ **0.1~0.3K/Stop** | `src/hooks/persistent-mode/index.ts`(2,632줄; 브레이커 :1579-1612), `src/hooks/ralph/`, `scripts/context-guard-stop.mjs`, `scripts/budget-guard.mjs` |
| **rate-limit/폴백** | `omc wait` 데몬: usage API 폴링 → tmux pane 스캔으로 막힌 세션 탐지 → 리셋 후 `send-keys`로 재개. Stop 훅은 `isRateLimitStop`/`isAuthenticationError`면 차단 안 함. 모델 폴백은 티어 라우팅(`routing.escalationEnabled`)뿐, 엔진 전환 없음 | tmux, usage API | 0 | `src/features/rate-limit-wait/{daemon,tmux-detector,rate-limit-monitor}.ts`, `src/hooks/todo-continuation/index.ts` |
| **도구 실패/가드** | PostToolUseFailure: 같은 툴 연속 실패 `retry_count`, 5회면 "다른 접근" 안내. PreToolUse `git-guardrails.mjs`: `reset --hard`, `clean -f`, `branch -D`, `checkout/restore .` 차단. `permission-handler.mjs`(Bash 권한). `workflow-drift-guard.mjs`, `code-simplifier.mjs`(opt-in) | 없음 | 안내 1줄 | `scripts/post-tool-use-failure.mjs`, `scripts/git-guardrails.mjs`, `scripts/pre-tool-enforcer.mjs` |
| **설정** | 사용자 `~/.config/claude-omc/config.jsonc` → 프로젝트 `.claude/omc.jsonc`(프로젝트 우선) + env. 에이전트별 모델, 기능 토글, 라우팅 티어, `keywordDetector.disabled`, `autopilot.workflows`, HUD 프리셋 | 없음 | 0 | `src/config/loader.ts`(1,484줄), `docs/settings-schema.md` |
| **Jev 판정점** | 8개 "judgment point"를 휴리스틱 쌍둥이 + 외부 API(`api.typesafe.ai`, `TYPESAFE_API_KEY`)로 이중 구현, off/shadow/active 상태 | **외부 네트워크 서비스** | 0(shadow) | `GLOSSARY.md`, `docs/adr/03665-jev-degradation-contract.md`, `src/hooks/*/jev-shadow.ts` |
| **알림** | Slack/Telegram/Discord 디스패처 + 회신 리스너 | 네트워크 | 0 | `src/notifications/` |

---

## 2. 가용성 판정 (otter 아키텍처: 벤더 CLI 1회성 서브프로세스 + JSON 봉투 툴 + 사람 승인)

| OMC 구성요소 | 판정 | 근거 (otter 경로:줄) |
|---|---|---|
| 훅 러너(11 이벤트) | **이식 불가(이유)** — otter 엔진에는 Claude Code 훅 수명주기가 없다. 단, otter는 호스트가 루프를 소유하므로 같은 지점이 코드 안에 이미 존재: 턴 시작(`plan-conversation.ts`), 툴 전/후(`chat-actions.ts` ActionGate), 턴 종료(`interactive-session.ts`), 세션 종료(`closeSessionHistory`). OpenCode 경로만 플러그인 훅 8종 보유 | `framework/src/hooks/{config,chat-message,chat-params,event,tool-before,tool-after,compacting,command}.ts`; `framework/src/index.ts:2` |
| CLAUDE.md 오버레이 | **이식 불가/불필요** — otter는 지시를 역할 정책 프리픽스로 호스트가 조립(`otter:main:<sha>`). 프로젝트 CLAUDE.md 주입은 프리픽스 불변 계약에 반함 | `framework/src/hosts/cli-host.ts:595` 입력 예산 문구; README "Chat execution" |
| 에이전트 19종 + 모델 티어 | **otter에 이미 있음(위치)** — 역할 5종(main/worker/reviewer/data-analyst/data-verifier)과 역할 콤보로 엔진·모델 라우팅. 19종으로 늘릴 이유 없음(09-22 리뷰 §4 결론 유지) | `framework/src/hosts/combo-presets.ts`, `default-model.ts`, README "Role combo" |
| 키워드 감지 + sanitizer | **otter에 이미 있음(위치)** — OMC sanitizer 발상이 이미 이식됨: 코드블록·경로 제거, 정보성 질문 억제, `force:` 프리픽스, 한국어 조사 처리(`ulw로`, `끝까지 해`). CLI 경로는 `classifyIntent`로, OpenCode 경로는 `detectMode`로 사용 | `framework/src/modes/sanitize.ts:8`, `framework/src/modes/detect.ts:1-40`, `framework/src/hosts/interactive-session.ts:26`, `framework/src/hooks/chat-message.ts:509` |
| `.omc/` 상태 레이아웃 | **otter에 이미 있음(위치)** — 세션별 `sessions/<sid>/workflow/workflow.json`, 상태 루트는 워크트리 밖(`stateRoot`), 쓰기는 `.otter/`·`.git/`·`knowledge/raw/` 보호. OMC의 2,409줄짜리 루트 해석(워크스페이스 마커·OMC_STATE_DIR·비-git 폴백)은 OMC가 겪은 파편화의 결과이므로 가져오지 않는다 | `framework/src/state/store.ts`, `framework/src/sessions/digest.ts:6`, README "Writes stay inside the worktree" |
| 상태 파일 원자 쓰기/락 | **otter에 이미 있음** — 워크플로 커밋은 바이트 동일 멱등, 단일 writer | `framework/src/workflows/commit.ts:4,365` |
| HUD/statusline | **otter에 이미 있음(부분)** — TUI 상태줄(`statusLines`: 안전 플래그·선택·요청 진행·대기열·워크플로), `/status`, `otter status --json/--watch`. **없는 것**: 컨텍스트 사용률 바, 턴 내 툴 호출 수, 승인 대기 표시. 이식 가능(§4-5) | `framework/src/tui/status-view.ts:77`, `framework/src/hosts/interactive-session.ts:3405`, README 1216-1283 |
| 세션 연속성(/resume, 다이제스트, 핸드오프) | **otter에 이미 있음(위치)** — `/resume [sid]`, `/history`, `/new`; 세션 종료 시 결정적 다이제스트(모델 호출 없음) → 프로젝트 facts 600자 블록을 다음 턴에 주입; `wiki.auto_capture` 기본 on. OMC의 PreCompact 체크포인트는 otter CLI에 컴팩션이 없어 해당 없음(오래된 툴 결과 절단만) | `framework/src/hosts/interactive-actions.ts:20-28`, `framework/src/sessions/digest.ts:1-7`, `framework/src/sessions/history.ts:1-16`, `framework/src/hosts/plan-conversation.ts:72`, `framework/src/hosts/cli-host.ts:66-67` |
| 워크스페이스 체크포인트(git shadow commit) | **otter에 이미 있음** — `/undo`는 비공개 스냅샷 트리(인덱스/HEAD 불변), 10턴 보존 | `framework/src/hosts/chat-checkpoint.ts:1-14`, `framework/src/orchestration/snapshot.ts` |
| notepad 3층 메모리 | **이식 가능(방법)** — otter에는 "항상 로드되는 짧은 우선 컨텍스트"가 없다. 위키 `memory` 회상은 모델 판정(Claude/Codex CLI, ≤15s)이라 로컬 전용 사용자는 비용이 크고, facts는 명령/파일 통계만. 상태 루트(워크트리 밖)에 `notepad.md`를 두고 Priority ≤500자를 facts 블록 뒤에 붙이면 됨(§4-4) | `framework/src/wiki/recall.ts:59-63,297`, `framework/src/sessions/history.ts:17` |
| project-memory 자동 탐지 | **otter에 이미 있음(대체)** — facts(검증된 명령·실패 명령·hot files)가 같은 역할을 결정적으로 수행 | `framework/src/sessions/history.ts:3-4,19-25` |
| 위키 | **otter에 이미 있음** — `knowledge/wiki` 캡처·ingest·lint, `memory` 툴 | `framework/src/wiki/wiki.ts:707` |
| 팀/병렬(tmux) | **이식 불가(이유)** — tmux pane·메일박스·프로세스 신원 바인딩은 벤더 CLI 1회성 서브프로세스 모델과 맞지 않고, 로컬 Ollama 슬롯 1개 전제(09-22 §3)와 충돌. otter는 직렬 `delegate` 큐 + 태스크별 워크트리로 이미 충분 | `framework/src/orchestration/queue.ts:4`, `framework/src/orchestration/worktree.ts:1` |
| ralph/지속 루프 + 브레이커 | **otter에 이미 있음(OpenCode 경로만)** / **CLI 경로는 이식 가능(방법)** — `loop/idle.ts`가 max_iterations 20·TTL 2h·stagnation 3·failures 브레이커를 갖지만 `hooks/event.ts`(OpenCode `session.idle`)에서만 쓰인다. CLI 채팅은 턴당 툴 24회 + 사람이 24회씩 3번 연장하는 구조이고, "미완료면 다음 턴 자동 제안"이 없다. ultragoal/autoresearch는 자체 noProgress 카운터 보유 | `framework/src/loop/idle.ts:9,36,51`, `framework/src/hooks/event.ts:11`, `framework/src/config.ts:366-369`, `framework/src/hosts/cli-host.ts:59-60,1455`, `framework/src/workflows/ultragoal-data.ts:16` |
| 동일 호출 반복 차단 / 복구 힌트 | **otter에 이미 있음** — RepeatGuard(동일 (tool,args) limit+1회 차단), 실패 출력에 복구 힌트 ≤200자. OMC의 "같은 툴 5회 실패(인자 달라도)" 카운터는 없음 — 작게 추가 가능 | `framework/src/guards/repeat.ts:1-2`, `framework/src/guards/recover.ts:1-30`, `framework/src/hosts/cli-host.ts:1596` |
| context guard(75%) / budget guard | **이식 가능(방법)** — otter는 예산 초과 시 "오래된 툴 출력 절단" 후 실패로 끝나며 사전 경고·상태줄 표시가 없다. `budgetEvidence`가 이미 cli-host에서 나온다(§4-5) | `framework/src/hosts/cli-host.ts:66-67,864,1040,1099` |
| git-guardrails(파괴적 git) | **이식 가능(방법)** — otter REFUSED 목록은 force push·sudo·rm -rf /·디스크·fork bomb뿐. `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`는 승인 대상이지만, "Always allow" 규칙이 **앞 두 단어**(`git checkout`)로 저장되므로 한 번 허용하면 `git checkout .`도 자동 실행된다(§4-3) | `framework/src/hosts/chat-actions.ts:22-31`, README "Always allow saves a command rule (the first two words)" |
| rate-limit 대기 데몬 / 엔진 폴백 | **이식 불가(데몬·tmux)** / **분류는 이식 가능** — otter는 Claude `rate_limit_event`를 형식 검증만 하고 버린다; 로그인 상태는 `engine-auth.ts`로 읽을 수 있다. "실패 분류 → 다른 엔진으로 이 턴 재실행 제안"은 로드맵 3-A·게이트웨이 계획 G2에 이미 설계됨 | `framework/src/hosts/cli-transport.ts:682-686`, `framework/src/hosts/engine-auth.ts:1-20`, `framework/src/hosts/memory-command.ts:127`, `docs/otter-ai-gateway-plan-2026-11-02.md` G2 |
| 설정(사용자→프로젝트) | **otter에 이미 있음** — 같은 병합 규칙에 더해 "사용자 전용 키"(skill_trust, model_api, chat.allow) 개념이 있어 OMC보다 안전 | `framework/src/config.ts:1,442-446,501` |
| skill-injector(trigger 목록으로 스킬 주입) | **otter에 이미 있음(더 나음)** — `skill_auto`: 모델이 카탈로그에서 로드, 리콜/정밀도 평가 스크립트 보유. OMC식 substring trigger 주입은 프리픽스를 늘리므로 가져오지 않음 | README "Model-loaded skills (`skill_auto`)" |
| Jev 판정점 | **이식 불가/불필요** — 외부 네트워크 서비스. otter의 `routing/jev.ts`는 로컬 OpenJev 엔드포인트이고 기본 `auto`는 Claude/Codex 판정 | `framework/src/routing/jev.ts`, `framework/src/config.ts:387` |
| 알림(Slack 등) | **이식 불가(네트워크)** — 단, 승인 대기 시 터미널 벨은 로컬이며 S 크기 **[otter에 없음: `grep notify\|bell` 결과 업데이트 알림뿐]** | `framework/src/hosts/cli.ts:122` |
| 자동 업데이트 | **otter에 이미 있음** — 하루 1회 백그라운드 확인·알림만 | `framework/src/hosts/update-check.ts`, `framework/src/hosts/interactive-session.ts:1383` |

---

## 3. OMC가 겪은 문제 (OMC 자체 문서에서)

1. **과잉설계 자인과 되감기** — epic #3698 "lightweight workflow plan"(`docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md`), `scripts/inventory-issue-3698.mjs`(파일 인벤토리 자동 집계), `scripts/measure-prompt-ssot.ts`. 측정값(`docs/design/issue-3704-prompt-ssot/measurements.json`): CLAUDE.md+agents 프롬프트 코퍼스 23,859 토큰 중 반복 절 비율 18.2%(3,107 토큰 중복). 교훈: 프롬프트는 단일 출처에서 생성하고 중복률을 측정하라. otter는 역할 프리픽스를 코드가 조립하므로 이미 유리하다.
2. **상태 파편화와 취소 누락** — `docs/cancel-skill-active-state-gap.md`: `/cancel`이 `skill-active-state.json`을 지우지 않아 Stop 훅이 최대 15분·5회 강화를 계속함. 모드별 state 파일(7종) + stop-breaker 파일 + last-tool-error + session-started + 팀 인스턴스 영수증 등 파일이 늘어나며 "무엇을 지워야 취소인가"가 흐려졌다. MIGRATION.md "Cancellation Scope"는 `--force`/`--all` 의미를 다시 정의해야 했다. 교훈: 모드 상태는 한 파일·한 writer, 취소는 그 파일 하나를 지우는 것이어야 한다(otter `workflow.json`이 이 형태).
3. **이름 변경 난류** — v5.0 "Retired (removed, not aliased)" 15개(`ultrawork`, `ultraqa`, `swarm`, `pipeline`…), 그 뒤 `src/alias-retirement/policy.ts`로 "2 마이너 릴리스 + 90일 + 95% 사용 점유" 정책을 코드화해야 했다. `#3668`은 자사 `/ralph`가 공식 플러그인 `/ralph-loop`와 충돌해 안내 문구를 넣은 사례. 교훈: 사용자 노출 이름은 적게, 바꿀 땐 alias 기간을 둔다.
4. **키워드 자동 감지의 사고** — `src/hooks/keyword-detector/index.ts:52-54`: "team" 키워드는 워커가 받은 프롬프트에 'team'이 들어 있으면 무한 스폰되어 비활성화. 교훈: 실행 모드 진입은 명시 명령으로(otter는 워크플로를 `/skill:<name>` 제출로만 시작하므로 이미 지킴).
5. **Stop 훅 루프의 안전장치가 사고 이력** — context_limit 중단은 절대 차단 금지(컴팩션 데드락), `MAX_BLOCKS=2`, 브레이커 TTL이 모드마다 다름(45분/5분/2분), "awaiting confirmation을 crash로 오판"(#4799), 실패 서명이 pytest 진행 점·vitest 시계를 실패로 오인(#4800-4802, #4819). 교훈: 모델 출력 텍스트를 파싱해 진행을 판정하지 말 것(otter 09-22 §5.4 원칙과 일치).
6. **네이티브 의존성** — `src/lib/mode-state-io.ts:46-82`: better-sqlite3 바인딩이 플러그인 캐시에서 빌드되지 않아 파일 락 폴백과 진단 문구를 유지해야 함. 팀의 프로세스 신원은 macOS 네이티브 addon 필요. 교훈: 상태 락에 네이티브 모듈을 쓰지 말 것.
7. **팀 런타임의 비대화** — `runtime-v2.ts` 6,744줄, `tmux-session.ts` 4,688줄, 인스턴스 소유권·tmux 서버 PID·프로세스 생성시각 바인딩, "MCP 팀 브리지를 아무것도 스폰하지 않아 제거"(5.7.31). 교훈: 병렬 실행 인프라는 실제 수요가 확인된 뒤에.
8. **훅 스크립트 이중화** — `scripts/*.mjs`와 `templates/hooks/*.mjs`를 "lockstep"으로 유지하는 테스트(#4784 "keep the plugin and standalone helper copies identical"), 훅 당 호출 비용 150~335ms(`docs/issues/issue-3668-ralph-namespace.md`). 교훈: 호스트 안에서 함수로 호출되는 otter 구조가 더 싸고 단순하다.
9. **문서 드리프트** — `docs/HOOKS.md` "21 hooks" vs `hooks.json` 30 커맨드, `docs/ARCHITECTURE.md` "41 shipped skills" vs 48개 디렉터리. 교훈: 인벤토리는 스크립트로 생성.
10. **외부 판정 API** — Jev 8개 판정점을 휴리스틱 쌍둥이와 이중 유지(shadow 로그, 승격 증거). 단일 사용자 로컬 도구에는 유지비가 효익을 넘는다.

---

## 4. otter 고도화 추천 Top 5

우선순위 기준: 로컬 Ollama + Codex + Claude CLI를 한 사람이 동작마다 승인하며 쓸 때의 실제 마찰. 의존성·네트워크 추가 없음.

### 4-1. 엔진 실패 분류 + "이 턴을 다른 엔진으로" 제안 (M, 위험 중)
- **무엇**: `cli-transport.ts:682`가 버리는 Claude `rate_limit_event`, "Not logged in"(`memory-command.ts:127` 문구), 스폰 실패, 기한 초과를 `transient | rate_limited | auth | quota | fatal`로 분류하고, 턴 실패 시 상태줄에 원인을 띄우며 `/model`을 거치지 않고 "같은 대화를 Codex/local로 이 턴만 재실행"을 한 번에 제안. 조용한 모델 교체는 하지 않는다(게이트웨이 계획 G2 원칙).
- **왜**: 로드맵 3-A 미해결. OMC는 tmux 데몬으로 해결했지만 otter는 호스트가 루프를 소유하므로 데몬 없이 가능. 도구 효과가 이미 일어난 턴은 재실행 금지(전송 단위라 자연 보장).
- **어디**: `framework/src/hosts/cli-transport.ts`(분류), `framework/src/hosts/interactive-session.ts`(제안·재실행), `framework/src/tui/status-view.ts`(표시), `framework/src/workflows/receipts.ts`(실제 사용 엔진 기록).
- **크기/위험**: M. 워크플로 소유권은 엔진 고정(`interactive-session.ts:2894`)이므로 채팅 턴에만 적용; G2의 첫 슬라이스로 잘라 게이트웨이 전체를 기다리지 않는다.

### 4-2. CLI 채팅에 "미완료 이어가기" 루프를 브레이커와 함께 연결 (M, 위험 중)
- **무엇**: 턴이 끝났는데 열린 todo/계획 단계가 남으면(`guards/todos.ts`), 다음 턴을 자동 제안하거나(ask 모드: Enter 한 번), auto-edit 모드에선 자동 이어가기. `loop/idle.ts`의 max_iterations 20·TTL 2h·stagnation 3·failures 브레이커와 `config.loop`를 그대로 재사용하고, `/stop`으로 즉시 종료.
- **왜**: OMC에서 가장 가치 있다고 인정되는 메커니즘(Stop 훅 지속)이 otter에선 OpenCode 경로(`hooks/event.ts:11`)에만 있다. CLI 경로는 툴 24회마다 사람이 연장 버튼을 누르는 구조라 긴 작업이 끊긴다.
- **어디**: `framework/src/hosts/interactive-session.ts`(턴 종료 지점), `framework/src/loop/idle.ts`(의존성 주입으로 CLI 호스트에 연결), `framework/src/guards/todos.ts`, `framework/src/state/`(세션별 루프 상태는 `sessions/<sid>/`에 파일 1개).
- **크기/위험**: M. OMC 교훈대로 모델 텍스트로 "완료"를 판정하지 말고 todo 원장·지문만 본다; 승인 게이트는 그대로라 효과는 여전히 사람이 결정한다.

### 4-3. 파괴적 git 명령은 "Always allow" 규칙과 매치되지 않게 (S, 위험 낮음)
- **무엇**: OMC `scripts/git-guardrails.mjs` 목록(`git reset --hard`, `git clean -f/-fd`, `git checkout .`/`restore .`, `git branch -D`, `git stash drop/clear`, `git push --delete`)을 otter에 "항상 묻는 명령" 집합으로 추가: 실행은 승인으로 가능하되 규칙 저장을 제안하지 않고 기존 규칙(`git checkout`, `git clean`)에도 매치되지 않게. REFUSED에 넣지는 않는다(사람이 허용할 수 있어야 함).
- **왜**: 규칙이 앞 두 단어로 저장되므로 `git checkout -b x`를 한 번 "Always allow"하면 `git checkout .`도 자동 실행된다. `/undo`는 턴 단위 복구라 untracked 삭제(`clean -f`)는 되돌리지 못한다.
- **어디**: `framework/src/hosts/chat-actions.ts`(REFUSED 옆에 `ALWAYS_ASK` 목록, `commandRule` 매치 제외), `/permissions` 표시.
- **크기/위험**: S. 기존 규칙 파일 호환.

### 4-4. 상태 루트의 notepad(우선 컨텍스트 ≤500자 + 7일 작업 메모) (S~M, 위험 낮음)
- **무엇**: OMC notepad 3층 중 Priority Context(상시 주입, 500자 상한)와 Working Memory(7일 자동 삭제)만. 파일은 워크트리 밖 상태 루트에 두어 클론된 저장소가 주입할 수 없게 하고, `/remember <text>`·`/remember priority <text>`로 쓰며, facts 600자 블록(`plan-conversation.ts:72`) 뒤에 같은 "참고 데이터, 지시 아님" 틀로 붙인다. 모델도 `memory` 툴로 쓰게 할지는 별도 결정(기본은 사람만).
- **왜**: 로컬 Ollama만 쓰는 사용자는 위키 회상(Claude/Codex CLI 판정, ≤15s)을 못 쓰거나 비싸고, facts는 명령/파일 통계뿐이라 "이 프로젝트에선 X를 쓰지 마라" 같은 한 줄 사실을 `/new` 뒤에 다시 말해야 한다. 프리픽스 증가는 ≤130 토큰.
- **어디**: `framework/src/sessions/history.ts`(facts 블록 조립), `framework/src/hosts/plan-conversation.ts`, `framework/src/hosts/interactive-actions.ts`(`/remember`), 다이제스트에 notepad 변경 횟수만 기록.
- **크기/위험**: S~M. 프롬프트 주입 경계는 facts와 동일하게 "데이터" 라벨 + 길이 상한.

### 4-5. 상태줄에 입력 예산 사용률·절단 표시 + 툴 호출 카운터 (S, 위험 낮음)
- **무엇**: OMC HUD의 contextBar·call-counts에 해당. `cli-host.ts`가 이미 만드는 `budgetEvidence`(추정 토큰, 절단 여부)를 TUI 상태줄 세그먼트로: `ctx 6.1k/8k 76% ✂`, `tools 17/24`. 75% 이상이면 한 번 "/context budget 또는 /new 권장" 알림(OMC context-guard의 2회 상한 규칙 차용).
- **왜**: 로컬 모델은 8,192 토큰 추정 한도라 절단이 자주 일어나는데 지금은 `[older tool output truncated…]` 마커가 모델에게만 가고 사람은 실패 뒤에야 안다(`cli-host.ts:1040,1099`). 승인 피로의 상당 부분은 "지금 몇 번째 호출인지, 왜 느린지"를 모르는 데서 온다.
- **어디**: `framework/src/hosts/cli-host.ts:864`(증거 방출), `framework/src/hosts/cli-progress.ts`, `framework/src/tui/status-view.ts:77`(세그먼트 priority 추가), `/status` JSON `execution`에 같은 숫자.
- **크기/위험**: S. 표시 전용.

### 가져오지 않을 것(명시)
tmux 팀 런타임, Jev 판정점, Slack/Telegram 알림, usage API 폴링 HUD, 19 에이전트·모델 티어 라우팅, substring trigger 스킬 주입, project-memory 환경 자동 탐지(facts가 대체), PreCompact 체크포인트(otter CLI에 컴팩션 없음), git shadow-commit 체크포인트(`/undo`가 대체), `.omc-workspace`/`OMC_STATE_DIR` 다중 루트 해석.

---

## 부록: 확인하지 못한 것
- OMC의 project-memory 요약·위키 세션 주입의 실제 토큰량(코드상 상한은 있으나 측정 파일 없음).
- OMC 훅 1회 150~335ms는 OMC 자체 문서 수치이며 이 머신에서 재측정하지 않았다.
- otter CI: `framework/.github/workflows`, 저장소 루트 `.github/workflows` 모두 없음(로드맵 5-A 미해결, 2026-11-04 기준).
