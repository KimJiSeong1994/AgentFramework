# AgentFramework (`otter`)

**에이전트 실행 이력을 버리지 않고 자산으로 쌓는 코딩 에이전트 프레임워크.**

대화는 끝나면 사라지지만, 계획·승인·도구 실행 결과는 남아야 합니다.
`otter`는 모든 작업을 계획 → 승인 → 실행 흐름으로 기록하고, 그 이력을 검색·재사용 가능한 로컬 지식으로 축적합니다.

## 기능

- **실행 이력 기록** — 도구 호출 결과를 append-only SQLite 로그로 남깁니다(인자·출력 본문은 저장하지 않음).
- **지식 위키로 축적** — `otter-wiki capture`가 실행 이력을 불변 원본 스냅샷 + 리포트로 만들고, `knowledge/wiki`에 출처가 연결된 개념·엔티티 페이지로 쌓습니다.
- **세션 보관·복원** — `/sessions`로 지난 작업을 보고 `/resume <sid>`로 이어갑니다.
- **통제된 실행** — `/plan` → `/approve` 후에만 실행하며, 원장(ledger)으로 승인·실행 기록을 추적합니다.
- **워크플로·스킬** — `ralplan`, `deep-interview`, `ultragoal`, `autoresearch` 내장 워크플로와 `/skill:<name>` 스킬.
- **멀티 모델 콤보** — 한 세션에서 역할별(planner/architect/critic/worker…)로 다른 엔진·모델을 씁니다. 지정 안 한 역할은 메인 모델.
- **엔진 무관** — Ollama(로컬)·Codex·Claude CLI 중 무엇을 써도 이력은 같은 형식으로 쌓입니다.

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.sh | bash
```

macOS/Linux, `git` 필요(`bun`은 없으면 자동 설치). 엔진(`ollama`/`codex`/`claude`) 중 하나 이상이 PATH에 있어야 합니다.
codex·claude는 각 CLI의 공식 로그인을 그대로 씁니다: `otter login codex` / `otter login claude`(대화 중 `/login`), 상태 `otter auth`(대화 중 `/auth`), 로그아웃 `/logout`. otter는 인증 정보를 읽거나 저장하지 않습니다.
다시 실행하면 업데이트, `~/.local/share/otter/AgentFramework/install.sh --uninstall`로 제거합니다.

## 사용

```sh
otter chat                                   # 엔진·모델 선택 후 대화
otter chat --engine codex --model gpt-5.6-sol
bun scripts/otter-wiki.ts capture            # 실행 이력 → 지식 위키
```

대화 중: `/plan` · `/approve` · `/sessions` · `/resume <sid>` · `/model` · `/login` · `/auth` · `/help`

의도 라우팅: 모호하거나 설계 수준인 요청은 전송 전에 [채팅 계속 | deep-interview | ralplan | 취소]를 제안하고, 질문은 답변만 받습니다(계획 JSON이 와도 `/plan` 전에는 승인 대기가 되지 않음). `force:` 접두사로 건너뛰고, `chat.intent: "off"`로 끕니다.

승인된 계획은 작업 트리 하나(`wf-<id>`)에서 모든 작업이 실행되고, 끝나면 변경 파일·diff 요약·패치 경로를 보여 준 뒤 [내 체크아웃에 적용 | 유지 | 버리기]를 묻습니다(적용 전에는 체크아웃이 그대로이며, 커밋이 없으면 "제자리 실행" 여부를 먼저 묻습니다). `chat.worktree: "off"`로 끕니다.

멀티 모델 콤보: `/model`의 엔진 목록 맨 아래 `combo`(또는 `/model combo`)를 고르면 메뉴에서 역할 → 엔진 → 모델을 고릅니다. 고른 값은 `~/.config/otter/otter.jsonc`에 저장되고, 메뉴의 "Apply to a new session"으로 새 세션에 적용합니다(기존 세션은 고정된 콤보 유지). 직접 입력도 됩니다:

```text
/model combo planner claude opus
/model combo worker local gemma4-26b-mtp:latest
/model combo apply
```

## 문서

- 사용법·설정: [`framework/README.md`](framework/README.md)
- 위키 스키마: [`knowledge/AGENTS.md`](knowledge/AGENTS.md)
- 설계: [`docs/agent-framework-review-2026-09-22.md`](docs/agent-framework-review-2026-09-22.md)

## 라이선스

[MIT](LICENSE)
