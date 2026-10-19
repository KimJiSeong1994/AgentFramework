#!/usr/bin/env bun
// Held-out routing evaluation for automatic skill selection (docs/lca-auto-skill-2026-10-18.md, phase 0).
// Runs the production selector (lexical prefilter + one choice judgment + thresholds) over a labeled fixture with the
// live judging engine: `--engine auto|claude|codex` (default auto, the same Claude/Codex CLI classifier as memory
// recall) or `jev` (the loopback OpenJev server at --endpoint). Candidates are the real discovered skills (name + description only) of
// this repository and the operator home, minus Codex/Claude import-tier skills unless --include names them. Routing
// telemetry goes to a scratch state root, never the operator's. Exit 0 = gate met, 1 = gate missed, 2 = usage/setup.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_CONFIG } from "../framework/src/config.ts"
import { AUTO_MIN_MARGIN, AUTO_MIN_PROBABILITY, AUTO_SELECT_BACKOFF_MS, AUTO_SELECT_TIMEOUT_MS, createAutoSkillSelector } from "../framework/src/routing/router.ts"
import { discoverSkills, resolveSkillRoots, skillRootTier } from "../framework/src/skills/roots.ts"

const ROOT = resolve(import.meta.dir, "..")
const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: join(ROOT, "scripts/fixtures/skill-route/labeled.jsonl") },
    engine: { type: "string", default: "auto" },
    model: { type: "string" },
    endpoint: { type: "string", default: DEFAULT_CONFIG.skill_router.endpoint },
    "timeout-ms": { type: "string", default: String(DEFAULT_CONFIG.skill_router.timeout_ms) },
    // Accuracy can be measured on a slow server by waiting longer; the latency gate still uses --timeout-ms.
    "measure-timeout-ms": { type: "string" },
    include: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    // Append each result here and skip cases already recorded, so a long run on a slow server can resume.
    journal: { type: "string" },
  },
})

type Case = { text: string; expect: string; category: string }
// Latency gate = the selector's own timeout: a CLI judgment (a few seconds) only ranks the intent offer.
const GATE = { precision: 0.95, noneFalsePositive: 0.02, p95Ms: AUTO_SELECT_TIMEOUT_MS }

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

async function main(): Promise<number> {
  const cases = readFileSync(values.fixture!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Case)
  const roots = await resolveSkillRoots({ projectRoot: ROOT, homeDirectory: homedir() })
  const discovery = await discoverSkills(roots)
  const include = new Set(values.include)
  const candidates = discovery.descriptors.flatMap((descriptor) => {
    if (descriptor.kind !== "skill") return []
    const tier = skillRootTier(descriptor)
    return tier === "native" || (tier === "import" && include.has(descriptor.name)) ? [{ name: descriptor.name, description: descriptor.description }] : []
  })
  const names = new Set(candidates.map((candidate) => candidate.name))
  const unknown = [...new Set(cases.map((c) => c.expect))].filter((name) => name !== "none" && !names.has(name))
  if (unknown.length) {
    process.stderr.write(`fixture labels are not discovered candidates: ${unknown.join(", ")}\n`)
    return 2
  }

  const scratch = mkdtempSync(join(tmpdir(), "otter-route-eval-"))
  const previousState = process.env.OTTER_STATE_HOME
  process.env.OTTER_STATE_HOME = scratch
  try {
    const config = structuredClone(DEFAULT_CONFIG)
    config.skill_router = {
      ...config.skill_router, endpoint: values.endpoint!, timeout_ms: Number(values["timeout-ms"]),
    }
    if (!["auto", "claude", "codex", "jev"].includes(values.engine!)) { process.stderr.write("--engine must be auto, claude, codex or jev\n"); return 2 }
    config.memory = {
      ...config.memory, engine: values.engine as typeof config.memory.engine,
      ...(values.model ? { model: values.model } : {}),
    }
    // A clock that jumps past every cooldown disables the runtime failure backoff: every case must reach the server.
    let clock = 0
    const measurementTimeoutMs = values["measure-timeout-ms"] === undefined ? undefined : Number(values["measure-timeout-ms"])
    const selector = createAutoSkillSelector({ directory: ROOT, worktree: ROOT, config, log: () => {} }, {
      now: () => (clock += AUTO_SELECT_BACKOFF_MS),
      ...(measurementTimeoutMs === undefined ? {} : { measurementTimeoutMs }),
    })
    type Row = Case & { index: number; skill: string | null; reason: string; elapsedMs: number }
    const recorded = new Map<number, Row>()
    if (values.journal && existsSync(values.journal)) {
      for (const line of readFileSync(values.journal, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as Row
        // Transport failures are not results: a resumed run measures them again.
        if (cases[row.index]?.text === row.text && row.reason !== "aborted" && row.reason !== "unavailable") recorded.set(row.index, row)
      }
    }
    const rows: Row[] = []
    for (const [index, item] of cases.entries()) {
      const prior = recorded.get(index)
      if (prior) { rows.push(prior); continue }
      const started = performance.now()
      const result = await selector.select({ sessionID: "route-eval", messageID: `case-${index}`, text: item.text, mode: "shadow", candidates })
      const row: Row = { ...item, index, skill: result.skill, reason: result.reason, elapsedMs: Math.round(performance.now() - started) }
      rows.push(row)
      if (values.journal) appendFileSync(values.journal, JSON.stringify(row) + "\n")
      process.stderr.write(`${index + 1}/${cases.length} ${item.expect} -> ${result.skill ?? `none(${result.reason})`}\n`)
    }

    const picked = rows.filter((row) => row.skill !== null)
    const correct = picked.filter((row) => row.skill === row.expect)
    // Only answered cases measure accuracy; a timeout is neither a correct abstention nor a false positive.
    const answered = (row: Row) => row.reason !== "aborted" && row.reason !== "unavailable"
    const noneCases = rows.filter((row) => row.expect === "none" && answered(row))
    const positives = rows.filter((row) => row.expect !== "none")
    const latencies = rows.filter((row) => !["input_bound", "sensitive_input"].includes(row.reason)).map((row) => row.elapsedMs).sort((a, b) => a - b)
    const reasons = Object.fromEntries([...new Set(rows.map((row) => row.reason))].map((reason) => [reason, rows.filter((row) => row.reason === reason).length]))
    const metrics = {
      cases: rows.length,
      candidates: candidates.map((candidate) => candidate.name),
      picked: picked.length,
      precision: picked.length ? correct.length / picked.length : 1,
      noneAnswered: noneCases.length,
      noneFalsePositive: noneCases.filter((row) => row.skill !== null).length / Math.max(1, noneCases.length),
      adversarialFalsePositive: rows.filter((row) => row.category === "adversarial" && row.skill !== null).length / Math.max(1, rows.filter((row) => row.category === "adversarial").length),
      recall: positives.filter((row) => row.skill === row.expect).length / Math.max(1, positives.length),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      reasons,
      thresholds: { minProbability: AUTO_MIN_PROBABILITY, minMargin: AUTO_MIN_MARGIN, timeoutMs: AUTO_SELECT_TIMEOUT_MS },
      engine: values.engine, ...(values.model ? { model: values.model } : {}),
      measurementTimeoutMs: measurementTimeoutMs ?? null,
    }
    const gate = {
      precision: metrics.precision >= GATE.precision,
      noneFalsePositive: noneCases.length > 0 && metrics.noneFalsePositive <= GATE.noneFalsePositive,
      p95Ms: metrics.p95Ms <= GATE.p95Ms,
      // A selector that never picks trivially passes precision; require it to actually route something.
      nonTrivial: picked.length > 0,
      // Timeouts and server errors are not abstentions; any of them makes the run unmeasured.
      transportHealthy: rows.every((row) => row.reason !== "unavailable" && row.reason !== "aborted"),
    }
    const passed = Object.values(gate).every(Boolean)
    const errors = rows.filter((row) => (row.skill ?? "none") !== row.expect)
      .map(({ text, expect, skill, reason }) => ({ text, expect, skill, reason }))
    const report = { schema: "otter-skill-route-eval.v1", recordedAt: new Date().toISOString(), gateTarget: GATE, gate, passed, metrics, errors }
    if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n")
    process.stdout.write(JSON.stringify({ passed, gate, metrics }, null, 2) + "\n")
    return passed ? 0 : 1
  } finally {
    if (previousState === undefined) delete process.env.OTTER_STATE_HOME
    else process.env.OTTER_STATE_HOME = previousState
    rmSync(scratch, { recursive: true, force: true })
  }
}

process.exit(await main())
