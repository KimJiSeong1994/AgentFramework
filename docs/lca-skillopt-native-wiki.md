# `llm-wiki`용 native SkillOpt 운영 안내서

[framework README의 native SkillOpt 항목](../framework/README.md#native-skillopt-runbook) · [기존 P1 차단 기록](lca-skillopt-pipeline-2026-10-03.md)

## 상태와 범위

이 안내서는 현재 소스에 있는 native foreground 경로의 명령과 한계를 설명한다. 구현은 아직 검증 중이며, 현재 실행에 사용할 genuine/승인 76-family pack은 제공되지 않았다. 입력이나 필수 fixture 데이터가 빠지거나 구조 요건을 충족하지 못하면 코드가 `DATA_REQUIRED`로 멈추고 dispatch는 0건이다. 코드의 구조 검사는 사람의 pack 승인 여부를 판정하지 않으므로 승인되지 않은 fixture를 넣어 이 경계를 우회하지 않는다. 합성 fixture, 임의 후보, 테스트 승인으로 빈칸을 메우지 않는다. 이 문서는 기존 P1 기록을 대체하지 않는다.

대상은 `.agents/skills/llm-wiki/SKILL.md`의 지정된 Compile 삽입 구간뿐이다. `prepare`는 데이터와 scope를 결합할 뿐 추론하지 않는다. 후보 생성, 독립 평가, 사용자 승인, 적용, 정상 loader 검증은 서로 다른 단계다. 준비나 후보 점수만으로 개선·배포를 주장할 수 없다.

## 명령 문법

### TUI의 `/skillopt`

`/skillopt`와 `/skillopt status`는 상태 조회다. 나머지 명령은 writable chat owner가 있어야 한다. 인수 경로는 명령 끝의 문자 그대로의 나머지이며, 공백을 허용하지만 shell 인용·변수 치환·확장은 하지 않는다.

```text
/skillopt [status | prepare <input-path> | consent <run-id> [input-path] | arm <run-id> [input-path] | disarm <run-id> [input-path] | cancel <run-id> [input-path] | resume <run-id> [input-path] | run <run-id> [input-path] | apply <run-id> | rollback <run-id> | cleanup <run-id>]
```

`prepare`에 경로가 없으면 입력을 읽지 않고 `DATA_REQUIRED`를 돌려준다. `consent`, `arm`, `disarm`, `cancel`, `resume`, `run`에는 run ID가 필요하며 입력 경로는 생략할 수 있다. `consent`, `arm`, `disarm`, `resume`, `run`은 생략 시 저장된 run 입력을 다시 읽는다. `cancel`은 현재 owner의 미시도 run이면 직접 처리하고, 다른 owner에서 reentry해야 하면 저장된 입력이 필요하다. `apply`는 live qualified candidate의 게시 승인 절차를 호출한다. `rollback`은 같은 live publication context의 원본 복원 절차만 호출한다.

### 독립 실행 스크립트

저장소 루트에서 실제 parser가 받는 명령과 옵션은 다음과 같다. 이 블록은 문법만 보여 주며 실행 지시가 아니다.

```text
bun scripts/otter-skillopt.ts <prepare|status|consent|arm|disarm|cancel|resume|run> [--root DIR] [--input FILE] [--run ID]
bun scripts/otter-skillopt.ts cleanup --run ID [--root DIR]
bun scripts/otter-skillopt.ts <snapshot|preflight> [--root DIR]
```

`--root` 기본값은 저장소 root다. `prepare`에는 `--run`을 쓸 수 없고, 실제 입력이 없으면 `DATA_REQUIRED`다. `status`는 `--input` 없이 실행하며 `--run`은 선택이다. 나머지 foreground 명령에는 UUID 형식 `--run`이 필요하고 `--input`은 선택이다. `consent`, `arm`, `disarm`, `resume`, `run`의 입력 생략 시 저장된 run 입력을 읽으며, `cancel`은 현재 owner에서 직접 취소할 수 없는 경우 reentry용 입력이 필요하다. 필요한 입력 artifact가 없으면 `DATA_REQUIRED`다. `snapshot`/`preflight`는 예전 별도 경로이며 `--input`/`--run`을 받지 않는다.

독립 스크립트에는 `apply`나 `rollback` 명령이 없다. `run`이 자격을 갖춘 후보까지 만들면 같은 프로세스를 유지해 private TTY 게시 검토와 별도 사용자 승인을 진행한다. TTY 승인을 할 수 없거나 결과가 `COMMITTED`가 아니면 성공으로 반환하지 않는다. 이 프로세스 종료 후 다른 CLI 프로세스가 apply/rollback 권한을 복원하는 경로는 없다. rollback은 같은 TUI service·owner·runtime이 보유한 live publication context에서만 가능하다.

### 만료된 비공개 실험 텍스트 정리

`cleanup`은 입력 경로나 `--input`을 받지 않으며 source 재검증·실행 reentry·모델 추론을 하지 않는다. 현재 owner의 실제 전역 claim과 별도 terminal `APPROVE` 결정으로 고정된 run의 private 입력 및 종료가 입증된 trainer scratch만 정리한다. 최초 retirement에는 같은 부팅의 native monotonic 7일 만료 증거가 필요하다. 재부팅 후 wall-clock 나이로 이를 대신하지 않는다.

retirement와 artifact identity/hash를 먼저 보존한 뒤 삭제하며, 부분 실패는 `CLEANUP_INCOMPLETE`다. 재시도에는 새 승인이 필요하고 기존 snapshot에 없는 파일이나 바뀐 inode를 채택하지 않는다. snapshot 최초 저장 byte 수와 매 retirement의 quarantine metadata 상한 8,192 bytes를 쓰기 전에 기존 256 MiB 한도에서 차감하며 실패해도 환불하지 않는다. 이 상한 예약은 실제 디스크 사용량 측정값이 아니다. 교체된 capture나 정확한 post-capture identity를 확인할 수 없는 잔여물은 보존·거부하며 자동 복원하지 않는다. 원본 source, 스킬, promotion backup/journal, 복구·감사 기록은 삭제 대상이 아니다. `status`, 자동 idle poll, `dispose`에는 cleanup이 없고 timer/daemon도 없다.

실행 중·종료 불명확·복구 중·미게시 후보 승인 대기는 보존한다. worker 종료 marker가 없는 crash 잔여물도 보존하며 JSON을 읽어 실행 권한을 복원하지 않는다. `COMPLETED`는 committed apply handoff, `ROLLED_BACK`은 committed apply·rollback handoff까지 확인하며 상태명만으로 삭제하지 않는다. 7일은 최소 보관 기간이 아니므로 이미 종료가 입증된 실험의 기존 즉시 정리는 유지한다. ledger schema 8만 허용하며 이전 schema를 자동 변환하거나 삭제하지 않는다.

## 입력, 소유권, 프라이버시

입력은 `skillopt.native-foreground-input.v1` 계약의 JSON이다. `schema`, `models`의 `generator`/`target`/`reviewer`, `fixturePack`이 필수이고 `selections`, 검증된 Python `runtime` 정보는 선택 필드다. 미지 키와 호출자가 공급하는 runtime identity는 거부된다. 입력 JSON 자체는 승인이나 dispatch capability가 아니다.

- `generator`는 현재 foreground owner의 실제 engine/model과 일치해야 하며 optimizer가 그 binding을 사용한다. `target`은 별도 target/canary model binding이다. reviewer engine은 generator engine과 달라야 한다. 각 모델의 실제 vendor CLI runtime/profile identity도 다시 확인·결합한다.
- source는 사용자가 명시적으로 선택한 상대 경로뿐이다. 심볼릭 링크 경로, 다른 owner의 파일, hard link, 잘못된 UTF-8, secret 패턴, 선택 후 바뀐 source는 거부된다. 허용 provenance는 `raw`, `annotation`, `synthesis`, `contract`다. 전체 64개 파일, 선택 corpus 2 MiB, 파일당 128 KiB 한도 안에서 읽는다.
- fixture pack은 정확한 split 수 `train=24`, `dev=16`, `final=24`, `safety=12`의 76개 fixture/family가 필요하다. family, lineage 및 source content 재사용은 거부되고 네 stratum 모두 각 split에 있어야 한다. pack 전체는 512 KiB, fixture가 target에 제공하는 task/source/slot 입력은 64 KiB 한도다. 구조 검증의 `STRUCTURALLY_VALID`는 데이터 모양·hash 확인이지 사람의 출처 검토나 승인 증명이 아니다. 최종/safety gold는 trainer projection에 넣지 않는다.
- Python trainer는 provider CLI나 API를 호출하지 않고 provider credential/URL을 받지 않는다. model authentication과 실제 inference는 선택한 vendor CLI가 소유한다. 로그인 자격 증명을 input, pack, prompt, 복사된 환경에 넣지 않는다.
- TUI와 CLI의 공개 결과는 allowlist된 상태·hash·수치 metadata만 출력한다. source, fixture, model raw response, candidate text는 chat 또는 저장 session history에 넣지 않는다. 단, 사용자가 승인한 source/fixture와 생성 candidate는 실제 추론 범위에 포함될 수 있다. apply/rollback 검토의 candidate diff는 session history가 아닌 private TTY에만 표시된다.

source/pack 준비자는 동의 가능한 소유자여야 하고, 다른 사용자 자료·미검토 사적 대화·자격 증명을 포함하지 않아야 한다. session digest는 P5의 최소 metadata trigger 판정용일 뿐 training corpus로 수집·재생되지 않는다.

## 준비, 동의, 예산, P5 trigger

1. `/skillopt prepare <input-path>`는 source, fixture, baseline skill, 모델/runtime, protocol, schedule을 hash-bound하여 private run input artifact를 만든다. 모델 호출은 없다.
2. `/skillopt consent <run-id>`는 TTY에서 표시되는 정확한 데이터·모델·scope·예산 challenge에 대한 별도 동의다. 동의는 최대 24시간이며 run 자체는 최대 7일이다.
3. `/skillopt arm <run-id>`는 별도 명시 동의다. arm 시점의 eligible digest watermark를 저장한다. consent와 arm은 same boot/clock, source/model/baseline scope, original owner/runtime에 결합되며 scope drift·expiry·cooldown은 차단된다.
4. `/skillopt run <run-id>`는 foreground 수동 실행이며, reentry challenge를 다시 승인해야 한다. `resume`은 기존 미시도 run에 대한 명시적 reentry일 뿐 새 run, quota reset, 실행 후 일반 복구가 아니다. `disarm`은 arm만 해제한다. `cancel`은 미시도 상태만 취소하며 dispatch가 pending/uncertain이면 취소 성공을 주장하지 않고 `UNRESOLVED`를 보존한다.

고정 campaign schedule은 target 요청 432건과 canary reserve 16건이다. 총 한도는 target 512, optimizer 40, reviewer 2, candidate step 1이며 동시성은 1이다. controller의 active-time budget은 6시간, 실제 native request timeout은 120초, 누적 artifact budget은 256 MiB다. 이 값은 controller/worker에 정의된 budget이지 어떤 OS에서도 동일하게 보장되는 자원 격리라는 뜻이 아니다.

현재 고정 native 경로의 256 MiB 누적 artifact 사전 차감은 아래 Linux 합성 통합 검증을 통과했다. trainer 입력·manifest·protocol staging, reference evaluator tree와 고정 upstream 출력의 선행 차감을 포함하며, 고정 source와 검증된 출력 형태·상한을 유지하는 계약이다. `RLIMIT_FSIZE`는 파일별 제한이고, 작은 파일시스템도 현재 물리 점유량만 제한한다. 덮어쓰기·삭제 후 재작성·sparse file·압축 때문에 둘 다 누적 직렬화 바이트의 단조 증가·환불 금지 계약을 대신할 수 없다.

현재 trainer 준비의 사전 차감은 projection 실제 바이트 + manifest 실제 바이트의 두 배 + cleanup metadata 69,632 bytes + 고정 upstream 출력의 보수적 누적 상한 32,484,710 bytes다. 덮어쓰기는 각각 세고 protocol staging을 다시 더하지 않는다. 예산이 1바이트 부족할 때의 거부와 정확히 충분할 때의 전액 차감 검사는 통과했으며 준비 실패에도 환불하지 않는다. 고정 Linux worker와 합성 모델 응답을 사용한 campaign 검사는 선택 단계의 실제 이벤트 증거 연결과 별도 optimizer IPC 사전 차감까지 통과했다. 실제 corpus·모델 동의나 vendor inference 검증을 뜻하지 않는다.

P5는 TUI foreground host의 safe chat-idle checkpoint에서만 살펴본다. arm 이후 새로 끝난, 서로 다른 eligible session metadata digest가 5개 이상이어야 하고, 원래 owner/runtime와 source/model/baseline binding이 그대로이며 idle·미보류·미실행, consent/arm 유효, rolling 24시간 cooldown 경과 등 controller 조건도 모두 맞아야 한다. digest 검사는 transcript를 읽지 않는다. deferred command 또는 이미 queued된 user input이 있으면 먼저 그 입력을 처리하고 자동 poll을 건너뛴다. `sessionClosed`는 digest/capture만 수행하며 그 callback에서 추론하지 않는다.

자동 poll은 timer/daemon/cron이 아니다. foreground loop가 다시 안전한 idle 경계에 도달했을 때만 eligibility를 확인한다. digest threshold·cooldown·owner-busy 같은 사전 조건이 모자라면 dispatch 없이 막히며 이후 idle 경계에서 readiness를 다시 확인할 수 있다. 이미 시작/불확실한 model dispatch를 자동 재시도하거나 arm을 자동 재발급하지 않고, 자동 경로는 candidate apply/publish도 하지 않는다. private automatic arm은 같은 in-process service·owner session/epoch/runtime에만 있다. 프로세스 종료, model/session/runtime 변경은 그 private arm을 무효화한다. 저장 JSON이나 persisted `ARMED` 문자열만으로는 자동 권한을 복원할 수 없다. 특히 독립 CLI의 `arm`은 background scheduler를 남기지 않는다.

rolling 24시간에 허용되는 campaign attempt는 1회다. controller는 quota DB transaction에서 reboot를 실제 boot ID/monotonic clock으로 처리한다. 직전 attempt가 있고 새 boot의 fence가 없으면 현재 boot의 monotonic fence를 먼저 원자적으로 기록해 보수적으로 대기한다. wall clock으로 downtime을 추정해 cooldown을 단축하거나 counter/run deadline을 초기화하지 않는다. consent/arm은 boot-bound이며 reboot가 안전한 자동 재개를 허용하는 것도 아니다.

시계 조회 실패나 불연속은 기존 consent·arm과 미사용 PREPARED 승인 revision을 무효화하는 durable `clock-uncertain` 차단이다. 신뢰할 수 있는 sample이 없었다면 다음 유효 sample은 복구 fence를 설정할 뿐 해제하지 않는다. 같은 boot에서 검증된 monotonic 24시간이 지나고 active/pending 실행이 없을 때만 새 `prepare` transaction이 차단을 해제하면서 새 PREPARED를 발급할 수 있으며, 새 scoped consent가 다시 필요하다. `status`, wall-clock 수정, 재부팅, 오래된 승인 재사용은 해제 수단이 아니다. 기존 charge·unknown·cooldown 기록은 환불하거나 지우지 않는다. 과거 reservation이 없는 정상 첫 campaign에는 선행 24시간 대기가 필요하지 않다.

## 후보 HITL, 게시, 검증

TUI에서 `run`이 후보 자격까지 도달해도 publish하지 않는다. `/skillopt apply <run-id>`가 실제 게시 검토를 별도로 연다. 검토는 private TTY에서 아래를 확인할 수 있게 보여 준다.

- 정확한 Compile anchor의 삽입 내용과 candidate diff, prefix/suffix 보호 불변 및 exact reassembly 검사
- dev/final/safety metric, trial 누락·무효 수, confidence interval, strata, 모델/runtime/profile 및 source/fixture/protocol/candidate hash scope
- 남은 target/optimizer/reviewer/active-time/artifact/canary budget, pending/unknown 요청

화면에 표시된 현재 challenge의 `APPROVE` 또는 `REJECT` 문구를 그대로 확인한다. 이전 challenge를 재사용하거나 승인 문자열을 만들어내지 않는다. 승인 입력은 실제 interactive TTY의 one-use receipt여야 하며 challenge는 operation/subject hash/owner에 결합되고 helper 승인 유효시간은 15분이다. 승인 대기 중 추가 모델 요청은 없다. 사람의 approve 입력을 받은 뒤 승인 capability를 발급하기 전에 실제 `runtime.runs` mutation claim을 잡아 native exchange helper가 terminal/quiescent하게 settle될 때까지 유지한다.

`SWAPPED_EXPECTED`는 교체가 관찰됐다는 뜻일 뿐 성공이 아니다. 승인된 candidate bytes를 새 session의 정상 `llm-wiki` loader로 fresh canary하고 witness를 확인한 뒤, canary `COMMITTED` 및 해당 controller run `COMPLETED`가 함께 확인될 때만 게시 `COMMITTED`다. 이미 열려 있던 다른 session은 자동 reload되지 않는다.

Rollback은 같은 live TUI service·owner·runtime의 exact publication context에서만 요청할 수 있다. 별도 exact rollback approval, 승인 때 검증된 immutable original backup/inode, 원래 consent와 남은 원래 예산을 사용한다. 성공 조건은 original bytes로 복원한 뒤 fresh normal-loader canary 및 controller `ROLLED_BACK`다. 자동 reverse, 추가 experiment 또는 별도 CLI의 apply/rollback 복구는 없다.

## Native helper와 OS 격리 경계

promotion helper는 패키지된 `framework/src/skillopt/native.c`를 trusted compiler `/usr/bin/cc`로 빌드하고 compiler/source identity를 확인한다. Python worker는 `-I -S -B`로 실행되고 private runtime proof·source lock 검증 전 third-party import를 허용하지 않는다. optimizer는 실제 설치된 vendor runtime을 업그레이드/수정하지 않으며 private scratch copy/profile에만 준비된다. native runtime proof의 wheel origin은 `unobserved`이며 그 이상의 출처 증명이 아니다. `READY`는 해당 private preparation과 containment probe 결과를 뜻하며 system/global runtime 설치 상태나 campaign 성공을 뜻하지 않는다.

고정 upstream의 기본 text writer를 UTF-8 바이트 상한으로 계산하기 위해, native runner는 출력 directory 생성 전에 메모리 기반 `TextIOWrapper`의 실제 기본 encoding을 확인한다. UTF-8이 아니거나 확인에 실패하면 `native_output_encoding_unverified`로 거부한다. locale 환경변수나 stdout encoding을 증거로 대신 사용하지 않으며, 설치된 runtime이나 upstream writer를 변경하지 않는다.

### 분리된 native runtime acceptance receipt

기존 native runtime verifier 결과를 legacy runtime 검증이나 전체 SkillOpt acceptance와 혼동하지 않도록 `verify-native-acceptance`가 별도 receipt를 분류한다. 저장소 루트에서 사용하는 문법은 다음과 같다. 이 블록은 인터페이스 예시이며, proof나 hash 값을 만들거나 제공하지 않는다.

```bash
"$SKILLOPT_PYTHON" -I -S -B scripts/skillopt_runner.py verify-native-acceptance \
  --source-lock scripts/skillopt-source-lock.json \
  --runtime-proof /absolute/private/native-runtime-proof.json \
  --runtime-proof-sha256 "$EXPECTED_NATIVE_RUNTIME_PROOF_SHA256"
```

`SKILLOPT_PYTHON`은 승인된 private runtime의 절대 interpreter 경로로 명시적으로 설정해야 하며, 보호 대상인 원본/설치 runtime을 가리키면 안 된다. `-I -S -B` 플래그는 그대로 사용한다. proof 파일은 이 명령을 실행하기 전에 별도 절차로 생성·보존되어야 한다. `EXPECTED_NATIVE_RUNTIME_PROOF_SHA256`는 호출자가 proof의 정확한 원시 바이트(마지막 개행 포함 가능)를 대상으로 독립적으로 계산하고 고정한 64자리 소문자 SHA-256이어야 한다. 지정 경로도 native verifier의 canonical absolute path, 소유권, 권한 및 파일 형식 검사를 통과해야 한다. 이 명령은 기존 `verify_native_runtime`의 실제 엄격한 verifier만 호출해 현재 관찰 runtime과 proof를 대조하는 분류·보고 surface이며, native attestation 구현이나 증명 생성 경로를 새로 추가하지 않는다. `attest-native-runtime`를 호출하거나 proof를 생성·갱신하지 않고, `verify-runtime` legacy verifier로 전환하지도 않는다. proof 거부는 기존 고정 `RunnerError` 진단과 exit 2이며 성공 receipt를 출력하지 않는다.

성공 시 `skillopt.native-runtime-acceptance.v1` receipt는 최대 16 KiB이고, `nativeRuntime.status: verified`와 기존 verifier가 만든 compact `nativeRuntime.verification` 결과(검증된 proof SHA-256 등)를 담는다. proof의 임의 원문 payload는 receipt에 복사하지 않는다. 나머지 분류는 `legacyRuntime.status: not_run` 및 `verified: false`, `containment.status: not_evaluated`, `modelQualification.status: not_evaluated`, `release.authorized: false`, `production.authorized: false`다. 따라서 이 명령은 legacy 검증, OS 격리·resource readiness, worker `READY`, 실제 모델 자격·campaign, release 권한이나 production 승인을 시험하거나 주장하지 않으며 G8의 durable goal 상태도 바꾸지 않는다.

기존 Python 확인에는 `verify-runtime`의 긍정 assertion을 보존한 채 81-test 전체가 78 pass / 1 error / 2 skip으로 남아 있다. 유일한 오류는 native proof 검사가 아니라 legacy `verify_runtime`의 `interpreter_unverified`다. 별도 private Darwin copy에서도 `-I -S -B`의 prefix/site 조건 때문에 같은 legacy 경로가 거부됐고, 설치된 SkillOpt import 전에 멈췄다. 새 native acceptance receipt는 이 역사적 legacy 실패를 통과로 바꾸거나 대체하지 않는다.

현재 남은 외부 조건은 Darwin 필수 `RLIMIT_AS` 제한 실패(`resource_limit_unenforced`)와 이에 따른 worker readiness 미충족, 검증되지 않은 실제 Windows 및 WSL2 경로, 승인된 genuine 76-family corpus/gold 자료 부재, 실제 vendor model qualification·예산 검증·외부 전송 동의 부재, production apply/rollback 권한 부재다. 합성 Linux 실행 결과나 native proof receipt는 이 조건을 충족하지 않는다. 최종 독립 경계 검토와 전체 G8 완료도 미해결이다.

`tools` 비활성화는 OS sandbox가 아니다. Darwin Seatbelt 또는 Linux `bwrap` 기반 OS profile 및 실제 probe가 필요하다. 6시간 wall watchdog은 Darwin의 hard CPU/memory cap을 뜻하지 않고, 2 GiB `RLIMIT_AS`는 virtual address-space 한도이지 RSS/cgroup 한도가 아니다. resource cap은 현재 OS/runtime profile이 증명한 항목만 주장한다. 전체 OS `READY`를 이 구성만으로 보장하지 않는다. Windows native platform은 지원 대상이 아니며 WSL2는 Windows가 아닌 Linux runtime 경로다. 별도 Linux 검증 VM의 도구 누락은 해결되어 아래 실제 실행 결과를 확보했다. 현재 Darwin 검증에서는 필수 자원 한도를 설정하지 못해 worker를 `resource_limit_unenforced`로 차단한다. WSL2 inference는 별도로 미입증이다.

## 미지원 복구와 현재 검증 상태

아래 실행 기록은 시간순 이력이다. 과거 시점의 미입증·실패를 현재 성공으로 덮어쓰지 않으며, 최신 집계와 남은 제약은 이 절 끝의 **최신 검증 경계**에서 구분한다.

아래 검증 기록은 시간순 누적 이력이다. 초기 부분 실패·제외·진행 중이라는 기록은 당시의 상태이며, 같은 범위의 최신 결과는 뒤의 Linux 전체 실행과 마지막 허용된 통합 검사 기록에 있다. 서로 다른 OS·runtime·실행 표면의 결과를 성공으로 합치지 않는다.

`UNRESOLVED`, unknown dispatch, 제3 버전 drift, native exchange `RACE_HELD`/race 상태는 수동 reset으로 정리할 수 있는 성공이 아니다. journal, backup/captured inode, evidence 및 unresolved controller/quota 상태를 그대로 보존한다. non-quiescent helper/unknown/`RACE_HELD`에서는 `runtime.runs` mutation claim을 유지한다. 실제 helper 종료와 mutation settlement가 별도로 입증된 terminal `RACE_PRESERVED`에서는 mutation claim을 해제할 수 있지만, 게시 결과는 여전히 `UNRESOLVED`이며 controller/quota와 evidence는 보존된다. 상태 문자열이나 JSON 복사본만으로 claim 해제를 허용하지 않는다. claim 해제는 게시 성공·canary 통과·복구 완료를 뜻하지 않는다.

authority store, promotion run directory, approval/journal, retained backup을 직접 삭제·초기화하지 않는다. `stash`, 재적용, chmod/chown, sudo 등으로 상태를 덮어쓰지 않는다. 자동 rollback·새 run 재시도·완전한 operator recovery 경로가 현재 제공되지 않는다. status 조회와 미시도 run의 제한된 `resume`은 전체 promotion 복구가 아니다. 7일 run expiry 자체는 새 승인/실행의 논리적 만료이며, 위의 명시적 `cleanup`과 별개다. committed backup도 자동 삭제되지 않는다.

전체 목표 검증은 아직 완료되지 않았다. 아래 435-pass 결과와 native/Wiki 16-file 검사 614 pass / 14 skip / 0 fail, 8165 assertions는 후속 수정 전의 기준선이다. 후속 controller/campaign/evaluation/Wiki 검사는 149 pass / 4 skip / 0 fail, 1178 assertions와 TypeScript exit 0을 기록했다. 그 뒤 출력 사전 차감을 포함한 controller/trainer/campaign 검사는 57 pass / 6 skip / 0 fail, 729 assertions를 기록했다. 이 범위별 결과는 진행 중인 이벤트 증거 연결을 포함한 전체 재검증을 대신하지 않는다. 실제 controlling PTY에서 합성 expired PREPARED run의 cleanup 승인 전에 Ctrl-C를 보내 `operator_decision_aborted`, CLI exit 1, child/supervisor 회수와 terminal 복원을 확인했다. 승인 문자는 보내지 않았고 run·quota·원본 보존을 검사했다. 이는 무추론 취소 경로의 증거이지 production 승인, 실제 vendor inference, whole-TUI 또는 전체 목표의 승인 증거가 아니다. runtime 의존 제외 검사와 최종 경계 검토는 여전히 남아 있다.

후속 예산 검증에서는 trainer 입력·manifest·protocol staging·고정 upstream 출력의 사전 차감과 evaluator의 실제 파일 쓰기 대비 계획 검사가 통과했다. fixture 결과는 전체 decoded content 32 KiB와 fixture별 encoded 상한(최대 200,094 bytes)을 파일 생성 전에 검사하도록 구현했다. 실제 worker 거부 실행은 READY runtime 의존 검사로 남아 있다. Python의 optimizer 형태·중첩 JSON fence 해석·출력 전 UTF-8 검사 등 11개 집중 검사는 통과했지만 설치된 원본 runtime 검증을 대신하지 않는다. 계획·상한 자체는 예산 권한이 아니다. 실제 trainer 이벤트, 정확한 reservation과 broker의 일회용 완료 증명을 연결하는 target/optimizer 경로가 구현되었으며, optimizer IPC는 반환할 메시지의 JSON 및 개행 바이트를 먼저 차감하고 동일한 frozen 메시지를 한 번만 소비한다. Linux 실제 trainer를 요구하는 긍정·quota 거부 검사는 현재 환경에서 제외되었으므로 해당 경로의 실행 성공은 아직 입증되지 않았다. campaign의 final/safety reviewer 요청은 응답·usage 상한 32,959 bytes를 요청 예약과 같은 transaction에서 선행 차감하며 환불하지 않는다. 메모리 전용 trial·summary는 별도 차감하지 않고, publication의 실제 evidence 파일은 직렬화한 바이트를 쓰기 전에 차감한다. 이 수정의 controller/publication/broker 77개 검사는 통과했지만 전체 경계 승인을 대신하지 않는다.

2026-10-23 후속 확인에서는 TypeScript 검사가 통과했고, 허용된 22-file 통합 검사는 820 pass / 19 skip / 0 fail, 별도 host 선택 검사는 4 pass / 1 filtered / 0 fail을 기록했다. 19개 제외 사례에는 새 genuine optimizer capability 회귀 검사도 포함되므로 실행 성공으로 세지 않는다. controller의 독립 프로세스 quota·cold-reopen 검사와 foreground의 실제 controlling-PTY 취소 검사는 통과했다. 이전 full-host 실행에는 제외 대상 legacy snapshot 검사가 잘못 포함되었으며 ledger에 범위 위반을 기록했다. 현재 host 보고서는 이 사례를 실행하지 않고 skipped / assertions 0으로 표시한다. Python 전체 74-test 확인은 71 pass / 1 error / 2 skip이며, 오류는 원본 runtime의 `interpreter_unverified`다. 아래 64-test 결과는 이전 기록이다. 원본 interpreter·proof·권한을 변경하거나 실패 assertion을 제거하지 않았다. 이 결과들은 전체 목표·실후보 qualification·WSL 지원 완료를 뜻하지 않는다.

삭제 권한·교체 경합·삭제 완료 증거 수정 후 통합 검증은 12-file 435 pass / 7 skip / 0 fail, 6782 assertions와 TypeScript 검사 exit 0이다. private-text retention 범위의 독립 재검토는 `CLEAR / APPROVE`이며 전체 G001의 최종 검토와는 별개다. 추가된 trainer 중단 시나리오는 READY runtime이 필요해 이번 실행에서 제외되었다. 추가 host provenance·CLI 거부 검사는 4 pass / 26 assertions이며, 실제 raw 자료를 읽는 기존 legacy snapshot 검사는 이후 실행 범위에서 제외했다. 이 결과는 synthetic/private 통합 검증이며 genuine 76-family/live qualified campaign, production apply/rollback, WSL2 inference, whole-OS `READY` 증거가 아니다. genuine qualified terminal cleanup 긍정 경로도 아직 실증되지 않았다. 최신 Python 64-test 확인 기록에는 legacy `interpreter_unverified` error 1건과 skip 2건이 있어 green이 아니다. 긍정적 legacy assertion은 삭제하지 않았다. 최신 Linux VM 확인은 `cc`/`bwrap`/`uv` 누락으로 중단되었으며 native Linux test 결과가 아니다.

2026-10-24에는 기존 VM·원본 runtime을 복제하거나 수정하지 않고, 호스트 마운트가 없는 별도 Linux 검증 VM에 고정 source/dependency와 검증 도구를 설치했다. 위 도구 누락 기록은 이전 환경의 결과다. 새 VM의 `/tmp`는 tmpfs여서 교환 검사가 거부되었고, private ext4 scratch에서는 Python native 15개와 packaged helper 3개 검사가 통과했다. producer/consumer proof 필드, fixture profile의 undefined 직렬화, worker의 inherited umask, sandbox proof-parent 권한을 수정한 뒤 실제 containment 14개 검사가 모두 통과했다(214 assertions, 제외 없음). 이어 실행한 genuine optimizer 프로토콜 3개 검사는 `clock-uncertain` 또는 이벤트 admission의 `binding-invalid`로 실패하여 원인 분석·수정 중이다. 이 실패를 제외나 성공으로 바꾸지 않는다. 원본 legacy proof 오류와 실제 데이터·모델·승인·WSL 검증은 별개로 남아 있다.

후속 Linux 실행에서는 direct optimizer 3개 검사(54 assertions)와 별도 native v2 attestation을 갖춘 private-copy trainer 5개 검사(64 assertions)가 통과했다. 그러나 전체 campaign 15개 검사는 9 pass / 6 fail이며, containment 재실행에서도 종료 직후 process-group 판정으로 1건이 실패했다. fixture/trainer의 역할별 source hash 차이와 테스트 상태 격리 등을 수정 중이므로 부분 통과를 전체 통과로 제시하지 않는다. 기존 Python 74-test 실행은 고정 원본과 다른 격리 interpreter에서 수행한 결과이며, 원본 legacy runtime의 실행 검증이나 native v2 Linux 결과로 서로 대체하지 않는다.

검증 VM의 journal에서는 Lima 시간 동기화와 chrony가 함께 동작하며 wall clock을 최대 약 2.28초 뒤로 조정한 사실을 확인했다. 새 검증 VM에서만 chrony를 비활성화했으며 제품의 clock·owner 검증은 완화하지 않았다. worker 출력의 filesystem type은 실제 `statfs` 값으로 전후 비교한다. 최신 Linux 전체 실행은 containment 14 pass(219 assertions), campaign 15 pass(692 assertions), private-copy trainer 5 pass(64 assertions)이며 모두 실패·제외가 없다. 실제 고정 trainer와 격리 worker를 실행했지만 모델 응답은 합성이므로 실제 vendor inference나 후보 qualification·생산 적용의 증거는 아니다.

고정 upstream이 한 문단에 붙이는 바깥 개행만 native adapter에서 제거하고, 원시 UTF-8 크기 한도와 내부 개행·제어문자·비밀 검사는 유지한다. rollout과 결과의 문단·해시는 같은 정규화 규칙을 사용한다. native `no_improvement`는 정상 종료 후 `NO_GAIN`으로 처리하며 승인 권한을 만들지 않는다. 취소 promise의 거부는 즉시 처리하되 종료 증명이 없으면 `UNRESOLVED`를 유지하고 취소를 재발행하지 않는다. 실제 campaign 검사는 quota 초과 시 optimizer IPC 차단, 실패한 안전성 평가에 대한 qualification 부재, 정확한 두 reviewer 예약, 취소 세 경우, 누적 artifact 사전 차감과 재시작 cooldown fence를 확인했다. Python 전체 81-test 검사는 78 pass / 1 error / 2 skip이다. 오류는 변경하지 않은 legacy proof와 격리 검증 interpreter의 불일치(`interpreter_unverified`)이며 제외나 성공으로 바꾸지 않았다. 원본 runtime·proof·source/dependency pin과 실제 데이터·모델·생산 승인 경계는 그대로다. 최종 독립 경계 검토와 전체 목표 승인은 별개로 남아 있다.

Darwin에서는 원본 interpreter·proof·권한을 변경하지 않고 별도 private CPython 3.13.2와 복사한 dependency tree에 새 native proof를 발급·검증했다. managed Python의 library 경로 변경과 서명은 새 복사본에만 적용했다. Seatbelt loader가 요구하는 `/` 디렉터리 자체의 읽기만 허용했으며 하위 경로의 data 접근 권한은 추가하지 않았다. 실제 containment 검사는 12 pass / 2 Linux 전용 skip / 0 fail, 108 assertions다. Darwin 자원 한도 거부는 개별 probe 실행보다 먼저 발생하므로 receipt의 모든 probe 값은 false이며, 이 결과를 filesystem·network 격리 성공이나 worker `READY`로 해석하지 않는다. 별도 trainer 준비 검사에서는 READY를 요구하는 2건이 실패한 기록을 보존하며 Linux의 5-pass 결과로 이를 대체하지 않는다.

추가 원인 분리에서는 동일 private copy의 native proof를 다시 검증한 뒤, credential 없는 별도 child를 `-I -S -B`로 실행했다. Seatbelt 밖에서도 `RLIMIT_AS=(2147483648, 2147483648)` 설정이 `ValueError: current limit exceeds maximum limit`로 거부됐다. 따라서 이 구성의 2 GiB address-space 제한 문제를 sandbox 파일 접근 권한 확대나 wall watchdog으로 해결했다고 주장하지 않는다. 다른 resource 값의 설정·조회 성공은 실제 강제 여부의 증명이 아니며, 기존 `resource_limit_unenforced`와 Darwin READY 실패는 그대로 남는다.

이전 22-file 통합 검사는 820 pass / 21 skip / 0 fail, 9325 assertions이며 TypeScript 검사도 통과했다. 별도 host 검사는 4 pass / 1 filtered / 0 fail, 26 assertions다. 기존 raw snapshot 사례는 계속 실행 범위에서 제외했다. 실제 controlling PTY의 cleanup 취소도 재실행하여 승인 문자 0바이트, SIGINT, CLI exit 1, child 회수와 원본·quota 보존을 확인했다. PTY Python helper도 `-I -S -B`로 격리했다. 이 결과와 별도 Linux 실검증을 구분하며, 실제 외부 모델·WSL2·전체 TUI·생산 승인 완료로 합산하지 않는다.

별도 credential-free worktree·home·state에서 실제 full-screen TUI의 모델 미선택 경로도 실행했다. 네트워크·원본 raw·자격증명 접근과 원래 home의 쓰기를 금지한 별도 Seatbelt profile 안에서 `/skillopt prepare`의 `DATA_REQUIRED`, owner 없는 status 거부, 잘못된 명령 문법 거부를 확인했다. `/quit`와 SIGINT 종료 두 경우 모두 실제 alternate-screen 진입·해제, child 회수와 terminal 복원을 확인했고 승인 문자는 보내지 않았다. 이는 admitted session부터 사람의 승인·실제 campaign까지 이어지는 TUI 긍정 경로의 증거는 아니다.

후속 Linux 첫 자동 campaign 검사는 실제 격리 trainer·reference worker로 1 pass / 299 assertions를 기록했다. 중복 poll은 비동기 준비 전에 차단하며, 새 quota에서 예약 1회, target 432건·optimizer 3건·reviewer 2건, 순서가 있는 trainer event 123개와 후보 승인 대기에서의 정지를 확인했다. 승인 대기 중 active quota hold는 유지하고 게시하지 않는다. 기존 scratch 중복 준비와 reservation ID/request ID 혼동 실패는 별도 기록으로 보존했다.

초기 default CLI transport 검사는 qualification 이후 `canary_bridge_refused`로 막혔다. 보존한 합성 후보의 모델 호출 없는 진단으로 외부 source capture 동의와 로컬 skill content 동의를 혼동한 fixture를 수정했다. 이어 normal-loader의 `main` policy와 broker 전용 실행 기록 형식 사이의 충돌을 별도 `nativeLoadCanary` 구분자로 해결했다. broker의 역할·identity hash 제한은 그대로 유지하며, canary에는 실제 main policy·요청·owner·일회용 승인·종료 증명을 요구한다. 실행되지 않던 quota UPDATE 두 곳도 수정하여 확정된 미전송은 pending slot을 해제하되 과금을 환불하지 않고, 미정산 전송과 불명 상태는 hold를 보존한다.

그 뒤 실제 apply canary는 완료했지만 trainer scratch 삭제가 실패했다. 보존한 트리에서 `output`과 `output/skillopt-output`의 depth가 같아 부모부터 삭제하려던 문제를 확인했다. depth를 일관된 0-based 값으로 수정했으며 nested-file 회귀를 포함한 Linux trainer 5개 검사(70 assertions)가 통과했다. 이전 부분 삭제 트리와 불명 진행 상태는 그대로 보존했고 권한·inode·quarantine·quiescence 검증이나 복구 제한은 완화하지 않았다.

첫 방향의 Linux default-transport service 전체 검사는 **1 pass / 395 assertions**다. 실제 고정 trainer·격리 reference worker·새 `SkillSession`을 거쳐 qualification, 별도 apply 승인과 `COMMITTED`, 별도 rollback 승인과 `ROLLED_BACK`, 원본 bytes 복원, 후속 중복 호출의 무전송 거부를 확인했다. target 434건·optimizer 3건·reviewer 2건인 총 439개 요청이 정산됐고 unresolved 요청은 0건이다. apply·rollback의 서로 다른 canary handoff 2개와 loader session·epoch·witness를 확인했다. 실제 optimizer stage는 `analyst, analyst, merge`다. 앞선 handoff 수 오기 검사의 실패도 보존했다.

수정 후 첫 자동 campaign도 다시 1 pass / 299 assertions를 기록했다. Linux 검증은 실행 직전 관련 source 231개의 hash 일치를 확인했으며, 별도 VM 호출 사이의 구버전 실행 기록을 현재 source 검증으로 계산하지 않는다. 모델 응답·데이터·승인은 합성이고 transport와 worker·loader·파일 교환은 실제 경로다. 이 service 결과만으로 실제 TUI 실행을 주장하지 않으며, TUI 경로는 아래에서 별도로 검증했다.

### 최신 검증 경계

현재 허용된 23-file host 통합 검사는 **847 pass / 24 skip / 0 fail, 9793 assertions**다. TypeScript와 별도 host 거부 검사 **4 pass / 1 filtered / 0 fail, 26 assertions**도 직렬 실행으로 exit 0을 확인했다. runtime 미제공으로 제외된 검사를 native 실행 성공으로 세지 않는다. 추가 canary 오류 검사는 7 pass / 56 assertions로 일반·위장 오류의 원문과 payload를 숨기고, 제한된 typed code만 공개하며 dispatch 0을 유지했다. Linux containment는 14 pass / 219 assertions, campaign은 15 pass / 692 assertions로 재확인했다. clone-attestation fixture에 이미 정리된 native venv를 잘못 전달한 실패는 올바른 private source venv로 재실행한 결과와 구분한다.

실제 Linux full-screen CLI/TUI도 private controlling PTY에서 실행했다. `prepare`와 `consent`만 수행한 별도 검사는 각각 dispatch 0이었다. 전체 경로는 실제 admission부터 `prepare → consent → run → apply → rollback → /quit`까지 통과했다. 표시된 합성 승인 문구 4회와 실제 local-content 선택 2회를 입력했고, qualification·`COMMITTED`·`ROLLED_BACK`, 총 439회 요청과 원본 복원, exit 0·child 회수·terminal 복원·alternate-screen 진입/해제 6회를 확인했다. 원시 PTY 283,725 bytes는 잘리지 않았으며 source·shim hash도 유지됐다. TUI·terminal·transport·worker·loader는 실제 구현이지만 외부 모델 응답·corpus·승인 입력은 합성이다. 이는 실제 사람의 production 승인이나 vendor 추론 증거가 아니다.

첫 자동 시작도 별도 실제 full-screen TUI에서 통과했다. 새 quota에서 `prepare → consent → arm`의 정확한 합성 승인 2회 후, arm 이후 현재 시각의 metadata-only digest 4개에는 무예약·무전송 거부가 유지됐고 다섯 번째 digest 이후 실제 idle 경계에서 한 번 시작했다. `/skillopt run`, `apply`, `rollback`은 입력하지 않았다. TUI가 빈 Enter를 무시하므로 `/help`를 열고 Escape로 닫아 host loop를 진행했으며, 복원된 합성 `/help` draft만 실제 editor 키로 지웠다. read-only ledger에서 automatic reservation 1회, 정산된 target 432·optimizer 3·reviewer 2회, trainer 연결 123개, qualification 1회, canary·handoff·unknown·pending 0을 확인했다. 후보 HITL 앞에서 멈췄고 추가 idle 경계에서도 요청·ledger·active hold·cooldown은 바뀌지 않았다. 원본 보존, exit 0·child 회수·terminal 복원, alternate-screen 진입/해제 7회와 잘리지 않은 PTY 419,219 bytes를 확인했다. digest 수는 실제 주입한 합성 metadata 파일 inventory의 관측치이며 TUI가 그 수를 출력했다고 주장하지 않는다. 앞선 verifier의 runId 파싱 오류와 복원된 `/help` draft 중복으로 인한 실패도 보존했다. 후자는 실제 qualification에 도달했어도 verifier timeout이므로 성공으로 세지 않는다.

반대 방향인 Claude generator → Codex target/reviewer의 default-transport service 검사도 **1 pass / 402 assertions**로 qualification·새 loader canary·apply·별도 rollback을 통과했다. target과 reviewer는 서로 다른 지원 catalog model을 사용한다. 최초에는 지원하지 않는 합성 Codex slug로 predispatch 실패했으며, 이때 setup 실패 fixture가 삭제된 harness 결함도 확인했다. 이후 모든 setup 실패를 보존하도록 수정했으며 과거 실패의 자료가 복원됐다고 주장하지 않는다. 두 방향의 합성 통합 성공은 실제 모델별 qualification 권한의 이전을 뜻하지 않는다. TUI와 반대 방향 실행 직전에는 source·fixture 234개의 hash를 확인했다. Linux의 별도 관측 pin은 CPython 3.14.4이며 원본 Darwin 3.13.2 pin을 변경하거나 동일하다고 간주하지 않았다.

이 문서에 기록된 이전 SkillOpt Python 두 모듈의 별도 프로세스 재실행 합계는 **81 tests / 78 pass / 1 error / 2 skip**이다. runner는 당시 66건 중 65 pass·1 error, native primitive는 15건 중 13 pass·2 Linux 전용 skip이었다. 이는 이번 변경의 전체 테스트 결과가 아니다. native private-copy attestation 검사는 통과했지만 legacy positive attestation은 초기화된 venv/site 상태와 원본 proof의 정확한 경로·hash를 요구한다. suite의 private source-runtime 경로 거부와, canonical suffix를 갖춘 검증된 private Darwin copy에서도 `-I -S -B`의 prefix/site 조건 때문에 발생한 실제 `verify_runtime` 거부를 따로 확인했다. 후자는 설치된 SkillOpt를 import하기 전에 거부됐다. 이를 통과시키려고 site 초기화, 원본 runtime 실행, proof 변경 또는 assertion 제거를 하지 않았다. Darwin의 필수 `RLIMIT_AS` 실패, 실제 Windows/WSL2 접근·검증, 검토된 실제 corpus/gold·모델·예산·외부 전송 동의와 production apply/rollback 승인은 별도 미충족 조건이다. 최종 독립 경계 검토와 전체 목표 완료는 위 범위별 성공과 별개다.

추가 crash 검증은 실제 controller의 자동 reservation·dispatch grant 후 무해 OS child를 시작하고 dispatch ACK 전에 controller를 `SIGKILL`했다. 같은 ledger를 다시 열어 child 생존 중과 종료 후 모두 무환불·무재전송·pending/unknown 보존을 확인했다. 별도 28-assertion 검사는 실제 자동 reservation COMMIT 이후, grant 소비·native child 시작 이전에 controller를 `SIGKILL`하고 같은 보수적 charge·consumed arm·복구 거부와 execution intent 0을 확인했다. 이 launch 전 검사는 reservation 호출이 반환한 뒤의 중단이며, 기존 storage-seam의 COMMIT 결과 유실 검사와 구분한다. 같은 session 재연결은 `admission-held`, 새 owner의 복구는 `owner-unavailable`로 거부됐다. 원래 process-local owner/epoch를 되살리거나 새 recovery API를 만들지 않았으며, 이것을 crash 후 정산 성공으로 계산하지 않는다. 별도 기존 검사가 유효한 owner의 실제 child 종료·reference-backed 복구를 검증한다. SQLite 검사는 제한된 실제 cache spill로 DELETE rollback journal의 hot header를 확인하고 COMMIT 전 `SIGKILL`한 뒤 부분 예약 없이 전체 rollback을 확인했다. Linux ext4의 controller 72건·promotion 50건·packaged helper 3건은 **125 pass / 0 skip / 0 fail, 1551 assertions**다. 실제 OS boot/continuous sampler와 제어된 reboot/fence 검사를 구분하며, 실제 VM 재부팅 뒤 같은 ledger의 복구를 검증했다고 주장하지 않는다.

이 검증의 최초 Linux 호출은 잘못된 `/tmp`(tmpfs) 선택과 package-script 경유로 **76 pass / 48 fail**이었다. 그 회차의 tmpfs worktree는 VM 종료 후 남지 않았고 복구됐다고 주장하지 않는다. 수정한 실행은 private ext4 scratch·working directory를 실행 전에 검사하고 Bun을 `--no-env-file`로 직접 호출했다. 성공한 unresolved fixture와 보고서는 ext4에 보존했고, source·실행 test 237개 hash를 확인했다. 초기 hot-journal의 cold header 실패도 보존했으며, header 검사를 약화하지 않고 실제 SQLite spill 조건을 수정했다.

### 구현 근거

합성 promotion proof fixture도 production의 transport 주입 거부를 유지한 채 실제 transport와 임시 mock CLI subprocess로 이관했다. 별도 promotion 검사는 49 pass / 444 assertions이며, 위 16-file 통합 검사에서도 기존 canary·변조·rollback 긍정 검사를 유지했다. 이는 실제 모델의 qualification 증거가 아니다. 별도 제한된 host 거부 검사는 4 pass / 26 assertions다.

별도 synthetic dataset·evaluation·containment 검사는 38 pass / 7 skip / 0 fail, 186 assertions다. containment의 runtime 의존 시나리오는 제외되었으므로 실제 OS 격리 성공을 의미하지 않는다.

- [TUI parser/help](../framework/src/hosts/interactive-actions.ts), [TUI lifecycle](../framework/src/hosts/interactive-session.ts), [standalone parser](../scripts/otter-skillopt.ts)
- [foreground service](../framework/src/skillopt/foreground.ts), [controller/quota](../framework/src/skillopt/controller.ts), [dataset limits](../framework/src/skillopt/dataset.ts), [campaign schedule](../framework/src/skillopt/campaign-protocol.ts)
- [private trainer](../framework/src/skillopt/trainer.ts), [worker profile](../framework/src/skillopt/host.ts), [Python adapter](../scripts/skillopt_runner.py)
- [publication HITL](../framework/src/skillopt/publication.ts), [atomic promotion](../framework/src/skillopt/promotion.ts), [fresh loader canary](../framework/src/skillopt/load-execution.ts)
