# 지식 위키 색인

이 위키는 원본을 보존하고 출처를 명시한 종합을 누적하는 [Karpathy LLM Wiki 패턴](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)을 따른다. 규칙과 ingest/query/lint 절차는 [`knowledge/AGENTS.md`](../AGENTS.md)에 있다.

## 개념

- [도구 결과 근거](concepts/tool-outcome-evidence.md) — 로컬 도구 실행 관찰의 출처·분류·한계와 개인정보 경계.
- [로컬 우선 설계 계약](concepts/local-first-contract.md) — 프리픽스 불변·예산·코드 측 조정 계약과 그 실측 근거.
- [에이전트 하네스와 도구 설계](concepts/agent-harness-design.md) — 행동 공간·작업 분할·완료 계약·신뢰 경계.
- [컨텍스트와 프롬프트 캐시](concepts/agent-context-and-cache.md) — 점진 공개·프리픽스 안정성·요약·제품별 예외.
- [스킬 패키지와 호스트 확장](concepts/agent-skills-and-extensions.md) — 패키징·배포·훅 수명주기·관측과 권한의 구분.
- [평가와 반복 최적화](concepts/agent-evaluation-and-hillclimbing.md) — 판정자 교정·과적합·독립 평가·로컬 관측 한계.
- [운영·성능·비용](concepts/agent-operations-and-economics.md) — 과업당 비용·effort·실험실과 현장 지표·배포 가드.
- [사람이 검토하는 산출물](concepts/agent-human-review-artifacts.md) — 명세·diff·HTML·출처·승인의 분리.

## 엔터티

- [OpenJev 라우터](entities/openjev-router.md) — 프로젝트의 선택적 스킬 추천 모드와 근거·한계.
- [otter 프레임워크](entities/lca-framework.md) — 2026-09-22 설계 문서가 제안한 레이어·에이전트·모드·안전장치.
- [claude.dev 전체 글 조사](entities/claude-dev.md) — 2026-10-02 공개 글 13편의 목록·분류·읽기 경로·출처 간 충돌.

## 캡처 산출물

- [도구 실행 결과 보고서](reports/tool-outcomes.md) — 캡처 CLI가 생성하는 메타데이터 집계. 기계 산출물이며 LLM 작성 종합이 아니다.
- [위키 활동 로그](log.md) — capture·ingest·query·lint 작업의 추가 전용 기록.

- [도구 실행 원본 9d8e2559edce](sources/tool-runs-9d8e2559edced1fdaee767441598a80e3317dee0565bc65417a5884987fceca9.md) — 0개 관측; 전체 0개 중 포함된 범위.

- [OpenCode 기반 자체 에이전트 프레임워크 심층 검토](sources/documents-e23212dec8bc6f31aa6120397f75f7dd1d58f0df41dc8275b9b0e3a93df6265a.md) — 등록 문서, 20950 bytes.

- [도구 실행 원본 3aca54aae22a](sources/tool-runs-3aca54aae22acabc4ca432c87fd6c552aa65ef0185ba6aaee37403f8df5f1386.md) — 9개 관측; 전체 9개 중 포함된 범위.

- [Jev routing snapshot 47ed1186900e](sources/routing-47ed1186900e8c9302e023b319a6a860cb25601234483d37e123829b38a3f7f7.md) — 0개 유효 이벤트; complete 범위.
- [Jev routing report](reports/routing.md)

- [claude\.dev 공개 글 13편: 에이전트 설계·운영 조사](sources/documents-42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8.md) — 등록 문서, 21789 bytes.
