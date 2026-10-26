#!/usr/bin/env bun
// Opt-in question-quality probes using production prompts, parser and local Ollama transport.
// bun scripts/otter-interview-eval.ts <installed-model> <output.json> [repeats:1-3] [case-id]
// Synthetic contexts only. This evaluates stages, not the complete workflow or file-reading tools.
import { writeFileSync } from "node:fs"
import { createCliTransport } from "../framework/src/hosts/cli-transport.ts"
import { parseStageEventsFor } from "../framework/src/workflows/turn.ts"
import { ambiguityOf } from "../framework/src/workflows/deep-interview.ts"
import { DI_TOPOLOGY_PROMPT, DI_QUESTION_PROMPT, DI_SCORER_PROMPT, DI_CLOSURE_PROMPT, DI_PANEL_PROMPTS } from "../framework/src/workflows/prompts/index.ts"

const [model, output, repeatArg = "1", onlyCase] = process.argv.slice(2)
const repeats = Number(repeatArg)
if (!model || !output || !Number.isInteger(repeats) || repeats < 1 || repeats > 3) {
  console.error("usage: bun scripts/otter-interview-eval.ts <installed-model> <output.json> [repeats:1-3] [case-id]")
  process.exit(2)
}
const section = (label: string, text: string) => `=== ${label} ===\n${text}\n`
const request = "고객 목록 CSV 내보내기와 작업 실패 알림을 개선하고 싶습니다. 한국어로 이야기해 주세요."
const completeExport = "[사용자 확정] CSV는 UTF-8 BOM으로 현재 검색 결과 전체를 내보내며, 버튼은 목록 상단에 둔다. 기존 관리자 권한만 허용하고 일반 사용자는 버튼과 API 접근 모두 거부한다. 새 의존성은 추가하지 않는다. 검색 결과 3건이면 헤더와 3행이 나오고 한글이 Excel에서 깨지지 않는 테스트를 통과한다."
const completeNotice = "[사용자 확정] 작업 실패 시 앱 내 알림을 작업 소유자에게 1회 보낸다. 재시도 중 중복 알림은 보내지 않는다. 이메일과 팀 전체 전송은 범위 밖이다. 실패1회→소유자 알림1건, 성공→0건, 재시도→중복0건 테스트로 검증한다."
const topology = "brownfield\n- export: 고객 목록 CSV 내보내기\n- notifications: 작업 실패 알림"
const base = (active: string, transcript: string, used = 2) => section("REQUEST", request) + section("PROJECT TYPE", "brownfield") +
  section("TOPOLOGY", topology) + section("TASK AGENDAS", topology) + section("ACTIVE AGENDA", active) +
  section("QUESTION BUDGET", `${used}/12 used; at most 2 questions per agenda. Caps, not targets.`) +
  section("TRANSCRIPT", transcript) + section("RECORDED EVIDENCE", "[제공된 코드 근거] 기존 CSV 유틸, 관리자 권한 검사, 앱 내 알림 API와 테스트 러너가 이미 존재한다. 파일을 직접 읽었다고 주장하지 말 것.")
const full = `${completeExport}\n${completeNotice}`
const cases = [
  { id: "export-scope", stage: "question", prompt: DI_QUESTION_PROMPT,
    expected: "CSV의 현재 페이지/검색 결과 전체 중 내보낼 범위만 질문. 확정된 인코딩/버튼/권한을 재질문하지 않음. 한국어 단일 결정과 짧은 선택지.",
    context: base("export: 고객 목록 CSV 내보내기", "[사용자 확정] UTF-8 BOM, 목록 상단 버튼, 관리자만 접근, 새 의존성 없음. [미결정] 현재 페이지와 검색 결과 전체 중 내보낼 데이터 범위.") + section("WEAKEST DIMENSION", "goal") },
  { id: "notification-recipient", stage: "question", prompt: DI_QUESTION_PROMPT,
    expected: "notifications의 수신자(소유자/팀)만 질문. export나 확정된 앱내채널/발송횟수 재질문 금지.",
    context: base("notifications: 작업 실패 알림", completeExport + "\n[사용자 확정] 앱 내 알림, 실패1회당1건, 재시도 중복 없음. [미결정] 소유자에게만 보낼지 팀 구성원 모두에게 보낼지.") + section("WEAKEST DIMENSION", "constraints") },
  { id: "reuse-prior-answer", stage: "question", prompt: DI_QUESTION_PROMPT,
    expected: "이미 답한 검색 결과 전체 범위를 다시 묻지 않고, 관리자 전용 여부 한 결정만 질문.",
    context: base("export: 고객 목록 CSV 내보내기", "Round1 Q: 현재 페이지와 검색 결과 전체 중 어느 범위를 원하세요? A: 검색 결과 전체입니다. UTF-8 BOM과 목록 상단 버튼도 확정합니다. [유일한 미결정] 내보내기를 관리자만 사용할지 모든 로그인 사용자가 사용할지.") + section("WEAKEST DIMENSION", "constraints") },
  { id: "closure-target-b", stage: "closure", prompt: DI_CLOSURE_PROMPT,
    expected: "pass=false, agenda_ids=[notifications]. export를 재개하지 않음.",
    context: base("Whole-interview audit", completeExport + "\n[사용자 확정] 실패 시 앱 내 알림1회, 중복없음. [명시적 미결정] 소유자 또는 팀 전체 수신 여부는 아직 결정하지 못했다.") },
  { id: "closure-ready", stage: "closure", prompt: DI_CLOSURE_PROMPT,
    expected: "pass=true, gaps=[], agenda_ids=[]. 확정한 범위 밖 구현 세부사항을 결함으로 만들지 않음.", context: base("Whole-interview audit", full) },
  { id: "budget-is-not-consent", stage: "closure", prompt: DI_CLOSURE_PROMPT,
    expected: "예산 소진만으로 pass=true로 판단하지 않음. 알림 수신 대상·접근 범위 미결정으로 notifications만 지목.",
    context: base("Whole-interview audit", completeExport + "\n[사용자] 알림 수신 대상과 공개 범위를 아직 정하지 못했습니다. 두 아젠다 모두 질문을 2회씩 사용했고 아젠다별 예산 2/2가 소진됐습니다(총 4/12). 답하지 않은 것을 동의로 취급하지 마세요.", 4) },
  { id: "short-answer-keeps-clarity", stage: "scoring", prompt: DI_SCORER_PROMPT,
    expected: "export의 충분한 이전 근거 유지, 모호성<=.20. 짧은 '네' 때문에 점수를 초기화하거나 미완료 알림과 혼동하지 않음.",
    context: base("export: 고객 목록 CSV 내보내기", completeExport + "\nRound2 Q: 방금 정한 기준을 수용 테스트로 사용하나요? A: 네.\n[다른 아젠다] notifications 수신자는 아직 미결정이다.") },
  { id: "panel-no-invented-work", stage: "panel", prompt: DI_PANEL_PROMPTS.simplifier,
    expected: "No material finding 또는 동일 의미. 새로운 사람의 결정을 강요하거나 확정 범위를 바꾸지 않음.", context: base("export: 고객 목록 CSV 내보내기", full) },
  { id: "task-not-technical-layers", stage: "topology", prompt: DI_TOPOLOGY_PROMPT,
    expected: "CSV 내보내기와 실패 알림의 두 사용자 작업으로 구분. UI/API/DB/테스트 등을 별도 의사결정 아젠다로 늘리지 않음. brownfield.",
    context: section("REQUEST", request + " 기존 앱에 이 두 기능을 추가합니다. UI, API, 권한 검사와 테스트까지 각 기능에 포함합니다. 저장소 내용은 이 입력으로만 평가하세요.") },
  { id: "justified-recommendation", stage: "question", prompt: DI_QUESTION_PROMPT,
    expected: "정보 노출 최소화라는 사용자 우선순위에 근거해 소유자 전용을 추천할 수 있음. 추천된 선택지는 소유자 전용이고 강제 동의로 취급하지 않음.",
    context: base("notifications: 작업 실패 알림", completeExport + "\n[사용자 확정] 앱 내 알림, 실패1회당1건, 재시도 중복 없음. [사용자 우선순위] 정보 노출 범위를 최소화하는 쪽을 선호합니다. 소유자와 팀 전체 중 최종 수신 대상을 질문하되 이 우선순위에 맞는 선택지도 추천해주세요.") + section("WEAKEST DIMENSION", "constraints") },
] as const

const selected = cases.filter(scenario => !onlyCase || scenario.id === onlyCase)
if (selected.length === 0) { console.error(`unknown case: ${onlyCase}`); process.exit(2) }
const results: unknown[] = []
const report = { model, startedAt: new Date().toISOString(), repeats, transport: "production createCliTransport/local, --think=false", results }
writeFileSync(output, JSON.stringify(report, null, 2))
let failures = 0
for (let repeat = 1; repeat <= repeats; repeat++) for (const scenario of selected) {
  const start = performance.now()
  const text = scenario.prompt.text + scenario.context
  const response = await createCliTransport({ engine: "local", model, prompt: text, deadlineAt: Date.now() + 90_000, maxOutputBytes: 32_000 }).run()
  const unfenced = response.text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1")
  const parsed = parseStageEventsFor(unfenced, "deep-interview", scenario.stage)
  const event = parsed.ok && parsed.events.length === 1 ? parsed.events[0] : undefined
  const checks: Record<string, boolean> = { completed: response.status === "completed" && response.quiescent, validEvent: !!event }
  if (scenario.stage === "question") {
    checks.singleQuestion = event?.type === "question" && (event.text.match(/[?？]/gu)?.length ?? 0) <= 1
    checks.onlySupportedOptions = event?.type === "question" && event.options?.length === 2 &&
      (scenario.id === "justified-recommendation" ? event.recommended !== undefined && /소유자/u.test(event.options[event.recommended] ?? "") && !/팀/u.test(event.options[event.recommended] ?? "") : event.recommended === undefined)
    checks.koreanQuestion = event?.type === "question" && /[가-힣]/u.test(event.text)
  }
  if (scenario.id === "closure-ready") checks.expectedClosure = event?.type === "closure" && event.pass && event.gaps.length === 0 && event.agenda_ids?.length === 0
  if (scenario.id === "closure-target-b" || scenario.id === "budget-is-not-consent") checks.expectedClosure = event?.type === "closure" && !event.pass && event.gaps.length > 0 && JSON.stringify(event.agenda_ids) === '["notifications"]'
  if (event?.type === "closure" && !event.pass) checks.koreanGaps = event.gaps.every(gap => /[가-힣]/u.test(gap))
  if (scenario.id === "budget-is-not-consent") checks.bothUnresolvedDecisions = event?.type === "closure" && /수신|대상/u.test(event.gaps.join(" ")) && /공개|열람|노출|접근/u.test(event.gaps.join(" "))
  if (scenario.id === "short-answer-keeps-clarity") checks.sufficientClarity = event?.type === "score" && event.context !== undefined && ambiguityOf("brownfield", event) <= 0.2
  if (scenario.id === "task-not-technical-layers") checks.twoTasks = event?.type === "topology" && event.project === "brownfield" && event.components.length === 2
  const pass = Object.values(checks).every(Boolean)
  if (!pass) failures++
  results.push({ id: scenario.id, repeat, expected: scenario.expected, promptSha: scenario.prompt.sha256, input: text,
    response, parsed, checks, structuralPass: pass, elapsedMs: Math.round(performance.now() - start) })
  writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ id: scenario.id, repeat, checks, elapsedMs: Math.round(performance.now() - start), response: response.text }))
}
console.log(JSON.stringify({ cases: results.length, structuralFailures: failures, output, semanticReviewRequired: true }))
process.exitCode = failures ? 1 : 0
