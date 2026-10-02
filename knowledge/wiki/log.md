# 작업 로그

## [2026-09-29T04:22:51.966Z] capture | 도구 실행 관측

- source_id: 9d8e2559edced1fdaee767441598a80e3317dee0565bc65417a5884987fceca9
- [원본 요약](sources/tool-runs-9d8e2559edced1fdaee767441598a80e3317dee0565bc65417a5884987fceca9.md); 0/0개 관측.
- 의미적 ingest는 아직 실행하지 않았습니다.

## [2026-09-29T04:23:55Z] ingest | 초기 도구 관측의 범위 확인

- [첫 원본 요약](sources/tool-runs-9d8e2559edced1fdaee767441598a80e3317dee0565bc65417a5884987fceca9.md)을 원본 JSON과 대조했다. 관측 0개이므로 실제 사용 성과를 추론하지 않았다.
- [도구 결과 근거](concepts/tool-outcome-evidence.md)에 빈 관측의 해석과 후속 수집 필요성을 연결했다.
- [라우터 페이지](entities/openjev-router.md)의 기존 README 불일치 설명을 현재 `suggest` 설정과 일치하도록 정정했다.

## [2026-09-29T04:28:02Z] lint | 구조·근거 경계 점검

- 구조 검사에서 링크·색인·불변 원본 무결성 문제가 없었다. 반복 capture도 같은 원본을 재사용하며 기존 통합 주석과 로그를 보존했다.
- [근거 페이지](concepts/tool-outcome-evidence.md)의 필드 이름과 잘못된 종료 코드 분류를 구현에 맞추고, 저장 관측의 완전성을 보장하지 않는 best-effort 한계를 명시했다.
- 실제 사용 관측이 비어 있으므로 실패 원인·성공률·업무 효과에 관한 결론은 추가하지 않았다.

## [2026-09-30T00:56:17.587Z] register | OpenCode 기반 자체 에이전트 프레임워크 심층 검토

- source_id: e23212dec8bc6f31aa6120397f75f7dd1d58f0df41dc8275b9b0e3a93df6265a
- [원본 요약](sources/documents-e23212dec8bc6f31aa6120397f75f7dd1d58f0df41dc8275b9b0e3a93df6265a.md); 의미적 ingest는 아직 실행하지 않았습니다.

## [2026-09-30T00:57:28Z] ingest | OpenCode 기반 자체 에이전트 프레임워크 심층 검토

- [원본 요약](sources/documents-e23212dec8bc6f31aa6120397f75f7dd1d58f0df41dc8275b9b0e3a93df6265a.md)을 원본과 대조해 통합했다.
- 새 페이지: [lca 프레임워크](entities/lca-framework.md), [로컬 우선 설계 계약](concepts/local-first-contract.md). [색인](index.md)에 연결했다.
- 설계 제안과 이후 구현을 구분했고, 출처의 미검증 항목은 확정하지 않았다.

## [2026-09-30T01:21:17Z] lint | 리뷰 반영 점검

- [로컬 우선 설계 계약](concepts/local-first-contract.md)의 README 인용이 등록 출처가 아닌 저장소 문서임을 명시했다.
- 구조 lint 통과, status 기준 모든 출처 컴파일 완료.

## [2026-10-02T02:12:38.851Z] capture | 도구 실행 관측

- source_id: 3aca54aae22acabc4ca432c87fd6c552aa65ef0185ba6aaee37403f8df5f1386
- [원본 요약](sources/tool-runs-3aca54aae22acabc4ca432c87fd6c552aa65ef0185ba6aaee37403f8df5f1386.md); 9/9개 관측.
- 의미적 ingest는 아직 실행하지 않았습니다.

## [2026-10-02T02:12:38.852Z] capture | Jev routing observations

- source_id: 47ed1186900e8c9302e023b319a6a860cb25601234483d37e123829b38a3f7f7
- [Sanitized routing snapshot](sources/routing-47ed1186900e8c9302e023b319a6a860cb25601234483d37e123829b38a3f7f7.md); 0 unique valid events.
- Recommendations and advice insertion are not evidence of skill execution or success.

## [2026-10-02T14:04:22.742Z] register | claude\.dev 공개 글 13편: 에이전트 설계·운영 조사

- source_id: 42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8
- [원본 요약](sources/documents-42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8.md); 의미적 ingest는 아직 실행하지 않았습니다.

## [2026-10-02T14:14:13Z] ingest | 후속 도구 관측의 범위와 한계

- 가장 오래된 미통합 [도구 출처](sources/tool-runs-3aca54aae22acabc4ca432c87fd6c552aa65ef0185ba6aaee37403f8df5f1386.md)를 원본과 대조하고 별도 통합 주석을 추가했다.
- [평가 페이지](concepts/agent-evaluation-and-hillclimbing.md)에 관측과 업무 성과의 차이를 기록했다. [도구 결과 근거](concepts/tool-outcome-evidence.md)에서 초기 빈 자료와 후속 자료를 구분했다.
- 새 관측이나 운영 성과를 만들어 넣지 않았다.

## [2026-10-02T14:14:13Z] ingest | 빈 라우팅 스냅샷의 해석

- 다음 미통합 [라우팅 출처](sources/routing-47ed1186900e8c9302e023b319a6a860cb25601234483d37e123829b38a3f7f7.md)를 원본과 대조하고 별도 통합 주석을 추가했다.
- [평가 페이지](concepts/agent-evaluation-and-hillclimbing.md)와 [도구 결과 근거](concepts/tool-outcome-evidence.md)에 제한된 수집 범위와 알 수 없는 비율을 연결했다.
- 이벤트 부재를 미사용·실행 성공·효과의 근거로 바꾸지 않았다.

## [2026-10-02T14:14:13Z] ingest | claude.dev 공개 글의 설계·운영 종합

- [등록 연구 노트](sources/documents-42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8.md)를 원본과 대조하고 A01–A13의 출처 연결과 통합 주석을 추가했다.
- [전체 목록](entities/claude-dev.md)에 13편의 발행일·주제·수집 범위·한계를 정리하고 [색인](index.md)에 연결했다.
- [하네스](concepts/agent-harness-design.md), [컨텍스트·캐시](concepts/agent-context-and-cache.md), [스킬·확장](concepts/agent-skills-and-extensions.md), [평가](concepts/agent-evaluation-and-hillclimbing.md), [운영·비용](concepts/agent-operations-and-economics.md), [검토 산출물](concepts/agent-human-review-artifacts.md)을 작성했다.
- 원문 주장·위키 해석·로컬 관측을 분리했다. 제품별 조언의 차이를 보존하고 벤치마크 재현이나 구현 변경을 주장하지 않았다.

## [2026-10-02T14:24:46Z] lint | 글 수집 범위·인용·불변성 점검

- [글 모음](entities/claude-dev.md)의 13개 고유 글과 연구 노트의 제목·발행일이 일치하며 새 의미 페이지 7개가 [색인](index.md)과 출처에 연결됨을 확인했다.
- Wiki lint 통과. 불변 원본 해시, 기존 로그·출처 본문의 바이트 보존, 상대 링크를 확인했다. 생성 보고서와 제품 코드는 변경하지 않았다.
- 원문 재대조로 A13의 ExitPlanTool 사례를 [출처 주석](sources/documents-42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8.md)과 [하네스 페이지](concepts/agent-harness-design.md)에서 정정했다. 불변 연구 노트의 오기는 숨기거나 덮어쓰지 않았다.
- 의미 검토에서 모델 배치 권고의 차이, 반복 선택에 쓰인 test의 한계, 외부 성능 수치와 로컬 관측의 분리를 확인했다. status 기준 등록 출처 5개 모두 통합됐고 pending·problems는 비어 있다.
