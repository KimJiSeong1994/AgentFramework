# 직접 실행(Direct Execution) 설계 — 2026-10-20

상태: **구현됨 (2026-10-20)**. 결정(§8): 기본 `ask`, `auto-edit` 제공(기본 아님), 대화형 명령 허용(승인 후 터미널 핸드오프), README 원칙 문구 갱신.
구현에서 달라진 점: 세션 중 `/execute` 전환과 메시지 단위 `plan:` 접두사는 넣지 않았다(모드는 main 정책 식별값이라 런타임 생성 시 고정). 기록은 새 `action` 종류 대신 기존 `shell`(명령 실행)과 `notice`(승인·거부)를 쓴다. 사용자 문서는 `framework/README.md`의 "Chat execution".

## 1. 증상

대화 중 otter에게 "테스트 돌려줘", "이 파일 고쳐줘"를 요청하면 모델이 이렇게 답한다.

> 읽기 전용인 이유는 현재 터미널이 Otter의 계획 역할로 설정되어 있고, 실행 도구가 제공되지 않기 때문입니다. 제가 스스로 역할이나 권한을 전환할 수는 없습니다.

모델 말 자체는 사실이다. 문제는 **실행할 수 있는 길이 실제로 있는데도 사용자가 그 길을 안내받지 못한다**는 점, 그리고 **그 길이 작은 작업에는 너무 무겁다**는 점이다.

## 2. 현재 구조 (코드 근거)

| 층 | 현재 동작 | 위치 |
|---|---|---|
| 대화 모델 역할 | `main` = **planning-only**. CLI 런타임이 항상 `planningOnlyMain: true`로 만든다 | `hosts/cli-runtime.ts:70` |
| 도구 | main은 `read, list, glob, grep, memory`(+`skill`)만. 나머지는 거부 | `hosts/tool-policy.ts:25,73-76,124` |
| 쓰기 권한 | `CLI_WRITE_CAPABILITY.main = false` (worker만 true) | `hosts/types.ts:23-27` |
| 셸 도구 | CLI 호스트에는 `bash`가 **아예 없다**. 도구는 `read/list/glob/grep/memory/skill/write/edit`뿐 | `hosts/cli-tools.ts:20` |
| 프롬프트 | "Never modify files or run commands… Do not claim work was executed." | `workflows/prompts/plan-main.ts`, `tool-policy.ts:26` |
| 실행 경로 | `/plan` → 계획 JSON(3–10단계, 위험 1–5개, 단계마다 파일·verify) → 사람 승인 → worker가 계획 작업트리에서 write/edit → verify는 허용 목록 명령만 → 적용/유지/버리기 | `flow/plan.ts:12`, `orchestration/queue.ts`, `config.ts:359` |
| 사람용 셸 | `!명령어` — 사람이 직접 실행(PR #62부터 실제 터미널). 모델은 못 씀 | `hosts/operator-shell.ts` |

즉 otter의 실행 모델은 **"모델은 계획만, 실행은 승인된 계획의 worker만"** 이다. 의도된 안전 설계이고 README의 "승인 없이는 실행하지 않는다"가 이것이다.

## 3. 문제

1. **안내 부재**: 모델은 "못 한다"고만 말하고, `/plan`으로 실행하는 방법이나 `!명령어`를 알려 주지 않는다. 사용자는 otter가 실행을 못 한다고 받아들인다.
2. **작은 작업에 과한 절차**: "테스트 한 번 돌려줘", "오타 하나 고쳐줘"도 3단계 이상 계획 + 위험 + verify + 승인 + 작업트리 + 적용을 거쳐야 한다. 계획 최소 단계(3)가 1단계 작업을 막는다.
3. **모델이 명령을 실행할 방법이 없다**: worker도 셸이 없다(verify는 큐가 허용 목록으로만 실행). "빌드해 보고 에러 고쳐줘" 같은 반복 작업이 불가능하다.

## 4. 목표 / 비목표

목표
- 대화 중 모델이 **파일 수정과 명령 실행을 직접 요청**하고, **사람이 한 동작씩 승인**하면 그 자리에서 실행된다(Claude Code·GJC의 "ask" 모드와 같은 체감).
- 승인·거부·결과가 세션에 기록된다(실행 이력 자산화 원칙 유지).
- 기존 `/plan` 파이프라인(다단계·작업트리·리뷰)은 그대로 둔다. 큰 작업용.

비목표
- 승인 없는 자동 실행을 기본값으로 만드는 것.
- 샌드박스/격리 보장(현 README 원칙 유지: "No process or filesystem containment is claimed").
- 워크플로(ralplan/ultragoal 등)의 실행 규칙 변경.

## 5. 설계: 대화 실행 모드 `chat.execute`

### 5.1 모드

| 값 | 동작 |
|---|---|
| `"plan"` (현재와 동일) | main은 읽기 전용. 실행은 `/plan`. **단, 프롬프트가 실행 방법을 안내**(§5.6) |
| `"ask"` (**제안 기본값**) | main에 `edit`, `write`, `bash` 도구 제공. **모든 쓰기·명령은 실행 직전 사람 승인** |
| `"auto-edit"` | 작업 폴더 안 파일 `edit/write`는 자동, `bash`는 여전히 승인 |

전환: 설정 `chat.execute`(user/project), 세션 중 `/execute ask|plan|auto-edit`, 한 메시지만 `plan:` 접두사로 읽기 전용.

### 5.2 승인 흐름 (호스트가 소유)

```
모델: {"type":"tool","name":"bash","input":{"command":"bun test test/foo.test.ts"}}
  → 호스트: 정책 확인(모드, 거부 목록, 경로) → 사람에게 승인 요청
  → TUI 카드:  Run in ~/proj?  $ bun test test/foo.test.ts
               [Allow once] [Always allow `bun test`] [Deny] [Deny and tell otter why]
  → 결과(종료 코드, 출력 꼬리)를 모델에게 도구 결과로 반환 + 세션에 기록
```

- 승인 UI는 기존 `terminal.choose`/`ask`를 재사용. readline은 번호 선택.
- 승인 지점은 `cli-tools`의 기존 `beforeEffect` 훅과 같은 자리. 호스트가 결정하고, 모델 출력은 결정을 대신할 수 없다.
- 편집은 승인 카드에 **diff 미리보기**(`oldText → newText`, write는 새 파일/덮어쓰기 표시).
- 모델이 한 응답에 여러 도구를 묶어도 **하나씩** 승인(현 호스트는 이미 한 번에 하나만 실행).

### 5.3 `bash` 도구 (main 전용, 신규)

- `$SHELL -c` 대신 **`/bin/sh -c`**, cwd = 작업 폴더, `TERM=dumb`, stdin 없음(비대화형). 대화형이 필요하면 사람에게 `!명령어`를 권한다.
- 출력 캡처: 기존 verify 카드 형식 재사용(꼬리 200줄/64KiB), 모델에게는 최대 32KiB(`MAX_TOOL_OUTPUT_BYTES`).
- 타임아웃 기본 2분, 최대 10분(`timeoutMs` 입력), 프로세스 그룹 종료(기존 `orchestration/shell.ts` 패턴).
- Esc/Ctrl+C = 해당 명령만 취소, 모델에는 "cancelled by user" 반환.
- 항상 거부(승인으로도 불가): `sudo`, `git push --force`, `rm -rf /`·홈 루트 같은 위험 패턴 목록(설정으로 확장), 작업 폴더 밖 `cd`. 거부 사유를 모델에게 반환.

### 5.4 "항상 허용" 규칙

- `Always allow` 선택 시 **명령 접두사**(예: `bun test`, `git status`) 또는 **경로 glob**(편집)을 저장.
- 저장 위치: 사용자 설정 `~/.config/otter/otter.jsonc`의 `chat.allow`만. **프로젝트 설정의 allow는 무시**(복제한 저장소가 스스로 권한을 주지 못하게; `skill_trust`와 같은 원칙).
- `/permissions`로 보기·삭제.

### 5.5 기록

- 새 세션 기록 종류 `action`: `{tool, input 요약(명령/경로), decision: allowed-once|allowed-rule|denied, outcome, exitCode, durationMs, lines}`.
- 이력 자산화: `tool-outcomes.sqlite`에도 기존처럼 메타데이터만(인자·출력 본문 저장 안 함 원칙 유지).

### 5.6 `plan` 모드에서도 바로 고칠 것 (작은 변경)

프롬프트에 실행 경로를 명시해 "못 한다"로 끝나지 않게 한다.
> "You cannot modify files or run commands yourself. When the user wants something executed, say so in one line and offer the way: `/plan` to make an approvable plan that otter's workers execute, or `!<command>` for the user to run it in the terminal now."

### 5.7 `/plan`과의 관계

- `ask` 모드에서도 큰 작업은 모델이 `/plan`을 제안할 수 있다(기존 의도 라우팅 유지).
- 1단계 작업을 위해 계획 최소 단계를 줄이지는 않는다 — 작은 작업은 `ask` 모드가 담당.
- 실행 중인 워크플로가 있으면 main의 쓰기·bash는 거부(작업트리·원장 충돌 방지).

## 6. 안전 불변식

1. 모델 출력·이전 승인·프로젝트 파일은 **새 동작을 승인할 수 없다**. 승인은 로컬 사람 입력만.
2. `plan` 모드는 지금과 정확히 같은 도구 집합(회귀 없음).
3. 작업 폴더 밖 쓰기 불가(기존 `cli-tools` 경로 검사 재사용), `.git/`, `.otter/`, `knowledge/raw` 쓰기 불가(`FORBIDDEN_ROOTS`).
4. 역할 정책 식별값: `chat.execute`는 main의 도구 집합을 바꾸므로 **main 정책 ID에 포함**되어야 한다(세션 메타데이터에 고정, `/resume` 시 확인).
5. 승인 대기 중 세션 종료·EOF·Ctrl+C = 거부.

## 7. 구현 단계 (승인 후)

| 단계 | 내용 | 파일 |
|---|---|---|
| 0 | `plan` 모드 프롬프트 안내 문구(§5.6) | `prompts/plan-main.ts`, `tool-policy.ts` |
| 1 | `chat.execute` 설정 + 검증, 정책에 반영(`planningOnlyMain` → 모드) | `config.ts`, `cli-runtime.ts`, `tool-policy.ts`, `types.ts` |
| 2 | 승인 게이트: 호스트→세션 콜백, `beforeEffect` 확장, diff 미리보기 | `cli-host.ts`, `cli-tools.ts`, `interactive-session.ts`, `tui/app.ts` |
| 3 | `bash` 도구(main 전용), 거부 목록, 타임아웃·취소 | `cli-tools.ts`(+`orchestration/shell.ts` 재사용) |
| 4 | `Always allow` 규칙 저장·`/permissions`·`/execute` | `default-model.ts`(rewriteUserConfig 재사용), `interactive-actions.ts` |
| 5 | 기록 `action` 종류 + TUI 카드 + 재생 | `sessions/store.ts`, `tui/session-transcript.ts`, `transcript-model.ts` |
| 6 | 문서·도움말 | `README.md`, `framework/README.md`, `cli.ts` |

테스트: 모드별 도구 집합, 승인/거부/항상허용, 프로젝트 allow 무시, 거부 목록, 작업 폴더 밖 차단, 워크플로 중 거부, 취소, 재생, 정책 ID 변화, 실제 PTY에서 승인 카드→실행→결과.

## 8. 결정이 필요한 것

1. **기본 모드**: `ask`(제안) vs 지금처럼 `plan` 유지 후 사용자가 켜기.
2. **`auto-edit` 제공 여부**: 편리하지만 "승인 없이는 실행하지 않는다" 메시지와 충돌. 제안: 제공하되 기본 아님, 켜면 상태줄에 표시.
3. **`bash` 범위**: 비대화형 한 줄 명령만(제안) vs 대화형도 허용(터미널 핸드오프).
4. **README 원칙 문구**: "승인 없이는 실행하지 않는다" → "모든 실행은 사람이 승인한다(한 동작씩 또는 계획 단위)"로 갱신.
