#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  FAMILY_TABLE,
  classify,
  expectedSnapshotPath,
  materializeArgv,
  readSupervisorBinding,
  supervisorBindingSha256,
  validateGrammar,
  verifyTail,
} from "./lca-soak-supervisor.ts"
import type { Family, ManifestLine } from "./lca-soak-supervisor.ts"

const MAX_RECEIPT_BYTES = 16 * 1024 * 1024

export type ManifestCheck = { ok: boolean; unexpected: number; problems: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function snapshotFile(evidenceDir: string, relativePath: string, problems: string[]): { bytes: Buffer; receipt: unknown } | null {
  const path = join(evidenceDir, ...relativePath.split("/"))
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch {
    problems.push(`referenced snapshot is missing: ${relativePath}`)
    return null
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400 || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES) {
    problems.push(`snapshot is not a bounded immutable regular file: ${relativePath}`)
    return null
  }
  const bytes = readFileSync(path)
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const parsed = JSON.parse(text) as unknown
    return { bytes, receipt: isRecord(parsed) ? parsed : {} }
  } catch {
    // A digest-matched but malformed receipt is unexpected operational evidence, not a missing file.
    return { bytes, receipt: {} }
  }
}

function checkSnapshotTree(evidenceDir: string, expectedPaths: Set<string>, problems: string[]): void {
  const root = join(evidenceDir, "snapshots")
  let rootStat: ReturnType<typeof lstatSync>
  try { rootStat = lstatSync(root) } catch {
    problems.push("snapshots directory is missing")
    return
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
    problems.push("snapshots directory is not a private regular directory")
    return
  }
  const expectedByLineage = new Map<string, Set<string>>()
  for (const path of expectedPaths) {
    const [directory, file] = path.slice("snapshots/".length).split("/")
    if (!directory || !file) {
      problems.push(`invalid snapshot path: ${path}`)
      continue
    }
    const files = expectedByLineage.get(directory) ?? new Set<string>()
    files.add(file)
    expectedByLineage.set(directory, files)
  }
  const actualDirectories = readdirSync(root).sort()
  for (const directory of actualDirectories) {
    const expectedFiles = expectedByLineage.get(directory)
    if (!expectedFiles) {
      problems.push(`unreferenced snapshot directory: ${directory}`)
      continue
    }
    const path = join(root, directory)
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(path) } catch {
      problems.push(`snapshot directory disappeared: ${directory}`)
      continue
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      problems.push(`snapshot lineage path is not a private directory: ${directory}`)
      continue
    }
    for (const file of readdirSync(path).sort()) {
      if (!expectedFiles.has(file)) problems.push(`unreferenced snapshot file: ${directory}/${file}`)
    }
    for (const file of expectedFiles) {
      if (!readdirSync(path).includes(file)) problems.push(`referenced snapshot file is missing: ${directory}/${file}`)
    }
  }
  for (const directory of expectedByLineage.keys()) {
    if (!actualDirectories.includes(directory)) problems.push(`referenced snapshot directory is missing: ${directory}`)
  }
}

function checkEvidenceRoot(evidenceDir: string, problems: string[]): void {
  const expected = new Set(["soak-manifest.jsonl", "soak-manifest.anchor", "soak-binding.json", "snapshots"])
  try {
    const stat = lstatSync(evidenceDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) problems.push("evidence directory is not private and canonical")
  } catch { problems.push("evidence directory is not available") }
  let entries: string[]
  try { entries = readdirSync(evidenceDir).sort() } catch {
    problems.push("evidence directory cannot be listed")
    return
  }
  for (const entry of entries) {
    if (entry === "soak.lock") problems.push("supervisor lock is still present")
    else if (!expected.has(entry)) problems.push(`unrecognized evidence entry: ${entry}`)
  }
  for (const entry of expected) if (!entries.includes(entry)) problems.push(`evidence entry is missing: ${entry}`)
}

function lineMap(lines: ManifestLine[], event: string, lineage: string): ManifestLine[] {
  return lines.filter(line => line.event === event && line.lineage === lineage)
}

function validateResumeLinks(
  lineage: ManifestLine,
  starts: ManifestLine[],
  ends: ManifestLine[],
  receipts: Map<number, unknown | null>,
  problems: string[],
): void {
  if (starts.length === 0) return
  const family = lineage.family as Family
  const firstReceipt = receipts.get(1)
  const firstParent = isRecord(firstReceipt) && isRecord(firstReceipt.nativeSessionIDs)
    ? firstReceipt.nativeSessionIDs.parentSessionID
    : undefined
  for (const start of starts) {
    const index = start.invocationIndex as number
    if (index === 1) {
      if (start.parentSessionID !== null) problems.push(`initial invocation must not predeclare a parent session: ${String(lineage.lineage)}`)
      continue
    }
    if (start.scenario !== "resume" || !firstParent || start.parentSessionID !== firstParent) {
      problems.push(`resume is not linked to invocation 1's parent session: ${String(lineage.lineage)} invocation ${index}`)
    }
    const receipt = receipts.get(index)
    const resumedParent = isRecord(receipt) && isRecord(receipt.nativeSessionIDs) ? receipt.nativeSessionIDs.parentSessionID : undefined
    if (typeof firstParent === "string" && typeof resumedParent === "string" && resumedParent !== firstParent) {
      problems.push(`resume snapshot parent session does not match invocation 1: ${String(lineage.lineage)} invocation ${index}`)
    }
  }
  const expected = FAMILY_TABLE[family].invocationCount
  if (starts.length !== expected || ends.length !== expected) {
    // A recorded failed invocation may intentionally stop a linked lineage; the outcome remains unexpected.
    const failed = ends.some(end => !["pass", "expected-fail-closed"].includes(String(end.outcome)))
    if (!failed) problems.push(`lineage does not contain all ${expected} linked invocations: ${String(lineage.lineage)}`)
  }
}

function inspectManifest(evidenceDir: string): ManifestCheck {
  const problems: string[] = []
  const tail = verifyTail(evidenceDir)
  if (!tail.ok) return { ok: false, unexpected: 0, problems: tail.problems }
  const grammar = validateGrammar(tail.lines)
  problems.push(...grammar.problems)
  checkEvidenceRoot(evidenceDir, problems)
  let binding: ReturnType<typeof readSupervisorBinding> | null = null
  try { binding = readSupervisorBinding(evidenceDir) }
  catch { problems.push("immutable run binding is missing or invalid") }
  const supervisorStart = tail.lines[0]
  if (!supervisorStart || supervisorStart.event !== "supervisor-start" || !binding ||
    supervisorStart.bindingSha256 !== (binding ? supervisorBindingSha256(binding.binding) : null)) {
    problems.push("supervisor-start does not authenticate the immutable run binding")
  }
  if (binding) {
    const provisioning = tail.lines.filter(line => line.event === "provision-start")
    const provisionEnds = tail.lines.filter(line => line.event === "provision-end")
    if (provisioning.length > binding.binding.fixtures.provisioning.length ||
      provisioning.some((line, index) => line.vm !== binding!.binding.fixtures.provisioning[index]?.vm) ||
      provisionEnds.some((line, index) => line.vm !== binding!.binding.fixtures.provisioning[index]?.vm)) {
      problems.push("provisioning events differ from the immutable run binding")
    }
    if (!grammar.provisionFailed && (provisioning.length !== binding.binding.fixtures.provisioning.length ||
      provisionEnds.length !== binding.binding.fixtures.provisioning.length || provisionEnds.some(line => line.outcome !== "ok"))) {
      problems.push("completed workload did not follow every bound provisioning command")
    }
  }

  const expectedSnapshots = new Set<string>()
  const lineageStarts = tail.lines.filter(line => line.event === "lineage-start")
  for (const lineageStart of lineageStarts) {
    const lineage = String(lineageStart.lineage)
    const family = lineageStart.family as Family
    const fixture = binding?.binding.fixtures.lineages.find(spec => spec.lineage === lineage)
    if (!fixture || lineageStart.family !== fixture.family || lineageStart.repetition !== fixture.repetition ||
      lineageStart.fixtureID !== fixture.fixtureID || lineageStart.fixtureTree !== fixture.fixtureTree) {
      problems.push(`lineage identity differs from the immutable run binding: ${lineage}`)
    }
    const starts = lineMap(tail.lines, "invocation-start", lineage)
    const ends = lineMap(tail.lines, "invocation-end", lineage)
    const receipts = new Map<number, unknown | null>()
    for (const start of starts) {
      const index = start.invocationIndex as number
      const end = ends.find(line => line.invocationIndex === index)
      const invocationSpec = fixture?.invocations[index - 1]
      if (!invocationSpec || start.scenario !== invocationSpec.scenario) {
        problems.push(`invocation scenario differs from the immutable run binding: ${lineage} invocation ${index}`)
      }
      if (invocationSpec) {
        const firstReceipt = receipts.get(1)
        const firstParent = isRecord(firstReceipt) && isRecord(firstReceipt.nativeSessionIDs)
          ? firstReceipt.nativeSessionIDs.parentSessionID
          : null
        try {
          const argv = materializeArgv(invocationSpec, index === 1 ? null : typeof firstParent === "string" ? firstParent : null)
          const argvSha256 = sha256(Buffer.from(JSON.stringify(argv)))
          if (start.argvSha256 !== argvSha256) problems.push(`invocation argv hash differs from immutable run binding: ${lineage} invocation ${index}`)
        } catch {
          problems.push(`invocation effective argv cannot be reconstructed from immutable run binding: ${lineage} invocation ${index}`)
        }
        if (index === 1 ? start.parentSessionID !== null :
          typeof firstParent !== "string" || start.parentSessionID !== firstParent) {
          problems.push(`invocation parent session differs from immutable run binding: ${lineage} invocation ${index}`)
        }
      }
      if (!end) continue
      const requiredPath = expectedSnapshotPath(lineage, index)
      if (end.snapshotPath !== requiredPath) {
        problems.push(`invocation snapshot path is not unique and canonical: ${lineage} invocation ${index}`)
        continue
      }
      let receipt: unknown | null = null
      const hasDigest = typeof end.snapshotSha256 === "string"
      if (hasDigest) {
        expectedSnapshots.add(requiredPath)
        const snapshot = snapshotFile(evidenceDir, requiredPath, problems)
        if (snapshot) {
          if (sha256(snapshot.bytes) !== end.snapshotSha256) problems.push(`snapshot digest mismatch: ${requiredPath}`)
          receipt = snapshot.receipt
        }
      } else {
        const path = join(evidenceDir, ...requiredPath.split("/"))
        try {
          lstatSync(path)
          problems.push(`unreferenced snapshot exists without a manifest digest: ${requiredPath}`)
        } catch { /* No snapshot is the recorded snapshot-missing case. */ }
      }
      receipts.set(index, receipt)
      const errorNames = end.errorNames as string[]
      const orderedTermination = end.orderedTermination as boolean
      const recomputed = classify({
        family,
        invocationIndex: index,
        scenario: start.scenario as "resume" | Family,
        exit: end.exit as { code: number | null; signal: string | null },
        receipt,
        ...(invocationSpec ? { receiptPath: invocationSpec.receiptPath } : {}),
        expectedInjection: end.expectedInjection as string | null,
        errorNames,
        orderedTermination,
      })
      if (recomputed !== end.outcome) problems.push(`recorded outcome disagrees with snapshot assertions: ${lineage} invocation ${index}`)
    }
    validateResumeLinks(lineageStart, starts, ends, receipts, problems)
  }

  checkSnapshotTree(evidenceDir, expectedSnapshots, problems)
  const unexpected = grammar.unexpected
  if (grammar.complete) {
    const end = tail.lines.at(-1)
    if (end?.event === "supervisor-end" && end.unexpected !== unexpected) problems.push("supervisor-end unexpected count disagrees with checker")
  }
  return { ok: problems.length === 0 && unexpected === 0, unexpected, problems }
}

export function checkManifest(evidenceDir: string): ManifestCheck {
  try { return inspectManifest(evidenceDir) }
  catch { return { ok: false, unexpected: 0, problems: ["manifest inspection failed safely"] } }
}

function main(argv: string[]): void {
  if (argv.length !== 2 || argv[0] !== "--check" || !argv[1]!.startsWith("/")) {
    console.error("usage: bun scripts/lca-soak-manifest.ts --check ABS_EVIDENCE_DIR")
    process.exitCode = 2
    return
  }
  const result = checkManifest(argv[1]!)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.problems.length > 0 ? 2 : result.unexpected > 0 ? 3 : 0
}

if (import.meta.main) main(process.argv.slice(2))
