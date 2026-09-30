# lca 프레임워크 (설계 근거)

> 출처: [OpenCode 기반 자체 에이전트 프레임워크 심층 검토](../sources/documents-e23212dec8bc6f31aa6120397f75f7dd1d58f0df41dc8275b9b0e3a93df6265a.md) (2026-09-22 설계 문서). 관련: [로컬 우선 설계 계약](../concepts/local-first-contract.md), [OpenJev 라우터](openjev-router.md).

이 페이지는 **2026-09-22 설계 문서가 제안한 내용**을 정리한다. 이후 구현이 실제로 어떻게 달라졌는지는 이 출처만으로 확인되지 않으며, 구현 사실은 코드·README를 별도 근거로 삼는다.

## 정체성

- `lca`(local coding agent)는 OpenCode 위에서 로컬 Gemma 4를 백엔드로 쓰는 자체 에이전트 프레임워크로 제안됐다. 위치는 저장소의 `framework/`(플러그인 패키지)와 `.opencode/`(프로젝트 자산)다.
- 설계 결론은 OMC·OMO·OMX의 "복제"가 아니라 "반대 전제"로 만든다는 것이다. 근거는 [로컬 우선 설계 계약](../concepts/local-first-contract.md)에 정리했다.
- OpenCode는 v1 플러그인 훅 API로 짓고, `experimental.*` 훅은 어댑터 한 겹으로 감싸며 버전을 고정한다고 적혀 있다.

## 제안된 구성

- **레이어**: L0 런타임 계약(프리픽스 예산·툴 캡·thinking 고정), L1 플러그인 코어(config, chat.message, event, tool.execute.*, compacting, chat.params), L2 상태(단일 writer·원자적 쓰기), L3 코드 측 직렬 오케스트레이션, L4 데이터 레이어, L5 HUD.
- **에이전트**: `main`(대화·작은 작업·위임), `worker`(태스크 1개, 하위 위임 금지), `reviewer`(읽기 전용 ACCEPT/REJECT 판정), 데이터용 `data-analyst`·`data-verifier`.
- **모드**(`ulw`, `plan`, `team`, `data`)는 시스템 프롬프트를 바꾸지 않고 user 메시지 말미의 짧은 지시로만 표현한다. 상세 절차는 필요할 때 읽는 SKILL 파일로 둔다.
- **지속 루프 안전장치**: 반복 상한 20, 모드 TTL 2시간, 정체 3회, 연속 실패 5회, 컴팩션 직후 가드, `/stop` 즉시 종료. 판단은 원장과 이벤트로 하고 모델 출력 텍스트를 파싱하지 않는다.
- **팀 실행**은 직렬 큐가 기본이며, 병렬 슬롯은 처리량이 아니라 캐시 격리 목적으로만 검토됐다.
- **데이터 레이어**는 EvoOntology MCP의 조회 툴 2개만 노출하고, 활성 버전 전환은 사람 승인 후로 둔다.

## 빌린 것과 버린 것

- 빌림: OMX의 태스크 원장·모드 state, OMC의 키워드 sanitizer와 제어면/데이터면 분리, OMO의 조립 파이프라인·`disabled_hooks`·오류 복구 훅.
- 버림: 30K 규칙 프롬프트, 에이전트 11~19종, 모델 티어 라우팅, tmux 결합, 폴링 워처, native dependency, 텔레메트리.

## 리스크와 미검증 (출처 기준)

- Gemma 4 툴 신뢰성이 프레임워크로 고칠 수 없는 한계일 수 있다고 적혀 있다.
- `session.idle` 재프롬프트는 Stop 훅과 달리 비결정적이다.
- OMO 플러그인과 동시 사용은 불가하다(둘 다 `config.agent`를 덮어씀).
- 출처는 31B 처리 시간, 2슬롯 처리량 저하, 긴 컨텍스트 품질, 일부 벤치 수치의 1차 출처를 **검증하지 못한 항목**으로 명시한다. 이 위키는 이를 사실로 승격하지 않는다.

## 해석 (에이전트)

- 이후 이 저장소에 추가된 [OpenJev 라우터](openjev-router.md)는 스킬을 자동 실행하지 않고 턴별 조언만 붙인다. 이는 "오케스트레이션·판단은 코드가 한다"는 설계 방향과 일관된다. 다만 설계 문서는 라우터를 다루지 않으므로 직접적인 근거 관계는 아니다.
