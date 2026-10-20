# otter 스킬 목록

**otter가 제공하는 스킬 = 내장 워크플로 4종 + 저장소 프로젝트 스킬 2종.** 모두 대화 중 `/skill:<name>`으로 부른다.

- 내장 워크플로: 코드로 구현된 단계형 작업. 이름을 불러도 실행 동의가 아니며, 자동으로 시작하지 않음
- 프로젝트 스킬: `.agents/skills/<name>/SKILL.md`. 커밋된 상태면 동의 창 없이 쓸 수 있어 자동 스킬 후보가 됨
- 목록 확인: 대화 중 `/skills`, 자동 후보는 `/skills auto`

## 내장 워크플로

| 스킬 | 호출 | 하는 일 | 실행 조건 |
|---|---|---|---|
| `deep-interview` | `/skill:deep-interview <요청>` | 요구사항 인터뷰 → 검증된 `spec.md` 작성 | 요구사항만 다룸, 코드 수정 없음. 3라운드 이후 `/finish`로 조기 종료 요청 |
| `ralplan` | `/skill:ralplan <요청>` | planner · architect · critic 합의 계획 | 합의만으로는 실행 안 함("execution pending") |
| `ultragoal` | `/skill:ultragoal <목표>` | 목표 원장 기반 단계 실행 | 단위마다 `APPROVE-UNIT` 승인 필요 |
| `autoresearch` | `/skill:autoresearch <미션>` | 로컬 연구 미션 → 구조화된 결론 | 실험마다 `RUN` 승인 필요 |

- 연결: 검증된 `deep-interview` 스펙은 같은 세션에서 `ralplan`으로 이어짐
- 의도 라우팅: 모호하거나 설계 수준 요청은 전송 전 `deep-interview` / `ralplan`을 제안(선택은 사람이 함)
- 자동 스킬 대상 아님: 워크플로는 모델이 스스로 불러오지 않음

## 프로젝트 스킬

| 스킬 | 호출 | 하는 일 | 출처 |
|---|---|---|---|
| `llm-wiki` | `/skill:llm-wiki` | 로컬 문서를 불변 출처로 등록 → `knowledge/wiki` 페이지로 컴파일(인용 연결) → 조회 · 린트 | 이 저장소 |
| `typesafe-ai` | `/skill:typesafe-ai` | TypeSafe(System One 모델, Jev)로 라우팅 · 랭킹 · 추출 · 검증 같은 AI 판단을 타입 있는 기능으로 구현 | [typesafe-ai/skills](https://github.com/typesafe-ai/skills) (MIT, `skills-lock.json`로 고정) |

- 자동 스킬: 대화 맥락에 맞으면 모델이 직접 불러 쓰고 답변 앞에 `Skills used: <name>` 표시
- 끄기: 메시지 하나 `force:`, 세션 `/skills auto off`, 영구 `skill_auto.mode: "off"`

## 스킬 추가하기

- **프로젝트 스킬**: `.agents/skills/<name>/SKILL.md`(frontmatter `name`, `description`) 작성 후 커밋
- **개인 스킬**: `~/.agents/skills`, `~/.claude/skills` 등 홈 스킬 폴더. 동의 창 없이 쓰려면 `~/.config/otter/otter.jsonc`의 `skill_trust`에 이름이나 폴더 등록
- **Codex/Claude 관례 스킬**(`.codex/skills`, 프로젝트 `.claude/skills`): 같은 이름의 기본 스킬이 없을 때만 쓰임. 자동 후보로 쓰려면 `skill_auto.include`에 이름 등록
- 프로젝트 `.otter/otter.jsonc`의 `skill_trust`는 무시됨(복제한 저장소가 스스로를 신뢰할 수 없음)

```jsonc
// ~/.config/otter/otter.jsonc
{
  "skill_trust": ["code-review", "~/.codex/skills"],
  "skill_auto": { "mode": "auto", "include": ["my-codex-skill"] }
}
```

상세 규칙: [`framework/README.md`](framework/README.md)의 skill 섹션
