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

- **기록**: 모든 엔진의 도구 결과·명령 종료 코드를 자동 저장(메타데이터만)
- **요약**: 세션마다 다이제스트(`/history`), 반복 통과·실패 명령과 자주 바뀌는 파일은 다음 대화의 참고 자료(`/facts`)
- **축적·재사용**: 위키가 있는 프로젝트는 종료 시 `knowledge/`에 자동 캡처, 대화 중 `memory` 도구로 찾아 씀
- **복원**: 시작은 항상 새 대화, 필요할 때 `--resume`·`/sessions`

## 2. 엔진 무관 · 멀티 모델 콤보

**어떤 엔진이든 기록은 하나, 역할마다 잘하는 모델을 쓴다.**

- **엔진**: Ollama·Codex·Claude CLI, 대화 중 `/model`로 전환
- **콤보**: 계획·실행·설계·리뷰 역할별 모델 지정. 일반 대화는 메인 모델, 콤보는 워크플로 역할에 쓰이며 실행 중인 모델이 화면에 표시됨
- **프리셋**: Codex×Claude 혼합 4종(`astra-fable` 등), `/model combo`에서 고르면 바로 적용
- **로그인**: 각 CLI 공식 로그인(`/login`). 인식되지 않으면 `otter auth --diagnose`

## 3. 자동 스킬 · 의도 라우팅

**알아서 돕되, 멋대로 하지 않는다.**

- **자동 스킬**: 맥락에 맞는 스킬을 불러 쓰고 `Skills used:` 표시
- **의도 라우팅**: 모호하거나 큰 요청은 deep-interview·ralplan 제안(자동 시작 없음)
- **끄기**: `force:` 접두사 · `/skills auto off` · 스킬 목록은 [`skill_index.md`](skill_index.md)

## 직접 실행 · 안전장치

**모든 실행은 사람이 승인한다 — 한 동작씩 또는 계획 단위.**

- **대화 중 실행**: 수정·명령마다 승인(diff·명령줄 표시), `/undo`로 되돌리기
- **승인 줄이기**: 읽기 전용 명령은 묻지 않음, 여러 파일 수정은 한 번에
- **항상 거부**: `sudo`, 강제 푸시 등 — 직접 하려면 `!명령어`
- **계획 단위**: `/plan` → `/approve` → 별도 작업 트리에서 실행

## 문서

[사용법·설정](framework/README.md) · [스킬 목록](skill_index.md) · [위키 스키마](knowledge/AGENTS.md) · [설계](docs/agent-framework-review-2026-09-22.md) · 라이선스 [MIT](LICENSE)
