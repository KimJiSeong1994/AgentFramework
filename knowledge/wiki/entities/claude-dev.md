# claude.dev: 에이전트 설계·운영 글 모음

[색인](../index.md) · [설계 읽기](../concepts/agent-harness-design.md) · [운영 읽기](../concepts/agent-operations-and-economics.md)

## 조사 범위와 출처

2026-10-02 UTC 기준 공개 블로그 **13편**을 조사했다. 사이트맵·`llms.txt`·`posts.json`의 목록을 대조했고, RSS의 10개 항목만으로 범위를 정하지 않았다. 아래 날짜는 글의 발행일이며 사이트맵 수정일이 아니다. 근거는 [등록 연구 노트](../sources/documents-42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8.md)와 그 페이지에서 연결한 불변 원본이다.

본문은 사이트가 제공하는 Markdown 대체 자료를 끝까지 읽었다. 동영상과 대화형 도표는 실행하지 않았으며 본문 설명만 사용했다. 링크된 다른 사이트의 모든 글, 삭제·비공개·색인 누락 글은 포함하지 않는다. 따라서 “전체”는 **조사 시점 공개 색인에서 발견한 13편 전체**를 뜻한다.

등록 자료는 글별 URL·저자·요지·제한을 담은 한국어 연구 노트다. 웹 원문의 복제본이나 독립 재현 보고서가 아니며 등록 해시는 연구 노트를 식별한다. 제품명·API·가격·성능은 발행 시점의 출처 주장으로 다룬다. 설치된 OpenCode에서 지원되거나 로컬 실험으로 입증됐다는 뜻이 아니다.

## 전체 글 목록

A01–A13은 [불변 조사 노트](../../raw/documents/42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8.md)의 같은 번호와 대응한다. 개별 원문 URL과 저자는 그 노트에 보존했다.

| ID | 발행일 | 원문 제목 | 위키에서 읽기 |
|---|---|---|---|
| A01 | 2026-10-01 | Getting started with Claude Code mods | [스킬·확장](../concepts/agent-skills-and-extensions.md) |
| A02 | 2026-09-28 | Building with Claude Sonnet 5.5 | [운영·비용](../concepts/agent-operations-and-economics.md) |
| A03 | 2026-09-28 | Automating eval design and hillclimbing with Claude | [평가·최적화](../concepts/agent-evaluation-and-hillclimbing.md) |
| A04 | 2026-09-25 | What a task costs on Opus 5.5 | [운영·비용](../concepts/agent-operations-and-economics.md) |
| A05 | 2026-09-25 | Using Claude Code: Spending your effort | [운영·비용](../concepts/agent-operations-and-economics.md) |
| A06 | 2026-09-23 | How we made claude.ai 3x faster in two weeks | [운영·비용](../concepts/agent-operations-and-economics.md) |
| A07 | 2026-09-22 | Getting the most out of Opus 5.5 in Claude and Claude Code | [하네스 설계](../concepts/agent-harness-design.md) |
| A08 | 2026-07-24 | The new rules of context engineering for Claude 5 generation models | [컨텍스트·캐시](../concepts/agent-context-and-cache.md) |
| A09 | 2026-06-03 | Lessons from building Claude Code: How we use skills | [스킬·확장](../concepts/agent-skills-and-extensions.md) |
| A10 | 2026-06-02 | A harness for every task: dynamic workflows in Claude Code | [하네스 설계](../concepts/agent-harness-design.md) |
| A11 | 2026-05-20 | Using Claude Code: The unreasonable effectiveness of HTML | [검토 산출물](../concepts/agent-human-review-artifacts.md) |
| A12 | 2026-04-30 | Lessons from building Claude Code: Prompt caching is everything | [컨텍스트·캐시](../concepts/agent-context-and-cache.md) |
| A13 | 2026-04-10 | Seeing like an agent: how we design tools in Claude Code | [하네스 설계](../concepts/agent-harness-design.md) |

## 목적별 읽기 경로

- **에이전트 설계:** 하네스 → 컨텍스트·캐시 → 스킬·확장 → 검토 산출물. 모델이 선택할 행동, 필요한 정보, 결과를 확인하는 인터페이스를 순서대로 본다.
- **에이전트 운영:** 평가·최적화 → 운영·비용 → 도구 결과 근거. 지표의 의미와 실행 환경을 먼저 정하고 비용·성능을 비교한다.
- **이 저장소와 비교:** [otter 프레임워크](lca-framework.md), [로컬 우선 계약](../concepts/local-first-contract.md), [OpenJev 라우터](openjev-router.md), [도구 결과 근거](../concepts/tool-outcome-evidence.md). 기존 페이지의 설계 시점과 관측 범위를 유지하며 새 글을 현재 구현 증거로 치환하지 않는다.

## 종합 판단과 충돌

다음은 원문 하나의 공식 아키텍처가 아니라 이 위키의 비교·해석이다.

1. **자율성의 전제는 검증 가능한 완료 계약이다.** 장기 실행, 동적 분할, 검증, 배포 관측은 분리된 단계지만 목표와 증거를 공유해야 한다(A03·A06·A07·A10).
2. **프롬프트를 줄이는 것과 권한을 줄이는 것은 별개다.** 중복 지침은 줄이되 승인·비밀·데이터 경계는 집행 계층에 남긴다(A01·A08·A13).
3. **모델 이름을 운영 원칙으로 고정하지 않는다.** A04는 코드 편집을 Opus에 남기는 방향이고, 뒤의 A02는 명확한 코딩 작업에 Sonnet을 권한다. 둘을 합쳐 절대 규칙으로 만들지 말고 작업 분포·버전별로 평가한다.
4. **더 좋은 점수와 실제 개선은 다르다.** 반복 선택에 사용한 test는 최종 독립 평가가 아니며, 실험실 지표는 사용자 지연을 자동 증명하지 않는다(A03·A06).
5. **더 많은 에이전트·토큰·HTML이 항상 좋은 것은 아니다.** 각각 조정 비용, 추가 판단, 검토·보안 부담이 있다(A04·A05·A10·A11).

이 조사에서 모델 설정·권한·스킬 정책을 바꾸거나 운영 관측을 활성화하지 않았다. 여기의 제안은 구현 승인이나 자동 학습 지시가 아니다.
