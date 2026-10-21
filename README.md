# AgentFramework (`otter`)

![otter: 실행할수록 쌓이는 코딩 에이전트](artifacts/otter-hero/hero.png)

**실행할수록 쌓이는 코딩 에이전트.**

- 실행 이력을 버리지 않고 로컬 지식으로 쌓아 다음 작업에 다시 씀
- 엔진·모델과 무관하게 같은 자산으로 쌓임, 역할마다 모델을 섞어 씀
- 대화 중에 직접 고치고 실행함. 모든 실행은 사람이 승인함(한 동작씩 또는 계획 단위)

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.sh | bash
otter
```

```powershell
# Windows (PowerShell, WSL2 사용)
irm https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.ps1 | iex
otter
```

## 1. 실행 이력이 자산이 된다

**대화는 사라져도 이력은 남아 다음 작업의 컨텍스트가 된다.**

`대화·실행 → 실행 로그 → 지식 위키 → 다음 작업의 컨텍스트`

- **기록**: 모든 엔진(codex·claude·local·OpenCode)의 도구 결과를 `tool-outcomes.sqlite`에 자동 저장(명령은 종료 코드까지). 메타데이터만, 인자·출력 본문은 저장 안 함
- **세션 다이제스트**: 세션이 끝나면 요약 1건을 저장소 밖 상태 폴더에 남김 — 턴 수, 바뀐 파일 경로, 실행한 명령(`bun test` 같은 앞부분)과 결과. 대화 원문·파일 내용·출력은 안 남김. `/history`로 보기
- **프로젝트 사실**: 다이제스트에서 "계속 통과하는 명령 / 반복 실패하는 명령 / 자주 바뀌는 파일"을 뽑아 다음 대화에 짧은 참고 자료로 넣음(모델 추측 아님). `/facts`로 보기
- **자동 축적**: 위키가 있는 프로젝트는 세션 종료 시 다이제스트를 `knowledge/`에 자동 캡처(`wiki.auto_capture`, 기본 켜짐). `/wiki`로 미통합 출처 보기, `/wiki ingest`로 otter가 위키에 통합(편집마다 승인) 후 lint
- **재사용**: 대화 중 모델이 `memory` 도구로 위키를 찾아 컨텍스트로 사용(`/memory`로 연결 엔진 설정)
- **복원**: 세션은 재시작해도 보관. 시작은 항상 새 대화, 필요할 때 `--resume`·`--continue`·`/sessions`·`/resume <sid>`

```sh
bun scripts/otter-wiki.ts capture   # 이력 → 위키
bun scripts/otter-wiki.ts status    # 출처·정리 상태
bun scripts/otter-wiki.ts lint      # 링크·해시 무결성
```

## 2. 엔진을 가리지 않는다 · 멀티 모델 콤보

**어떤 엔진을 써도 기록은 하나, 역할마다 잘하는 모델을 쓴다.**

- **엔진 무관**: Ollama(로컬)·Codex·Claude CLI 모두 같은 이력 형식. 대화 중 `/model`로 전환
- **콤보**: planner / architect / critic / worker / reviewer 역할별로 엔진·모델 지정. 미지정 역할은 메인 모델
- **어디에 적용되나**: 일반 대화는 메인 모델. 콤보 경로는 워크플로 역할(`/plan`, `/skill:ralplan`, `ultragoal`, `deep-interview`, `autoresearch`)에서 쓰이고, 실행 중인 역할의 엔진·모델이 화면에 표시됨(예: `ralplan · planner · claude / opus`)
- **프리셋**: Codex×Claude 혼합 4종 — `astra-fable`, `astra-fable-opus`, `fable-opus-codex`, `opus-codex`(메인·계획·실행·설계·리뷰를 두 엔진에 나눠 배치). **고르면 바로 그 멀티 모델 구성으로 세션 적용**(확인 창·커스텀 화면 없음, 대화 이어짐)
- **인증**: 각 CLI 공식 로그인 그대로 사용. otter는 인증 정보를 읽거나 저장하지 않음. 로그인했는데 인식되지 않으면 `otter auth --diagnose`(대화 중 `/auth diagnose`)
- **콤보 경로가 안 될 때**: 예를 들어 지원하지 않는 Codex CLI 버전이면, 그 역할들만 메인 모델로 돌리고 세션은 그대로 시작. 안내에 설치된 버전·지원 버전·설치 명령(`npm install -g @openai/codex@0.163.0`)이 나옴. 고친 뒤 `/model combo apply`

```text
/model combo                                   # 메뉴: 추천 프리셋(고르면 메인+역할 바로 적용) 또는 역할 → 엔진 → 모델
/model combo preset astra-fable                # 프리셋으로 바로 전환
/model combo planner claude opus               # 역할 직접 지정(저장만)
/model combo apply                             # 직접 지정한 콤보를 적용(대화 이어짐)
```

## 3. 자동 스킬 · 의도 라우팅

**알아서 돕되, 멋대로 하지 않는다.**

- **자동 스킬**: 맥락에 맞는 스킬을 모델이 직접 불러 쓰고 `Skills used: <name>` 표시. 동의 창 없이 쓸 수 있는 스킬만 후보
- **의도 라우팅**: 모호하거나 설계 수준 요청은 전송 전 [채팅 계속 | deep-interview | ralplan | 취소] 제안. 질문은 답변만
- **워크플로**: `ralplan`·`deep-interview`·`ultragoal`·`autoresearch`를 `/skill:<name>`으로 시작. 자동 시작 없음
- **끄기**: 메시지 하나는 `force:` 접두사, 세션은 `/skills auto off`, 영구는 `skill_auto.mode: "off"` / `chat.intent: "off"`
- Codex/Claude 관례 스킬은 `skill_auto.include`(`~/.config/otter/otter.jsonc`)에 등록해야 후보가 됨
- **제공 스킬 목록**: [`skill_index.md`](skill_index.md)(내장 워크플로 4종 + 프로젝트 스킬 2종, 추가 방법)

## 직접 실행 · 안전장치

**모든 실행은 사람이 승인한다 — 한 동작씩 또는 계획 단위.**

- **대화 중 직접 실행**(기본): 파일 수정·명령 실행을 동작마다 [한 번 허용 | 항상 허용 | 거부]. 수정은 diff, 명령은 명령줄을 보여 줌
- **되돌리기**: `/undo`로 그 턴의 변경 복원(최근 10턴)
- **승인 줄이기**: 읽기 전용 명령(`git status`, `ls`, `rg` 등)은 묻지 않음 · 이 턴 동안 폴더 단위 허용 · 여러 파일 수정은 한 번에 승인
- **항상 거부**: `sudo`, 강제 푸시, 루트/홈 삭제 등. 직접 하려면 `!명령어`
- **모드**: `chat.execute` = `"ask"`(기본) · `"auto-edit"`(수정은 묻지 않음) · `"plan"`(읽기 전용) · 규칙 관리 `/permissions`
- **계획 단위 실행**: `/plan` → `/approve` → 작업 트리 `wf-<id>`에서 실행 → [적용 | 유지 | 버리기]. 큰 작업용 (샌드박스는 아님)

## 문서

- 사용법·설정: [`framework/README.md`](framework/README.md)
- 스킬 목록: [`skill_index.md`](skill_index.md)
- 위키 스키마: [`knowledge/AGENTS.md`](knowledge/AGENTS.md)
- 설계: [`docs/agent-framework-review-2026-09-22.md`](docs/agent-framework-review-2026-09-22.md)

## 라이선스

[MIT](LICENSE)
