# OpenCode 기반 자체 에이전트 프레임워크 심층 검토

- 일자: 2026-09-22
- 목적: OMC(oh-my-claudecode) / OMO(oh-my-openagent) / OMX(oh-my-codex) 류의 프레임워크를 **OpenCode 위에, 로컬 Gemma 4를 백엔드로** 직접 만들 때의 타당성·설계·로드맵을 정한다. 사용자 추가 요청으로 **EvoOntology 등 데이터 처리 지향 기법**의 수용 방안을 포함한다.
- 근거: 에이전트 팀 6개(OpenCode 확장 표면 감사 / OMO 코드 분석 / OMX 코드 분석 / OMC 웹 리서치 / 로컬 모델 제약 실측 / EvoOntology·데이터 기법 리서치)의 읽기 전용 조사. 모든 수치는 이 머신의 `opencode.db`(32세션·335메시지·172툴호출), `~/.ollama/logs/server-1.log`, 설치된 패키지 코드에서 나왔다. **[검증]** = 코드·로그·DB에서 직접 확인, **[추정]** = 외삽·유추.

---

## 0. 한 줄 결론

**만들 가치가 있다. 단, 세 프레임워크의 "복제"가 아니라 "반대 전제"로 만들어야 한다.** OMC·OMO·OMX는 (1) 프롬프트 토큰이 싸고 (2) 병렬 슬롯이 무한하며 (3) 모델이 30K 규칙을 잘 따른다는 전제 위에 있다. 이 머신은 셋 다 거짓이다. 실측으로 OMO의 Sisyphus 프리픽스는 31.6K 토큰이라 캐시 미스 한 번에 72초, 실제 세션 시간의 45%가 컴팩션에 쓰였고 "일하는 토큰"은 30%였다. 자체 프레임워크의 존재 이유는 **프리픽스 불변·프롬프트 예산·코드 측 오케스트레이션**이라는 로컬 우선 계약이고, 여기에 OpenCode의 플러그인 API가 OMX가 tmux 곡예로 만들던 것을 정식 API로 제공한다는 점이 결합한다.

---

## 1. 세 프레임워크 비교

| 항목 | OMC 5.5 (Claude Code) | OMO 4.19.4 (OpenCode 플러그인) | OMX 0.21.6 (Codex CLI) |
|---|---|---|---|
| 호스트 결합 | settings.json 훅 9종 + agents/skills/commands + MCP + statusLine | OpenCode 플러그인 훅 15종(v1 API만) | hooks.json 7종 + AGENTS.md 25KB + notify 훅 + rollout JSONL 폴링 워처 + tmux |
| 규모 [검증] | 41 skills, **294 hook 파일**, 19 agents, 29 commands | 48MB, `dist/index.js` **5.7MB 단일 번들**, 훅 팩토리 ~60개, 플러그인 툴 14개 + MCP 5종 | 81MB, `codex-native-hook.js` **22,003줄**, Rust 워크스페이스 동봉 |
| 에이전트 | 19개 md, haiku/sonnet/opus 티어 | 11개 프로그래매틱(`config.agent` 주입), 카테고리 8종 | TOML 18개(posture/model_class/leaf-guard) |
| 키워드 | 정규식 16개 + sanitizer(코드블록·인용·정보성 질문 제외), 한국어 alias | `ultrawork\|ulw`, `team mode`, `hyperplan\|hpp` | `$autopilot/$ultragoal/$team`, ralph·ultrawork는 sunset |
| 지속 루프 | **Stop 훅 `continue:false`** + circuit breaker + TTL 2h | `session.idle` → 2초 후 재프롬프트, stagnation 3/failures 5 | Stop 훅 block + no_progress_guard 8회 + 워처의 `tmux send-keys` |
| 팀 | CC 네이티브 implicit team + TodoWrite owner + handoffs/<stage>.md | 자식 세션 + BackgroundManager(동시성 설정) + tmux 시각화 | worktree + tmux pane + **파일 메일박스/claim_token/lease 원장** |
| HUD | statusLine 커맨드 | TUI 플러그인 sidebar slot | tmux split pane |
| 상태 | `.omc/` 제어면·데이터면 분리 | `.omo/run-continuation`, `boulder.json` | `.omx/state/*.json`, delivery lease 원장 |
| 주요 약점 | 메인테이너 스스로 과잉설계 인정(#3698), `.omc` 104개 파편화(#3873), native dep, 무alias 리네임 17개 | 프롬프트 7.7K+ultrawork 5.2K 토큰, 툴 description ≈5K 토큰, Gemma 변형 없음, 이 머신에 하네스 2개 공존(플러그인 + Senpi) | tmux 강결합, rollout 포맷 의존, provenance 방어 코드 폭발, 이 프로젝트에서 team 실패 로그 |

**공통 골격(세 프로젝트가 수렴한 것)**: 상태 파일 기반 모드 → 키워드로 진입 → 종료 시점에 미완료면 재프롬프트 → 서브에이전트/팀은 별도 세션 → HUD는 상태 파일 렌더. 이 골격 자체는 옳고, 빌릴 것은 골격이지 살이 아니다.

---

## 2. OpenCode가 주는 것과 안 주는 것 [검증]

기준: `@opencode-ai/plugin@1.18.31` 타입, OMO 실 코드, 라이브 config 스키마.

| 필요한 것 | OpenCode 프리미티브 | 비고 |
|---|---|---|
| 에이전트 정의 | `.opencode/agents/*.md` 또는 `config` 훅에서 `config.agent[...]` 직접 대입 | 전용 훅 없음. 디렉터리 단/복수(`agent`/`agents`) 혼재 → 둘 다 스캔 |
| 시스템 프롬프트 동적 변경 | `experimental.chat.system.transform({sessionID, model}, {system[]})` | agent 이름을 안 넘겨줌 → sessionID→agent 맵 유지 필요(OMO 동일) |
| 키워드/모드 | `chat.message`(message·parts 변형) | 1:1 |
| 툴 추가/대체 | `tool:{}` 훅, `.opencode/tools/*.ts`, 동명 override | 1:1. `tool.definition`으로 description 축소 가능 |
| 가드레일 | `tool.execute.before`(args 변형·throw로 차단), `tool.execute.after`(output 변형), `permission.ask` | 1:1 |
| Stop 훅(종료 차단) | **없음.** `event`의 `session.idle` → `client.session.prompt()` 재프롬프트 | 모델이 "끝"이라 한 뒤 다시 시키는 구조. hard cap·TTL·breaker 필수 |
| 서브에이전트 | SDK `session.create({parentID})` + `promptAsync({agent, model, system, tools})` | 내장 `task`는 동시성·모델 설정 없음 → `tools.task=false` + 자체 delegate 툴 |
| 컴팩션 | `experimental.session.compacting`(context 주입) + `compaction{auto,prune,tail_turns,…}` | 거의 1:1 |
| HUD | TUI 플러그인 `slots.register(sidebar_content/app_bottom)` + `event.on`, 또는 `opencode serve` SSE `/event` | statusLine 등가는 없음 |
| 외부 오케스트레이터 | `opencode serve` + `/session`, `/prompt_async`, `/children`, `/event`, `/tui/*` | tmux 없이 팀 실행 가능 |
| 세션 간 메모리 | 전용 API 없음. `instructions` 파일, `system.transform` 주입, `session.prompt({noReply:true})` | |
| 상태 저장 | SQLite `~/.local/share/opencode/opencode.db`(비공개 스키마), `storage/<plugin>/` | 읽기만, 쓰기는 API |

주의: v2 `define()` API는 Effect 4 beta 의존이고 AgentDraft에 `add`가 없어 **v1 훅 API로 짓는다**. `experimental.*` 훅은 버전 간 바뀔 수 있으므로 어댑터 한 겹을 둔다. OpenCode는 09-22에 1.18.32로 자동 업그레이드됐다(핀 필요, 자동화 설계 문서의 `versions.env`로 커버).

---

## 3. 이 머신의 제약이 설계를 강제한다 [검증]

| 실측 | 값 | 설계에 주는 의미 |
|---|---|---|
| 바닐라 build 프리픽스 | 6.8K 토큰(13초) | 예산의 기준선 |
| OMO Sisyphus 프리픽스 | **31.6K 토큰(72초)**, 서브에이전트 24~33K | 캐시 미스마다 1분+, 작업 공간 65K−32K−8K ≈ 25K |
| 서브에이전트 왕복 후 메인 캐시 복원 | plan 후 복원됨 / Junior 후 **88초 재프리필** | 복원은 비결정적 → "복원 안 됨"으로 설계 |
| 컴팩션 1회 | 2~4분(요약 12~21K + 재구축 33~50K 미캐시) | 68호출 세션에서 8회 = 32분 = **45%** |
| 출력 한도(8,192) 도달 | 4회 = 17분 = 24% | 폭주 생성 가드 필요 |
| Gemma 26B 툴 오류 후 행동 | 같은 `write`를 **13회 연속** 재발행, write 57% 오류 | 코드 측 반복 차단 필수 |
| 26B↔31B 전환 | 언로드+로드+캐시 전멸+31.6K/96 tok/s ≈ 5분 | 에이전트별 모델 라우팅 금지 |
| 26B KV | global 20 KiB/token + SWA 200 MiB 고정 → 슬롯당 1.5~1.9 GiB | `NUM_PARALLEL=2` 메모리 여유 큼 |
| 툴 스키마 | `task` 하나 ≈ 2.5K 토큰(31B에서 제거 시 27초 단축 역산) | 툴 개수 = 프리픽스 |

커뮤니티 근거: Ollama #18275/#17562/#15719(gemma4 툴 호출 파싱 실패·무한 반복), OpenCode #21034(gemma4 26b/31b 툴 루프). SWE-bench에서 Gemma 4 26B 17.4% vs Qwen3.6-35B-A3B 73.4%라는 gist는 1차 출처 미확인 [추정]. Ollama에 `qwen3.6:35b-a3b-coding-mtp-q4_K_M` 태그가 있다 [검증].

**결론**: 프레임워크가 지켜야 할 불변 계약은 다음 셋이다.
1. **정적 프리픽스 불변**: 시스템 프롬프트·툴 목록·thinking 토글은 세션 시작에 확정하고 세션 중 절대 바꾸지 않는다. 모드 지시·todo·리마인더는 **마지막 user 메시지 뒤**에만 붙인다.
2. **프리픽스 예산 ≤ 8K 토큰(툴 포함)**, 워커 세션 ≤ 5K.
3. **오케스트레이션·검증·반복 차단은 코드가 한다.** 26B는 워커로 쓰고, 오케스트레이터 역할을 모델에 맡기지 않는다.

---

## 4. 무엇을 빌리고 무엇을 버리나

**빌린다**
- OMX: 태스크 원장 스키마(`tasks/task-<id>.json`, `claim_token`, lease, `writeAtomic`), 모드 state 파일 + no-progress guard, 역할 정의의 posture/leaf-guard 계층(leaf-guard는 OpenCode `permission.task: deny`로 정확히 표현됨), codebase-map ≤1000자.
- OMC: 키워드 sanitizer(코드블록·URL·인용·정보성 질문 제외)와 우선순위 배열, 제어면(`state/`)과 데이터면(`plans/`, `handoffs/`) 분리, 단계별 `handoffs/<stage>.md` 10~20줄, PreCompact 체크포인트, skillify 품질 게이트 3문항, circuit breaker 목록(그 목록의 길이가 사고 이력이다).
- OMO: 조립 파이프라인(`createManagers → createTools → createHooks → createPluginInterface`)과 `disabled_hooks`, `deepMerge/protectUserFields/writeAtomically/_migrations`, 자식 세션 + `session.idle` 폴링 서브에이전트 패턴, `edit/json error recovery` 훅(로컬 소형 모델에 가장 유용), `experimental.max_tools` 트리밍 발상.

**버린다**
- 30K 규칙 프롬프트, 에이전트 11~19종, 모델 티어 라우팅(이 머신은 티어가 1개), tmux 신원 증명·pane owner 체계, rollout/JSONL 폴링 워처, 294 훅 파일급 게이트 중첩, native dependency(better-sqlite3), 텔레메트리, 무alias 리네임, MCP 서버로 자기 상태를 읽는 우회(플러그인 프로세스가 단일 writer면 불필요).

---

## 5. 제안 아키텍처

이름은 미정이며 아래는 `lca`(local coding agent)로 표기한다. 리포지토리 위치는 이 저장소 하위 `framework/`(플러그인 패키지) + `.opencode/`(프로젝트 자산)로 두고, 설치·doctor는 09-21 자동화 설계 문서의 `scripts/setup.sh`를 확장한다.

### 5.1 레이어

```
L5 HUD            TUI sidebar slot(이벤트 버스 렌더) / opencode serve SSE 외부 뷰
L4 Data layer     EvoOntology MCP(browse/resolve만) + db_query/schema_lookup/data_check 툴 + ontology-evolver 배치
L3 Orchestration  코드 측 직렬 세션 큐(SDK 자식 세션), 태스크 원장, 검증 게이트, handoffs
L2 State          .lca/state/*.json (git root 앵커, 단일 writer, atomic write), trajectories/, plans/, handoffs/
L1 Plugin core    config(에이전트·툴 주입) / chat.message(모드) / event(idle 루프) / tool.execute.*(가드) / session.compacting(체크포인트) / chat.params(모델별 옵션)
L0 Runtime 계약   프리픽스 예산·툴 캡·thinking 고정·NUM_PARALLEL 정책 → doctor가 강제
```

### 5.2 에이전트 (3 + 2)

| 에이전트 | mode | 프리픽스 | 툴 | 역할 |
|---|---|---|---|---|
| `main` | primary | ≤ 6K | read/edit/write/bash/glob/grep + `delegate` + `state` | 사용자와 대화, 작은 작업은 직접, 큰 작업은 태스크 원장에 쓰고 코드가 위임 |
| `worker` | subagent | ≤ 5K (구현: `budget.worker`) | read/edit/write/bash/glob/grep | 태스크 1개 실행, `task: deny`(leaf-guard), thinking OFF, 출력 4,096 |
| `reviewer` | subagent | ≤ 3K | read/glob/grep (bash 없음 — 검증은 코드가 실행, ask 권한은 무인 큐를 멈춤) | diff·검증 결과를 보고 첫 줄 ACCEPT / REJECT: 사유 |
| `data-analyst` | subagent | ≤ 5K | `resolve_semantics/browse_semantics`, `db_query`, `schema_lookup` | 온톨로지에서 매핑 → 질의 JSON → SQL 실행 |
| `data-verifier` | subagent | ≤ 3K | `data_check` | 결과 샘플 + 검사 결과로 판정 |

모드(`ulw`, `plan`, `team`, `data`)는 시스템 프롬프트를 바꾸지 않고 **user 메시지 말미에 ≤300자 지시**를 붙이는 것으로만 표현한다. 모드별 상세 절차는 `skills/<mode>/SKILL.md`로 두고 필요한 턴에만 `read`로 읽게 한다(OMO `skill` 툴이 17개 스킬 요약을 description에 넣어 13.5K자를 상시 점유하는 것과 반대).

### 5.3 플러그인 훅 매핑

| 훅 | 담당 |
|---|---|
| `config` | `config.agent`(위 5개), `config.tools.task=false`, `config.command`(`/plan`, `/team`, `/data`, `/stop`), `config.mcp.evo-semantic`, `config.compaction`(`prune`, `tail_turns`) |
| `tool` | `delegate(task_id)`, `state(read/write)`, `db_query`, `schema_lookup`, `data_check`, `ontology_evolve_request` |
| `chat.message` | 정규식 모드 감지(OMC sanitizer 이식, 한국어 alias 포함) → 모드 state 기록 → user 메시지 말미 지시 추가. 세션→agent 맵 갱신 |
| `chat.params` | 모델별 `reasoningEffort/maxOutputTokens` 고정(워커 4,096), 세션 중 변경 금지 |
| `tool.execute.before` | 동일 시그니처 재호출 2회 → 차단 + "다른 접근 필요" 메시지, 위험 명령 차단, 워커의 `task` 차단 |
| `tool.execute.after` | edit/json 오류 복구 힌트(OMO 이식), 파일 읽기 결과 트리밍(경로+해시+요약), `db_query` 결과 행 제한, EvoOntology 궤적 기록, n-gram 반복 탐지 시 abort |
| `event` | `session.idle`: 태스크 원장에 미완료가 있고 breaker 미발동이면 다음 태스크를 **워커 세션으로 직렬 위임**(메인 재프롬프트가 아님) → 완료 시 handoff 파일 갱신 → 메인에 결과 1개 메시지 주입. `session.compacted`: 체크포인트 복원. **[2단계 구현 주석 2026-09-22]** 큐는 idle이 아니라 main의 `delegate` 툴 호출 **안에서** 블로킹 실행한다(약한 모델은 결정 1회, main이 busy라 사용자 입력과 경합 없음). idle은 중단된 실행의 미완료 태스크를 main에 1회 알리고 `delegate({resume:true})`로 재개하게 한다. `state(read/write)` 툴은 폐기(원장은 코드 단일 writer, 프리픽스 절감). 리뷰어 판정은 툴 호출이 아닌 텍스트 계약(ACCEPT/REJECT 첫 줄) |
| `experimental.session.compacting` | `.lca/state/checkpoint.json`(todo, 현재 태스크, handoff 경로)을 context에 주입 |
| `experimental.chat.system.transform` | 사용하지 않는다(프리픽스 불변 계약). 유일한 예외는 세션 최초 1회 codebase-map ≤1000자 |

### 5.4 지속 루프의 안전장치 (처음부터)

- hard max 반복 20, 모드 TTL 2h, stagnation 3(원장 fingerprint 동일), 연속 실패 5, 컴팩션 직후 60초 가드, 컨텍스트 90% 초과 시 중단, 사용자 `/stop` 즉시 종료.
- 모든 판단은 원장 파일과 이벤트로 하고 모델 출력 텍스트를 파싱하지 않는다.

### 5.5 팀 실행

- 기본은 **직렬 큐**. 워커 1개가 GPU를 쓰는 동안 메인은 대기.
- `OLLAMA_NUM_PARALLEL=2`가 검증되면 슬롯 1 = 메인 캐시, 슬롯 2 = 워커 캐시로 **캐시 격리**를 얻는다(처리량 증가는 기대하지 않음). 검증 항목: `draft-mtp`가 `n_parallel>1`에서 초기화되는지, MLX 러너 다중 슬롯 지원 여부.
- 워크트리 격리는 옵션. 병합은 코드(`git merge --no-ff`)가 하고 충돌 시 원장 상태를 `blocked`로.
- 26B + 31B 동시 팀은 불가. 31B는 세션 단위 전환만.

### 5.6 데이터 레이어 (EvoOntology 수용)

EvoOntology는 실재한다 [검증]: RUC DataLab, arXiv 2609.15779(2026-09-21), `github.com/ruc-datalab/EvoOntology`(MIT). 데이터 에이전트를 위한 **자기진화 온톨로지 계층**을 MCP 서버(`evo-semantic`, Python 표준 라이브러리만)로 제공하고, 지능은 SKILL.md에 있어 **호스트 모델이 빌더·이볼버가 된다**. 이 구조가 OpenCode + Gemma로의 이식을 가능하게 한다.

| 구성 | 결정 |
|---|---|
| 정본 | `.evoontology/versions/ontology_vN/{terms,mappings,relations,constraints,evidence}.json`을 git 관리. 프로젝트 데이터의 핵심 엔티티(차량/장소/방문/위험도/발생)가 첫 온톨로지 |
| 에이전트 노출 툴 | `browse_semantics`, `resolve_semantics` 2개만(라이프사이클 툴은 `permission`으로 차단). 세션 매니페스트 수백 토큰만 프리픽스에 |
| 자체 툴 | `db_query`(read-only 트랜잭션, statement_timeout, LIMIT 50, 컬럼 폭 절단, 응답에 "다음엔 X는 볼 필요 없음" 힌트), `schema_lookup(table)`(전체 덤프 금지), `data_check(suite)`(Pandera/SQL assertion, pass/fail JSON만) |
| 진화 | `rolling_trajectory` 모드, 검증셋 10~15문항, 라운드 2~3, LLM Judge = 같은 Gemma. **Accept돼도 `set_active_version`은 사람 승인 후**(PR diff). 야간 헤드리스 `opencode run --agent ontology-evolver </dev/null` |
| 근거 | DDR-Bench +20pp, BIRD 63.6→72.7, 토큰 −20%. 정적 시맨틱 레이어를 프롬프트에 박으면 오히려 불안정. 게이트 제거 −11.2pp. **백본별로 다른 온톨로지로 진화하고 교차 이식 시 −6.6~−10.9pp → 반드시 Gemma로 build/evolve** |
| 로컬 비용 [추정] | 질의 1회 ≈ 6~10K 토큰, 프리필 15초 내. 진화 1라운드 = 검증셋 × 2 재실행 → 벤치의 8라운드는 5시간+, 배치 필수 |

함께 채택: SMQ식 "질의 JSON → SQL 컴파일러"(모델은 매핑만, Spider2 94%), Sophrosyne식 툴 응답 힌트(과탐색 4.6배 감소), Vanna식 "질문→검증된 SQL" 쌍을 evidence로 축적. 배제: GraphRAG(구조화 DB에 불필요), AlphaEvolve/EvoAgent(단일 슬롯에 비현실), Mem0/Graphiti(evidence가 도메인 메모리 역할), OMO codegraph(PR #7644로 제거됨).

### 5.7 HUD

TUI 플러그인 `sidebar_content` 슬롯에 원장(현재 태스크/큐 길이/breaker 상태/캐시 미스 카운트/컴팩션 횟수)을 렌더. 데이터는 `event` 훅과 `.lca/state`에서만. 모델에게 진행 상황 출력을 요구하지 않는다.

### 5.8 설정·설치

- `~/.config/lca/lca.jsonc`(user) → `.lca/lca.jsonc`(project, closest wins), 스키마 검증, 원자적 쓰기, `disabled_hooks`. 프로필·하네스 블록은 필요해질 때.
- 설치는 `scripts/setup.sh install --with-lca`로 09-21 설계에 합류. doctor에 **프리픽스 예산 검사**(`opencode run --pure` 대비 델타), 툴 개수, thinking 고정, `NUM_PARALLEL` 정책을 추가.
- **OMO 플러그인과 동시 사용 금지**(둘 다 `config.agent`를 덮어쓰고 마지막 승리). 전환 시 `plugin` 배열에서 제거. `~/.bun/bin/omo`(Senpi)는 별개이므로 무관.

---

## 6. 로드맵

| 단계 | 내용 | 완료 기준(측정) |
|---|---|---|
| 0. 기준선 | `--pure`로 바닐라 프리픽스·캐시 미스율·컴팩션 횟수 측정 스크립트(`opencode.db` 쿼리) | 세션당 프리픽스/미스/컴팩션 표 자동 생성 |
| 1. 코어 | 플러그인 골격(config/chat.message/tool.execute.*/event), `main`+`worker`, 반복 차단·출력 트리밍·오류 복구, 모드 state | 프리픽스 ≤ 8K, 동일 호출 반복 0회, 4주 전 fib 과제(20분+)를 5분 내 |
| 2. 루프·원장 | 태스크 원장, `delegate`, 직렬 워커 위임, breaker/TTL, handoffs, 체크포인트 | 3태스크 plan → 무인 완료, 캐시 미스 ≤ 태스크당 1회 |
| 3. 데이터 | EvoOntology MCP 연결, `db_query/schema_lookup/data_check`, `data-analyst/verifier`, 프로젝트 온톨로지 v0를 Gemma로 build | 대표 질의 세트(`sql`의 질의를 온톨로지 경유로 재현, 질의당 ≤ 10K 토큰 |
| 4. 진화·팀 | rolling_trajectory 야간 배치 + PR 게이트, `NUM_PARALLEL=2` 검증, 워크트리 옵션, HUD | 진화 1런 무인 완료, 워커 복귀 시 메인 재프리필 0회 |
| 5. 모델 | `qwen3.6:35b-a3b-coding-mtp` 동일 벤치(툴 신뢰성·MTP 수락률·프리픽스 캐시) | 툴 오류율·SWE류 과제 비교표 |

---

## 7. 리스크

1. **Gemma 4 툴 신뢰성**이 프레임워크로 못 고치는 바닥일 수 있다. 1단계 완료 시점에 5단계(Qwen3.6) 벤치를 앞당겨 판단한다.
2. `experimental.*` 훅 변동. 어댑터 한 겹 + OpenCode 버전 핀 + doctor 검사.
3. `session.idle` 재프롬프트는 Stop 훅과 달리 비결정적. breaker를 먼저 만든다.
4. OMO와의 공존 불가. 전환 시점을 명시하고 `opencode.jsonc` 백업.
5. EvoOntology는 26B 로컬에서 미검증. v0 build 후 검증셋 10문항으로 효과를 먼저 잰다.
6. `NUM_PARALLEL=2`에서 MTP 드래프터 동작 미검증. 실패 시 직렬 큐로 유지(설계는 그대로 성립).

## 8. 검증하지 못한 항목

31B 시간(96 tok/s 선형 외삽), 2슬롯 시 처리량 저하 비율, Gemma 긴 컨텍스트 품질, 장문 지시 준수율 정량치, SWE-bench 17.4%의 1차 출처, MLX 러너 다중 슬롯, EvoOntology의 SkillOpt 출처.
