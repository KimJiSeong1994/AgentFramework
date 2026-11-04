# oh-my-codex(OMX) 0.21.6 심층 검토 — otter 관점 가용성·간섭 판정

- 일자: 2026-11-04
- 대상: 설치본 `/opt/homebrew/lib/node_modules/oh-my-codex` (0.21.6, `src/`는 `scripts/`만 포함, 본체는 `dist/`), 업스트림 클론(읽기 전용) `<clone>/omx` (이하 `ref/omx`), 사용자 상태 `~/.omx/`, `~/.codex/`, 프로젝트 상태 `/Users/gimjiseong/orca/projects/AgentFramework/.omx/`.
- otter: `/Users/gimjiseong/orca/projects/AgentFramework/framework` (branch `feat/otter-intro-motion-video`, master `c703a06`).
- 표기: **[검증]** = 파일·명령 실행으로 직접 확인, **[미검증]** = 확인 못 함. 모든 경로는 절대 경로.

## 0. 결론 다섯 줄

1. **OMX 훅은 otter의 `codex exec` 하위 프로세스에서 실행되지 않는다** [검증]. otter가 넘기는 `--ignore-user-config`가 `~/.codex/config.toml`(훅 trust 해시 포함)을 건너뛰기 때문이다. 같은 명령에서 이 플래그만 빼면 OMX SessionStart 훅이 cwd에 `.omx/state/…`를 쓴다.
2. **그러나 프롬프트는 샌다** [검증]. otter의 실제 argv로 codex 0.165.0을 띄워 요청 본문을 로컬 리스너로 받아 보니 `~/.codex/AGENTS.md`(OMX 25 KB "자율 실행, 허락 묻지 말 것" 지시)가 user 메시지로, `~/.codex/skills`의 OMX 스킬 24개 목록이 `<skills_instructions>`(7.6 KB)로 들어간다. otter가 의도한 1 KB 대신 호출당 ≈37 KB(≈9K 토큰)이고, 내용이 otter의 "행동마다 사람 승인 + JSON envelope" 계약과 정면 충돌한다. `project_doc_max_bytes=0`과 카탈로그의 `include_skills_usage_instructions=false`는 0.165.0에서 이를 막지 못한다.
3. 지금 당장은 2번이 발현되지 않는다. 설치된 codex가 0.165.0(10-29 18:11 교체)인데 otter 승인 목록은 0.159.3/0.163.0뿐이라 codex 엔진이 "Codex native profile verification failed"로 거부된다 [검증: 코드 + 10-29 17:53 이후 digest 0건]. 0.165를 승인하기 전에 격리(§2.4)를 먼저 넣어야 한다.
4. `~/.codex/skills`는 otter `/skills`·`/skill:` 팔레트에 import 계층으로 올라오고 `skill_trust` 때문에 동의 없이 로드되지만, 모델에게 주는 skill 도구 목록(autoCandidates)에서는 import 계층이 기본 제외라 **자동 적용 경로로는 새지 않는다** [검증].
5. OMX 구성요소 대부분(팀/tmux/서브에이전트/MCP/Rust 런타임/Stop 훅 연속 실행)은 otter 아키텍처에서 불필요하거나 불가하고, otter가 이미 더 결정적인 형태로 가진 것이 많다(원장, 직렬 큐, breaker, digest, facts, 상태줄). 이식 가치가 있는 것은 **no-progress 지문 가드, 문서 갱신 규칙, 세션 사용량·검색, 원장 lease 필드, 코드베이스 맵** 정도이며 모두 S~M 규모다.

## 1. OMX 구성요소 인벤토리

규모 [검증]: `dist/` JS 401개, `src/scripts` TS 48,033줄, `dist/scripts/codex-native-hook.js` 22,003줄(업스트림 `src/scripts/codex-native-hook.ts` 23,297줄), 스킬 29개(설치 24개), 역할 프롬프트 `prompts/*.md` 33개 111 KB, 에이전트 TOML `~/.codex/agents` 18개, Rust 크레이트 6개.

| 구성요소 | 메커니즘 | 의존성 | 프롬프트 토큰 비용 | 경로 |
|---|---|---|---|---|
| AGENTS.md "두뇌" | 자율 실행 지시문 + 위임 규칙 + 키워드 라우팅 폴백. codex가 전역 user instructions로 주입 | codex의 `$CODEX_HOME/AGENTS.md` 로딩 | 22,287 B(템플릿)/25,057 B(설치본) ≈ 6~7K 토큰, 매 턴 | `/opt/homebrew/lib/node_modules/oh-my-codex/templates/AGENTS.md`, `~/.codex/AGENTS.md` |
| 키워드 탐지 | UserPromptSubmit 훅에서 `$autopilot`, `$ultragoal`, `interview`, `plan this`, `stop/abort` 등 → skill-active-state 기록 + 한 줄 guidance 주입 | hooks.json | ≤ 수백 자/턴 | `ref/omx/src/hooks/keyword-detector.ts`(4,426줄), `keyword-registry.ts` |
| autopilot | FSM: deep-interview → ralplan → ultragoal → rework/team/code-review/ultraqa, Stop 훅으로 비종료 세션 재개 | hooks Stop, 네이티브 서브에이전트 | 스킬 7,958 B | `ref/omx/src/autopilot/fsm.ts`, `skills/autopilot/SKILL.md` |
| ultragoal / goal-workflows / performance-goal / autoresearch-goal | codex 네이티브 goal 모드(`features.goals`, `goals_1.sqlite`) 스냅샷 + `.omx/ultragoal/ledger.jsonl` 체크포인트, 벤치마크 게이트 변형 | codex goal 모드 | 스킬 4,606 B / 3,551 B / 497 B | `ref/omx/src/goal-workflows/codex-goal-snapshot.ts`, `ultragoal/artifacts.ts`, `performance-goal/artifacts.ts` |
| ralph / ultrawork | **0.21에서 제거, sunset 스텁**(`$ultragoal`/`$team`로 안내) | — | 574 B / 462 B | `skills/ralph/SKILL.md`, `skills/ultrawork/SKILL.md`; 런타임 잔존 `ref/omx/src/ralph/persistence.ts` |
| ralplan / deep-interview | Planner→Architect→Critic 합의, 소크라테스 인터뷰. skill-active-state로 Stop 훅이 완료 전 종료를 막음 | 네이티브 서브에이전트, Stop 훅 | 16,945 B / 41,261 B | `skills/ralplan/SKILL.md`, `skills/deep-interview/SKILL.md` |
| autoresearch | validator-gated 연구 루프, worktree 옵션 | git worktree | 3,139 B | `ref/omx/src/autoresearch/{contracts,goal,runtime,skill-validation}.ts` |
| team | 리더 + tmux pane 워커(worktree 옵션), 메일박스 `mailbox.json`, dispatch request(inbox/mailbox/nudge), idle pane `send-keys` 넛지, 사이드카 | **tmux 필수**, git worktree | 스킬 4,575 B + 워커 2,767 B | `ref/omx/src/team/*`(38 파일), `team/idle-nudge.ts`, `team/tmux-session.ts` |
| 태스크 원장(claim_token/lease) | `.omx/state/team/<team>/tasks/task-<id>.json`, `claim {owner, token, claimed_at, leased_until = now+15 min}`, `version`, 오류 `claim_conflict / lease_expired / invalid_transition` | pinned-atomic-file(darwin helper/janitor) | 0 | `ref/omx/src/team/state.ts:238-243, 448-456`, `team/state/tasks.ts:109`, `state/pinned-atomic-file.ts`(554줄) |
| 모드 상태 파일 | `.omx/state/<mode>-state.json`(root) / `sessions/<id>/<mode>-state.json`, 세션 우선, 단일 writer `state/operations.ts` | — | 0 | `ref/omx/docs/STATE_MODEL.md`, `ref/omx/src/state/operations.ts`(1,152줄) |
| no-progress guard | Stop 훅에서 `last_assistant_message` 지문을 `.omx/state/native-stop-state.json`에 누적, 같은 지문 8회 **이고** 10분 경과 시 `decision: block` + 진단 요구 | hooks Stop | 240자 메시지 | `ref/omx/src/scripts/codex-native-hook.ts:247-251, 21146-21215` |
| HUD | `.omx/state/*`·`metrics.json`·subagent-tracking 읽어 렌더, preset minimal/focused/full, `omx hud --tmux` 분할 pane; 별도로 codex TUI `[tui] status_line` | tmux(pane 모드) | 0 | `ref/omx/src/hud/{index,state,render,tmux,reconcile}.ts`, `.omx/hud-config.json`(`focused`) |
| 훅 (codex hooks.json) | 이벤트 SessionStart(`startup\|resume\|clear`), UserPromptSubmit, PreToolUse, PostToolUse, Stop(30 s), PreCompact, PostCompact → `codex-native-hook.js`. trust 해시는 `config.toml [hooks.state]` 15개. 추가로 `notify` 훅 + rollout 폴링 워처 | codex `features.hooks`(0.165 기본 true) | 이벤트별 수백 자 | `~/.codex/hooks.json`, `~/.codex/config.toml`, `dist/scripts/codex-native-hook.js`, `dist/scripts/notify-hook.js` |
| 서브에이전트/리더 | codex 네이티브 서브에이전트 `agent_id` 추적(`.omx/state/subagent-tracking.json`), 리더 신원 계약, 역할 TOML 18개 | codex `features.multi_agent` | 역할 프롬프트 111 KB(역할별 로드) | `ref/omx/src/subagents/tracker.ts`(1,931줄), `leader/contract.ts`, `~/.codex/agents/*.toml` |
| 알림 | Discord/Telegram/Slack/webhook 생명주기 알림, reply-listener | 네트워크 | 0 | `ref/omx/src/notifications/*` |
| session-history | `$CODEX_HOME/sessions` rollout JSONL 검색·타임라인·토큰 사용량·friction 리포트·export | codex rollout 포맷 | 0 | `ref/omx/src/session-history/{search,timeline,usage,friction,transcript,export}.ts` |
| document-refresh | 규칙(sourceGlobs → refreshTargets) 대비 `git commit` PreToolUse·Stop 최종 핸드오프에서 **경고만**, 면제 접두 `Document-refresh: not-needed \|` | hooks | 경고 문자열 | `ref/omx/src/document-refresh/{config,enforcer}.ts` |
| evals | zod 스키마 run record, config별 pass/fail/difficult, 사용량 귀속이 불완전하면 `null`(0으로 숨기지 않음), 운영자 분 별도 | — | 0 | `ref/omx/src/evals/astra-defaults/{suite,report,usage}.ts` |
| MCP | state(읽기 전용 projection), memory, wiki, trace, code-intel, hermes 브리지 | MCP SDK | 툴 스키마 | `ref/omx/src/mcp/*`; 이 머신 `mcpMode: none`, `config.toml`에 `[mcp_servers]` 없음 [검증] |
| sidecar | 팀 스냅샷을 tmux 우측 pane에 렌더 | tmux | 0 | `ref/omx/src/sidecar/*` |
| Rust crates | runtime(lease mutex), runtime-core(authority/dispatch/mailbox/replay), explore-harness, mux(tmux), sparkshell(codex 브리지·redaction), api | cargo 빌드 | 0 | `ref/omx/crates/*`; 로컬 `~/.omx/runtime/bin`(7-28) |
| codebase-map / agents-overlay | SessionStart에 `git ls-files` 기반 맵 ≤1,000자, 오버레이 ≤3,500자 | hooks | ≤4.5K자/세션 | `ref/omx/src/hooks/codebase-map.ts:24`, `hooks/agents-overlay.ts:46` |
| wiki | `omx_wiki/` 세션 캡처·요약 주입 | — | 세션 시작 요약 | `ref/omx/src/wiki`, `skills/wiki` |

## 2. 설치 상태와 간섭

### 2.1 등록된 것 [검증]

`~/.codex/config.toml`:
- `notify = ["node", ".../dist/scripts/notify-hook.js"]`, `developer_instructions = "You have oh-my-codex installed. AGENTS.md is the orchestration brain…"`(≈1 KB), `model = "gpt-6-astra"`.
- `[features] child_agents_md = true, hooks = true, goals = true` — `child_agents_md`는 0.165.0이 "unrecognized… ignored"로 경고한다(캡처 출력에서 확인).
- `[tui] status_line = [model-with-reasoning, git-branch, context-remaining, total-input-tokens, total-output-tokens, five-hour-limit, weekly-limit]`.
- `[hooks.state."…hooks.json:<event>:<group>:<handler>"] trusted_hash` 15건.
- `[shell_environment_policy.set] USE_OMX_EXPLORE_CMD = "0"`. MCP 서버 없음.

`~/.codex/hooks.json`: 모든 이벤트에 두 출처가 있다.
- Orca `~/.orca/agent-hooks/codex-hook.sh` (SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/SubagentStart/SubagentStop/Stop): `ORCA_AGENT_HOOK_ENDPOINT`·`ORCA_PANE_KEY`가 없으면 즉시 종료. otter는 환경 allowlist(`framework/src/hosts/vendor-process.ts:11-19`)로 `ORCA_*`를 넘기지 않으므로 어차피 무해.
- OMX `codex-native-hook.js` (SessionStart matcher `startup|resume|clear`, UserPromptSubmit, PreToolUse, PostToolUse, Stop timeout 30, PreCompact, PostCompact).

프로젝트 `.omx/`: `state/sessions/01a1…` 5건은 **VS Code Codex TUI 세션**이 만든 것이다(rollout `originator: codex-tui, source: vscode, cli_version 0.166.0`; `session-owner.json`의 pid 54679 = app-server 데몬, 오늘 13:12 건 포함). `logs/omx-2026-10-31.jsonl`의 `prompt_session_provenance_rejected … foreign-cwd`도 그 세션의 notify 훅 출력이다. otter 흔적은 없다. `~/.omx/`는 9-17 이후 변화 없음.

### 2.2 otter가 codex를 띄우는 방식 [검증]

`framework/src/hosts/cli-transport.ts:452-462` `nativeArgv`:
```
exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C <scratch> -m <model>
-c default_permissions="otter_text_only" -c permissions.otter_text_only={ filesystem = { "<scratch>" = "read" } }
-c model_catalog_json="<owned catalog>" -c features.code_mode=false -c features.goals=false
-c tools.experimental_request_user_input.enabled=false            (codex-profile.ts:103-118)
-c features.shell_tool=false -c features.multi_agent=false -c web_search=disabled -c features.view_image=false
-c features.sleep_tool=false -c features.apps=false -c features.plugins=false
-c include_environment_context=false -c project_doc_max_bytes=0 -c mcp_servers={} -
```
환경은 allowlist만(`vendor-process.ts:11-19`: PATH, HOME, CODEX_HOME, XDG_*, 프록시, CA) → **실제 `~/.codex`가 CODEX_HOME**. 카탈로그는 모델 메타에 `instructions_template = HOST_INFERENCE_INSTRUCTIONS`(1,047자), `shell_type = "disabled"`, `include_skills_usage_instructions = false` 등을 박는다(`codex-profile.ts:30-46`).

### 2.3 실측 1 — 훅은 안 돈다 [검증]

오프라인 재현(모델 provider를 `127.0.0.1:1`로 바꿔 네트워크 없이 훅 단계만 실행, cwd에 빈 `.omx/` 생성):
- otter 플래그 그대로(`--ignore-user-config` 포함): `.omx/` 비어 있음, `~/.omx/logs`·프로젝트 로그 변화 없음.
- `--ignore-user-config`만 제거: `.omx/state/session.json`, `.omx/state/sessions/<thread>/session-owner.json`, `.omx/logs/omx-2026-11-04.jsonl` 생성 → OMX SessionStart 훅 실행.
- `hooks` 기능은 빈 CODEX_HOME에서도 `stable true`(`codex features list`)이므로 억제 원인은 기능 플래그가 아니라 config.toml(trust 상태 포함)을 건너뛴 효과다. 내부에서 hooks.json 자체를 안 읽는지 trust 부재로 건너뛰는지는 **[미검증]**(결과는 동일).

### 2.4 실측 2 — 프롬프트는 샌다 [검증]

otter의 `createCodexProfile("gpt-6-astra")`로 카탈로그를 생성하고 §2.2 argv 그대로, provider만 로컬 HTTP 리스너(`127.0.0.1:18787`)로 바꿔 요청 본문을 받았다(`<scratch>/capture/requests.log`). 첫 요청 37,654 B:

| input 항목 | role | 크기 | 내용 |
|---|---|---|---|
| [0], [1] | developer | 1,047자 ×2 | otter HOST_INFERENCE_INSTRUCTIONS가 **두 번** 들어감(원인 미검증, 비용 소) |
| [2] | developer | 7,642자 | `<skills_instructions>` — roots `r0=~/.codex/skills`(OMX 24개: ultragoal, omx-setup, ai-slop-cleaner…), `r1=~/.agents/skills`, `r2=~/.codex/skills/.system` |
| [3] | user | 25,359자 | `# AGENTS.md instructions <INSTRUCTIONS> <!-- AUTONOMY DIRECTIVE --> YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION…` = `~/.codex/AGENTS.md` |
| [4] | user | 5자 | `ping` |

`instructions` 필드 빈 문자열, `tools: []`(네이티브 툴 제거는 성공). 즉 `project_doc_max_bytes=0`은 프로젝트 AGENTS.md만 막고 `$CODEX_HOME/AGENTS.md`는 못 막으며, `include_skills_usage_instructions=false`는 0.165.0에서 스킬 목록을 막지 못한다. 영향: (a) 호출당 ≈9K 토큰이 매 도구 라운드(최대 24회, `cli-host.ts:59`)마다 재전송, (b) "허락 묻지 말고 실행", "`$ultragoal`·네이티브 서브에이전트 사용" 지시가 otter의 승인 프로토콜과 충돌, (c) 모델이 OMX 스킬 경로를 읽으려 시도할 유인.

단, 현재는 발현되지 않는다: `codex-cli 0.165.0`(`/opt/homebrew/bin/codex → Caskroom/codex/0.165.0`, 10-29 18:11) ∉ `CODEX_SUPPORTED_VERSIONS = ["0.159.3","0.163.0"]`(`framework/src/hosts/codex-profile.ts:15`) → `supportedCodexVersion` 실패 → `SAFE_ERRORS.profile`(`cli-transport.ts:1088`). otter digest 19건 중 codex 마지막은 10-29 17:53이고 이후 어떤 엔진의 세션도 없다. 0.163.0에서 같은 누수가 있었는지는 Caskroom에 0.165.0만 남아 **[미검증]**.

### 2.5 스킬 팔레트 누수 [검증]

- `framework/src/skills/roots.ts:36-38`: `~/.codex/skills`는 `import` 계층(home). 이름 충돌 시 native 우선, `PROTECTED_NAMES`(deep-interview/ralplan/ultragoal/autoresearch)는 건너뜀(`roots.ts:595`). 따라서 OMX `plan`은 `.opencode/skills/plan`에 가려지고, 보호 워크플로 동명 스킬은 무시된다.
- `SkillSession.catalog()`(`skills/session.ts:276-300`)는 import 계층도 `custom`으로 올리고 `skill_trust`(`~/.config/otter/otter.jsonc`의 `~/.codex/skills`)로 `trusted` 표시 → `/skills`·`/skill:` 완성에 `[OMX] …` 설명으로 노출, 명시 호출 시 동의 창 없음.
- `autoCandidates()`(`session.ts:335`)는 `tier === "import" && !include.has(name)`이면 제외 → 모델의 `skill` 도구 목록에는 **안 들어간다**. 라우팅 판단(의도 제안 순위)에도 쓰이지 않는다.

### 2.6 권고

1. **0.165.0 승인 전에 codex 격리를 넣는다** (Top 5 #1). 검증된 조합: (i) `-c skills.include_instructions=false` → 스킬 블록 제거(30,691 B 잔존 = AGENTS.md), (ii) otter 소유 `CODEX_HOME`(안에 `auth.json → ~/.codex/auth.json` 심볼릭 링크만) → AGENTS.md 제거(9,487 B; 남는 4,542자는 `~/.agents/skills` 4개 + codex 번들 `.system`), `codex login status`가 "Logged in using ChatGPT"를 반환. 둘을 합치면 ≈2.4 KB. 주의: codex가 그 홈에 `state_5.sqlite-wal`(2 MB) 등 상태 파일을 만들므로 per-run scratch가 아니라 state 디렉터리 아래 **영속 1개**로 두고, auth 토큰 갱신이 심볼릭 링크를 통해 원본에 쓰이는지는 **[미검증]**(읽기만 확인).
2. 승인 프로브(`cli-transport.ts:1070-1089`)에 **요청 형태 검사**를 추가: 로컬 리스너로 1회 캡처해 input 항목이 {developer otter 지시 1개, user 프롬프트}만인지 확인. 새 codex 버전 승인 조건으로 삼는다.
3. `~/.config/otter/otter.jsonc`의 `skill_trust`에서 `~/.codex/skills` 제거. 명시 호출은 여전히 가능(동의 창 1회).
4. OMX 훅 자체는 otter에 영향이 없으므로 `omx setup --disable-hooks`는 선택 사항. VS Code/TUI codex 사용 시 이 저장소에 `.omx/state`가 계속 쌓이는데 `.omx/`는 이미 ignore 상태(git status에 미표시).

## 3. 가용성 판정

범례: **이미 있음**(otter 경로) / **이식 가능**(방법·규모) / **이식 불가·불필요**(이유).

| OMX 구성요소 | 판정 | 근거·방법 |
|---|---|---|
| 태스크 원장 + claim_token/lease | **이미 있음(부분)** `framework/src/state/ledger.ts:1-6`(세션별 `ledger.json`, 단일 writer, `.otter/handoffs/<id>/task-<n>.md`), 원자 쓰기 `state/durable.ts` | lease/claim 없음(`grep lease ledger.ts` → tmp 파일 pid뿐). 직렬 큐(`orchestration/queue.ts:1-8`)라 지금은 불필요. 병렬 워커를 넣는 날 `TaskRecord`에 `{owner, token, leasedUntil}` + 큐의 만료 lease 회수 추가: **S** |
| 모드 상태 파일(root/session, 단일 writer) | **이미 있음** `state/store.ts`, `flow/state.ts`, `workflows/*-data.ts`, `workflows/checkpoint.ts`(write-once 체크포인트 + sha) | otter가 더 엄격(체크포인트 해시, 세션 guard `workflows/session-guard.ts`) |
| no-progress guard | **이미 있음(워크플로)** `workflows/ultragoal.ts:130-135` `UG_MAX_NO_PROGRESS`, 루프 breaker `config.ts:369-373`(max_iterations 20, ttl 2 h, stagnation 3, failures 5; `loop/idle.ts`는 OpenCode 경로), n-gram 반복 abort `config.ts:360-364` | **이식 가능** `otter chat` 도구 루프(`hosts/cli-host.ts` 라운드 루프 ~1089-1463)에는 동일 호출 지문 가드가 없다. OMX 방식(지문 + repeat_count + 경과시간)을 (tool, name, input 해시) 기준으로: **S** |
| HUD / 상태줄 | **이미 있음** `tui/status-view.ts`(세그먼트 우선순위 상태줄), `tui/progress.ts`(tasks/goals/stage 진행), `/status`, `/details` | tmux 불필요. 빠진 것: 세션 토큰 사용량 — `cli-transport.ts:51-54` `observedNativeUsage`로 이미 관측하지만 digest/status에 없음(`grep usage sessions/digest.ts` → 0) → **이식 가능 S** |
| 훅(codex hooks.json) PreToolUse/PostToolUse 가드 | **이미 있음(구조적으로 상위)** 호스트가 도구를 직접 실행·승인: `security/`, `flow/bash-policy.ts`, `orchestration/gaming.ts`, `orchestration/git-boundary.ts` | otter에는 "훅"이 필요 없다. 네이티브 툴이 꺼져 있어 훅 이벤트 자체가 없음 |
| Stop 훅 연속 실행(autopilot/team/ralplan 재개) | **이미 있음(등가)** one-shot 호출의 종료 = 호스트 결정. `/continue`, 워크플로 driver(`workflows/*-driver.ts`) | 모델 "끝" 뒤 재프롬프트가 아니라 호스트가 다음 호출을 결정하므로 OMX보다 결정적 |
| 키워드 탐지 | **이미 있음** `modes/detect.ts classifyIntent` → 제안(offer) 모드 | 자동 활성화는 의도적으로 안 함(`docs/lca-auto-skill-2026-10-18.md`). 유지 |
| autopilot 체인 | **이식 가능** 각 단계(deep-interview/ralplan/ultragoal)는 있음(`workflows/`). 단계 사이에 사람 승인 게이트를 둔 체인 driver: **M** | OMX의 Stop-훅 FSM 대신 driver 상태기계 |
| ultragoal(네이티브 goal 모드 스냅샷) | **이식 불가** otter는 `features.goals=false`; otter ultragoal은 자체 데이터(`workflows/ultragoal-data.ts`) | 이미 동등 기능 보유 |
| ralplan / deep-interview / autoresearch | **이미 있음** `workflows/ralplan*.ts`, `deep-interview*.ts`, `autoresearch*.ts` | OMX 스킬(17 KB/41 KB)은 프롬프트, otter는 코드 driver |
| performance-goal | **이식 가능** autoresearch 변형(벤치 명령 + 임계값 게이트): **M** | 필요 시 |
| team(tmux pane 워커, 메일박스, 넛지) | **이식 불가·불필요** tmux 의존, 워커 = 대화형 codex pane. otter 워커는 one-shot 프로세스 + 직렬 큐 | 병렬은 추후 `queue.ts` 동시성으로, tmux 없이 |
| 서브에이전트/리더 추적(agent_id) | **이식 불가** `features.multi_agent=false`가 설계. 역할은 `agents/prompts.ts` + combo 라우팅으로 이미 분리 | |
| 알림(Discord/Telegram/Slack) | **이식 가능(축소)** 네트워크 없이 터미널 BEL/OSC 알림(승인 대기, 턴 종료): **S** | otter에 알림 코드 없음(grep bell/notification → 0) |
| session-history(검색/타임라인/usage/friction) | **이미 있음(부분)** `sessions/digest.ts`(결정적 요약, 모델 호출 없음), `sessions/history.ts`(facts: 통과/실패 명령, hot files, 600자 프롬프트 블록), `/sessions`, `/facts` | 빠진 것: 세션 간 텍스트 검색·토큰 사용량 → 자체 `sessions/<id>/segments*.jsonl` 대상 `/sessions search <q>`: **S**. codex rollout 의존 부분은 `--ephemeral`이라 불가·불필요 |
| document-refresh | **이식 가능** `workflows/commit.ts`/`/finish` 직전에 규칙표(소스 glob → 문서 경로) 대비 변경 파일 검사, 경고만, 면제 접두 지원: **S~M** | otter에 없음 |
| evals(astra-defaults) | **이미 있음(부분)** `scripts/otter-skill-load-eval.ts`, `otter-skill-route-eval.ts`, `otter-interview-eval.ts`, `harness/probe*.ts`, `telemetry/*` | 추가 가치: "사용량 귀속 불완전 시 null, 운영자 시간 별도" 규칙을 eval 리포트에: **S** |
| codebase-map(≤1,000자) | **이식 가능** facts 블록(`FACTS_PROMPT_CHARS` 600) 옆에 `git ls-files` 디렉터리 맵 ≤1,000자, 세션 시작 1회: **S** | 접두부 예산 주의(README 계약) |
| MCP 서버(state/memory/wiki/trace/code-intel) | **이식 불가** `mcp_servers={}`가 설계. 등가물은 호스트 도구(`memory`, `skill`, wiki) | |
| sidecar / Rust 런타임 / sparkshell / explore 하네스 | **불필요** tmux·네이티브 바이너리 의존, otter 계약(새 의존성 없음)과 충돌 | |
| AGENTS.md 25 KB 지시문 / 역할 프롬프트 111 KB | **반대** otter 지시문 1,047자(`hosts/inference-instructions.ts`)가 계약 | §2.4 누수 차단이 과제 |
| wiki 캡처 | **이미 있음** `wiki/wiki.ts`, `sessions/history.ts closeSessionHistory`(auto_capture) | |

## 4. otter 고도화 추천 Top 5

| # | 무엇 | 고치는 otter 한계 | 코드 위치 | 규모 | 위험 |
|---|---|---|---|---|---|
| 1 | **codex 엔진 격리**: otter 소유 영속 `CODEX_HOME`(auth.json 심볼릭 링크만) + `-c skills.include_instructions=false` + 승인 프로브에 요청 형태 캡처 검사 + 0.165.0 승인 | §2.4 누수(호출당 ≈9K 토큰, 승인 계약과 충돌하는 지시) 및 현재 codex 엔진 전면 불가(0.165 미승인) | `hosts/cli-transport.ts:452-462`(argv), `:1070-1089`(프로브), `hosts/codex-profile.ts:15`(승인 목록), `hosts/vendor-process.ts:11-19`(CODEX_HOME 덮어쓰기) | M | auth 갱신 write-through [미검증]; codex가 홈에 sqlite 상태를 만듦(영속 홈으로 흡수); 0.165 프로토콜 차이는 기존 레코드 검증(`cli-transport.ts:527-650`)이 잡음 |
| 2 | **도구 루프 no-progress 지문 가드**: (tool, input 해시) 또는 final 텍스트 지문이 N회(기본 3) 반복되면 호출 중단 + "마지막 진전·차단 원인" 진단 요구 | 24라운드 상한 전까지 같은 실패 호출을 반복(digest에 `multiedit failed 3`, `bash failed 3` 패턴) | `hosts/cli-host.ts` 라운드 루프(~1089-1463), 실패 사유 분류 `workflows/turn.ts hostFailureReason` | S | 정당한 반복 읽기 오탐 → "동일 호출 + 동일 결과"만 세고 읽기 도구는 임계 높임 |
| 3 | **세션 사용량 + 검색**: digest에 `usage {input, output, cached}`(엔진별), `/status`·상태줄에 누적 토큰, `/sessions search <q>`(자체 segments JSONL) | 콤보 효과·비용 판단 근거 부재(로드맵 3-B), 과거 세션 회수 수단 부재 | `sessions/digest.ts`, `hosts/cli-transport.ts:51-54 observedNativeUsage`, `tui/status-view.ts`, `hosts/interactive-actions.ts`(명령표 `:33` 근처) | S | 텍스트는 로그에 안 남긴다는 정책 유지 → 검색은 digest 메타(파일/명령/워크플로) 우선, 본문 검색은 opt-in |
| 4 | **문서 갱신 규칙(document-refresh)**: `.otter/otter.jsonc` 규칙표(예: `framework/src/hosts/**` → `framework/README.md`), 커밋/`/finish` 직전 변경 파일 대비 경고, `Docs: not-needed \|` 면제 | README가 2,426줄인데 변경 시 갱신 누락을 잡는 장치 없음 | `workflows/commit.ts`, `flow/review.ts`, 설정 `config.ts` | S~M | 경고만(차단 없음)으로 시작; 규칙은 프로젝트 설정이지만 사용자 승인 없이 행동을 바꾸지 않음 |
| 5 | **승인 대기 알림 + 스킬 신뢰 정리**: 승인 프롬프트/턴 종료 시 BEL·OSC 알림(옵션), `skill_trust`에서 `~/.codex/skills` 제거하고 `/skills`에 import 계층 표시 | 긴 턴 중 승인 대기를 놓침(승인 피로의 반대 문제); OMX 스킬 24개가 동의 없이 로드 가능한 상태 | `hosts/interactive-session.ts`(승인 프롬프트), `tui/terminal.ts`, `skills/trust.ts`, `~/.config/otter/otter.jsonc` | S | 알림은 TTY 전용·기본 off; 신뢰 제거는 사용자 설정 변경이므로 사용자 확인 후 |

다음 단계(5 이후): 원장 lease 필드(병렬 워커 도입 시), 코드베이스 맵 ≤1,000자, autopilot 체인 driver(M), performance-goal 변형(M).

## 5. 재현 파일

- 훅 실행 여부: `<scratch>/hooktest/{ignore,noignore}/` (`out.jsonl`, `err.txt`, `.omx/`)
- 요청 캡처: `<scratch>/capture/requests.log`(otter argv 그대로), `req-skillsoff.log`, `req-isohome.log`, `catalog.json`(otter `createCodexProfile` 출력), `server.py`/`server2.py`
- 격리 홈: `<scratch>/capture/iso-home/`
(`…` = `/private/tmp/claude-501/-Users-gimjiseong-orca-projects-AgentFramework/c0874888-573d-4b43-98d8-5e6f509cd529/scratchpad`)

## 6. 미검증 항목

`--ignore-user-config`가 hooks.json을 아예 안 읽는지 trust 부재로 건너뛰는지; codex 0.163.0의 AGENTS.md/skills 주입 여부; 심볼릭 링크 auth.json의 토큰 갱신 write-through; otter 지시문이 developer 메시지로 2회 들어가는 원인.
