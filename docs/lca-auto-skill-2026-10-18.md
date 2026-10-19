# otter 자율 스킬 선택 (auto-skill) 검토 및 반영 계획 — 2026-10-18

목표: 사용자가 `/skill:<name>`을 쓰지 않아도 otter가 요청에 맞는 스킬을 스스로 골라 적용한다.
범위: `otter chat`(CLI 호스트)이 주 대상, OpenCode 플러그인 경로는 보조.

## 1. 현재 상태 (코드 근거)

| 경로 | 스킬 선택 방식 | 근거 |
|---|---|---|
| `otter chat` 일반 스킬 | 사용자가 `/skill:<name>`을 제출할 때만 로드. 모델에는 skill 도구가 없음 | `hosts/interactive-session.ts` 2513, 2680-2694; `hosts/types.ts` CLI main 역할 |
| `otter chat` 보호 워크플로 | 정규식 의도 분류(`modes/detect.ts classifyIntent`) → ambiguous/architecture일 때 [chat / deep-interview / ralplan / cancel] 제안 | `interactive-session.ts intentOptions` 498, 2603-2645 |
| OpenCode 플러그인 | OpenJev `jev-latest`로 스킬 1개 추천 → `<otter-skill-advice>` 문구만 덧붙임(“optional, not a request to load”) | `hooks/chat-message.ts` 585; `routing/router.ts` |
| vendor CLI 자체 스킬 | 끔: claude `--disable-slash-commands --setting-sources ""`, codex `include_skills_usage_instructions=false` | `hosts/cli-transport.ts` 359; `hosts/codex-profile.ts` 35 |

즉 otter chat은 **어떤 경로로도 일반 스킬을 자율 적용하지 않는다.** 라우터(`createSkillRouter`)는 OpenCode 훅에만 연결되어 있고 CLI 호스트에는 연결되지 않았다.

### 실측 사실
- OpenJev 서버: `127.0.0.1:8080` LISTEN (PID 53914), 엔드포인트 `/v1/systemone`.
- 라우팅 결정 로그: `~/.local/state/otter/*/routing/*.jsonl` **0건**, `knowledge/raw/routing` 스냅샷도 이벤트 0건. → 라우터 정확도·지연에 대한 운영 데이터가 없다.
- `artifacts/skill-evaluation-p1/benchmark.json`은 관측 훅 오버헤드(p95 +1.1ms)만 측정했고 라우팅 정확도는 측정하지 않았다.
- 발견 가능한 스킬 ~35개: 프로젝트 `plan, ulw`(.opencode), `llm-wiki, typesafe-ai`(.agents, `.gjc/skills`는 같은 곳 심볼릭), 홈 `computer-use, find-skills, orca-cli, orchestration`(.agents/.claude), codex import 계층 `[OMX]` 24개.
- `~/.config/otter/otter.jsonc`의 `skill_trust`가 `~/.codex/skills`, `~/.agents/skills` 폴더 전체를 신뢰 → OMX 스킬 24개가 동의 없이 로드 가능한 상태.

### 구조적 제약
1. **라우터 카탈로그 상한 16개 초과 시 무조건 기권** (`routing/catalog.ts` 21). 현재 카탈로그 35개 → 그대로 붙이면 항상 none.
2. **신뢰 ≠ 자동 적용 적합성.** OMX 스킬은 omx/tmux/codex 상태를 전제(`team`, `worker`, `hud`, `cancel`, `omx-setup`…)하므로 otter에 자동 주입되면 해롭다. 신뢰는 “동의 프롬프트 생략”일 뿐이다(`skills/trust.ts` 주석).
3. **컨텍스트 예산.** 대화 요청 24,000자 − 응답 예약 8,000자 − 프롬프트 접두부 ≈ 스킬 본문 상한 ~14,000자. `ralplan`(17KB), `deep-interview`(41KB)은 들어가지 않는다. 현재 `bind()`에서 초과 시 턴 전체가 실패한다(`plan-conversation.ts` 132).
4. **스킬 바인딩은 턴 시작 시 1개 고정.** `bindSkillInvocation`은 요청 바인드 시점에 컨텍스트를 만든다. 모델이 턴 도중 스킬을 고르는 방식은 cli-host 도구 루프 재설계가 필요하다.
5. **스킬이 붙은 턴은 메모리 prefetch를 취소한다** (`plan-conversation.ts` 113). 자동 적용 빈도가 높으면 recall 품질이 떨어진다.
6. **동의 프롬프트는 대화형 TTY 전제** (`skills/session.ts choose`). 자동 경로에서 깜짝 동의 창이 뜨면 안 된다.

## 2. 설계 선택지

| 안 | 내용 | 판단 |
|---|---|---|
| A. 모델 자율 로드 | 메인 프롬프트에 카탈로그를 싣고 CLI에 `skill` 도구 제공, 모델이 턴 중 로드 | 보류. 제약 4(턴 중 재바인딩), main 접두부 8K 예산 대비 카탈로그 3-4K 토큰, 로컬 gemma의 도구 선택 신뢰도 미검증 |
| B. 디스패치 전 라우터 자동 적용 | 기존 OpenJev 라우터 + 검색 사전필터로 1개 선택 → 기존 `prepare`/`bind` 경로로 명시 호출과 동일하게 적용 | **채택.** 기존 보안 경로(캡처·해시·권한·감사) 재사용, 결정적 게이트, 모델 추가 호출 없음 |
| C. 메인 엔진으로 분류 호출 | 매 턴 메인 모델에 선택 질의 | 기각. 턴마다 원격/로컬 모델 호출 비용과 지연 2배 |

보호 워크플로(deep-interview/ralplan/ultragoal/autoresearch)는 **자동 시작하지 않는다.** 지속 상태·세션 슬롯 점유·다역할 비용이 있어 오판 비용이 크다. 대신 기존 의도 제안의 선택지 정렬에 같은 선택기 결과를 쓴다(3단계).

## 3. 동작 명세 (안 B)

턴 순서: 기존 hold 검사 → 의도 제안(사용자가 워크플로를 고르면 거기서 끝) → **auto-skill 선택** → 디스패치.

1. **게이트**: `skill_auto.mode`가 `auto`/`shadow`, 입력이 `/`로 시작하지 않음, `force:` 접두 없음, 세션 토글 on, 2,000자 이하, 비밀 패턴 없음, 진행 중 워크플로 없음.
2. **적격 카탈로그** (세션 시작·`/skills` 갱신 시 캐시):
   - 동의 없이 인가되는 스킬만: 프로젝트 common baseline(git 추적·무변경) 또는 사용자 `skill_trust`.
   - `native` 계층만 기본 포함. `import` 계층(codex/claude 프로젝트·홈 import)은 사용자 설정 `skill_auto.include`에 이름이 있을 때만.
   - `skill_auto.exclude` 이름 제외, 보호 워크플로 이름 제외, 본문 크기가 스킬 예산(§1-3)을 넘으면 제외.
   - `include`/`exclude`는 **사용자 config 전용**(`skill_trust`와 같은 읽기 경로). 클론한 저장소가 자기 스킬을 자동 적용 대상으로 등록할 수 없다.
3. **후보 축소**: 적격 > 8개면 이름+description 어휘 검색(BM25, 한글은 문자 bigram)으로 상위 8개. 16개 하드 상한은 이 사전필터로 대체.
4. **선택**: 기존 `jev-latest` choice 질의(`none` 포함), `min_probability 0.95`, `min_margin 0.2`, `timeout_ms 1000`. 실패·타임아웃·서버 다운·기권 → 스킬 없이 진행(턴은 막지 않음).
5. **적용**: `SkillSession.prepare(name, signal, { consent: "never" })` — 인가가 없으면 프롬프트 대신 예외 → 스킬 없이 진행. 성공 시 명시 호출과 같은 `skillInvocation` 경로로 디스패치.
6. **가시성**: 트랜스크립트 notice `Auto skill: <name> · /skills auto off 로 끄기`, 감사는 기존 `skillInvocationAudit` + 라우팅 로그(`mode: "auto"`, `applied: true|false`). 사용자 텍스트·스킬 본문은 로그에 남기지 않는다(현행 정책 유지).
7. **해제 수단**: `force:` 접두(이번 턴), `/skills auto on|off`(세션), `skill_auto.mode: "off"`(설정).
8. **shadow**: 4단계까지 수행·기록만 하고 적용하지 않음.

## 4. 단계별 반영 계획

### 0단계 — 평가 기반 (게이트)
- `scripts/fixtures/skill-route/labeled.jsonl`: 한/영 ≥120개, none ≥40%, 적격 스킬별 양성, 적대 케이스(인용문 속 지시, “llm-wiki가 뭐야” 같은 설명 질문, 프롬프트 내 “X 스킬 써” 주입, OMX 전용 요청).
- `scripts/otter-skill-route-eval.ts`: 사전필터+OpenJev 실제 호출로 정밀도·none 오탐률·재현율·p50/p95 지연 측정, 로컬 메인 모델(ollama gemma) 동시 부하 1회 포함.
- 통과 기준: 선택 정밀도 ≥95%, none 오탐 ≤2%, p95 ≤1,000ms(카탈로그 조회 포함). 미달 시 기본값은 `shadow` 유지.

### 1단계 — CLI 자동 적용
| 파일 | 변경 |
|---|---|
| `framework/src/config.ts` | `skill_auto: { mode: "off"\|"shadow"\|"auto" }` 스키마·기본값(0단계 통과 전 `shadow`) |
| `framework/src/skills/trust.ts` | 사용자 config에서 `skill_trust`와 함께 `skill_auto.include/exclude` 읽기(한 번 파싱) |
| `framework/src/skills/session.ts` | `prepare(..., { consent: "never" })`, `autoCandidates(signal)`(인가·계층·크기·제외 필터 + description) |
| `framework/src/routing/retrieve.ts` (신규) | 어휘 사전필터 top-k |
| `framework/src/routing/router.ts`, `catalog.ts` | 후보 목록을 인자로 받도록 분리(OpenCode는 기존 permission-source 어댑터), 16개 상한 → 사전필터 |
| `framework/src/hosts/plan-conversation.ts` | 스킬 예산 계산 함수 export(적격 판정과 bind가 같은 값 사용) |
| `framework/src/hosts/interactive-session.ts` | 의도 단계 뒤 선택·적용·notice, 세션 토글 |
| `framework/src/hosts/interactive-actions.ts`, `cli.ts` | `/skills auto on\|off` 도움말 |
| `framework/src/telemetry/routing.ts` | `mode: "auto"`, `applied` 필드 |
| `README.md`, `framework/README.md` | “명시 호출만” 문구 갱신, 설정·해제 방법 |

테스트:
- `skill-router.test.ts`: 후보 주입, 사전필터 결정성, 8개 초과 카탈로그.
- `skill-session.test.ts`: `consent: "never"`는 미인가 시 프롬프트 없이 거부, 신뢰/baseline은 통과, 내용 변경 시 재캡처 불일치 거부.
- `interactive.test.ts`(가짜 라우터): 적용, 기권, 서버 다운, 타임아웃, 예산 초과 제외, import 계층 제외/include 허용, `force:` 우회, 워크플로 선택 시 미적용, 세션 토글, shadow 미적용 + 로그.
- `skill-router-redteam.test.ts`: 사용자 텍스트의 스킬명 주입·인용문이 선택을 강제하지 못함.

### 2단계 — 워크플로 제안 정렬 + OpenCode 문구
- `intentOptions`: 선택기가 고른 보호 워크플로를 첫 선택지로(자동 시작은 하지 않음).
- OpenCode `mode: "auto"`일 때 advice 문구를 “관련 없으면 무시, 관련 있으면 skill 도구로 로드”로 강화. OpenCode main은 이미 `skill` 도구+allowlist가 있으므로 별도 바인딩 불필요.

### 3단계 — (재평가 후) 모델 자율 로드(안 A)
1-2단계 운영 로그에서 기권 후 사용자가 직접 `/skill:`을 친 비율이 높을 때만 검토.

## 5. 위험과 대응

| 위험 | 대응 |
|---|---|
| 오선택 스킬이 조용히 행동을 바꿈 | 높은 임계값, 매 턴 notice, 3단계 해제 수단, shadow 선행 |
| OMX 등 런타임 전제 스킬 주입 | import 계층 기본 제외, 사용자 include만 허용 |
| 클론 저장소의 자기 등록·프롬프트 주입 | `include`/`exclude`/`skill_trust`는 사용자 config에서만 읽음. 단, 커밋되고 수정되지 않은 프로젝트 스킬은 baseline이라 사용자 설정 없이도 목록에 오름(§8 참조) |
| 매 턴 지연 | 1s 타임아웃, 실패 시 무스킬 진행, 단일 슬롯 |
| OpenJev(MLX)와 로컬 메인 모델 GPU 경합 | 0단계 동시 부하 측정, 미달 시 shadow |
| 예산 초과로 턴 실패 | 적격 판정에서 크기 제외(bind와 같은 함수) |
| 메모리 prefetch 손실 | 자동 적용 턴 비율을 로그로 측정, 필요 시 스킬 턴에서도 prefetch 허용 검토 |
| 깜짝 동의 창 | `consent: "never"` |

## 6. 구현 상태 (2026-10-18)

- 1단계 구현 완료: `skill_auto`(사용자 설정 전용, 기본 `shadow`), `SkillSession.autoCandidates`/`prepare({ consent: "never" })`, `routing/retrieve.ts` 사전필터, `createAutoSkillSelector`(연속 3회 전송 실패 시 60초 백오프), `otter chat` 적용·알림·`/skills auto on|off`, 라우팅 로그 `auto_skill` 이벤트. 문서: `framework/README.md` "Automatic skill selection", 루트 `README.md`.
- 0단계 하네스 완료: `scripts/fixtures/skill-route/labeled.jsonl`(132건, none 51%, 적대 29건), `scripts/otter-skill-route-eval.ts`.
- 0단계 측정 결과 (`artifacts/skill-route-eval/`):
  - 1차: 124건 전부 `aborted`. OpenJev(MLX, PID 53914, 19일 가동)의 `/health`는 응답했지만 `/v1/systemone`이 60-120초 넘게 무응답이었음(여유 메모리 10%, swap 대량). 증거: `openjev-hang-2026-10-18.txt`, `report-2026-10-18.json`.
  - 조치: `launchctl kickstart -k gui/<uid>/local.openjev`로 재시작. 이후 추론 1건당 약 23-90초가 걸림. Ollama 모델 2개(qwen3.6 35B, gemma4 26B)가 무기한 상주해서, 사용자 설정으로 보고 내리지 않았음.
  - 2차(측정 타임아웃 90초, 132건 = 기존 124건 + OMX 적대 8건): 답이 온 것은 24건이고 모두 양성 케이스였음. 정답 22, 기권 2, 오선택 0. none/적대 케이스는 전부 타임아웃이라 오탐률은 **미측정**. 답이 온 요청의 지연은 63-90초. 보고서 `report-2026-10-18-accuracy.json`, 케이스별 `journal-2026-10-18.jsonl`.
  - 게이트: precision 1.0(22/22), noneFalsePositive는 미측정(0/0), p95와 transport는 실패. 기본값은 `shadow` 유지.
  - 계획의 "로컬 메인 모델 동시 부하 측정"은 별도로 하지 않음. 측정 중에 Ollama 모델이 상주해 있었으므로 결과에 그 부하가 섞여 있음.
- 남은 측정: 메모리를 확보한 뒤(상주 모델 해제 등) `bun scripts/otter-skill-route-eval.ts --measure-timeout-ms 90000 --journal <file> --out <report>`를 다시 돌려 none/적대 케이스를 측정하고 지연을 확인. 게이트를 통과할 때만 `skill_auto.mode: "auto"`를 권장.

## 7. 2단계 전환: 모델이 맥락을 보고 직접 호출 (2026-10-19, 사용자 결정)

사용자가 "대화 맥락 속에서 필요한 스킬을 호출"하는 방식(§2 안 A)을 선택했다. 그래서 전송 전에 라우터가 스킬을 골라 붙이는 방식(안 B)을 없앴다.

- 동작: 일반 채팅 턴의 메인 모델에 동의가 필요 없는 스킬 목록(이름+설명)과 `skill` 도구를 준다. 모델은 대화 맥락을 보고 그 턴 안에서 필요한 스킬을 불러온다(`{"type":"tool","name":"skill","input":{"name":...}}`). 불러온 지침은 그 턴의 도구 결과로 들어가고, 역할의 도구·읽기 전용 제한·승인 규칙은 바뀌지 않는다.
- 구조
  - `ExecutionRequest.skillTool`(`SkillToolProvider`: catalog, load, delivered)을 `plan-conversation` → `workflows/turn.ts` bind → `cli-host`로 전달한다.
  - `skill`은 role policy 바깥의 host 제공 도구다. 그래서 `PLANNING_MAIN_TOOLS`와 정책 ID, 동결된 baseline은 바뀌지 않는다.
  - main 역할이고, 명시 `/skill:` 바인딩이 없고, 목록이 비어 있지 않을 때만 노출한다. 다른 경우에 `skill`을 호출하면 기존 거부 경로로 실패한다.
- 안전장치
  - `load`는 `prepare({ consent: "never", requiredTools })`로 현재 내용과 도구 범위를 다시 확인한다.
  - 목록에 없는 이름, 같은 턴의 재호출, 남은 입력 예산에 통째로 들어가지 않는 지침은 도구 오류로 돌려준다. 프롬프트는 띄우지 않는다.
  - `delivered`는 지침이 실제로 모델 입력에 들어갔을 때만 기록한다(`Skills used:` 알림, `Skill tool load` 감사, 라우팅 로그 `skill_tool_load`).
- 설정: `skill_auto.mode`는 `off | auto`(기본 `auto`)다. `shadow`와 전송 전 라우터 선택은 제거했다. OpenJev 선택기는 의도 제안 순위에만 쓴다.
- 실측(`scripts/otter-skill-tool-smoke.ts`, gemma4-26b-mtp, `artifacts/skill-tool-smoke/run-2026-10-19.jsonl` 외 추가 실행 포함)
  - 맥락에만 의존하는 후속 요청("그거 정리해서 배포용 문서로 써줘")에서 release-notes를 불러온 비율: 5/5.
  - 무관한 턴에서 스킬을 불러온 경우: 0/10.
  - 15턴 중 1턴은 최종 텍스트 안의 이스케이프되지 않은 코드 블록 때문에 JSON envelope가 깨졌다. 스킬 호출과는 무관하고, 같은 프롬프트를 단독으로 돌리면 5/5 정상이었다.
- 첫 실측에서 모델이 `{"type":"skill",...}`처럼 잘못된 envelope을 썼다. 그래서 목록 안내문에 정확한 호출 예시를 넣었고, 이후에는 재발하지 않았다.
- claude 엔진 실측은 CLI가 로그인되어 있지 않아서 하지 못했다(`claude auth status`: loggedIn false).

## 8. 미검증 항목 심층 검토 (2026-10-19)

- 최종 방식(모델이 직접 호출) 코드 리뷰를 따로 받았다. 결과는 REQUEST CHANGES, 차단 2건. 둘 다 고쳤다.
  1. 불러온 스킬 지침이 다음 도구 결과 때문에 잘리거나 빠질 수 있었는데, 화면에는 `Skills used`로 계속 표시됐다.
     - 수정: 스킬 교환은 잘라내지 않는다. 다른 결과를 먼저 줄이고, 오래된 교환을 먼저 뺀다. 그래도 넣을 수 없을 때만 지침 전체를 빼고 "더 이상 적용되지 않음" 안내로 바꾼다.
     - 뺀 스킬은 `withdrawn`으로 표시 목록과 감사 기록에서 빠지고, 같은 턴에서 다시 불러올 수 있다.
  2. 스킬 목록 길이에 제한이 없어서, 긴 대화(한글 기준 약 8천 자 이상)에 스킬이 많으면 매 턴 모델 호출 전에 실패할 수 있었다.
     - 수정: 목록은 요청 텍스트 기준 상위 12개, 설명은 160자로 자른다. 그래도 넘치면 그 턴만 스킬 없이 진행한다.
- 같이 고친 것: 거부된 로드를 같은 턴에 다시 부르면 기록된 거부를 그대로 돌려준다(재캡처 없음). 취소(Escape, /cancel, stop)하면 느린 로드도 중단한다.
- 결정(2026-10-19, 사용자 확인: 의도한 동작): 기본값 `auto`에서는 클론한 저장소에 커밋된 스킬이 사용자 조치 없이 목록에 오르고 불러와진다. 도구 범위는 넓어지지 않는다(main은 읽기 전용이고 승인 규칙도 그대로). opt-in으로 바꾸지 않고 이대로 유지한다. 원치 않으면 `exclude` 또는 `mode: "off"`로 끈다.
- 실제 `otter chat` E2E: `launchInteractive`와 `defaultDependencies`를 실제로 쓰고, 터미널 입력만 스크립트로 대신했다. 사용자 설정과 상태 디렉터리는 격리했다.
  - local gemma4-26b-mtp, codex gpt-5.6-sol 모두에서 맥락 후속 요청 "그거 정리해서 배포용 문서로 써줘"가 release-notes를 불러 형식대로 작성했다.
  - 무관한 질문(파이썬)은 스킬을 불러오지 않았다.
  - SQL 리뷰 요청은 sql-style을 불러왔다.
  - 스킬 동의 창은 한 번도 뜨지 않았다.
  - 위 맥락 후속 요청은 의도 분류에서 "under-specified" 제안이 먼저 뜬다. 기존 동작이며, "Continue in chat"을 고르면 진행된다.
- Claude 엔진은 CLI가 로그인되어 있지 않아(`loggedIn: false`) 실측하지 못했다.
- OpenJev는 지금도 요청 1건에 약 64초가 걸린다(여유 메모리 10%). 그래서 '스킬 없음' 케이스의 오탐률은 여전히 미측정이다. 이 선택기는 이제 의도 제안 순서에만 쓰인다.

## 9. 판단 엔진을 OpenJev에서 Claude/Codex로 통일 (2026-10-19)

결정 사항: 판단은 OpenJev가 아니라 Claude/Codex가 각자 지원하는 기능으로 한다(메모리 recall은 이미 `memory.engine: auto`로 그렇게 동작). 이번 작업에서 남아 있던 OpenJev 직접 호출을 같은 경로로 옮겼다.

- 공통 판단 모듈 `framework/src/routing/judge.ts`(`judgeChoice`)
  - 엔진: claude/codex/local CLI(도구 없이 실행) 또는 jev.
  - 엔진 선택은 `memory.engine`을 그대로 따른다. `auto`는 claude가 먼저, 없으면 codex이고, 모델을 지정하지 않으면 claude-haiku-5-5 / gpt-5.6-luna.
- 옮긴 곳
  - 메모리 recall: 동작 변화 없이 `judgeChoice`를 쓰도록만 정리(테스트 23/23).
  - `otter chat`의 의도 제안 순위.
  - OpenCode 플러그인의 스킬 조언(`skill_router`, 이 저장소는 suggest 모드).
  - 평가 스크립트(`--engine auto|claude|codex|jev`).
- 남은 OpenJev 경로: `memory.engine: jev`로 설정했을 때만 호출한다. 메모리는 `memory.endpoint`, 스킬 판단은 `skill_router.endpoint`를 쓴다. `skill_router.endpoint`는 지우지 않았다. 지우면 동결된 역할 정책 ID 해시가 바뀌어 기록된 실행·워크플로 재개가 깨지기 때문이다.
- 시간 제한
  - CLI 판단은 몇 초가 걸리므로 `min(memory.timeout_ms, 15 s)`를 쓴다.
  - jev는 기존 `skill_router.timeout_ms`(기본 1초)를 쓴다.
  - OpenCode suggest 모드에서는 메시지마다 CLI 판단 몇 초가 더해진다. 대신 메시지 텍스트와 스킬 이름·설명이 해당 벤더로 전송된다.
- 실측(132건, 라벨 데이터)

  | 엔진 | 게이트 | 고른 수 | 정밀도 | 'none' 오탐 | 재현율 | p95 |
  |---|---|---|---|---|---|---|
  | claude-haiku-5-5 | 통과 | 9 | 9/9 | 0/68 (적대 0) | 14% | 4.9초 |
  | gpt-5.6-luna | 실패 | 62 | 95% | 3/68 | 92% | 6.6초 |

  - Codex 오탐 3건: "What is the plan skill for?", OMX worker 요청 → orchestration, `omx_wiki` 기록 → llm-wiki.
  - `auto`는 claude를 먼저 쓰므로 기본 경로는 게이트를 통과한다. Codex만 설치된 환경은 오탐 위험이 있다(의도 제안 순서에만 영향, 자동 시작 없음).
  - 이전에 막혀 있던 'none' 오탐률을 이번에 처음으로 측정했다.
- 실제 `otter chat` E2E에 Claude 엔진을 추가했다(로그인 후, claude-haiku-5-5).
  - 맥락 후속 요청에서 release-notes, SQL 리뷰에서 sql-style을 불러왔다.
  - 무관한 턴은 스킬을 불러오지 않았다.
  - 동의 창은 0회였다. 2회 실행 모두 같은 결과(`artifacts/skill-tool-smoke/chat-e2e-2026-10-19.txt`).
