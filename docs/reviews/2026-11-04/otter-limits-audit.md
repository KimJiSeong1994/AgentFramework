# otter 런타임 제약 감사 (2026-11-04)

기준: 브랜치 `feat/otter-intro-motion-video` (master c703a06 기준), `framework/src/` 경로 기준. 모델 호출 없음. 실행한 읽기 전용 명령: `otter --help`, `otter auth status`, `otter harness profile --json`, `otter engines`, `scripts/otter-doctor.sh`, `bunx tsc --noEmit`.

환경 사실: codex-cli **0.165.0** (Homebrew cask), claude 2.1.318, ollama 0.40.6, opencode 1.18.35. `~/.local/bin/otter`는 설치본이 아니라 **소스 체크아웃**(`framework/src/hosts/cli.ts`)을 직접 실행한다 (`.git/otter-installer` 없음).

---

## 1. 제약 목록

범례 — 의도: Y = 의도적 안전장치(보안·권한·무결성 정책), N = 구현 한계/미완. 난이도: S(하루 이내) / M(며칠) / L(설계 변경).

### 1-A. 실행/승인

| 제약 | 코드 위치 | 사용자가 체감하는 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| 기본 `ask` 모드: write/edit/bash/model_api **매번** 승인(Allow once/Always/Deny) | `hosts/interactive-session.ts:1242-1290`, `config.ts:522-530` | 작은 작업도 승인 피로. 거부는 도구 결과로 돌아가 턴은 계속됨 | Y | M |
| **읽기 전용 명령 자동 허용 제거** (`git status`, `ls`, `cat` 등도 승인) | 커밋 `11c9de8`: `chat-actions.ts`에서 `readOnlyCommand`/`READ_ONLY` 삭제, `interactive-session.ts:1247-1256`에 분기 없음 | 모델이 `git status` 한 번 치려 해도 물어봄. README는 아직 자동 허용이라고 적혀 있음(§2) | Y(권한 정책, 11c9de8 "enforce user authority") | S (정책 결정 필요) |
| 항상 거부 목록: sudo/su/doas/pkexec, `rm -rf /|~`, force push, mkfs/fdisk/diskutil erase, `dd of=/dev/`, shutdown/reboot, 포크밤, `>/dev/sd*` | `hosts/chat-actions.ts:22-32` | 사람이 허용해도 거부, `!<cmd>`로만 가능 | Y | — |
| "Always allow" 규칙 = **앞 두 단어**, 파이프·체인·리다이렉트·치환 포함 명령은 규칙 제공 안 함, 사용자 설정만, 최대 100개 | `chat-actions.ts:44-51, :16, :65-72` | `bun test \| tail` 같은 건 매번 승인 | Y | S |
| 폴더 허용은 **편집에만, 이번 턴만**, 명령에는 없음, 저장 안 됨 | `chat-actions.ts:103-121`, `interactive-session.ts:1268-1272` | 테스트 명령은 폴더 허용으로 못 풀음 | Y | M |
| `auto-edit`는 사용자 설정만 부여, 프로젝트 설정은 축소만 가능 | `config.ts:522-530` | 저장소 설정으로 편의 모드 못 켬 | Y | — |
| **응답당 도구 1개만 실행**; 엄격 엔벨로프 밖에서 온 호출은 읽기 전용만, 그마저 첫 번째만 | `hosts/cli-host.ts:1413-1416`, `:393, :448-457` | 모델이 3개 호출을 보내면 1개만 돌고 "나머지는 안 돌았다"고 통보 → 왕복 과다 | N(부분적: multiread로 완화) | M |
| 턴당 도구 라운드 **24**, 채팅 main만 "24개 더?" 3회 연장(최대 96), 워커·워크플로 역할은 하드 리밋 | `cli-host.ts:59-61, :1088-1090, :1450-1464`; `interactive-session.ts:1344-1352` | 큰 리팩터링 한 턴에 못 끝냄 | N | S |
| `multiread` ≤ 8파일, 합산 32 KiB, 각 파일이 라운드 1개씩 차감; 프롬프트가 넘치면 multiread 자체를 뺌 | `hosts/cli-tools.ts:21, :754`; `cli-host.ts:1033-1035, :1450` | 묶음 읽기가 라운드 절약이 안 됨 | N | S |
| 응답은 **JSON 엔벨로프** 필수; 깨지면 "malformed CLI response; no fallback execution was attempted"로 턴 실패. 미지 도구명도 실패 | `cli-host.ts:69, :415-457, :1314, :1411` | 로컬 모델에서 포맷 실패 빈번(README 자체 측정 5-9%) | Y(무결성) | L |
| `model_api`는 매번 Allow once(규칙·폴더·auto-edit 무효), 사용자 설정 타깃만, https 또는 루프백 http만, 프롬프트 16 KiB, 출력 1-4096 토큰, 1-600 s, 재시도 없음, 응답 256 KiB/텍스트 16 KiB | `hosts/model-api.ts:19-20, :24-30, :31-39, :72-76` | 외부 모델 호출이 번거롭고 짧음 | Y | M |
| 모델 전환 거부 조건: 다른 실행 활성, 워크플로 상태 손상, 이 세션의 워크플로 활성, 소유권 미해결; 워크플로 중 **엔진 변경 불가** | `interactive-session.ts:2720-2750, :2894`; `sessions/admission.ts:670-682` | ralplan 중 claude→codex 못 바꿈 | Y | — |
| `/model combo apply`·모델 선택은 세션이 held면 불가 | `interactive-session.ts:3822, :3842` | 복구 먼저 해야 함 | Y | — |
| 시작 조건: 접근 가능한 디렉터리, 정규 Git worktree, 홈 폴더/타 사용자 폴더 거부, stdin/stderr TTY 필수, TUI 최소 60x20 | `interactive-session.ts:551-571, :1046`; `hosts/cli.ts:109-110` | 홈에서 `otter` 치면 시작 안 됨 | Y | — |
| 설정 파일 오류(`chat.intent/worktree/execute`, `local_model`, `delegate` 모양)는 **예외로 시작 거부** | `config.ts:507-535` | 오타 하나로 otter가 안 뜸 | Y | S |

### 1-B. 도구

| 제약 | 코드 위치 | 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| 모드별 도구: plan = read/list/glob/grep/memory; ask/auto-edit = +write/edit/bash/model_api(+multiedit, multiread, skill은 호스트가 추가) | `hosts/tool-policy.ts:25-28`; `cli-tools.ts:940-947` | 워크플로 역할·워커는 쓰기 불가 | Y | — |
| `edit`: oldText **정확히 1회** 일치만, 64 KiB 상한; `multiedit` ≤20개, 하나라도 실패하면 전부 미적용 | `cli-tools.ts:23, :70, :159-160, :465, :504` | 흔한 문자열은 편집 실패 반복 | N | M |
| `write` ≤ 64 KiB; `read` 파일 ≤1 MiB, 출력 ≤32 KiB, **하드링크(nlink≠1) 거부** | `cli-tools.ts:69-71, :155, :736, :978` | 큰 파일 생성 불가 | Y/N | S |
| `grep`: 200건, 8 MiB 총량, **1000 ms** 시간 예산, 파일당 256 KiB; `list/glob` 10,000 엔트리·깊이 16·200건 | `cli-tools.ts:73-79, :788-829` | 큰 저장소에서 grep 결과 잘림 | N | S |
| `.gitignore` 대상 경로는 list/grep/단일 grep 모두 거부("ignored directory is unavailable") | `cli-tools.ts:687, :785, :849` | node_modules·build 산출물 못 봄 | Y | S |
| 보호 디렉터리 `.git/.otter/.gjc`, 자격증명 디렉터리/파일(.ssh .aws … ) 읽기·쓰기 거부; `knowledge/raw/` 쓰기 거부 | `cli-tools.ts:82, :88-89, :201, :391, :420-434` | | Y | — |
| 경로는 worktree 내부 상대경로만, 심링크 미추적(O_NOFOLLOW) | `cli-tools.ts:81, :216, :393` | 모노레포 외부 참조 불가 | Y | — |
| `bash`: `/bin/sh -c`, 기본 120 s·최대 600 s, 명령 4096자, 모델에 돌아가는 출력 16,000자 꼬리 | `cli-tools.ts:25-27`; `chat-actions.ts:15` | 긴 빌드는 타임아웃 | N | S |
| `memory`/`skill`/`repo_search`는 호스트 제공, `execute`에서 직접 호출 거부 | `cli-tools.ts:902-909` | — | Y | — |

### 1-C. 예산/컨텍스트

| 제약 | 코드 위치 | 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| 입력 예산(추정 토큰): local main 8192(설정 4096-65536), **vendor main 49,152**, 워커·데이터·판정 역할 **5,120** | `cli-host.ts:51-58, :550-552`; `config.ts:541-543` | Claude/Codex 200K+ 컨텍스트를 1/4만 사용; 워커는 5K라 큰 diff 못 봄 | N | S |
| 대화창: local 24,000자(토큰×3, 최대 196,608), vendor 96,000자, 응답 예약 8,000자, 최대 24턴 페어, 프로젝트 팩트 600자 | `hosts/plan-conversation.ts:15-28, :21-22, :111`; `sessions/history.ts:16` | 긴 세션에서 앞부분 자동 삭제(요약 없음) | N | M |
| 예산 초과 시 "estimated input budget exceeded"로 턴 실패 (현재 입력·핀은 잘리지 않음) | `cli-host.ts:1096, :1104`; README:519-520 | 큰 파일 붙여넣기 → 실패 | Y | M |
| 토큰 추정기는 Gemma 기준 휴리스틱(±15%)을 Claude/Codex에도 적용 | `tokens.ts:1-12, :44-63` | 예산 계산이 벤더 실제와 다름 | N | M |
| 벤더가 보고한 **실제 사용량(input/output/cached/cost)을 받고 버림**; 채팅·워크플로에서 안 씀 | `hosts/cli-transport.ts:35-42, :639, :804, :931`; 소비자는 `skillopt/{broker,campaign,controller}.ts`뿐 | `/status`에 비용·토큰 없음 | N | S |
| 응답 256 KiB, 턴 총 출력 16 MiB; 프로세스 최대 24 h | `cli-host.ts:63-65`; `cli-transport.ts:86-89` | — | Y | — |
| 워크플로 역할 턴 데드라인 = `delegate.task_ttl_ms` 15분; 검증 명령 120 s(`verify_timeout_ms`) 넘으면 **fenced**(재시도 거부) | `workflows/turn.ts:261`; `config.ts` DEFAULT delegate; README:1202-1214 | 느린 테스트 스위트는 autoresearch/ultragoal에서 막힘 | Y | M |
| 메모리 회상: 30 s, 질의 2000자, 후보 16, max_pages 3, **동시 1건(busy)**; `prefetch: true` 기본 → **매 main 턴마다 haiku/luna 추론 1회** | `wiki/recall.ts:19-24, :200, :215`; `config.ts` DEFAULT memory | 매 턴 몇 초 지연·벤더 호출 추가 | N | S |
| 스킬 카탈로그: 턴당 12개, 설명 160자, ~14K자 초과 스킬 제외 | `cli-host.ts:557`; README:1047-1052 | — | N | S |
| 프롬프트 바이트 1 MiB, 모델 ID 256 B | `cli-transport.ts:84-85` | — | Y | — |

### 1-D. 엔진/모델

| 제약 | 코드 위치 | 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| **Codex CLI 버전 핀**: `0.159.3`·`0.163.0`만 허용. 설치본 **0.165.0 → 거부**. `otter engines`: "codex: 0.165.0 (not otter-supported) · homebrew … brew uninstall --cask codex && npm install -g @openai/codex@0.163.0" | `hosts/codex-profile.ts:16`; `cli-transport.ts:943-948`; `interactive-session.ts:1702-1711, :2157-2172` | 사용자 기본 `codex/gpt-6-astra`라 **매 실행마다 "Cannot start codex / gpt-6-astra"** 후 미선택 composer. 콤보의 codex 경로(worker·data-analyst·ontology-evolver·simplifier → gpt-5.6-luna)도 세션에서 탈락 | Y(프로필 검증) | S(핀 추가) / L(버전 무관화) |
| Codex 모델은 **번들 슬러그만**: gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 (+hidden). 미지 ID → "unsupported Codex model profile"/콤보 invalid | `codex-profile.ts:45-48`; `hosts/default-model.ts:135-136`; `hosts/codex-models-0.159.3.json` | 새 모델 나오면 코드 갱신 전까지 사용 불가 | Y | S |
| Claude: 카탈로그는 fable/sonnet/opus/haiku 별칭만; 정규식 통과 ID는 `claude --model`로 그냥 전달(실패 시 "native CLI reported failure"로 가려짐) | `hosts/model-catalog.ts:30-41` | 오타 모델은 벤더 에러로만 보임 | N | S |
| Local: `ollama run <m> --think=false --nowordwrap` — **모든 로컬 모델 thinking 강제 OFF** | `cli-transport.ts:464-468` | 추론 모델 품질 저하 | N(안정성 선택) | S |
| Claude argv: `-p --restricted --safe-mode --tools "" --setting-sources "" --settings disableAllHooks --disable-slash-commands --no-session-persistence --system-prompt …` → 네이티브 도구·CLAUDE.md·훅·세션 연속성 없음 | `cli-transport.ts:445-450` | Claude Code 본연 기능 전부 비활성, 매 턴 전체 프롬프트 재전송 | Y | L |
| Codex argv: `exec --json --ephemeral --ignore-user-config --ignore-rules … shell_tool=false multi_agent=false web_search=disabled mcp_servers={} project_doc_max_bytes=0` | `cli-transport.ts:453-462` | AGENTS.md·웹검색·MCP 없음 | Y | L |
| 네이티브 tool_use 징후 → "native tool activity refused" 턴 실패 | `cli-transport.ts:106, :629, :660-666, :757-761, :803` | 벤더 CLI가 플러그인·도구를 켜면 전부 실패 | Y | — |
| 벤더 프로세스 환경은 **허용 목록만**(PATH HOME … CODEX_HOME CLAUDE_CONFIG_DIR XDG_*); API 키 환경변수 전달 안 함 | `hosts/vendor-process.ts:12-13, :37-44`; `engine-auth.ts:259` | `ANTHROPIC_API_KEY`만 있으면 "not signed in" | Y | — |
| **엔진 간 폴백·재시도 없음**(채팅·판정·회상 모두) | `cli-host.ts:263, :1314`; `routing/judge.ts:128`; `wiki/recall.ts:51` | 한도·장애 시 수동 전환 | Y | M |
| 턴마다 새 프로세스, 기한 초과 시 SIGTERM→1 s→SIGKILL | `cli-transport.ts:89-90`; `vendor-process.ts:56-69` | 프롬프트 캐시 연속성 없음 | N | L |
| 역할 순차 실행, 병렬 없음; 로컬 콤보 전환 시 모델 재로드 | README:468-472 | 워크플로 느림 | N | L |
| 콤보 프리셋은 Codex+Claude 둘 다 필요; 메인과 같은 경로는 자동 삭제 | `hosts/combo-presets.ts:41-55`; README:375 | — | Y | — |
| 사용자 설정의 `python3`, `ollama pull` 허용 규칙은 **`python3 <아무 스크립트>`** 전부 자동 허용 | `chat-actions.ts:57-62` (`rules.includes(first)`) | 편의지만 사실상 임의 실행 | 사용자 선택 | — |

### 1-E. 워크플로

| 제약 | 코드 위치 | 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| 시작은 `/skill:<builtin>` 또는 intent 제안만; 동명 사용자 스킬(OMX ralplan 등)은 protected-name 거부 | `skills/roots.ts:19, :365-366, :393`; README:1100-1105 | `~/.codex/skills/{ralplan,deep-interview,ultragoal,autoresearch}` 숨겨짐 | Y | — |
| 시작 조건: 라이브·unheld·**같은 엔진** 세션; 보존 SDK 히스토리 세션에서는 불가 | `workflows/session-guard.ts:11-12, :24-29`; `interactive-session.ts:3917` | — | Y | — |
| deep-interview: 임계 0.20, 아젠다당 2문·총 12문(구버전 0.05/100라운드), 답변 10,000자, 요청 4,000자, 연속 실패 2회면 stuck | `workflows/deep-interview-data.ts:5-13, :101, :106` | — | Y | — |
| ralplan: 오프너 5회, 시도 2회 → stuck; 합의 = Architect CLEAR/APPROVE + Critic OKAY **같은 해시** | `ralplan-data.ts:5-6`; `ralplan.ts:89, :197, :235` | 합의 못 보면 "planning complete; not executed" | Y | — |
| ultragoal: 목표 10, 무진전 10, 시도 2; 유닛마다 정확한 `APPROVE-UNIT <wid> <sha>` 입력 | `ultragoal-data.ts:7-10`; README:1113 | 타이핑 부담 | Y | S(복사 버튼 등) |
| autoresearch: 반복 10, 시도 2, 명령 8; 실험마다 `RUN <wid> <sha>`; 120 s 넘는 검증은 fenced·Retry 거부 | `autoresearch-data.ts:9-11`; README:1202-1214 | — | Y | M |
| 워크플로 역할 전부 읽기 전용, 입력 5,120 토큰; stage 이벤트 ≤32, plan 문서 ≤16 KiB | `hosts/types.ts:12`; `cli-host.ts:551`; `turn.ts:539-541` | 계획 품질이 작은 컨텍스트에 묶임 | Y/N | S |
| `/plan` worktree는 커밋 있는 Git repo 필요, 없으면 "Run in place | Cancel" | README:964-966; `config.ts:67-72` | — | Y | — |
| OpenCode 호스트는 워크플로 시작 불가(관찰만); foreground `import/run/resume`는 admission에서 거부 | README:1198, :1321-1337; `cli.ts:35-36` | OpenCode 경로는 사실상 plan 워크플로 전용 | Y(미완) | L |

### 1-F. 스킬

| 제약 | 코드 위치 | 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| 루트 우선순위: project native(.opencode/.agents/.gjc) > home native(.agents/.claude/.config/opencode/.gjc) > import(.claude/.codex); import는 빈 이름만 채움 | `skills/roots.ts:27-38` | 같은 이름이면 Codex 스킬 무시 | Y | — |
| 미커밋/외부 스킬은 세션당 1회 "Allow this content"; 신뢰는 **사용자 설정** `skill_trust`만; 잘못된 항목 1개면 전체 무신뢰 + auto off | `skills/trust.ts:1-3, :59-70, :98-104`; `interactive-session.ts:1428` | — | Y | — |
| `skill_auto`: native tier만 자동 목록(import는 `include`로 지정), 프로젝트 스킬은 폴더 신뢰만, 12개·160자, 14K 초과 제외, `disable-model-invocation` 제외 | `skills/session.ts:321-335`; README:1047-1056 | `~/.codex/skills`의 OMX 스킬은 자동 로드 안 됨 | Y | S |
| SKILL.md ≤16 KiB; `allowed-tools`는 권한을 부여하지 않음 | `roots.ts:18, :403, :208` | — | Y | — |
| `/skill:` 턴, 슬래시 명령, 워크플로 중에는 `skill` 도구 없음 | README:1066-1068 | — | Y | — |
| 로더 위트니스는 로컬 엔진 비대상 | `skills/context.ts:475` | — | Y | — |
| `skill_router.mode: "suggest"`는 **OpenCode 훅 전용**(`hooks/chat-message.ts`); otter chat은 `memory.engine` 판정 | `routing/router.ts:28, :210-215` | 프로젝트 설정의 router가 otter chat엔 무효 | — | — |

### 1-G. 세션/복원

| 제약 | 코드 위치 | 증상 | 의도 | 난이도 |
|---|---|---|---|---|
| 시작은 항상 새 대화; `--continue`/`--resume`/`/resume`만 복원 | `cli.ts:14-18` | — | Y | — |
| 복원 거부: replay 불완전, 세션 변경, 호환 선택 없음, 엔진 불일치, 리비전 변경 | `interactive-session.ts:1901, :1923, :3120-3129, :3199-3204`; `admission.ts:735, :757, :775` | — | Y | — |
| `/resume`·복구 CLI는 **핀된 routes** 사용, 현재 설정 무시; `--engine --model --session` 정확 일치 필수 | `sessions/store.ts:22-23`; README:1296-1317; `cli.ts:243-248` | — | Y | — |
| 세션 디렉터리는 본인 소유·0700 아니면 거부 | `store.ts:128-132` | — | Y | — |
| `/undo`: 10턴, 백업 8 MiB, Git 밖에서는 명령 효과 복구 불가 | `hosts/chat-checkpoint.ts:5-8, :15-16` | — | N | S |

### 1-H. 설정 권한

| 제약 | 코드 위치 | 증상 | 의도 |
|---|---|---|---|
| 프로젝트 설정이 **못 하는 것**: auto-edit 부여, 명령 사전 허용, skill_trust/skill_auto, model_api 타깃, repo_search 활성, 콤보 완화 | `config.ts:522-530`; `chat-actions.ts:64-70`; `trust.ts:1-3`; `model-api.ts:72-76`; README:198-203 | 클론 저장소가 권한을 얻지 못함 | Y |
| `local_model.context_input_tokens` 4096-65536, trim 50-85 | `config.ts:541-546` | | Y |
| `otter update`는 소스 체크아웃 거부; 현재 런처가 소스 체크아웃이라 업데이트 알림·`otter update` 모두 비활성 | README:1945-1947; `.git/otter-installer` 없음 | git pull로만 갱신 | Y |

### 1-I. 플랫폼

| 제약 | 코드 위치 | 의도 |
|---|---|---|
| POSIX(macOS/Linux/WSL)만; 프로세스 그룹 필요 | `vendor-process.ts:188`; README:1925 | Y |
| Codex 네이티브 프로브는 darwin/linux만 | `cli-transport.ts:1041-1044` | Y |
| Linux 단일 사용 검증기는 Linux에서만; 기본은 `legacy-unowned`(자손 프로세스 정지 증명 불가) | `hosts/linux-domain.ts:174-183`; `config.ts` DEFAULT delegate.verifier | Y |
| `repo_search`: macOS arm64 + python.org 3.13.2 + uv, **plan 모드 main만**, 수동 빌드 | README:198-215; `hosts/cli-runtime.ts:79` | Y |
| WSL에서 Windows 마운트 CLI 제외 | README:414-415 | Y |

---

## 2. README와 코드 불일치

| # | README 주장 | 코드 사실 |
|---|---|---|
| 1 | `README.md:121-123` "**Read-only commands** run without asking … `git status|diff|log…`, `ls`, `cat`…" | 커밋 `11c9de8`이 `chat-actions.ts`의 `READ_ONLY`/`readOnlyCommand`와 `interactive-session.ts`의 분기(구 1254-1257)를 삭제. 현재 승인 순서는 거부→규칙→auto-edit→폴더 허용→질문 (`interactive-session.ts:1247-1272`). 같은 커밋이 README:92-103은 고쳤으나 121-123 불릿은 남겨 **README가 자기모순** |
| 2 | `README.md:360-370` 템플릿 표 3개(`astra-fable`, `astra-fable-opus`, `opus-codex`), "Codex GPT-6 Luna", "Codex GPT-6 Sol" | `hosts/combo-presets.ts:12-18, :41-55` 프리셋 4개(+`fable-opus-codex`), 실행 = `gpt-5.6-luna`/`gpt-5.6-terra`, 설계 = `gpt-5.6-sol`. README:448-455의 두 번째 표는 코드와 일치 → 같은 절에 두 표가 충돌 |
| 3 | `README.md:97-99` ask 모드 도구 `read list glob grep memory + write edit multiedit bash model_api` | 실제로는 `multiread`와 `skill`도 제공 (`cli-tools.ts:940-941`); 누락 |
| 4 | `config.ts:149-153` 주석 "`prefetch` … Default off" | `DEFAULT_CONFIG.memory.prefetch: true` (`config.ts:382`), README:2250·2298 "on by default" — 코드 주석이 틀림 |
| 5 | `README.md:1890` "otter-doctor.sh static checks D01-D10" | doctor는 D12e·D13까지 출력(실행 결과) |
| 6 | 로드맵 2-E "실행 모드에서 Planning → Working" | `hosts/cli-progress.ts:117, :262, :396`은 "Agent" 라벨 채택; README:666은 상태줄 `Model request`/`Working` — 문서 간 용어 불일치(기능상 해결됨) |
| 7 | 게이트웨이 계획 §1 인용 줄번호 | `cli-host.ts:67`→실제 **:69**(RESPONSE_ENVELOPE), `vendor-process.ts:187`→**:188**, `cli-transport.ts:16`→deadlineAt 필드는 **:21**. 나머지(`:444 nativeArgv`, `:997 createCliTransport`, `:35 CliObservedUsage`, `cli-host.ts:260/263/550/767/1314`, `interactive-session.ts:1722`, `model-api.ts:31`, `skillopt/host.ts:1629`, `security/secrets.ts`, `tokens.ts:44`, `types.ts:11-13`)는 일치. "읽기 전용 자동 허용 제거됨(11c9de8)" 주장은 **사실** |
| 8 | `README.md:432-436` "Codex is pinned to the newest otter-supported release … a newer unqualified release is a stated downgrade" | 코드와 일치하지만, 사용자 환경에서는 이 정책 자체가 Codex 엔진 전면 불가의 원인(§3) |

로드맵(10-20) 항목 상태: 1-A 도구결과 기록 ✓(`cli-runtime.ts:71`), 1-B 다이제스트 ✓(`sessions/digest.ts`), 1-C 자동 캡처 ✓(`wiki.auto_capture`), 1-D 팩트 회수 ✓(600자), 2-A 묶음 읽기 △(multiread만, 첫 호출 규칙 유지), 2-B `/undo` ✓, 2-C △(폴더 허용·multiedit ✓, 읽기 전용 자동 허용은 **추가 후 11c9de8에서 제거**), 2-D ✓(vendor 49152·계속 묻기), 2-E ✓("Agent"), 3-A 엔진 전환 제안 ✗(로그인 힌트만), 3-B 사용량 표시 ✗(usage 폐기), 5-A CI ✗(`.github/workflows` 없음).

---

## 3. 설정 상태 문제

1. **Codex 전면 불가**: `~/.config/otter/otter.jsonc:13-16` 기본 `codex/gpt-6-astra`, 콤보 4역할이 `codex/gpt-5.6-luna`. 설치 codex 0.165.0은 `CODEX_SUPPORTED_VERSIONS` 밖 → 매 실행 "Cannot start codex / gpt-6-astra … run /engines update codex" 후 미선택 상태(`interactive-session.ts:2157-2172`). Homebrew cask라 `otter engines update codex`도 "update by hand: brew uninstall --cask codex && npm install -g @openai/codex@0.163.0"(다운그레이드). Claude 전용 프리셋(`opus-codex`도 codex 포함)이 없어 **모든 프리셋이 현재 환경에서 완전 적용 불가**.
2. 모델 ID 검증: `gpt-6-astra`, `gpt-5.6-luna`는 번들 슬러그 ✓; `fable`, `opus`는 Claude CLI 별칭 ✓(`claude --help`도 'fable','opus','sonnet' 명시). 형식상 거부되는 ID는 없음.
3. 신뢰 루트: `~/.gjc/agent/skills`, `~/.gjc/skills` **존재하지 않음**(무해: `trust.ts:55` canonical()이 resolve로 대체, 다른 항목은 유효). `~/.codex/skills`(OMX 23개, import tier)·`~/.agents/skills`(4개)는 존재.
4. 프로젝트 `.otter/otter.jsonc`: `skills.allow`, `skill_router.mode: "suggest"`는 **OpenCode 플러그인 전용** 키 — otter chat에는 효과 없음. `skill_observation` 캠페인 바인딩 유지만.
5. `chat.allow: ["python3"]` → `python3 <무엇이든>` 자동 실행(`chat-actions.ts:57-62`). 의도했는지 확인 필요.
6. doctor: WARN D12e opencode 1.18.35 vs pin 1.18.32; WARN D05c oh-my-openagent + otter 동시 로드(`config.agent` 상호 덮어쓰기, `hooks/config.ts:56-60`); **FAIL D09b** reviewer가 OMO 도구(call_omo_agent, session_*, interactive_bash…)를 봄 → 읽기 전용 계약 깨짐; WARN D13 plan/ulw/typesafe-ai 스킬 설명에 트리거 문구 없음. 모두 OpenCode 경로 문제이며 otter chat(CLI 엔진)에는 영향 없음.
7. 런처가 소스 체크아웃을 직접 실행 → 업데이트 체크·`otter update` 비활성(설계상).
8. `memory.prefetch` 기본 true → 매 main 턴 claude-haiku 호출(30 s 타임아웃). 지연·비용 체감 시 `"memory": {"prefetch": false}`.

---

## 4. 타입체크 결과

`cd framework && bunx tsc --noEmit -p tsconfig.json` → 출력 없음, **exit 0** (오류 0건).

---

## 5. 가장 체감이 큰 제약 Top 10

| 순위 | 제약 | 수정 방향 |
|---|---|---|
| 1 | Codex 0.165.0 미지원으로 기본 모델·콤보 전부 시작 실패 | `codex-profile.ts:16`에 0.165.0 자격 부여(프로필 프로브 재검증) + `codex-models-*.json` 갱신; 장기적으로 "버전 핀 → 프로토콜 스모크 테스트"로 전환 |
| 2 | 모든 명령(`git status` 포함) 매번 승인 — README는 자동 허용이라 함 | 11c9de8 결정 유지 시 README:121-123 삭제; 완화 시 `chat.allow_read_only`(사용자 설정) 옵트인으로 READ_ONLY 복원 |
| 3 | 응답당 도구 1개 + 24라운드 | 엄격 엔벨로프 안의 **읽기 전용 배열**은 순차 실행; main 기본 라운드 48 |
| 4 | vendor 입력 49K 토큰·Gemma 휴리스틱 | 엔진별 추정기 계수 + 벤더 보고 usage로 보정, vendor main 128K |
| 5 | 네이티브 Claude/Codex 기능 전부 OFF(CLAUDE.md·훅·세션·캐시) | 설계상 유지하되 `--resume`/프롬프트 캐시 활용 여지를 전송 계층에서 검토(L) |
| 6 | 엔진 폴백 없음 | 게이트웨이 계획 G2대로 "같은 모델 경로 전환 자동, 다른 모델은 고지" |
| 7 | 사용량 폐기 → 비용 불가시 | `cli-host`에서 `native.usage`를 digest/`/status`에 기록(S) |
| 8 | `edit` 정확 1회 일치·64 KiB | 줄 범위 기반 edit 또는 occurrence 지정 인자 추가 |
| 9 | 로컬 모델 thinking 강제 OFF | `local_model.think` 설정으로 선택 가능하게 |
| 10 | 매 턴 메모리 prefetch 추론 | 기본 false 또는 wiki 없는 프로젝트에서 자동 스킵 |
