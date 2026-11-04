# oh-my-openagent(OMO) 심층 리뷰 — otter 관점 (2026-11-04)

대상
- 업스트림 클론(읽기 전용, 실행 안 함): `<clone>/omo` — `oh-my-opencode` **5.1.60**, HEAD `f9c7e7ad` (2026-11-04). 이하 `OC/` = `…/ref/omo/packages/omo-opencode/src/`, `PK/` = `…/ref/omo/packages/`.
- 설치본 1: OpenCode 플러그인 캐시 `/Users/gimjiseong/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent` — **4.19.4** (캐시 `package.json`에 `"oh-my-openagent": "4.19.4"` 고정, 2026-09-21 설치, `dist/index.js` 5.7MB 단일 번들). `~/.config/opencode/opencode.jsonc`의 `plugin: ["oh-my-openagent@latest"]`로 로드.
- 설치본 2: Senpi 에디션 `/Users/gimjiseong/.bun/install/global/node_modules/omo-ai` **5.0.0-0.beta.80** + `@code-yeongyu/senpi` **2026.9.20** (별도 프로세스, `omo` 명령).
- OpenCode **1.18.35** (`/Users/gimjiseong/.opencode/bin/opencode`).
- otter: `/Users/gimjiseong/orca/projects/AgentFramework/framework/src` (이하 `S/`), 저장소 루트 `/Users/gimjiseong/orca/projects/AgentFramework` (이하 `R/`).
- 검증 방법: 업스트림은 grep/sed로만 읽음. 설치본의 실제 효과는 저장소 루트에서 `opencode debug config` / `opencode debug agent {main,reviewer}`를 실행해 얻은 **유효 설정**(`<scratch>/effective-config.json`, `agent-main.json`, `agent-reviewer.json`)으로 확인. otter 쪽 "이미 있음" 주장은 전부 `S/` grep으로 확인했다.

---

## 1. OMO 구성요소 인벤토리 (업스트림 5.1.60 기준, 설치본 4.19.4 차이는 별도 표기)

### 1.1 에이전트

| 에이전트 | mode | 툴 제한(permission) | 프롬프트 크기 | 파일 |
|---|---|---|---|---|
| sisyphus | primary | `call_omo_agent: deny`, `task: allow` | 정적 22,679자 + 동적 섹션 ~20K자(core 9,024 / policy 6,306 / category-skills 5,282) ≈ **10K+ 토큰**. 이 머신 유효 설정에서 32,179자 | `OC/agents/sisyphus/default.ts`, `OC/agents/dynamic-agent-*.ts` |
| hephaestus | primary | 위와 동일 | 12,779자 ≈ 3.2K | `OC/agents/hephaestus/gpt.ts` |
| atlas (Plan Executor) | primary | `task: allow` | 19,195자 + 3,818 ≈ 5.8K. 유효 설정 29,088자 | `PK/prompts-core/prompts/atlas/*.md`, `OC/agents/atlas/prompt-section-builder.ts` |
| prometheus (Plan Builder) | primary(OpenCode `plan`을 강등해 대체) | edit/bash/webfetch deny(후처리) | 1,120자 + native frame. 유효 1,119자 | `PK/prompts-core/prompts/prometheus/default.md`, `OC/plugin-handlers/prometheus-agent-config-builder.ts` |
| sisyphus-junior | subagent(카테고리 위임 실행체) | `task: deny` | 2,152자 ≈ 540 + 카테고리 `prompt_append`. 유효 2,494자 | `OC/agents/sisyphus-junior/default.ts` |
| oracle | subagent | write/edit/apply_patch/task deny | ≈6.5K자(변형 3종). 유효 6,153자 | `OC/agents/oracle.ts:413-418` |
| librarian | subagent | 위 + call_omo_agent deny | 11,740자 ≈ 2.9K | `OC/agents/librarian.ts:25-31` |
| explore | subagent | 위 + `lsp_*` 허용 | 4,090자 ≈ 1K | `OC/agents/explore.ts:28-31` |
| metis (Plan Consultant) | subagent | write/edit/apply_patch deny | ≈11.5K자. 유효 13,083자 | `OC/agents/metis.ts:393-397` |
| momus (Plan Critic) | subagent | 동일 | ≈6.6K자. 유효 6,543자 | `OC/agents/momus.ts:284-288` |
| multimodal-looker | subagent | `read`만 허용 | 2,634자. 유효 1,656자 | `OC/agents/multimodal-looker.ts:15` |
| build / plan / OpenCode-Builder | build→hidden subagent, plan→prometheus 설정으로 강등 | — | — | `OC/plugin-handlers/agent-config-assembly.ts:162-213` |

카테고리: 모델 체인·reasoning·temperature·`prompt_append`·`tools`를 묶은 프리셋. `task(category=…)`는 항상 sisyphus-junior로 실행(`OC/tools/delegate-task/category-resolver.ts:321`). 스키마 enum `visual-engineering, ultrabrain, deep, artistry, quick, unspecified-low/high, writing`(`OC/config/schema/categories.ts:44-53`), 실제 내장 정의는 `deep-low/deep-high`로 갈라져 있음(`openai-categories.ts:160-199`).

### 1.2 훅 (OpenCode 플러그인 API 매핑)

OMO가 등록하는 OpenCode 훅: `tool`, `chat.params`, `chat.headers`, `command.execute.before`, `chat.message`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `config`, `event`, `tool.definition`, `tool.execute.before/after`(`OC/plugin-interface.ts:53-162`) + `experimental.session.compacting`, `experimental.compaction.autocontinue`(`OC/testing/create-plugin-module.ts:340-342`). `permission.ask`는 쓰지 않음. 조립: `OC/create-hooks.ts:63-95` → core/continuation/skill 그룹, `disabled_hooks`로 개별 차단.

| 훅 | OpenCode 이벤트 | 메커니즘 | 외부 의존 | 파일 |
|---|---|---|---|---|
| keyword-detector | `chat.message`(+`system.transform`) | `ultrawork|ulw`(`ulw-*` 제외), `team mode`, `hyperplan|hpp`; 코드블록 제거 후 매칭; user 텍스트 끝에 `\n\n---\n\n<prompt>` 덧붙임(ultrawork 프롬프트 ≈5.2K 토큰, 09-22 실측), 반복 턴은 `<ultrawork-mode>active</ultrawork-mode>` 마커만 | 없음 | `OC/hooks/keyword-detector/constants.ts:16-56`, `hook.ts:85-306` |
| todo-continuation-enforcer | `event: session.idle` | 미완료 todo가 있으면 2초 카운트다운 후 `promptAsync`로 CONTINUATION_PROMPT 재투입. 스킵 조건: 질문 대기, 컴팩션 마커, 백그라운드 작업 중, 토큰한도 오류, 3초 내 abort. 쿨다운 5s×2^min(실패,5), 연속실패 5, 정체(stagnation) 3회, 컴팩션 가드 60초 | 없음 | `OC/hooks/todo-continuation-enforcer/constants.ts:5-26`, `idle-event.ts:43-236`, `stagnation-detection.ts:24` |
| stop-continuation-guard | `event: session.deleted`, `command.execute.before` | 세션을 stopped로 표시, `.omo/run-continuation/<sid>.json`에 `stop=stopped` 기록, 자손 백그라운드 작업 전부 취소. `/ulw-execute`로 해제 | 없음 | `OC/hooks/stop-continuation-guard/hook.ts:33-120` |
| atlas | `event: session.idle`, `tool.execute.before/after` | `.omo/boulder.json`에 등록된 세션만 계획 체크리스트가 남아 있으면 재프롬프트(쿨다운 5s, 연속실패 10, 백오프 5분) | 없음 | `OC/hooks/atlas/idle-event.ts:35-101` |
| goal (ralph-loop 후속) | `event`, `chat.message`, `command.execute.before`, `tool.execute.before` | opt-in. 목표 활성 중 idle마다 재프롬프트. `create_goal/update_goal/get_goal` 툴 | 없음 | `OC/hooks/goal/controller.ts:26-30` |
| ralph-loop / task-reminder | **배선 안 됨**(HookName에서 제거) | — | — | `OC/hooks/index.ts:37`, `OC/hooks/AGENTS.md:9` |
| comment-checker | `tool.execute.before/after`(write/edit) | 외부 바이너리 실행, exit 2면 stderr를 툴 결과에 덧붙임(30초당 1회) | **`comment-checker` v0.8.0 바이너리를 GitHub release에서 `~/.cache/oh-my-opencode/bin`으로 다운로드** | `PK/comment-checker-core/src/release.ts:4-5,59-67`, `OC/hooks/comment-checker/downloader.ts:38-45` |
| edit-error-recovery | `tool.execute.after`(edit) | "oldString not found/multiple/same" 감지 → `[EDIT ERROR - IMMEDIATE ACTION REQUIRED]` 안내 덧붙임 | 없음 | `OC/hooks/edit-error-recovery/hook.ts:6-55` |
| json-error-recovery | `tool.execute.after` | JSON 파싱 오류 정규식 8종, 제외 툴 20종, 1회만 안내 | 없음 | `OC/hooks/json-error-recovery/hook.ts:3-66` |
| compaction-context-injector | `session.compacting`/autocontinue/`event` | 6섹션 체크포인트 프롬프트(≈2.6KB) 주입, 복구 쿨다운 60초 | 없음 | `OC/hooks/compaction-context-injector/hook.ts:39-173` |
| compaction-todo-preserver | `session.compacting`, `event: session.compacted` | todo 스냅샷 후 컴팩션 뒤 비어 있으면 복원(`opencode/session/todo` 동적 import) | 없음 | `OC/hooks/compaction-todo-preserver/hook.ts:84-244` |
| rules-injector | `tool.execute.before/after`(read/write/edit), `event` | `.omo/rules`, `.claude/rules`, `.cursor/rules`, `.github/instructions`, `.opencode/rules` 등의 `.md/.mdc`를 경로 glob 매칭으로 `[Rule: path]` 블록 주입 | 캐시 `<data>/opencode/storage/rules-injector` | `PK/rules-engine/src/constants.ts:3-25`, `OC/hooks/rules-injector/hook.ts:36` |
| directory-agents/readme-injector | 동일 | 상위 디렉터리의 AGENTS.md/README 주입(OpenCode ≥1.1.37에서는 agents 쪽 자동 비활성) | 없음 | `OC/plugin/hooks/create-tool-guard-hooks.ts:80-93` |
| (공통 캡) dynamic-truncator | — | 주입량 ≤ min(남은 컨텍스트×0.5, 50K 토큰) | — | `OC/shared/dynamic-truncator.ts:15,37-56` |
| tool-pair-validator | `messages.transform` | 결과 없는 tool part를 `error`로 보정 | 없음 | `OC/hooks/tool-pair-validator/tool-result-repair.ts:29-68` |
| write-existing-file-guard | `tool.execute.before`, `event` | read한 적 없는 기존 파일에 write → "File already exists. Use edit tool instead." throw. `overwrite:true` 또는 `.omo/**`는 예외 | 없음 | `OC/hooks/write-existing-file-guard/tool-execute-before-handler.ts:129-192` |
| hashline-read-enhancer (+ hashline `edit`) | `tool.execute.after`(read/write) | `hashline_edit:true`일 때 read 각 줄을 `N#XX|content`로 바꾸고, `edit`를 해시 앵커 기반(set_line/replace_lines/insert…)으로 교체. XX = xxhash32(줄번호+내용) 2글자 | 없음 | `OC/hooks/hashline-read-enhancer/hook.ts:11-66`, `PK/hashline-core/src/*` |
| think-mode | `chat.message` | `think|ultrathink`(+다국어) 키워드 → `message.variant="high"` | 없음 | `OC/hooks/think-mode/detector.ts:35-49` |
| unstable-agent-babysitter | `event: session.idle`(메인) | 불안정 표시된 백그라운드 작업이 120초 유휴면 메인에 리마인더 재프롬프트 | 없음 | `OC/hooks/unstable-agent-babysitter/unstable-agent-babysitter-hook.ts:207-262` |
| delegate-task-retry | `tool.execute.after`(task) | 인자 오류 패턴 9종 → 재시도 안내 | 없음 | `PK/delegate-core/src/retry-patterns.ts:7-70` |
| model-fallback / runtime-fallback | `chat.message` / `event` | 선제적 모델 체인 교체 / 429·5xx 반응형 재시도(3회, 쿨다운 60s, 기본 off) | 없음 | `OC/hooks/runtime-fallback/constants.ts:13-21` |
| background-notification | `event`(message.*, session.*), `chat.message` | BackgroundManager로 이벤트 전달, 부모 깨우기 큐(100ms 디바운스) | 없음 | `OC/hooks/background-notification/hook.ts:20-55` |
| agent-usage-reminder / category-skill-reminder | `tool.execute.after`, `messages.transform` | grep/glob 직접 호출 n회 후 "위임해라" 리마인더 주입 | 없음 | `OC/hooks/agent-usage-reminder/constants.ts:3-30`, `OC/hooks/category-skill-reminder/hook.ts:10-28` |
| ast-grep-sg-provision | `event: session.created` | **ast-grep 0.43.0 바이너리 다운로드**(`~/.omo/runtime/ast-grep/`) | 네트워크 | `OC/hooks/ast-grep-sg-provision/hook.ts:55-70` |
| interactive-bash-session | `tool.execute.after`, `event` | tmux 세션 관리 | **tmux** | `OC/hooks/interactive-bash-session/` |
| auto-update-checker | `event` | npm 조회 | 네트워크 | `OC/hooks/auto-update-checker/` |

설치본 4.19.4에만 있는 훅(업스트림에서 제거/대체): `codegraph-bootstrap`, `preemptive-compaction*`, `start-work`, `session-notification`, `tool-output-truncator`(HookName 59종, `…/dist/config/schema/hooks.d.ts`). 업스트림에만: `ulw-execute`, `native-edition-nudge`, `momus-review-persistence`.

### 1.3 툴 (`OC/plugin/tool-registry.ts:52-85`)

| 툴 | 게이트 | description 크기 | 의존 |
|---|---|---|---|
| `task`(delegate-task; `delegate_task`라는 이름의 툴은 없음) | 항상 | 동적, 본문 4,325B + 카테고리/에이전트/스킬 목록 (09-22 실측 ≈2.5K 토큰) | BackgroundManager, SDK 자식 세션 |
| `call_omo_agent` | 항상 | ≈503자 | explore/librarian 전용 자식 세션 |
| `background_output`, `background_cancel` | 항상 | 447 / 130자 | BackgroundManager |
| `session_list/read/search/info` | 항상 | 651/751/833/526자 | OpenCode 세션 스토리지 |
| `look_at` | multimodal-looker 활성 시 | 345자 | 자식 세션(비전) |
| `skill`, `skill_mcp` | 항상 | skill ≈487+1,242+목록(17개 스킬 요약 13.5K자, 09-22 실측), skill_mcp ≈176 | SkillMcpManager(MCP 프로세스 spawn) |
| `interactive_bash` | tmux가 PATH에 있을 때 | 301자 | **tmux** |
| `grep`, `glob`(OpenCode 내장 대체) | 항상 | ≈500자 | **ripgrep 14.1.1 다운로드**(`~/.cache/oh-my-opencode/bin/rg`) |
| `edit`(hashline) | `hashline_edit:true` | 4,712자 | hashline-core |
| `create_goal/update_goal/get_goal` | `goal.enabled` | — | `.omo/goal` |
| `team_*` 13종 | `team_mode.enabled` | — | tmux + BackgroundManager |
| `monitor_*` 4종 | `monitor.enabled` | — | MonitorManager |
| `task_create/get/list/update` | task system | — | 파일 저장소 |
| `lsp_*`(status/diagnostics/goto_definition/find_references/symbols/rename/format…) | 내장 MCP `lsp` | — | **`@code-yeongyu/lsp-daemon`** 데몬(`~/.omo/lsp-daemon`), 언어 서버는 다운로드하지 않고 설치 힌트만 |
| `ast_grep`(MCP: search/rewrite/scan) | senpi 에디션만 배선 | — | ast-grep 바이너리 |
| `codegraph_*` 9종 | **4.19.4 설치본에만 존재**, 업스트림은 폐기(마이그레이션 코드만 잔존) | — | — |

전역 설정 쓰기(`OC/plugin-handlers/tool-config-handler.ts:61-75,156-161`): `config.tools = {grep_app_*:false, LspHover/LspCodeActions/LspCodeActionResolve:false, task_*:false, teammate:false, (task system 시 todowrite/todoread:false)}`, `config.permission = {webfetch:allow, external_directory:allow, …기존, task:deny}`. `experimental.max_tools`로 플러그인 툴 수 상한 트리밍(`tool-registry-trimming.ts`).

### 1.4 백그라운드 태스크 매니저 (`OC/features/background-agent/`)

- 자식 세션: `client.session.create({parentID})` → `promptAsync({queueBehavior:"defer"})`(`spawner.ts:58-61,100-150`).
- 동시성: `modelConcurrency[model]` → `providerConcurrency[provider]` → `defaultConcurrency` → 5; 0=무제한(`concurrency.ts:24-38`). 설정 키: `background_task.{defaultConcurrency, providerConcurrency, modelConcurrency, maxDepth(3), maxLiveDescendantsPerRoot(24), staleTimeoutMs, taskTtlMs, maxToolCalls, circuitBreaker{…}}`(`OC/config/schema/background-task.ts:4-28`).
- 폴링 3초(`constants.ts:4-17`), stale 45분, TTL 30분.
- 루프 탐지: `tool::JSON(sorted input)` 시그니처 연속 20회 또는 총 4,000회 → 취소(`loop-detector.ts:21-87`, `manager.ts:1857-1888`).
- 부모 깨우기: `promptAsync({noReply: !(allComplete||failure)})`, 사용자가 타이핑 중이면 noReply로 보류(`parent-wake-prompt-dispatch.ts:30-60`, `parent-wake-flush-runner.ts:92-100`).

### 1.5 상태 파일

| 경로 | 스키마 | 쓰는 쪽 |
|---|---|---|
| `<project>/.omo/run-continuation/<sessionID>.json` | `{sessionID, updatedAt, sources:{todo|stop|background-task:{state, reason?, updatedAt}}}` | stop-continuation-guard, `background-task-marker.ts:14-35`; todo-continuation-enforcer가 삭제(`OC/features/run-continuation-state/constants.ts:1`, `storage.ts:10-11`) |
| `<project>/.omo/boulder.json` | `active_work_id, works{}, active_plan, session_ids[], task_sessions{…}`(`PK/boulder-state/src/types.ts:2-60`) | ulw-execute/atlas 훅 |
| `<project>/.omo/plans/`, `.omo/notepads/`, `.omo/goal/`, `.omo/ulw-loop/<sid>/` | 계획 md 체크리스트 / goal json | prometheus, atlas, goal |
| `<XDG data>/opencode/storage/{rules-injector,directory-agents,directory-readme,agent-usage-reminder}` | 세션별 주입 캐시 | 각 훅 |
| `~/.omo/omo.jsonc`, `<project>/.omo/omo.jsonc` | 설정(`PK/omo-config-core/src/loader/paths.ts:28-60`) | 사용자 |
| `~/.omo/memory/agents/<id>/…` (memory-core, git 기반 md) | — | **senpi 에디션만** 주입(`PK/omo-senpi/src/components/memory/index.ts:145`); omo-opencode에는 memory 툴 없음 |

### 1.6 설정 스키마 (`OC/config/schema/oh-my-opencode-config.ts`)

최상위 키: `new_task_system_enabled, default_run_agent, agent_order, agent_definitions, disabled_{mcps,agents,skills,hooks,commands,tools,providers}, mcp_env_allowlist, hashline_edit, telemetry, model_fallback, agents, categories, claude_code, sisyphus_agent, comment_checker, experimental, auto_update, skills, goal, ralph_loop(폐기→goal), runtime_fallback, background_task, notification, model_capabilities, openclaw, i18n, monitor, team_mode, keyword_detector, babysitting, git_master, browser_automation_engine, websearch, tmux, tui, sisyphus, ulw_execute, start_work, default_mode, _migrations`. omo-config-core(strict)에 `[opencode]/[native]/[senpi]/[codex]` 하네스 블록(`PK/omo-config-core/src/schema/config.ts:81-107`). 4.19.4 설치본 스키마(`…/dist/oh-my-opencode.schema.json`)에는 `codegraph`가 남아 있고 `ulw_execute`가 없음 — 사용자 `~/.omo/omo.jsonc`의 주석이 지적하듯 strict 스키마라 모르는 키가 있으면 파일 전체 무효.

### 1.7 Senpi/omo-ai 네이티브 에디션

`omo-ai`는 `@code-yeongyu/senpi` 엔진 CLI를 `--extension <pkg>/plugin`으로 띄우는 런처(`PK/omo-native/AGENTS.md:1-10`). 상태: 엔진 홈 `~/.omo/agent`(`PK/omo-native/bin/lib/agent-dir.js:15,33-43`), 태스크 `~/.omo/agent/projects/<basename>-<sha12>/senpi-task`, 메모리 `~/.omo/memory`. 프로젝트 안에는 `.omo/boulder.json`, `.omo/plans`, `.omo/ulw-loop/<sid>/`, `.omo/ulw-execute/ledger.jsonl`, `.omo/evidence` 등을 씀(설치본 `omo-ai/plugin/extensions/omo.js`에서 `join(a,".omo","boulder.json")`, `join(a,".omo","ulw-execute","ledger.jsonl")` 확인). **`.omo/run-continuation`은 쓰지 않음**(omo-senpi/senpi-task/omo-native 전체 grep 0건).

---

## 2. 설치 상태와 충돌

### 2.1 버전

| 구성 | 설치 | 업스트림 | 비고 |
|---|---|---|---|
| OpenCode 플러그인 | 4.19.4 (2026-09-21 캐시) | 5.1.60 (2026-11-04) | `@latest`는 설치 시점에 4.19.4로 고정됨(`~/.cache/opencode/packages/oh-my-openagent@latest/package.json`). 두 메이저 사이에 codegraph 폐기, goal로 ralph-loop 대체, hashline edit, memory-core(네이티브), ulw-execute 추가 |
| Senpi 에디션 | omo-ai 5.0.0-0.beta.80 + senpi 2026.9.20 | — | 마지막 활동 2026-09-21(`~/.omo/agent/OmO-debug.log`, EIO 크래시로 끝남) |
| OpenCode | 1.18.35 | — | 09-22 문서 당시 1.18.32 |

### 2.2 두 플러그인이 함께 로드될 때 실제로 일어나는 일 (저장소 루트에서 `opencode debug config` 실측)

로드 순서(`plugin_origins`): ① `oh-my-openagent@latest`(global) → ② `~/.config/opencode/plugins/orca-opencode-status.js`(global) → ③ `R/.opencode/plugins/otter.ts`(local). OpenCode 로더는 설정 문서 순서대로 `plugin[]`을 모으고 디렉터리의 `{plugin,plugins}/*.{ts,js}`를 뒤에 붙이므로(바이너리 내 `config-plugin` 서비스), **OMO의 `config` 훅이 먼저, otter가 나중에** 실행된다.

결과(유효 설정):
- `default_agent = "Sisyphus - ultraworker"`. OMO가 `config.default_agent = "sisyphus"`를 무조건 쓰고(`OC/plugin-handlers/agent-config-assembly.ts:144-152`; 4.19.4 번들 동일), otter는 `config.default_agent ??= "main"`(`S/hooks/config.ts:187`)이라 양보한다. → **이 저장소에서 `opencode`를 열면 otter `main`이 아니라 Sisyphus로 시작한다.**
- 에이전트 20개 공존: OMO 10개(Sisyphus 32,179자, Atlas 29,088, Metis 13,083, Momus 6,543, oracle 6,153, Junior 2,494, Prometheus 1,119, multimodal-looker 1,656, build/plan hidden) + otter `main` 2,042자 / `worker` 1,628 / `reviewer` 1,509 + 워크플로 역할 7개(hidden). OMO의 `config.agent = {…builtin, …기존 config.agent(mode 미지정 시 subagent 강제)}`는 "통째 재할당이되 기존 항목 보존"이라(`agent-config-assembly.ts:203-213`) 역순이었어도 otter 에이전트는 살아남지만, otter `main`은 `mode:"all"`을 명시해 subagent 강등은 피한다(`S/agents/prompts.ts:171`).
- 툴 오염(`opencode debug agent`): otter `main` 22개 중 OMO 툴 10개(`background_cancel, background_output, call_omo_agent, interactive_bash, look_at, session_info, session_list, session_read, session_search, skill_mcp`), `reviewer` 14개 중 같은 10개 → 읽기 전용 계약 파괴(doctor D09b FAIL과 일치). 이 10개 description만 ≈4.7K자 ≈1.2K 토큰이 모든 otter 역할의 프리픽스에 들어간다. OMO는 플러그인 툴을 전 에이전트에 등록하고 permission으로만 가리는데, otter 에이전트는 OMO의 deny 목록에 없다.
- 명령 충돌: OMO가 `ulw, hyperplan, goal, start-work, stop-continuation, refactor, remove-ai-slops, init-deep, handoff` + 스킬 명령을, otter가 `stop, continue, status, plan, approve, reject, cancel`을 등록. 이름 충돌은 없지만 `/plan`(otter)과 `/hyperplan`(OMO)이 다른 계획 체계다.
- **동작 중복**: (a) 키워드 `ulw`를 OMO keyword-detector(`OC/hooks/keyword-detector/constants.ts:16`)와 otter(`S/modes/detect.ts:1-52`)가 **둘 다** 잡아 ultrawork 프롬프트(≈5.2K 토큰)와 otter 모드 지시가 한 메시지에 동시 주입된다. (b) `session.idle`에 OMO todo-continuation-enforcer와 otter `S/loop/idle.ts`가 둘 다 재프롬프트를 쏜다(OMO는 todo 기반, otter는 모드/원장 기반; 서로의 breaker를 모른다). (c) OMO write-existing-file-guard가 otter worker의 read 없는 `write`를 throw로 막아 otter의 반복 가드·복구 힌트와 다른 오류 경로를 만든다. (d) `permission.task=deny`는 둘 다 같은 값.
- 상태 디렉터리: 겹치지 않는다. OMO 플러그인 → `R/.omo/run-continuation/ses_*.json`(09-21·09-29·09-30 3건, `sources.background-task: idle`; `.gitignore:5`로 무시됨). Senpi → `~/.omo/agent`, 프로젝트 `.omo/{plans,boulder.json,ulw-loop,ulw-execute}`. otter → `$XDG_STATE_HOME/otter/<sha1(worktree)>/`(`S/state/store.ts:1-9,53`)와 `R/.otter/{otter.jsonc,workflows,plans,handoffs}`. otter 소스에는 `.omo`/`run-continuation` 참조가 0건(경고 문자열 `S/hooks/config.ts:38,56-60`만 있음). Senpi는 별도 프로세스라 OpenCode 플러그인 충돌과 무관.

### 2.3 권장 해결

1. `~/.config/opencode/opencode.jsonc`의 `"plugin": ["oh-my-openagent@latest"]`에서 OMO를 제거한다(이미 `R/framework/README.md:1950-1956`과 doctor D05c가 요구). OpenCode `plugin[]`은 문서 간 **합집합**이라 프로젝트 설정에서 뺄 수 없으므로, OMO를 쓰고 싶은 다른 프로젝트가 있으면 그 프로젝트의 `.opencode/opencode.jsonc`에 `"plugin": ["oh-my-openagent@latest"]`로 내려 쓰는 것이 유일한 분리 방법이다.
2. 사용자 워크플로에 미치는 효과: otter 저장소에서는 `default_agent`가 `main`으로 돌아오고 프리픽스에서 OMO 툴 10개와 Sisyphus 32K자가 빠진다. 다른 프로젝트에서는 OpenCode 기본 build/plan 에이전트만 남고 `/ulw`, `/hyperplan`, `/init-deep`, OMO 스킬 명령(`git-master`, `debugging` 등)과 lsp MCP가 사라진다. `~/.omo/omo.jsonc`는 그대로 두어도 무해(Senpi가 `[senpi]` 블록을 계속 읽음). 코드 측 보완으로 otter가 interactive 모드일 때 `config.default_agent = "main"`을 강제(`S/hooks/config.ts:187`, `??=` → 조건부 대입)하면 "Sisyphus로 시작" 문제만은 막을 수 있으나 툴 오염·이중 idle 루프는 남는다.
3. Senpi(`omo` 명령)는 손댈 필요 없음. 단, `.omo/` 하위를 otter가 쓰지 않는다는 전제를 doctor에 한 줄 추가할 가치는 있다(현재 D05c는 플러그인 목록만 본다).

---

## 3. 가용성 판정 (otter 아키텍처: 엔진=원샷 CLI 서브프로세스, 네이티브 툴 off, JSON 봉투, 호스트가 승인 후 실행)

| OMO 구성요소 | 판정 | 근거 |
|---|---|---|
| 키워드/모드 감지 + sanitizer | **otter에 이미 있음** `S/modes/detect.ts:1-52,88-93,128`, `S/modes/sanitize.ts:5-17`, `S/modes/markers.ts:1-40`, `S/hooks/chat-message.ts:339,400` | ulw/plan/data/cancel + 한국어 alias, 코드블록·URL·인용 제거, 정보성 질문 억제. `team` 키워드만 없음 |
| idle 지속 루프(todo-continuation, stagnation, breaker) | **이미 있음** `S/loop/idle.ts:46-54,61,254-261`, `S/config.ts:367-371`(20회/2h/정체3/실패5/컴팩션가드60s), `S/hooks/event.ts:357` | 질문 대기 감지도 있음(`idle.ts:61`). OpenCode 경로 전용(CLI 경로는 호스트 루프가 대신함) |
| run-continuation/boulder 지속 상태 | **이미 있음(다른 설계)** `S/state/store.ts:53`, `S/flow/state.ts:1-6`, `S/workflows/checkpoint.ts:85,101`, `S/flow/resume.ts:187`, `S/hooks/chat-message.ts:624` | 프로젝트 밖(XDG state)에 저장, 자동 재개 없이 `<otter-resume>` 제안 + admission epoch. boulder의 "다음 세션 자동 이어가기"는 의도적으로 안 함 |
| 백그라운드 병렬 매니저 + 동시성 | **이식 불가(의도적)** `S/orchestration/queue.ts:95`("serially"), `S/tools/delegate.ts:1-3` | 단일 Ollama 슬롯·캐시 격리 때문에 직렬 큐가 설계 계약(09-22 §5.5). CLI 엔진에는 자식 세션 개념이 없음. 루프 탐지·TTL은 `task_ttl_ms/queue_ttl_ms`(`S/config.ts:254-290`)로 이미 있음 |
| 동일 툴콜 반복 차단 | **이미 있음** `S/guards/repeat.ts:1-36`(limit 2, `S/config.ts:357`), `S/hooks/tool-before.ts:249-253`, `S/hosts/tool-policy.ts:159-161`; n-gram 텍스트 반복 `S/guards/repetition.ts:1-20` | OMO loop-detector(연속 20회)보다 엄격 |
| edit/json 오류 복구 힌트 | **이미 있음** `S/guards/recover.ts:9-47`(OMO 출처 명시), `S/hooks/tool-after.ts:73`, `S/hosts/tool-policy.ts:186` | 힌트 ≤200자 |
| 툴 출력 트리밍 | **이미 있음** `S/guards/trim.ts:4,22`, 캡 `S/config.ts:358-360` | head/tail 70/30 |
| todo 보존 + 컴팩션 체크포인트 | **이미 있음** `S/guards/todos.ts:13-22`, `S/hooks/compacting.ts:12-77`(≤600자), `S/hooks/config.ts:189`(auto/prune) | OMO 6섹션 2.6KB보다 작게 유지 |
| comment-checker | **이식 가능(바이너리 없이)** | 외부 바이너리 다운로드는 "의존성 추가 금지"에 걸림. 호스트 측 정규식 휴리스틱(diff에 추가된 주석만 검사)으로 힌트 주입은 가능. 현재 otter에 없음 |
| rules/AGENTS.md/README 주입 | **이식 가능(축소형)** | otter는 `S/hosts/cli-transport.ts:454-461`에서 codex `project_doc_max_bytes=0`·`--ignore-rules`, claude `--setting-sources ""`로 프로젝트 문서를 **일부러 차단**(프리픽스 예산). 경로 glob 매칭·캡 300자·세션당 파일 1회 조건의 축소판은 예산 안에서 가능. §4-2 |
| hashline edit | **이식 가능(opt-in)** | otter edit는 `{path, oldText, newText}` 정확히 1회 일치(`S/hosts/cli-tools.ts:157-160,463-469`), `multiedit`도 동일. 호스트가 read 결과를 렌더하므로 `N#XX|` 형식은 CLI 경로에서도 가능. 단 read 한 줄당 +2 토큰. §4-5 |
| write-existing-file guard | **이식 가능(S)** | CLI `write`는 기존 파일을 덮어씀(`S/hosts/cli-tools.ts:471-472`; `O_EXCL`은 신규 파일에만 `:447`). §4-1 |
| think-mode | **부분 있음 → 이식 가능(S)** `S/hooks/chat-params.ts:68-72`(워커·리뷰어만 `reasoningEffort:none`), `S/hosts/tool-policy.ts:123`, `S/hosts/cli-transport.ts:466`(`--think=false` 고정) | 켜는 쪽 스위치(턴 단위)가 없음. §4-3 |
| model/runtime fallback | **이식 가능(제안형, M)** | otter는 "fallback execution" 금지(`S/hosts/cli-host.ts:587,1314,1411`). 자동 전환이 아니라 오류 분류 → 엔진 전환 **제안**(로드맵 3-A)으로만. §4-4 |
| session_list/read/search 툴 | **이식 불가(설계상 불필요)** | otter는 모델 호출형 세션 툴 대신 `memory`(`S/tools/memory.ts:1-5`, 위키 recall)와 사람용 `/history /sessions /facts /search`(`S/hosts/interactive-session.ts:3414`)를 둠. OpenCode 세션 스토리지 의존이라 CLI 엔진에 맞지 않음 |
| look_at(비전) | **이식 불가(현 정책)** | codex `features.view_image=false`(`S/hosts/cli-transport.ts:458`), 툴에 image 0건 |
| LSP / ast-grep / codegraph | **이식 불가(의존성)**; 부분 대체 있음 `S/repo-search/`(Graphify 고정 커밋, `S/repo-search/runtime.ts:14`, planning-only main에만 `S/hosts/tool-policy.ts:147`) | LSP 데몬·ast-grep·rg 바이너리 다운로드는 금지 항목. codegraph는 업스트림도 폐기 |
| skill 툴/로더 | **이미 있음** `S/tools/skill.ts:8-10`, `S/hosts/cli-host.ts:556-557`(턴당 ≤12개, 설명 160자), `S/state/ledger.ts:66` | OMO가 17개 요약 13.5K자를 상시 점유하는 것과 반대로 과제 연관 상위 12개만 |
| slash 명령 | **이미 있음** `S/hooks/config.ts:156-185`, `S/hooks/command.ts:20-55`, CLI `S/hosts/interactive-actions.ts` | `/stop /continue /status /plan /approve /reject /cancel` + CLI 30여 종(`/undo` 포함) |
| interactive_bash(tmux) | **이식 불가(의존성·승인 모델)** | 사람용 `!<cmd>`와 터미널 양도형 대화식 bash는 있음(`S/hosts/interactive-session.ts:145`) |
| team mode / mailbox | **이식 불가(단일 슬롯)** | 0건. 직렬 큐 설계 |
| 계획 검증(prometheus/metis/momus) | **이미 있음(다른 계약)** `S/workflows/ralplan.ts:26-42,131-149`, `S/workflows/ralplan-driver.ts:164`, `S/flow/plan.ts:54`, 리뷰어 판정 `S/orchestration/queue.ts:1115-1140` | planner→architect(CLEAR/WATCH/BLOCK+APPROVE/…)→critic(OKAY/ITERATE/REJECT), 타입드 `lane_verdict`; 위임 리뷰어는 마지막 줄 `ACCEPT|REJECT:` |
| 프롬프트 예산 | **선언만(부분)** `S/config.ts:131,354`(8000/5000/3000, 런타임 미사용), doctor가 1500/800/600 강제(`R/scripts/otter-doctor.sh:59`, D06) | 실제 주입 크기는 main 2,042자/worker 1,628/reviewer 1,509 |
| 컴팩션 설정 | **이미 있음** `S/hooks/config.ts:189`, `S/hooks/compacting.ts:47` | `tail_turns` 없음 |
| tool-pair-validator | **해당 없음** | CLI 경로는 호스트가 대화창을 직접 구성해 고아 tool part가 생기지 않음(`S/hosts/cli-host.ts:405-415` 봉투 파서가 fail-closed) |
| delegate-task-retry | **부분 있음** `S/guards/recover.ts` 규칙 확장으로 흡수 가능 | otter `delegate`는 `task_id` 하나라 인자 오류 패턴이 적음 |
| memory-core(git 기반 md 메모리) | **이미 있음(다른 구현)** `S/wiki/`, `S/tools/memory.ts`, `S/sessions/digest.ts:68,138` | otter 핵심 가치(이력→자산)와 동일 영역, senpi 전용 구현을 가져올 이유 없음 |

---

## 4. otter 고도화 추천 Top 5 (토큰 비용 낮고 원샷 CLI 엔진에서 동작하는 것 우선)

### 4-1. read-before-overwrite 가드 (`write`가 기존 파일을 덮어쓰려면 같은 세션에서 read했거나 `overwrite:true`) — **S, 위험 낮음**
- 무엇: OMO write-existing-file-guard(`OC/hooks/write-existing-file-guard/tool-execute-before-handler.ts:129-192`)의 규칙만 가져온다. 세션별 read 경로 집합(상한 1,024)을 두고, 기존 파일에 대한 `write`를 "read한 적 없음 → 거부 + 'edit를 쓰거나 먼저 read'" 힌트로 바꾼다. `.otter/**`·신규 파일은 예외.
- 고치는 한계: CLI `write`가 무조건 덮어씀(`S/hosts/cli-tools.ts:471-472`). Gemma가 실패한 `write`를 13회 반복하고 write 오류율 57%였던 실측(09-22 §3)과 결합하면, 반복 가드 전에 "애초에 덮어쓰기 금지"가 더 싸다.
- 위치: `S/hosts/tool-policy.ts`(RepeatGuard 옆, `:128,159-161` 패턴) + `S/hosts/cli-tools.ts` write(`:440-475`); OpenCode 경로는 `S/hooks/tool-before.ts:249-253` 옆. 힌트 문구는 `S/guards/recover.ts` 규칙 테이블에 1행 추가.
- 토큰: 프롬프트 0, 거부 시 힌트 ≤200자.

### 4-2. 경로 범위 규칙 주입 (`.otter/rules/*.md`, glob 프런트매터, 파일당 세션 1회, ≤300자) — **S/M, 위험 낮음(캡 필수)**
- 무엇: OMO rules-injector(`PK/rules-engine/src/constants.ts:3-25`)의 "읽거나 편집한 파일 경로에 매칭되는 규칙만, 툴 결과 뒤에 덧붙임" 아이디어. 전체 AGENTS.md 주입이 아니라 glob 매칭된 규칙만, 세션당 파일 1회, 300자 캡.
- 고치는 한계: otter는 프리픽스 예산 때문에 프로젝트 문서를 전부 차단한다(`S/hosts/cli-transport.ts:454-461`). 그 결과 "이 디렉터리는 Bun test만", "이 파일은 생성물이니 수정 금지" 같은 지역 규칙이 모델에 전혀 닿지 않는다. 툴 결과 뒤에 붙는 형태는 프리픽스를 바꾸지 않아 정적 프리픽스 불변 계약과 양립한다.
- 위치: 새 `S/guards/rules.ts`(로더·매처·세션 dedupe) → `S/hooks/tool-after.ts:65-73`와 `S/hosts/tool-policy.ts:181-186`(trim·recover 다음). 설정 키 `guards.rules_max_chars`를 `S/config.ts:357-360` 옆에.
- 토큰: 매칭될 때만 ≤75 토큰, 세션당 파일 1회.

### 4-3. 턴 단위 think 토글 (`think`/`깊게` 키워드 → 그 턴만 reasoning ON; 기본은 main도 OFF 옵션) — **S, 위험 낮음**
- 무엇: OMO think-mode(`OC/hooks/think-mode/detector.ts:35-49`)를 otter 모드 감지기에 키워드 1종으로 추가하고, 반대로 main의 기본 thinking을 설정으로 끌 수 있게 한다.
- 고치는 한계: otter는 끄는 스위치만 있다(워커·리뷰어 `reasoningEffort:none` `S/hooks/chat-params.ts:68-72`, 로컬 CLI `--think=false` 고정 `S/hosts/cli-transport.ts:466`). main은 `opencode.jsonc`의 모델 기본(26B thinking ON, 호출당 400~500 토큰·7초)을 그대로 따른다. 턴 단위 토글이면 평소 턴에서 호출당 ≈450 토큰·7초를 아끼고 어려운 턴에만 켠다.
- 위치: `S/modes/detect.ts`(키워드 테이블, 기존 sanitizer 재사용) → `S/modes/instructions.ts`(모드 지시가 아니라 플래그만) → OpenCode: `S/hooks/chat-params.ts`(main에도 `reasoningEffort` 대입, 현재 `if (agent === "main") return` 분기 수정) / CLI: `S/hosts/cli-transport.ts:466`의 `--think` 인자를 턴 플래그로. 세션 중 프리픽스는 바뀌지 않는다(옵션은 요청 파라미터).
- 토큰: 0(요청 옵션).

### 4-4. 엔진 오류 분류 + 전환 제안 (로드맵 3-A, OMO runtime-fallback의 분류표만 차용) — **M, 위험 중간**
- 무엇: OMO runtime-fallback/error-classifier(`OC/hooks/runtime-fallback/constants.ts:13-21`, `OC/features/background-agent/error-classifier.ts`)의 429·5xx·overloaded·auth 만료 분류를 CLI 종료코드/stderr/JSON 이벤트 기준으로 옮기고, 자동 전환 대신 "다른 엔진으로 이어가기(대화 유지)"를 TUI에서 한 번에 제안한다.
- 고치는 한계: 로그인 만료·한도 초과 시 오류 안내만 하고 대화가 끊긴다(로드맵 2026-10-20 §3-A). otter는 조용한 fallback 실행을 금지하므로(`S/hosts/cli-host.ts:587`) **제안형**이어야 한다.
- 위치: `S/hosts/vendor-process.ts`(종료 분류) → `S/hosts/engine-auth.ts`(auth 류) → `S/hosts/interactive-actions.ts`(제안 액션, 기존 `/model` 전환 재사용) → 디제스트에 "엔진 전환" 이벤트(`S/sessions/digest.ts`).
- 토큰: 0. 위험: 엔진별 오류 형식이 버전마다 바뀜 → 분류 실패 시 "제안 안 함"으로 fail-safe.

### 4-5. 해시 앵커 편집(opt-in, hashline 축소판) — **M/L, 위험 중간, 측정 후 결정**
- 무엇: `hashline_edit` 설정이 켜진 세션에서만 read 출력을 `N#XX|내용`으로 렌더하고(`PK/hashline-core/src/hash-computation.ts:15-26` 방식: 줄번호+내용 해시 2글자), `edit_lines({path, anchors:["12#QK","13#ZP"], replacement})` 툴을 추가해 "정확히 1회 일치 문자열" 대신 줄 앵커로 편집한다. 앵커 해시 불일치면 거부(파일이 바뀐 것).
- 고치는 한계: otter edit는 oldText가 정확히 1회 일치해야 하고(`S/hosts/cli-tools.ts:463-469`) 로컬 모델은 긴 oldText를 자주 틀린다(recover.ts의 "not found/multiple" 규칙이 그 증거). 앵커 방식은 모델이 4~5자만 정확히 옮기면 된다.
- 위치: `S/guards/trim.ts`(read 렌더 분기) + `S/hosts/cli-tools.ts`(새 툴, multiedit 옆 `:162,502`) + `S/hosts/tool-policy.ts` 역할별 허용 + doctor D09b 기대 툴 목록(`R/scripts/otter-doctor.sh:366-369`).
- 토큰: read 한 줄당 +2 토큰(200줄 read면 +400) → 기본 OFF, `tool-outcomes.sqlite`의 edit 실패율을 먼저 재고(로드맵 1-A) 실패율이 높은 역할에만 켠다. 위험: Gemma가 해시를 잘못 베끼면 편집이 거부되는데, 이는 잘못된 위치를 고치는 것보다 안전한 실패다.

보너스(우선순위 밖): 호스트 측 정규식 comment-checker(diff에 추가된 "코드를 되풀이하는 주석"만 힌트, 바이너리 없음, `S/guards/`에 S 규모); OMO todo-continuation의 지수 쿨다운(5s×2^n)은 otter `S/loop/idle.ts`의 고정 간격보다 재프롬프트 폭주에 강하므로 1줄 변경으로 가져올 만함.

---

## 5. 한 줄 결론

OMO 4.19.4는 지금 이 저장소에서 otter보다 **먼저** 로드돼 `default_agent`를 Sisyphus로 바꾸고, otter의 세 역할 모두에 OMO 툴 10개(≈1.2K 토큰)를 끼워 넣으며, `ulw` 키워드와 `session.idle` 재프롬프트를 이중으로 발화시킨다. 해결은 전역 `plugin[]`에서 OMO를 빼고 필요한 프로젝트의 `.opencode/opencode.jsonc`로 내리는 것뿐이다. OMO의 가드·복구·루프·키워드·컴팩션 메커니즘은 otter에 이미 축소판으로 있고, 아직 없는 것 중 예산 안에서 가져올 가치가 있는 것은 덮어쓰기 가드, 경로 범위 규칙 주입, 턴 단위 think 토글, 엔진 오류 분류(제안형), 그리고 측정 후의 해시 앵커 편집이다. 병렬 매니저·팀·tmux·LSP·세션 툴은 otter의 전제(단일 슬롯, 원샷 CLI, 의존성 없음)와 맞지 않아 이식 대상이 아니다.
