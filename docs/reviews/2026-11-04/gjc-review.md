# GJC 0.18.0 리뷰 — otter 유지보수자 관점 (2026-11-04)

조사 방법: `gjc --version`, `gjc --help`, 서브커맨드 `--help`만 실행(모델 호출·대화형 실행 없음). `~/.gjc/`와 프로젝트 `.gjc/`의 yml/json/jsonl/md를 읽되 메시지 본문은 읽지 않고 레코드 키·타입·건수만 집계. sqlite는 `sqlite3 -readonly`로 `.schema`와 행 수만. 바이너리는 `strings | grep`으로 슬래시 명령 이름과 훅 이름만 추출. "추론"이라고 표시한 항목은 파일 이름·스키마에서 유추한 것이며 실행으로 확인하지 않았다.

기준 코드: otter `framework/` (브랜치 `feat/otter-intro-motion-video`, HEAD `c703a06`).

---

## 0. 한눈에 보기

| 영역 | GJC | otter |
|---|---|---|
| 실행 모델 | 상주 브로커(`sdk/broker.exit.json` uptime 547,582,959 ms ≈ 6.3일) + 세션별 ws 엔드포인트(`.gjc/state/sdk/<sid>.json`) + 자체 도구(read/bash/edit/apply_patch/subagent/job/irc/python/computer…) | 벤더 CLI 1회성 서브프로세스 + JSON 봉투 도구 + 호스트 승인 |
| 세션 저장 | `~/.gjc/agent/sessions/v2-<cwd digest>/<ISO>_<ulid>.jsonl` (parentId 트리) + 아티팩트 디렉터리 | `stateRoot(worktree)/sessions/<sid>/` (`metadata.json` + seq 선형 트랜스크립트, `framework/src/sessions/store.ts:1239`) |
| 모델 선택 | 서명된 프리셋 레지스트리(프로필 63, 프리셋 4,639) + 역할별 effort·폴백 체인 | 하드코딩 콤보 템플릿 3개(`framework/src/hosts/combo-presets.ts`) |
| 지식 축적 | `/memory`(consolidation), `history.db` FTS5, 압축 요약 | 세션 다이제스트 → `knowledge/` 위키(자동 캡처) — **GJC에 없는 otter 고유 가치** |
| 되돌리기 | 없음(바이너리 슬래시 명령 목록에 undo 없음 — 추론) | `/undo`, `multiedit`, 24라운드 연장 — otter가 앞섬 |

---

## 1. GJC 관찰 가능한 구성요소

바이너리: `/Users/gimjiseong/.local/bin/gjc` (Mach-O arm64, 137 MB; `~/.gjc/agent/gjc-crash.log`의 스택이 `/$bunfs/root/cli-*.js`를 가리켜 Bun 단일 실행파일로 추론). 네이티브: `~/.gjc/natives/0.18.0/pi_natives.darwin-arm64.node` (49 MB; PTY·터미널 네이티브로 추론).

| 기능 | 증거 (파일/플래그) | 메커니즘에 대한 함의 |
|---|---|---|
| **모델 역할 smol/slow/plan + 프로필 프리셋** | `gjc --help`: `--model/--smol/--slow/--plan/--mpreset/--default/--models(Alt+N)/--thinking`. `~/.gjc/agent/config.yml`: `modelRoles: {}`, `modelProfile.default: claude-opus`, `defaultThinkingLevel: medium`. `~/.gjc/agent/models.yml`: `profiles.<name>.model_mapping{default,executor,planner,architect,critic}` + `required_providers`. `~/.gjc/agent/model-presets/state.json`(3.9 MB): `history[].manifest.signed{registryRevision,…}`+`signature{algorithm,keyId,value}`, `profiles.profiles[63]{id,displayName,providerGroup,requiredProviders,roleBindings}`, `presets.presets[4639]{id,provider,name,api,reasoning,input,cost,contextWindow,maxTokens,compat,thinking}`. `gjc models presets`(refresh/pin/rollback/disable) | 역할 5종(default/executor/planner/architect/critic)에 `provider/model:effort` 문자열 또는 **배열(폴백 체인)**을 바인딩. 예: `astra-fable` = default `openai-codex/gpt-6-astra:medium`, executor `gpt-5.6-luna:max`, architect/critic `anthropic/claude-fable-5-1:xhigh`, planner `gpt-6-astra:xhigh`. 레지스트리는 원격 서명 매니페스트를 받아 revision/etag로 관리(핀·롤백 가능). 세션 jsonl의 `configured_model_chain{entries,explicitHead,role}`·`model_change{role}`·`thinking_level_change`가 런타임 적용 기록. |
| **자격 증명 선택기 / 쿼터 폴백** | `--credential email:/id:/account:/project:`, `--prefer-credential …`(quota fallback). `gjc accounts`, `gjc auth-broker`(vault), `gjc auth-gateway`(forward proxy). `~/.gjc/agent/agent.db`: `auth_credentials(provider,credential_type,data,disabled_cause,identity_key,revision)` 2행, `oauth_refresh_leases` 1행, `model_usage` 10행. `credential-auto-import-state.json {lastImportVersion, initialImportResolution:accepted}`. `~/.gjc/logs/gjc.2026-10-26.log`: "Usage fetch requested providers [anthropic, openai-codex] credentialTypes [oauth]" / "Codex usage token expired" | 여러 OAuth 계정을 sqlite 금고에 두고, 리프레시는 **lease**로 직렬화, 쿼터 초과 시 다음 자격 증명으로 폴백. `/usage`, `/account`, `/health`, `/check` 슬래시 명령(바이너리 문자열)이 제공자 사용량을 조회. 업그레이드 시 타 CLI 자격 증명 자동 임포트. |
| **워크트리 실행** | `-w, --worktree[=branch]` "Launch in a managed worktree"; `gjc gc --help`: "Managed worktrees under ~/.gjc/wt are never touched"(이 머신에 `~/.gjc/wt` 없음). 프로젝트 `.gjc/worktrees/linux-live-qualification/`(136 MB 전체 체크아웃, 자체 `.gjc/`에 서브에이전트 세션 190+개). `gjc ralplan --worktree-root`. `state/ralplan-state.json.repository_binding{worktreeRoot,commonDir,displayPath,head,branch}` | 세션/워크플로가 git 워크트리에 **바인딩**되어 기록되고, 워크플로가 별도 워크트리에서 돌 수 있음. 세션 스코프 자체가 canonical cwd 기준(`.gjc-managed-session-scope.v2.json {canonicalPath, identityDigest}`)이라 워크트리별로 세션 목록이 분리됨. |
| **세션 fork/resume/continue** | `-c/--continue`, `-r/--resume[=id|path|picker]`, `--fork=<id>`, `--session-dir`, `--no-session`, `--export <jsonl>→HTML`, `--no-title`. 슬래시: `/fork`("Choose an earlier prompt to continue in a new session"), `/tree`("Navigate session tree (switch branches)"), `/transcript`, `/rename`, `/move`, `/info`, `/delete`, `/drop`. jsonl 레코드 전부 `id`+`parentId`; `session{cwd,id,title,titleSource,version,starredPatchVersion}`. `~/.gjc/agent/terminal-sessions/ttys000…006`(tty별 209바이트 파일) | 트랜스크립트가 **DAG**(parentId)라서 임의 지점 분기·브랜치 전환이 저장소 수준에서 지원. 제목 자동 생성(`titleSource`). tty별 바인딩 파일은 `--continue`를 터미널 단위로 해석하기 위한 것으로 추론. |
| **ACP/json 출력 모드** | `--mode text|json|acp`, `-p/--print`, `gjc session --json`, `gjc skills … --json`, `gjc harness --json`, `gjc daemon --help`가 페이지 분할 JSON 문서(`SECTION/CONTINUATION`)를 출력 | 에디터 통합(ACP)과 스크립팅(json, -p)이 1급. 도움말까지 기계가 읽는 형태. |
| **MCP 자동 로드** | `--mcp-config`, `--no-mcp`("native user ~/.gjc/agent/mcp.json and project .gjc/mcp.json"), `gjc mcp add/list/remove --project --sharing per-session|shared --type stdio|http|sse`, `gjc mcp-serve`, `gjc coordinator check|tools`(MCP bridge contracts). **이 머신에 `~/.gjc/agent/mcp.json`, 프로젝트 `.gjc/mcp.json` 모두 없음(확인).** | 사용자/프로젝트 2단 등록 + 세션 공유 모드. 타 CLI 설정을 상속하지 않음(명시). 사용자는 실제로 MCP를 쓰지 않았음. |
| **LSP 도구/포맷/진단** | `--no-lsp` "Disable LSP tools, formatting, and diagnostics" | 플래그 외 설정 파일 없음. 기본 켜짐이라는 것만 확인. |
| **PTY bash** | `--no-pty` "Disable PTY-based interactive bash execution"; 아티팩트 디렉터리에 `N.bash.log`(267) + `N.bash-original.log`(43); jsonl `message.bashExecution{command,exitCode,output,cancelled,truncated,excludeFromContext}`; 프로젝트 `.gjc/*.pty` 캡처 2개 | 모델의 bash가 PTY에서 돌아 대화형 명령도 가능. 출력은 세션 아티팩트 로그로 **퇴거(evict)** 후 컨텍스트에서는 참조만(`evictedContent` 있는 메시지 6,527건, `N.evicted.log` 2,403개). |
| **tmux** | `--tmux`; `gjc session list|status|create|attach|remove|force-close --session-id --state-file` ("tagged GJC-managed tmux sessions", `@gjc-session-id` 태그) | 세션을 tmux 창에 태깅해 재부착·강제 종료. |
| **클립보드 전송** | `--clipboard-transport auto|native|osc52|ssh`, `--clipboard-ssh-host`(~/.ssh/config alias) | SSH 원격에서 로컬 클립보드로 되돌리는 경로까지 지원. |
| **스킬 디렉터리** | `gjc skills list|read|discover --source all|project|user --query --limit --offset`; 내장 워크플로 스킬(ultragoal/ralplan/autoresearch/deep-interview)은 바이너리에 임베드. 프로젝트 `.gjc/skills -> ../.agents/skills`(심링크 존재 확인). `.gjc/worktrees/linux-live-qualification/skills-lock.json {skills.<name>{source,sourceType:github,skillPath,computedHash}}`. `gjc plugin install|…|marketplace|discover|upgrade --scope user|project`(v1→v2 마이그레이션) | 파일시스템 스킬 + **해시 락파일** + 플러그인 마켓. 검색 결과는 페이지네이션(50개 상한). |
| **서브에이전트 세션** | 프로젝트 `.gjc/`에 `_session-%5B%22subagent-canonical%22%2C%22<owner>%22%2C%22<N>-<Label>%22%5D` 370개(=URL 인코딩된 JSON 배열 `["subagent-canonical", ownerSid, "N-Label"]`), 소유 세션 22개. 각 서브에이전트 디렉터리는 `runtime/runtime-state.json`(+lock 2개)만 보유: `{schema_version, state, ready_for_input, live, event(turn_start/agent_end), cwd, activity{seq,tool,phase,outcome,elapsed_ms,active_tools,in_flight}, execution_state, final_response{text,format,artifact_path,truncated}}`. 소유 세션 jsonl의 `toolCall.name` 분포: read 1,048 / bash 876 / **subagent 409** / job 213 / search 164 / apply_patch 142 / todo_write 124 / irc 111 / edit 93 / write 72 / task 54 / find 44 / goal 39 / ask 16 / computer 13 / skill 11 / monitor 9 / python 8. 서브에이전트 트랜스크립트는 소유 세션 아티팩트 디렉터리 안의 `<N>-<Label>.jsonl`(67줄짜리 예: session_init, model_change, configured_model_chain, user 1, assistant 19, toolResult 40) + 결과 `<N>-<Label>.md.<uuid>.output` + `.output.meta.json{id,kind,sizeBytes,lineCount,sha256,createdAt}` + `.selector.json{outputFilename,outputSha256,…}`. `token-logs/token-log.jsonl{agent: main|executor|architect|critic|planner, subagentId, model, turn, input, output, cacheRead, cacheWrite, totalTokens}`(소유 세션 01a0ea72: 8,379행, subagentId 80종 ≈ 서브에이전트 디렉터리 79개). `state/ralplan-state.json{planner_subagent_id: QM0AmendmentPlanner, critic_id: QM0Critic, architect_id: QM0Architect, *_resumable: true}` | **추론한 오케스트레이션 모델**: 메인이 `subagent` 도구로 라벨(예: `25-ResearchGJC`, `78-QM0Critic`, `16-G003RedTeamQA`)을 붙여 자식 세션을 만들고, 자식은 역할(executor/architect/critic/planner)에 묶인 모델 체인으로 돌며, 결과를 sha256 메타데이터가 붙은 output 파일로 돌려줌. `job`/`task`/`monitor`는 비동기 작업이고 `custom_message{customType: task-notification|async-result}`로 메인에 통지. 워크플로(ralplan 등)는 서브에이전트를 **라벨로 재개**할 수 있음(`*_resumable`). 라벨 시퀀스가 소유 세션마다 0부터 증가(`0-OpenJevLauncher … 81-QM0NoEgressPauseCritic`). `/routing`("sub-agent model autorouting"), `/agents`(dashboard), `/jobs` 슬래시 명령 존재. |
| **워크플로 상태/영수증** | `gjc state read|write|clear|doctor|handoff`, `gjc deep-interview stage|check|apply`("runtime-owned revision+sha CAS"), `gjc ultragoal`(checkpoint/review/quality-gate/succession), `gjc autoresearch`(intake/log-run/verdict/critic), `gjc ralplan --write --stage planner|critic`. 소유 세션 디렉터리: `state/{ultragoal,ralplan,autoresearch,skill-active}-state.json`(각각 `receipt{mutation_id,content_sha256,fresh_until,state_path}`, `state_revision`), `state/active/*.json{hud{summary,chips}}`, `state/audit.jsonl`(1,289행: category state/ledger/artifact/log/prune, verb write/append/reconcile/handoff/invalid_transition_detected 49건, owner gjc-runtime/gjc-state-cli/gjc-hook), `ultragoal/{goals.json, ledger.jsonl(goal_started, goal_checkpointed, critic_verdict, blocker_classified, plan_created, nudge…), brief.md, evidence/{quality-gate.json, framework-tests.xml, *-report.txt}}`, `plans/ralplan/<run-id>/{index.jsonl{stage,stage_n,path,sha256}, stage-01-intent.md, stage-01-planner.md, stage-02-critic.md, stage-02-architect.md, stage-02-adr.md, stage-02-revision.md, stage-02-final.md, pending-approval.md}`, `specs/deep-interview-<slug>.md`, `autoresearch/retired/<slug>.<ts>/`, `ipykernels/<ts>-<uuid>/transcript.jsonl{code,exitCode,output,cancelled,truncated}` | 모든 상태 변경이 **영수증(mutation_id + content sha)** 과 감사 로그를 남기고, 비정상 전이는 `invalid_transition_detected`로 기록. 단계 산출물은 sha256 인덱스로 고정. otter의 workflow authority(`sessions/<sid>/workflow/workflow.json`)와 같은 계열이지만 감사 로그·HUD 칩·영수증 신선도(`fresh_until`)가 더 있음. |
| **재시도 설정** | `~/.gjc/agent/config.yml: retry.streamFirstEventTimeoutMs: 3600000`(1시간), `~/.gjc/strata-agent/config.yml: streamFirstEventTimeoutMs: 1800000, maxRetries: 0, requestMaxRetries: 0, streamMaxRetries: 0` | 스트림 첫 이벤트 타임아웃·요청/스트림 재시도 횟수가 설정값. 사용자는 로컬 모델(TTFT 김) 때문에 크게 올렸음. |
| **크래시 인덱스/오류 이벤트** | `gjc-crash.log`(Uncaught Exception + 스택), `gjc-error-events.jsonl`(`gjc-crash-event.v1 {k:occurrence, fp(지문), fpv, id, at, n(이름), m(메시지)}`, 같은 fp 반복 7건·6건), `gjc-crash-index.json{recentEventIds, recentJournalDigests, lastNudgedAt, overflow, recoveredRecordIds}` + `.retired`, `~/.gjc/logs/gjc.YYYY-MM-DD.log(.gz)`(JSON lines level/pid/message), `~/.gjc/logs/http-400-requests/<ts>-<id>.json`, `/recovery`·`/health` 슬래시 명령, `gjc gc --repair-session-index` | 오류를 **지문으로 중복 제거**하고, 저널 다이제스트로 복구 가능한 세션을 가리키며, 다음 시작 때 "nudge"(`lastNudgedAt`). 제공자 400 응답은 별도 보관. |
| **사이드카/상주 캐시** | `sidecar-cache/s-<nonce>/owner.json{pid,startTimeMs,nonce,createdAt}`; `resident-cache/i-UYjXxT/<sha256>` 11,894개·137 MB(샘플 400개 중 JSON `type: reasoning`(`encrypted_content` 포함) 162, 비JSON 215); `blobs/` 24,227개·158 MB(텍스트 블롭, 내용 주소); `cache/tool-choice-capabilities.db`; `sdk/{broker.identity, machine-identity.secret, broker.exit.json{mode: owned-root, reason: signal, uptimeMs: 547582959}, sessions/index.jsonl(3.2 MB, `host_heartbeat{sessionId,pid,locator,endpointGeneration,hostIncarnation,indexSeq,checksum}`), index.snapshot.json, index-audit.jsonl}`; `.gjc/state/sdk/<sid>.json{sessionId,url: ws://127.0.0.1:<port>/,token,pid}` | **추론**: 상주 브로커가 세션별 WebSocket 엔드포인트를 열고 하트비트 인덱스를 유지(하네스/코디네이터가 붙는 제어면). `resident-cache`의 reasoning 항목은 OpenAI Responses의 암호화 추론 블록을 재전송하기 위한 캐시로 보임(프롬프트 캐시 연속성). `tool-choice-capabilities.db`는 제공자별 tool_choice 지원 여부 프로브 캐시. |
| **strata-agent** | `~/.gjc/strata-agent/{config.yml, models.yml, model-presets/, agent.db, models.db}`(agent/와 동일 레이아웃): `providers.strata{baseUrl: http://127.0.0.1:18080/v1, api: openai-completions, models[qwen3.8-flash-next-q2_0{contextWindow 32768, compat{supportsDeveloperRole:false, thinkingFormat: qwen-chat-template}}]}`; 프로젝트 `.gjc/gjc-strata-evidence/<ns>/{manifest.json{scope,notes,files[27]{source,archive,sha256,bytes}}, helpers-current/{strata_client_server.py, gjc_strata_preflight.py, gjc_strata_live.py, strata_guard_finalize.py}, verified/{live-receipt.json, wire-captures.json, …}}`; `~/.gjc/agent/sessions/v2-c5u24…`의 canonicalPath `/Users/gimjiseong/.local/share/strata` | 사용자가 GJC 홈을 통째로 분리해(환경 변수로 홈을 바꾼 것으로 추론) 로컬 Strata(qwen 3.8 flash) 서버를 제2 에이전트로 검증했고, 그 증거를 프로젝트 `.gjc/`에 sha256 매니페스트로 보관. otter의 lca(local coding agent) 단계와 같은 작업. |
| **압축(compaction)** | jsonl `compaction{summary(15,594자), shortSummary, tokensBefore(231,515), firstKeptEntryId, preserveData, fromExtension, details{modifiedFiles, readFiles}}` 83건(12개 파일 기준) | 요약 생성 + **수정/읽은 파일 목록 보존**. 압축 후에도 파일 사실은 남음. |
| **사용량 기록** | `message.assistant.usage{input,output,cacheRead,cacheWrite,cost,totalTokens}`, `ttft`, `duration`, `responseId`, `promptPrefix`; `token-logs/token-log.jsonl`(프로젝트 전체 48,196행, totalTokens 누적 8.12e9 — 캐시 읽기 포함 누적치); `gjc stats`(대시보드 포트 3847, `--json`, `--summary`); `/usage`, `/context`("active context token usage breakdown"), `/effort` | 호출 단위 비용·TTFT가 트랜스크립트에 남고 역할/서브에이전트별로 집계 가능. |
| **훅/이벤트** | 바이너리 문자열: `tool_call`, `tool_result`, `tool_execution_start/end`, `agent_start/end`, `turn_start/end`, `session_start`, `session_shutdown`, `before_agent_start`, `compaction`, `context`, `input`, `message_start/end`, `notification`; Claude Code식 `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `pre_tool_use`/`post_tool_use`; `gjc codex-native-hook`; `/extensions`("Configure skills, hooks, and MCPs") | 플러그인/훅 이벤트 면이 넓고, Claude Code·Codex 훅 호환 계층이 있음(추론). |
| **기타 표면** | `gjc quick-lane classify --json`(quick lane vs deep path), `gjc harness start|preflight|submit|observe|classify|recover|validate|finalize|retire|events --follow|monitor|operate`(gajae-code 하네스 제어면, ReceiptEnvelope spool), `gjc daemon`(Telegram/Discord/Slack), `gjc notify`, `irc` 도구(`custom_message irc:incoming` 117건), `gjc web-search`(Exa/Brave/Perplexity/Tavily), `python` 도구(ipykernel 영속), `computer` 도구, `gjc gc --disk`(liveness 기반 GC + 디스크 보존 보고), `gjc contribute-pr`, `gjc setup`, `gjc migrate`, `--master --scope repo|pwd|global`, `--no-rules`, `--allow-home`, `/btw`(세션 컨텍스트로 임시 사이드 챗), `/memory view|enqueue|clear`, `/goal set|show|pause|resume|drop`, `/monitors`, `/theme`, `/hotkeys`, `/changelog`, `/pet` | — |

프로젝트 `.gjc/` 규모: 399개 항목, 161 MB(워크트리 136 MB 포함). 홈 세션 중 이 프로젝트 스코프 `~/.gjc/agent/sessions/v2-5b7477qm6mjmzbkdrxyims7juaykybnlfcwtpsx3lvnfmnn3ctsa/`: jsonl 16개·236 MiB, 아티팩트 포함 2.4 GiB(최대 jsonl 101 MB, 아티팩트 디렉터리 하나가 187 MB·10,850 파일).

---

## 2. otter와 비교

`있음`은 `framework/src/...` 경로와 grep으로 확인한 줄.

| GJC 기능 | otter 상태 | 근거 |
|---|---|---|
| TUI 배치·선택 메뉴·명령 팔레트·도구 호출 행·시작 시 업데이트 확인 | **있음(GJC-inspired, README 명시)** | `framework/src/tui/render.ts:540,593,624,934`, `framework/src/hosts/interactive-view.ts:51`, `framework/src/tui/app.ts:458`, `framework/src/tui/editor.ts:4`(GJC 레퍼런스 픽스처 `8cd17c0f…`), `framework/src/hosts/update-check.ts:3` |
| 스킬 루트(`.gjc/skills`, `~/.gjc/agent/skills`, `~/.gjc/skills`) | **있음, 단 홈 경로는 이 머신에 없음** | `framework/src/skills/roots.ts:30,34,35`(모두 `optional: true`). 확인: `~/.gjc/agent/skills` **없음**, `~/.gjc/skills` **없음**, `~/.config/opencode/skills` 없음; `~/.agents/skills`(4), `~/.claude/skills`(4), `~/.codex/skills`(24) 있음. 프로젝트 `.gjc/skills -> ../.agents/skills` 심링크 **존재**(`roots.ts:328`이 중복 제거). `framework/.gjc/skills`는 없음(otter는 저장소 루트 기준이므로 문제 없음). README `skill_trust` 예시의 `~/.gjc/agent/skills`도 존재하지 않는 경로. GJC의 `skills-lock.json`(해시 락) 상당은 없음 → 스킬 측면은 **부분적** |
| 모델 역할 + 프리셋 | **부분적** | 역할 라우트: `framework/src/config.ts:191-194`, `framework/src/hosts/combo-presets.ts`(템플릿 3개 `astra-fable`, `astra-fable-opus`, `opus-codex`; GJC 레지스트리의 같은 id `astra-fable` roleBindings와 모델이 일치 — 코드의 `gpt-5.6-luna`는 GJC와 같고 README 표의 "GPT-6 Luna"가 어긋남, `framework/README.md:369`). 없음: `--mpreset`, 외부 레지스트리, 역할별 **effort 접미사**, **폴백 체인 배열**, `/effort` |
| 자격 증명 선택/쿼터 폴백/`/usage` | **없음** | otter는 벤더 CLI 로그인에 위임(`framework/src/hosts/engine-auth.ts`, `/auth`, `/login`). 다계정·쿼터 조회·폴백 없음. 로드맵 3-A(엔진 전환 제안) 미구현(`interactive-session.ts:2894`는 워크플로 중 전환 거부만) |
| 워크트리 실행 | **부분적** | `--worktree PATH`는 기존 디렉터리 선택(`framework/src/hosts/cli.ts:48,65-67`); 계획 실행은 작업트리 사용(`framework/src/orchestration/`); 관리형 워크트리 **생성** 플래그 없음 |
| 세션 fork/resume/continue/export/title | **부분적** | `--continue`, `--resume [ID]`, `/sessions`, `/resume`, `/new`(`framework/src/hosts/interactive-session.ts:2005,3401,3422,3426,3509`). 없음: `/fork`, `/tree`(트랜스크립트가 `seq` 선형, `framework/src/sessions/store.ts:17`), HTML export, 제목(`SessionMetadata`에 title 없음, `store.ts:18-22`), `/rename`, `/move` |
| ACP/json/print 모드 | **부분적** | `otter status --json`(`cli.ts:188`), `otter run --plan`(비대화형 워크플로). 없음: `-p` 1회성 프롬프트, ACP |
| MCP 자동 로드 | **없음(설계상)** | 엔진 실행 시 MCP 차단: `framework/src/hosts/cli-transport.ts:447`(`--strict-mcp-config`), `:461`(`mcp_servers={}`), `:656-661`. 예외: OpenCode data-analyst용 vendored evo-semantic MCP(`framework/src/hooks/config.ts:137-146`) |
| LSP 도구/포맷/진단 | **없음** | 프롬프트 문구만("verify … with read, grep, or LSP where available", `framework/src/hosts/tool-policy.ts:31`) |
| PTY bash | **없음** | 비대화형 `/bin/sh -c`, 타임아웃 `DEFAULT_BASH_TIMEOUT_SECONDS`(`framework/src/hosts/cli-host.ts:1729`); 대화형은 사람이 `!cmd`(`framework/src/hosts/operator-shell.ts`) |
| tmux 세션 관리 | **없음** | grep `tmux` → 없음 |
| 클립보드 전송 | **부분적** | `framework/src/tui/clipboard.ts:30-43`: pbcopy/xclip/xsel → OSC 52 폴백. ssh 전송·플래그 없음 |
| 서브에이전트 세션 | **부분적** | `delegate` 도구는 OpenCode 경로 전용·직렬 큐·최대 12개(`framework/src/tools/delegate.ts:1-3, MAX_TASKS`), CLI 호스트 도구 목록에 없음(`framework/src/hosts/cli-tools.ts:20`). 워크플로 드라이버(`framework/src/workflows/ralplan-driver.ts` 등)가 역할 서브프로세스를 돌림. 없음: 라벨로 재개 가능한 자식 세션, 역할별 토큰 로그, 비동기 job/monitor, `/agents` |
| 재시도 설정(`streamFirstEventTimeoutMs` 등) | **없음** | `cli-transport.ts`/`cli-host.ts`에 재시도·첫 이벤트 타임아웃 설정 없음(bash 타임아웃만) |
| 크래시 인덱스/오류 이벤트 | **없음** | `OTTER_DEBUG=1` 디버그 로거만(README:2075 근처). 지문·저널·nudge 없음 |
| 사이드카/상주 캐시 | **없음** | 턴마다 1회성 서브프로세스(`framework/src/hosts/vendor-process.ts`). 프롬프트 캐시 연속성은 벤더 CLI에 의존 |
| strata(로컬 OpenAI 호환 서버) 엔진 | **없음** | local 엔진은 Ollama CLI(`interactive-session.ts:618` 메뉴 "local — Ollama CLI") |
| 압축 | **부분적** | `/context compact`는 요약 없이 쌍을 잘라냄(`framework/src/hosts/context-command.ts:138` "trims history without generating a summary"). 수정 파일 보존 없음 |
| 사용량·비용 기록 | **없음** | `framework/src/sessions/store.ts`에 usage 종류 없음(grep `totalTokens` 0건). 로드맵 3-B 미구현 |
| 프롬프트 이력 FTS | **부분적** | `/history`는 세션 다이제스트 요약(`interactive-session.ts:3568-3580`); 세션 횡단 프롬프트 검색 없음 |
| 훅 이벤트 | **부분적** | OpenCode 플러그인 훅만(`framework/src/hooks/event.ts:124-363`: message.updated, session.created/compacted/idle/deleted). CLI 호스트에 사용자 훅 지점 없음 |
| 워크플로 영수증/감사 로그 | **부분적** | 단일 authority 파일(`sessions/<sid>/workflow/workflow.json`, README:1102,1649)과 커밋 프로토콜(`framework/src/workflows/commit.ts:364`). 감사 jsonl·HUD 칩·`invalid_transition` 기록 없음 |
| quick-lane 분류 | **부분적** | 의도 라우팅(`framework/src/routing/`, README 4-B) |
| 알림/데몬/irc/web-search/python 커널/computer | **없음** | — |
| `/undo`, `multiedit`, 24라운드 연장 | **otter만 있음** | `framework/src/hosts/chat-checkpoint.ts`, `cli-tools.ts:20,162,945`, `cli-host.ts:59-60,232`. GJC 바이너리 슬래시 명령 목록에 undo 없음(추론) |
| 세션 다이제스트 → 위키 자동 캡처 | **otter만 있음** | `framework/src/sessions/digest.ts`, `framework/src/wiki/wiki.ts:707`, `framework/README.md:280-290`, `knowledge/AGENTS.md` "세션 다이제스트" 절 |

---

## 3. GJC 세션 데이터 활용 가능성

### 3.1 무엇이 있나 (형식 요약, 본문 미인용)

| 원천 | 위치 | 형식 | 크기 |
|---|---|---|---|
| 트랜스크립트 | `~/.gjc/agent/sessions/v2-5b7477qm6mjmzbkdrxyims7juaykybnlfcwtpsx3lvnfmnn3ctsa/<ISO>_<ulid>.jsonl` | JSONL, 레코드 `{type,id,parentId,timestamp,…}`; `type ∈ session, message, custom, custom_message, model_change, thinking_level_change, configured_model_chain, discovered_builtin_tool_selection, mode_change, compaction, service_tier_change`; `message.role ∈ user, assistant, toolResult, bashExecution, fileMention, developer`; assistant에 `provider, api, model, usage{input,output,cacheRead,cacheWrite,cost,totalTokens}, ttft, duration, stopReason(toolUse 3,300/stop 332/error 11), errorMessage/errorStatus/transportFailure`; 콘텐츠 블록 `text, thinking{provenance,summaryText,…signature}, toolCall{name,arguments,intent}, image{data,mimeType}`; `toolResult{toolName,toolCallId,isError,details,prunedAt}`; `evictedContent` | 16개, 236 MiB |
| 아티팩트 | 같은 디렉터리의 `<ISO>_<ulid>/` | `N.read.log`, `N.bash.log`, `N.bash-original.log`, `N.search.log`, `N.evicted.log`, `N.review-findings.log`, `.artifact-id-N`, 서브에이전트 `N-Label.jsonl` + `.md.<uuid>.output` + `.output.meta.json{sha256,lineCount}` + `.selector.json` | 2.4 GiB |
| 서브에이전트 상태 | `.gjc/_session-%5B%22subagent-canonical%22…%5D/runtime/runtime-state.json` | JSON(§1 표 참조) | 370개 |
| 토큰 로그 | `.gjc/_session-<sid>/token-logs/token-log.jsonl` | `{agent, subagentId, model, turn, input, output, cacheRead, cacheWrite, totalTokens, at}` | 48,196행 |
| 워크플로 원장 | `.gjc/_session-<sid>/{state/audit.jsonl, ultragoal/ledger.jsonl, ultragoal/goals.json, plans/ralplan/<run>/index.jsonl, state/*-state.json, runtime/runtime-state.json}` | JSON/JSONL(메타데이터만; `stage-*.md`, `brief.md`, `pending-approval.md`는 모델 생성 본문) | 소유 세션 7개에 존재 |
| 프롬프트 이력 | `~/.gjc/agent/history.db` `history(prompt, created_at, cwd)` + FTS5 | 464행 — **프롬프트 원문이라 allowlist 위반, 사용 불가** | 295 KB |

### 3.2 otter `SessionDigest`(`framework/src/sessions/digest.ts:23-44`)로의 투영

| otter 필드 | GJC 출처 | 비고 |
|---|---|---|
| `sessionID` | `session.id` | `gjc-` 접두어로 네임스페이스 분리 권장 |
| `engine` / `model` | `"gjc"` / 마지막 `model_change.model` 또는 assistant `provider/model` | 세션 중 모델 전환 106건 → 마지막 값 + 분포 |
| `routes` | `configured_model_chain{role, entries}` 또는 token-log `agent → model` | 역할 이름이 GJC(executor/architect/critic/planner) → otter 역할로 매핑 필요 |
| `startedAt`/`endedAt` | 첫/마지막 `timestamp` | |
| `turns` | `message.user` 건수 | |
| `tools{succeeded,failed,denied}` | `toolCall.name` 집계 + 같은 `toolCallId`의 `toolResult.isError` | GJC에 승인/거부 기록이 jsonl에 없음(관찰 범위) → `denied`는 0, 다이제스트 `decisions`는 비움 |
| `files` | `compaction.details.modifiedFiles` ∪ `edit/write/apply_patch` toolCall `arguments`의 경로 필드 | **인수에서 경로만 추출**하고 본문·패치는 버림. 작업트리 상대 경로로 정규화 |
| `commands` | `bashExecution.command`(사람 실행) + `bash` toolCall `arguments.command` → `commandRule()`(`framework/src/hosts/chat-actions.ts`)로 접두사만 | 종료 코드는 `bashExecution.exitCode`는 있으나 도구 bash 결과의 exitCode 필드 존재는 미확인 → 없으면 `isError`로 status만 |
| `workflows` | `custom{customType: workflow-intent-diff}`, `.gjc/_session-<sid>/state/ralplan-state.json{run_id,current_phase}`, `ultragoal/goals.json{goals[].status}` | |
| `outcome` | `runtime/runtime-state.json{execution_state: terminal_ok, state: completed}` / 마지막 assistant `stopReason` | |
| `complete` | 파싱 실패 줄 수 == 0 | |

GJC에만 있어서 **새 원본 종류**(`knowledge/raw/gjc-sessions/<sha>.json`, `kind: gjc-session-snapshot`)로 둘 가치가 있는 것: 모델·역할별 토큰/비용 합(`usage.cost` 포함), 압축 횟수·`tokensBefore`, 서브에이전트 수와 라벨 접미사(RedTeamQA/Critic/Architect…) 분포, `ledger.jsonl` 이벤트 종류별 수, `audit.jsonl`의 `invalid_transition_detected` 수, `stopReason: error`·`transportFailure` 수. 이것들은 roadmap 3-B/3-C("콤보 효과 이력화")의 근거가 되는 **유일한 대규모 실측치**다(otter 자체 세션은 현재 3개뿐이고 `knowledge/wiki/reports/project-facts.md`는 명령 0건·파일 0개).

### 3.3 제약과 안전 장치

1. **allowlist**(`knowledge/AGENTS.md` "세션 다이제스트" 절): 메시지 원문·파일 내용·편집 텍스트·전체 명령줄·출력·자격 증명 금지. GJC jsonl에는 `thinking`, `providerPayload`, `evictedContent`, `image.data`, `text`가 들어 있으므로 **레코드 복사가 아니라 필드 화이트리스트 투영**으로만 구현. `.gjc/state/sdk/<sid>.json`에는 ws 토큰이 있으므로 읽지 않음.
2. 기존 `captureWiki`의 비밀 패턴 검사(스냅샷 전체)를 그대로 통과시킴.
3. 크기: 100 MB jsonl을 줄 단위 스트리밍으로 파싱(`replaySession`처럼 페이지), `MAX_FILES/MAX_COMMANDS` 상한 유지.
4. 동시성: GJC가 쓰는 중일 수 있음(`.gjc-exact-replace-destination-*`, `.gjc-receipt-remove-*` 0바이트 영수증 마커가 원자적 교체 프로토콜로 추론됨). `runtime-state.json.live == false`인 세션만, 또는 복사 후 파싱.
5. 경계: `.gjc`는 otter 도구의 보호 디렉터리(`framework/src/hosts/cli-tools.ts:82`, `framework/src/repo-search/corpus.ts:17`)이므로 **모델 도구가 아니라 호스트 측 임포터**가 읽기 전용으로 접근. `~/.gjc/agent/sessions`는 0700이지만 같은 사용자이므로 접근 가능.
6. 세션 스코프 매칭: `v2-<digest>/.gjc-managed-session-scope.v2.json{canonicalPath}`가 otter worktree의 canonical 경로와 같을 때만 그 프로젝트 위키에 넣음(워크트리 `linux-live-qualification`은 별도 스코프 `v2-fza6…`).
7. 해석 경계: GJC 도구 성공은 종료 결과일 뿐이며(`knowledge/AGENTS.md` 원칙), `totalTokens` 누적치는 캐시 읽기를 포함하므로 "사용량"이지 "고유 토큰"이 아님을 보고서에 명시.

결론: **가능하고 가치가 큼.** 가장 적은 코드는 GJC → otter `SessionDigest` 형태로 투영해 `stateRoot/digests/gjc-<sid>.json`에 두고 기존 자동 캡처(`framework/src/wiki/wiki.ts:707`)가 집계하게 하는 것. 다만 `engine: "gjc"`를 `project-facts.md`에서 구분 표기하고 `knowledge/AGENTS.md`에 GJC 원천 조항을 추가해야 한다.

---

## 4. otter 고도화 추천 Top 5

| # | 무엇 | 고치는 otter 한계 | 코드 위치 | 크기 | 위험 |
|---|---|---|---|---|---|
| 1 | **GJC 세션 임포터**: `bun scripts/otter-wiki.ts capture --gjc`(또는 `wiki.import_gjc` 설정)로 §3.2 투영을 수행해 다이제스트·원본·출처 페이지 생성. 스코프 매칭·live 세션 제외·화이트리스트 투영·비밀 검사 | 로드맵 1("이력→자산 루프")의 데이터 부재. 현재 project-facts가 사실상 비어 있음. 400개 GJC 세션이 즉시 "반복 실패 명령·자주 바뀐 파일·역할별 모델 효과" 근거가 됨 | 신규 `framework/src/wiki/gjc-import.ts`(리더+투영) + `framework/src/sessions/digest.ts`(`engine: "gjc"` 허용, `source` 필드) + `framework/src/wiki/wiki.ts:707 captureWiki`(원천 추가) + `scripts/otter-wiki.ts`(플래그) + `knowledge/AGENTS.md`(조항) + 테스트 픽스처는 합성 jsonl | M | 중: allowlist 위반 가능성(투영 테스트로 봉쇄), 대용량 파싱 시간(스트리밍·캐시 sha로 재실행 방지), GJC 포맷 변경(schema `version` 체크·미지 타입 무시) |
| 2 | **모델 프로필 레지스트리 + 역할별 effort·폴백 체인**: `combo-presets.ts`의 3개 상수를 데이터 파일(번들 기본 + `~/.config/otter/model-profiles.json`)로 옮기고, `ComboRoute`에 `effort?`와 `fallback?: ComboRoute[]` 추가, `/model combo <id>`·`--combo <id>` 지원. 엔진 실패(로그인 만료·429·CLI 비정상 종료) 시 같은 역할의 다음 체인 항목으로 **같은 대화를 이어서** 재시도 | 로드맵 3-A(엔진 장애 시 전환 제안)와 "템플릿 3개 하드코딩"(README:367) 한계. GJC가 63개 프로필로 검증한 설계 | `framework/src/hosts/combo-presets.ts`, `framework/src/hosts/types.ts`(ComboRoute), `framework/src/hosts/cli-transport.ts`(effort 전달: codex `-c model_reasoning_effort=…`, claude는 CLI 지원 여부 확인 필요), `framework/src/hosts/cli-host.ts`(폴백 루프), `framework/src/hosts/interactive-session.ts:2057,3828`(`/model combo`), `framework/src/sessions/store.ts`(`model-rebind` 기록 재사용) | M | 중: 역할 정책 ID 불변식(README "정책 ID에 포함")과 `/resume` 검증, 프로젝트 오버라이드 의미, Codex 슬러그 검증(`codex-models-0.159.3.json`) |
| 3 | **사용량·토큰·비용 기록 + `/usage`**: 턴마다 역할·엔진·모델별 `usage{input,output,cacheRead,cost?,ttft,durationMs}`를 트랜스크립트 종류 `usage`로 기록(codex `exec --json`의 token 이벤트, claude `-p --output-format json`의 usage, local은 Ollama 응답의 eval_count), 다이제스트에 합계, `/status`·상태줄에 세션 합계 | 로드맵 3-B/3-C. GJC `token-log.jsonl`·`/usage` 상당. #1과 합치면 콤보 추천 근거가 생김 | `framework/src/sessions/store.ts:16`(TranscriptKind 추가·validateKindData), `framework/src/hosts/cli-transport.ts`(파싱), `framework/src/sessions/digest.ts`(필드), `framework/src/hosts/interactive-session.ts:3405`(`/status`), `framework/src/tui/`(상태줄), `knowledge/AGENTS.md`(허용 필드 추가) | S–M | 낮음: 숫자 메타데이터만. local 엔진은 추정치임을 표기 |
| 4 | **크래시 저널 + 오류 지문 + 재시작 nudge**: 엔진 프로세스 비정상 종료·타임아웃·파싱 실패를 `stateRoot/errors/events.jsonl{fingerprint(engine+exitCode+stderr 머리 해시), at, sessionID, message}`에 기록, 같은 지문 반복 횟수 집계, 다음 대화형 시작 때 "마지막 세션 `<sid>`가 X로 끝났습니다 — `/resume <sid>` 또는 다른 엔진" 1회 안내. 다이제스트 `outcome: abandoned`에 사유 코드 연결 | "abandoned" 세션이 왜 버려졌는지 모름, 로드맵 5-D·3-A의 전제. GJC `gjc-error-events.jsonl`+`gjc-crash-index.json` 상당 | `framework/src/hosts/vendor-process.ts`(종료 분류), `framework/src/hosts/cli.ts`(시작 안내; `update-check.ts` 패턴 재사용), `framework/src/sessions/digest.ts`(사유), 테스트 `framework/test/` | S | 낮음: stderr 머리를 해시만 저장(본문 저장 금지) |
| 5 | **세션 트리·포크·제목**: `SessionMetadata`에 `title`(첫 사용자 턴 앞 60자, 결정적·모델 호출 없음)과 `parent{sessionID, seq}` 추가, `/fork [seq]`로 해당 seq까지 복사한 새 세션 생성, `/sessions` 목록에 제목·부모 표시, `/rename` | "시작 시 항상 새 대화"라서 이전 세션 발견성이 낮고, 실패한 턴 직전으로 되돌아가 다른 접근을 시도할 수 없음. GJC `/fork`·`/tree`·`titleSource` 상당(완전한 DAG 대신 복사 포크로 선형 불변식 유지) | `framework/src/sessions/store.ts:18-22,309,1239`, `framework/src/hosts/interactive-session.ts:3401-3426`, `framework/src/hosts/interactive-actions.ts:19`, `framework/src/tui/session-transcript.ts` | M | 중: `model-rebind`·workflow authority·`/undo` 체크포인트가 seq에 묶여 있어 포크 시 체크포인트는 버리고 workflow는 상속 금지 등 불변식 정의 필요 |

**차순위(한 줄씩)**: 엔진별 `firstEventTimeoutMs`/재시도 설정(로컬 모델 TTFT 대응, S, `cli-transport.ts`); 스킬 해시 락파일(`skills-lock.json` 상당, S, `framework/src/skills/`); 압축 시 결정적 요약(수정/읽은 파일 목록 보존, M, `context-command.ts`); 관리형 워크트리 생성 `--worktree new:<branch>`(M, `orchestration/`); `-p` 1회성 프롬프트 모드(S, `cli.ts`). **채택하지 않을 것**: MCP 자동 로드(엔진 격리 설계와 충돌), PTY bash(L; `!cmd` 핸드오프로 충분), 상주 브로커(1회성 서브프로세스 설계의 장점을 잃음).

---

## 부록 A. 확인한 경로

- `/Users/gimjiseong/.local/bin/gjc`, `/Users/gimjiseong/.gjc/natives/0.18.0/pi_natives.darwin-arm64.node`
- `/Users/gimjiseong/.gjc/agent/{config.yml, models.yml, model-presets/state.json, agent.db, history.db, models.db, credential-auto-import-state.json, gjc-crash-index.json, gjc-crash-index.json.retired, gjc-crash.log, gjc-error-events.jsonl, gjc-error.log, onboarding/frictionless.json, resident-cache/i-UYjXxT/, sidecar-cache/s-*/owner.json, blobs/, sdk/{broker.exit.json, sessions/index.jsonl, index.snapshot.json, index-audit.jsonl}, sessions/v2-*/, terminal-sessions/ttys*}`
- `/Users/gimjiseong/.gjc/{cache/tool-choice-capabilities.db, logs/gjc.*.log(.gz), logs/http-400-requests/, strata-agent/, machine-identity.secret}`
- `/Users/gimjiseong/orca/projects/AgentFramework/.gjc/{_session-<ulid>/ ×22, _session-%5B%22subagent-canonical%22…%5D ×370, state/sdk/, skills -> ../.agents/skills, worktrees/linux-live-qualification/, gjc-strata-evidence/, skillopt-pilot-review-20261003.json, skill-evaluation-p1-framework*.pty}`
- otter: `framework/README.md`, `framework/src/{skills/roots.ts, hosts/combo-presets.ts, hosts/cli.ts, hosts/cli-host.ts, hosts/cli-tools.ts, hosts/cli-transport.ts, hosts/interactive-session.ts, hosts/interactive-actions.ts, hosts/context-command.ts, hosts/chat-checkpoint.ts, hosts/update-check.ts, hosts/tool-policy.ts, tools/delegate.ts, sessions/store.ts, sessions/digest.ts, wiki/wiki.ts, wiki/recall.ts, tui/clipboard.ts, tui/render.ts, hooks/event.ts, hooks/config.ts}`, `scripts/otter-wiki.ts`, `knowledge/AGENTS.md`, `docs/otter-roadmap-2026-10-20.md`, `docs/lca-direct-execution-2026-10-20.md`

## 부록 B. 추론 표시 목록

Bun 단일 바이너리; pi_natives = PTY; 서브에이전트 생성·재개 메커니즘(이름·상태 파일에서 유추); 영수증 마커 파일의 원자적 교체 의미; resident-cache의 용도(암호화 reasoning 재전송); strata-agent가 홈 오버라이드로 만들어졌다는 점; terminal-sessions의 용도; GJC에 `/undo`가 없다는 점(바이너리 문자열에 부재); Claude Code식 훅 이름이 호환 계층이라는 점.
