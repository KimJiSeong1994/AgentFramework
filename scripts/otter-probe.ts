#!/usr/bin/env bun
// Same-task probes (harness2-inspired), script-first. Nothing here approves, merges or adopts anything by itself:
//   propose  two read-only proposer turns (INV, DOM) -> subject.json; prints the subject sha and the overlays
//   approve  write-once receipt bound to the exact subject sha (any byte change needs a new approval)
//   run      k unmodified bases + each overlay, one isolated worktree each, sequential; checkout untouched
//   show     contrast table (facts per run; a pass does not show that an overlay caused it)
//   apply    apply exactly one probe's diff to the checkout (human decision)   |   discard  remove the worktrees
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig } from "../framework/src/config.ts"
import { createCliRuntime } from "../framework/src/hosts/cli-runtime.ts"
import { readCombo, validateComboRoutes } from "../framework/src/hosts/default-model.ts"
import type { ComboRoutes } from "../framework/src/hosts/types.ts"
import { applyProbe, discardProbes, proposeProbe, reflectProbes, runProbes, showProbe, type ProbeRoutes } from "../framework/src/harness/probe-flow.ts"
import { renderContrast, writeApproval, loadSubject, PROBE_LIMITS } from "../framework/src/harness/probe.ts"
import * as lessons from "../framework/src/harness/lessons.ts"
import type { ProbeRun } from "../framework/src/harness/types.ts"

const USAGE = [
  "Usage: bun scripts/otter-probe.ts <command> [options]   (run from the repository to probe, or pass --worktree DIR)",
  "  propose --task TITLE --detail TEXT --verify CMD [--k 2] --engine local|codex|claude --model ID",
  "  approve --wid ID --sha SUBJECT_SHA",
  "  run     --wid ID",
  "  show    --wid ID",
  "  apply   --wid ID LABEL        (LABEL: base1.. | inv | dom; applies that probe's diff to your checkout)",
  "  discard --wid ID              (removes the probe worktrees; records stay)",
  "Each probe is one worker session plus one verify command. No model chooses or applies anything.",
].join("\n")

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

const [command, ...rest] = process.argv.slice(2)
if (!command || !["propose", "approve", "run", "show", "apply", "discard"].includes(command)) fail(`${command ? `Unknown command: ${command}\n` : ""}${USAGE}`, 2)

let parsed: ReturnType<typeof parseArgs>
try {
  parsed = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      worktree: { type: "string" }, task: { type: "string" }, detail: { type: "string" }, verify: { type: "string" }, k: { type: "string" },
      engine: { type: "string" }, model: { type: "string" }, wid: { type: "string" }, sha: { type: "string" },
    },
  })
} catch (error) {
  fail(`${(error as Error).message}\n${USAGE}`, 2)
}
const { values, positionals } = parsed
const worktree = resolve(values.worktree ?? process.cwd())
const wid = values.wid as string | undefined
const need = (name: string, value: string | undefined): string => value ?? fail(`--${name} is required\n${USAGE}`, 2)

function comboFor(engine: string, model: string): ComboRoutes {
  const lookup = readCombo(worktree)
  if (lookup.state === "invalid") fail(`combo is invalid: ${lookup.reason}`)
  if (lookup.state === "unset") return {}
  const checked = validateComboRoutes(lookup.routes)
  if (typeof checked === "string") fail(checked)
  return Object.fromEntries(Object.entries(checked).filter(([, route]) => route.engine !== engine || route.model !== model)) as ComboRoutes
}

function runtimeFor(routes: ProbeRoutes) {
  return createCliRuntime({ worktree, engine: routes.engine as "local" | "codex" | "claude", model: routes.model, ...(Object.keys(routes.combo).length ? { routes: routes.combo } : {}) })
}

const abort = new AbortController()
process.on("SIGINT", () => abort.abort())
process.on("SIGTERM", () => abort.abort())

/** Newest lessons that fit the proposer's data bound; reference data for proposer turns only. */
function lessonsReference(): string {
  for (let limit = 8; limit >= 1; limit--) {
    const text = lessons.renderLessonsReference(lessons.readLessons(worktree, limit))
    if (text.length <= 4000) return text
  }
  return ""
}

try {
  if (command === "propose") {
    const engine = need("engine", values.engine)
    const model = need("model", values.model)
    if (!["local", "codex", "claude"].includes(engine)) fail("--engine must be local, codex or claude", 2)
    const k = values.k === undefined ? 2 : Number(values.k)
    const routes: ProbeRoutes = { engine, model, combo: comboFor(engine, model) }
    const result = await proposeProbe(runtimeFor(routes), {
      title: need("task", values.task), detail: need("detail", values.detail), verify: need("verify", values.verify), k, routes,
      lessons: lessonsReference(), signal: abort.signal,
    })
    for (const proposal of result.proposals) console.log(`${proposal.dimension}: ${proposal.status}${proposal.reason ? ` (${proposal.reason})` : ""}`)
    if (!result.subject) {
      console.log(`workflow ${result.wid}: no overlay survived validation (KEEP_BASE or invalid); no probe is spent.`)
    } else {
      const { body, sha } = result.subject
      console.log(`workflow ${result.wid}`)
      console.log(`subject sha ${sha}`)
      console.log(`probes: ${body.k} base + ${[body.overlays.inv ? "inv" : "", body.overlays.dom ? "dom" : ""].filter(Boolean).join(" + ")}; each is one worker session plus one verify (max ${PROBE_LIMITS.overlayBytes} bytes per overlay)`)
      for (const dim of ["inv", "dom"] as const) if (body.overlays[dim]) console.log(`\n[${dim}] ${body.overlays[dim]}`)
      console.log(`\nApprove with: bun scripts/otter-probe.ts approve --wid ${result.wid} --sha ${sha}`)
    }
  } else if (command === "approve") {
    const subject = loadSubject(worktree, need("wid", wid))
    const ref = writeApproval(worktree, subject, need("sha", values.sha))
    console.log(`approved ${subject.wid} ${subject.sha}\nreceipt ${ref}`)
  } else if (command === "run") {
    const subject = loadSubject(worktree, need("wid", wid))
    const runtime = runtimeFor(subject.body.routes as ProbeRoutes)
    const runs: ProbeRun[] = await runProbes(runtime, subject.wid, {
      signal: abort.signal,
      onRun: run => console.log(`${run.label}: ${run.valid ? (run.verify?.ok ? "verify ok" : "verify failed") : `invalid (${run.invalid})`}`),
    })
    console.log(`\n${renderContrast(runs)}`)
    // Single call site for the evidence-gated lessons ledger (S3): one read-only reflector turn, admission in code.
    const outcome = await reflectProbes(runtime, subject, runs, abort.signal)
    console.log(`\nlesson: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`)
    console.log(`Choose with: show / apply --wid ${subject.wid} LABEL / discard --wid ${subject.wid}`)
  } else if (command === "show") {
    const view = showProbe(worktree, need("wid", wid))
    console.log(`workflow ${view.subject.wid}  subject ${view.subject.sha}  approved: ${view.approved ? "yes" : "no"}`)
    console.log(`task: ${view.subject.body.task.title}\nverify: ${view.subject.body.task.verify}\n`)
    console.log(view.runs.length ? renderContrast(view.runs) : "(no probe has run yet)")
    console.log("\nA verify pass shows what the command did in that worktree; it does not show that an overlay caused it (one run per variant).")
  } else if (command === "apply") {
    if (positionals.length !== 1) fail(`apply requires exactly one LABEL\n${USAGE}`, 2)
    const config = loadConfig(worktree)
    const result = await applyProbe({ worktree, config }, need("wid", wid), positionals[0]!)
    if (!result.ok) fail(`apply refused for ${result.label}: ${result.reason}${result.patch ? ` (patch kept at ${result.patch})` : ""}`)
    console.log(`applied ${result.files.length} file(s) from ${result.label} to your checkout; that probe worktree was removed. Run discard to remove the others.`)
  } else {
    const removed = await discardProbes({ worktree, config: loadConfig(worktree) }, need("wid", wid))
    console.log(`removed ${removed.length} probe worktree(s)${removed.length ? `: ${removed.join(", ")}` : ""}`)
  }
} catch (error) {
  fail(`${command} failed: ${(error as Error).message}`)
}
