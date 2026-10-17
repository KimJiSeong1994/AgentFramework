#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { basename, isAbsolute, join } from "node:path"

const MANIFEST_NAME = "soak-manifest.jsonl"
const ANCHOR_NAME = "soak-manifest.anchor"
const LOCK_NAME = "soak.lock"
const BINDING_NAME = "soak-binding.json"
const SNAPSHOTS_NAME = "snapshots"
const MANIFEST_SCHEMA = "otter.soak-manifest.v2"
const LEGACY_MANIFEST_SCHEMA = "otter.soak-manifest.v1"
const FIXTURE_SCHEMA = "otter.soak-fixtures.v1"
const BINDING_SCHEMA = "otter.soak-binding.v1"
const ZERO_SHA256 = "0".repeat(64)
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const MAX_TIMEOUT_MS = 60 * 60_000
const MAX_FIXTURE_BYTES = 1_048_576
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024
const RECEIPT_TIMEOUT_MS = 30_000
const RECEIPT_DRAIN_AFTER_EXIT_MS = 250
const CHILD_SIGNAL_ESCALATION_MS = 1_000
const FAMILY_NAMES = ["success", "retry", "reject", "cancel", "verifier-cancel", "interrupt", "checkpoint", "active-verifier"] as const

export type Family = typeof FAMILY_NAMES[number]
export type InvocationScenario = Family | "resume"
export type InvocationOutcome = "pass" | "expected-fail-closed" | "unexpected-failure" | "killed" | "snapshot-missing"
export type ExitStatus = { code: number | null; signal: string | null }
export type ManifestLine = Record<string, unknown> & {
  schema: typeof MANIFEST_SCHEMA
  seq: number
  prevSha256: string
  at: string
  event: string
}

export const FAMILY_TABLE = Object.freeze({
  success: Object.freeze({ scenario: "success", expectedInjection: null, invocationCount: 1, expectedExitCode: 0 }),
  retry: Object.freeze({ scenario: "retry", expectedInjection: "retry-after-worker-fault", invocationCount: 1, expectedExitCode: 0 }),
  reject: Object.freeze({ scenario: "reject", expectedInjection: "review-reject-after-worker", invocationCount: 1, expectedExitCode: 0 }),
  cancel: Object.freeze({ scenario: "cancel", expectedInjection: "user-cancel-active-worker", invocationCount: 1, expectedExitCode: 0 }),
  "verifier-cancel": Object.freeze({ scenario: "verifier-cancel", expectedInjection: "cancel-active-native-verifier", invocationCount: 1, expectedExitCode: 0 }),
  interrupt: Object.freeze({ scenario: "interrupt", expectedInjection: "interrupt-after-second-worker-busy", invocationCount: 2, expectedExitCode: 137 }),
  checkpoint: Object.freeze({ scenario: "checkpoint", expectedInjection: "self-interrupt-after-task-checkpoint", invocationCount: 2, expectedExitCode: 137 }),
  "active-verifier": Object.freeze({ scenario: "active-verifier", expectedInjection: "self-interrupt-at-active-verifier-boundary", invocationCount: 3, expectedExitCode: 137 }),
} as const)

export type ProvisionSpec = { vm: "vm-c" | "vm-r"; cwd: string; argv: string[]; timeoutMs: number }
export type ResumeSessionSpec = { fromInvocationIndex: 1 }
export type InvocationSpec = {
  scenario: InvocationScenario
  cwd: string
  argv: string[]
  receiptPath: string
  expectedInjection: string | null
  timeoutMs: number
  resumeSession?: ResumeSessionSpec
}
export type LineageSpec = {
  lineage: string
  family: Family
  repetition: 1 | 2 | 3
  fixtureID: string
  fixtureTree: string
  invocations: InvocationSpec[]
}
export type FixtureManifest = {
  schema: typeof FIXTURE_SCHEMA
  version: 1
  provisioning: ProvisionSpec[]
  lineages: LineageSpec[]
}
export type SupervisorBinding = {
  schema: typeof BINDING_SCHEMA
  vmC: string
  fixtures: FixtureManifest
}
export type ReadSupervisorBinding = { binding: SupervisorBinding; sha256: string; bytes: Buffer }

export type TailVerification = {
  ok: boolean
  problems: string[]
  lines: ManifestLine[]
  seq: number
  lineSha256: string
  byteLength: number
  anchoredSeq: number
  oneLineAhead: boolean
}

export type GrammarVerification = {
  ok: boolean
  complete: boolean
  problems: string[]
  unexpected: number
  lineages: number
  provisionFailed: boolean
}

export type ClassificationInput = {
  family: Family
  invocationIndex: number
  scenario: InvocationScenario
  exit: ExitStatus
  receipt: unknown | null
  receiptPath?: string
  expectedInjection: string | null
  errorNames?: string[]
  orderedTermination?: boolean
}

function fail(message: string): never {
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function validHash(value: unknown, lengths: number[] = [64]): value is string {
  return typeof value === "string" && lengths.includes(value.length) && /^[a-f0-9]+$/.test(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value))
}

function requireSafeFile(path: string, label: string, mode?: number): ReturnType<typeof lstatSync> {
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { return fail(`${label} is missing`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
  if (mode !== undefined && (stat.mode & 0o777) !== mode) fail(`${label} has unexpected permissions`)
  return stat
}

function requireDirectory(path: string, label: string): import("node:fs").Stats {
  let stat: import("node:fs").Stats
  try { stat = lstatSync(path) } catch { return fail(`${label} is missing`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a directory, not a symlink`)
  return stat
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function isSessionID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)
}

function isAbsPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0") && !/[\r\n]/.test(value)
}

function isRemoteReceiptPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || /[\r\n]/.test(value)) return false
  return value.split("/").every(part => part !== "..")
}

function validateArgv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 || value.some(arg => typeof arg !== "string" || arg.length > 32_768 || arg.includes("\0"))) {
    fail(`${label} must be a bounded non-empty argv array of strings`)
  }
  if (value[0] === "") fail(`${label} must name an executable`)
  return value as string[]
}

function timeoutMs(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || (value as number) < 1_000 || (value as number) > MAX_TIMEOUT_MS) {
    fail(`${label} must be an integer from 1000 through ${MAX_TIMEOUT_MS}`)
  }
  return value as number
}

function optionValue(argv: string[], flag: string): string | undefined {
  const indexes = argv.flatMap((arg, index) => arg === flag ? [index] : [])
  if (indexes.length !== 1 || indexes[0]! + 1 >= argv.length) return undefined
  return argv[indexes[0]! + 1]
}

function validateInvocationArgv(invocation: InvocationSpec, lineage: string, index: number): void {
  const label = `${lineage} invocation ${index}`
  if (optionValue(invocation.argv, "--scenario") !== invocation.scenario) fail(`${label} argv must contain its exact --scenario value once`)
  if (optionValue(invocation.argv, "--receipt") !== invocation.receiptPath) fail(`${label} argv must contain its exact --receipt path once`)
  if (optionValue(invocation.argv, "--verifier") !== "linux-production") fail(`${label} argv must select linux-production explicitly`)
  const sessionFlags = invocation.argv.filter(arg => arg === "--session").length
  const sessionMarkers = invocation.argv.filter(arg => arg === "@otter-soak-parent-session").length
  if (invocation.scenario === "resume") {
    if (sessionFlags !== 1 || sessionMarkers !== 1 || optionValue(invocation.argv, "--session") !== "@otter-soak-parent-session" ||
      invocation.resumeSession?.fromInvocationIndex !== 1) {
      fail(`${label} resume must use the validated @otter-soak-parent-session argv value and source invocation 1`)
    }
  } else if (sessionFlags !== 0 || sessionMarkers !== 0 || invocation.resumeSession !== undefined) {
    fail(`${label} only resume may declare a parent session argument`)
  }
}

export function validateFixtureManifest(input: unknown): FixtureManifest {
  if (!isRecord(input) || !exactKeys(input, ["schema", "version", "provisioning", "lineages"]) ||
    input.schema !== FIXTURE_SCHEMA || input.version !== 1 || !Array.isArray(input.provisioning) || !Array.isArray(input.lineages)) {
    fail(`fixtures manifest must use ${FIXTURE_SCHEMA} version 1`)
  }
  if (input.provisioning.length < 1 || input.provisioning.length > 2) fail("fixtures manifest must have one or two explicit provisioning argv entries")
  const provisionVMs = new Set<string>()
  const provisioning = input.provisioning.map((raw, index): ProvisionSpec => {
    if (!isRecord(raw) || !exactKeys(raw, ["vm", "cwd", "argv", ...(raw.timeoutMs === undefined ? [] : ["timeoutMs"])]) ||
      (raw.vm !== "vm-c" && raw.vm !== "vm-r") || !isAbsPath(raw.cwd)) fail(`provisioning[${index}] has an invalid vm or absolute cwd`)
    if (provisionVMs.has(raw.vm)) fail(`provisioning vm ${raw.vm} is duplicated`)
    provisionVMs.add(raw.vm)
    return { vm: raw.vm, cwd: raw.cwd, argv: validateArgv(raw.argv, `provisioning[${index}].argv`), timeoutMs: timeoutMs(raw.timeoutMs, `provisioning[${index}].timeoutMs`) }
  })
  if (input.lineages.length !== 24) fail("fixtures manifest must contain exactly 24 lineages")
  const fixtureIDs = new Set<string>()
  const receiptPaths = new Set<string>()
  const expectedOrder = FAMILY_NAMES.flatMap(family => [1, 2, 3].map(repetition => `${family}-r${repetition}`))
  const lineages = input.lineages.map((raw, index): LineageSpec => {
    if (!isRecord(raw) || !exactKeys(raw, ["lineage", "family", "repetition", "fixtureID", "fixtureTree", "invocations"]) ||
      typeof raw.family !== "string" || !FAMILY_NAMES.includes(raw.family as Family) ||
      !Number.isInteger(raw.repetition) || (raw.repetition as number) < 1 || (raw.repetition as number) > 3 ||
      typeof raw.lineage !== "string" || typeof raw.fixtureID !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(raw.fixtureID) ||
      !validHash(raw.fixtureTree, [40, 64]) || !Array.isArray(raw.invocations)) {
      fail(`lineages[${index}] has an invalid identity or fixture tree ID`)
    }
    const family = raw.family as Family
    const repetition = raw.repetition as 1 | 2 | 3
    const lineage = `${family}-r${repetition}`
    if (raw.lineage !== lineage || expectedOrder[index] !== lineage) fail(`lineages must be ordered as the fixed 8-family x 3-repetition table (${lineage} expected at ${index + 1})`)
    if (fixtureIDs.has(raw.fixtureID)) fail(`fixtureID ${raw.fixtureID} must be unique across all 24 lineages`)
    fixtureIDs.add(raw.fixtureID)
    const policy = FAMILY_TABLE[family]
    if (raw.invocations.length !== policy.invocationCount) fail(`${lineage} must declare exactly ${policy.invocationCount} ordered invocations`)
    const rawInvocations = raw.invocations
    const invocations = rawInvocations.map((rawInvocation, invocationOffset): InvocationSpec => {
      const invocationIndex = invocationOffset + 1
      const isResume = invocationIndex > 1
      const allowedKeys = ["scenario", "cwd", "argv", "receiptPath", "expectedInjection", "timeoutMs", ...(isResume ? ["resumeSession"] : [])]
      if (!isRecord(rawInvocation) || !exactKeys(rawInvocation, allowedKeys.filter(key => key !== "timeoutMs").concat(rawInvocation.timeoutMs === undefined ? [] : ["timeoutMs"])) ||
        typeof rawInvocation.scenario !== "string" || !isAbsPath(rawInvocation.cwd) || !isRemoteReceiptPath(rawInvocation.receiptPath) ||
        !Array.isArray(rawInvocation.argv) || !(rawInvocation.expectedInjection === null || typeof rawInvocation.expectedInjection === "string")) {
        fail(`${lineage} invocation ${invocationIndex} has invalid fields`)
      }
      const scenario: InvocationScenario = invocationIndex === 1 ? policy.scenario : "resume"
      const expectedInjection = invocationIndex === 1 ? policy.expectedInjection : null
      if (rawInvocation.scenario !== scenario || rawInvocation.expectedInjection !== expectedInjection) {
        fail(`${lineage} invocation ${invocationIndex} does not match the fixed family scenario/injection table`)
      }
      if (isResume && (!isRecord(rawInvocation.resumeSession) || !exactKeys(rawInvocation.resumeSession, ["fromInvocationIndex"]) ||
        rawInvocation.resumeSession.fromInvocationIndex !== 1)) fail(`${lineage} resumeSession must reference invocation 1 explicitly`)
      const firstInvocation = rawInvocations[0]
      if (invocationOffset === 0) {
        if (receiptPaths.has(rawInvocation.receiptPath)) fail(`${lineage} must use an operational receipt path unique to its fresh fixture`)
        receiptPaths.add(rawInvocation.receiptPath)
      } else if (!isRecord(firstInvocation) || rawInvocation.receiptPath !== firstInvocation.receiptPath || rawInvocation.cwd !== firstInvocation.cwd) {
        fail(`${lineage} linked resumes must reuse the original operational receipt path and cwd`)
      }
      const invocation: InvocationSpec = {
        scenario,
        cwd: rawInvocation.cwd,
        argv: validateArgv(rawInvocation.argv, `${lineage} invocation ${invocationIndex}.argv`),
        receiptPath: rawInvocation.receiptPath,
        expectedInjection,
        timeoutMs: timeoutMs(rawInvocation.timeoutMs, `${lineage} invocation ${invocationIndex}.timeoutMs`),
        ...(isResume ? { resumeSession: rawInvocation.resumeSession as ResumeSessionSpec } : {}),
      }
      validateInvocationArgv(invocation, lineage, invocationIndex)
      return invocation
    })
    return { lineage, family, repetition, fixtureID: raw.fixtureID, fixtureTree: raw.fixtureTree, invocations }
  })
  return { schema: FIXTURE_SCHEMA, version: 1, provisioning, lineages }
}

export function createSupervisorBinding(vmC: string, fixtures: FixtureManifest): SupervisorBinding {
  return {
    schema: BINDING_SCHEMA,
    vmC: validateSshTarget(vmC),
    fixtures: validateFixtureManifest(fixtures),
  }
}

function bindingBytes(binding: SupervisorBinding): Buffer {
  return Buffer.from(`${JSON.stringify(binding)}\n`)
}

export function supervisorBindingSha256(binding: SupervisorBinding): string {
  return sha256(bindingBytes(binding))
}

function bindingPath(evidenceDir: string): string {
  return join(evidenceDir, BINDING_NAME)
}

function validateSupervisorBinding(value: unknown): SupervisorBinding {
  if (!isRecord(value) || !exactKeys(value, ["schema", "vmC", "fixtures"]) || value.schema !== BINDING_SCHEMA || typeof value.vmC !== "string") {
    fail(`run binding must use ${BINDING_SCHEMA}`)
  }
  return createSupervisorBinding(value.vmC, value.fixtures as FixtureManifest)
}

export function readSupervisorBinding(evidenceDir: string): ReadSupervisorBinding {
  const path = bindingPath(evidenceDir)
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(path) } catch { return fail("immutable run binding is missing") }
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o400 || before.nlink !== 1 || before.size > 2 * MAX_FIXTURE_BYTES) {
    fail("run binding is not a bounded immutable regular file")
  }
  if (typeof constants.O_NOFOLLOW !== "number") fail("platform does not support no-follow binding reads")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o400 || opened.nlink !== 1 || opened.size !== before.size) {
      fail("run binding changed during no-follow read")
    }
    bytes = readFileSync(fd)
  } finally { closeSync(fd) }
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    parsed = JSON.parse(text)
  } catch { return fail("run binding is invalid UTF-8 or JSON") }
  const binding = validateSupervisorBinding(parsed)
  if (!bindingBytes(binding).equals(bytes)) fail("run binding is not canonical normalized JSON")
  return { binding, sha256: sha256(bytes), bytes }
}

function validateManifestLine(value: unknown): value is ManifestLine {
  if (!isRecord(value) || value.schema !== MANIFEST_SCHEMA || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1 ||
    !validHash(value.prevSha256) || !validTimestamp(value.at) || typeof value.event !== "string" || Object.prototype.hasOwnProperty.call(value, "cause")) return false
  const event = value.event
  let fields: string[]
  switch (event) {
    case "supervisor-start": fields = ["budget", "bindingSha256"]; break
    case "supervisor-restart": fields = ["recoveredSeq"]; break
    case "provision-start": fields = ["vm"]; break
    case "provision-end": fields = ["vm", "outcome", "errorKind"]; break
    case "lineage-start": fields = ["lineage", "family", "repetition", "fixtureID", "fixtureTree"]; break
    case "invocation-start": fields = ["lineage", "invocationIndex", "scenario", "parentSessionID", "argvSha256"]; break
    case "invocation-end": fields = ["lineage", "invocationIndex", "exit", "snapshotPath", "snapshotSha256", "outcome", "expectedInjection", "errorNames", "orderedTermination"]; break
    case "lineage-end": fields = ["lineage", "outcome"]; break
    case "supervisor-end": fields = ["lineages", "unexpected"]; break
    default: return false
  }
  if (!exactKeys(value, ["schema", "seq", "prevSha256", "at", "event", ...fields])) return false
  if (event === "supervisor-start") {
    return isRecord(value.budget) && exactKeys(value.budget, ["maxVMs", "headroomGiB"]) && value.budget.maxVMs === 2 &&
      value.budget.headroomGiB === 20 && validHash(value.bindingSha256)
  }
  if (event === "supervisor-restart") return Number.isSafeInteger(value.recoveredSeq) && (value.recoveredSeq as number) >= 1
  if (event === "provision-start" || event === "provision-end") {
    if (value.vm !== "vm-c" && value.vm !== "vm-r") return false
    return event === "provision-start" || (value.outcome === "ok" && value.errorKind === null) ||
      (value.outcome === "failed" && ["exit-nonzero", "signal", "timeout", "spawn-error"].includes(String(value.errorKind)))
  }
  if (event === "lineage-start") {
    return typeof value.lineage === "string" && typeof value.family === "string" && FAMILY_NAMES.includes(value.family as Family) &&
      value.lineage === `${value.family}-r${String(value.repetition)}` && Number.isInteger(value.repetition) &&
      (value.repetition as number) >= 1 && (value.repetition as number) <= 3 && typeof value.fixtureID === "string" &&
      /^[A-Za-z0-9._-]{1,100}$/.test(value.fixtureID) && validHash(value.fixtureTree, [40, 64])
  }
  if (event === "invocation-start") {
    return typeof value.lineage === "string" && Number.isSafeInteger(value.invocationIndex) && (value.invocationIndex as number) >= 1 &&
      typeof value.scenario === "string" && (FAMILY_NAMES.includes(value.scenario as Family) || value.scenario === "resume") &&
      (value.parentSessionID === null || isSessionID(value.parentSessionID)) && validHash(value.argvSha256)
  }
  if (event === "invocation-end") {
    const exit = value.exit
    return typeof value.lineage === "string" && Number.isSafeInteger(value.invocationIndex) && (value.invocationIndex as number) >= 1 &&
      isRecord(exit) && exactKeys(exit, ["code", "signal"]) &&
      (exit.code === null || (Number.isInteger(exit.code) && (exit.code as number) >= 0 && (exit.code as number) <= 255)) &&
      (exit.signal === null || (typeof exit.signal === "string" && /^SIG[A-Z0-9]+$/.test(exit.signal))) &&
      typeof value.snapshotPath === "string" && (value.snapshotSha256 === null || validHash(value.snapshotSha256)) &&
      ["pass", "expected-fail-closed", "unexpected-failure", "killed", "snapshot-missing"].includes(String(value.outcome)) &&
      (value.expectedInjection === null || (typeof value.expectedInjection === "string" && /^[a-z0-9-]{1,80}$/.test(value.expectedInjection))) &&
      typeof value.orderedTermination === "boolean" &&
      Array.isArray(value.errorNames) && value.errorNames.length <= 32 && value.errorNames.every(name => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(name))
  }
  if (event === "lineage-end") return typeof value.lineage === "string" && (value.outcome === "pass" || value.outcome === "unexpected")
  if (event === "supervisor-end") return Number.isSafeInteger(value.lineages) && (value.lineages as number) >= 0 && (value.lineages as number) <= 24 && Number.isSafeInteger(value.unexpected) && (value.unexpected as number) >= 0
  return false
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) fail("manifest write made no progress")
    offset += written
  }
}

function anchorPath(evidenceDir: string): string { return join(evidenceDir, ANCHOR_NAME) }
function manifestPath(evidenceDir: string): string { return join(evidenceDir, MANIFEST_NAME) }

function writeAnchor(evidenceDir: string, anchor: { seq: number; lineSha256: string; byteLength: number }): void {
  const temporary = `${anchorPath(evidenceDir)}.tmp.${process.pid}.${randomUUID()}`
  const bytes = Buffer.from(`${JSON.stringify(anchor)}\n`)
  const fd = openSync(temporary, "wx", 0o600)
  try { writeAll(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, anchorPath(evidenceDir))
  fsyncDirectory(evidenceDir)
}

export function initializeManifest(evidenceDir: string, binding: SupervisorBinding): string {
  requireDirectory(evidenceDir, "evidence directory")
  const entries = readdirSync(evidenceDir)
  if (entries.some(entry => entry !== LOCK_NAME) || entries.length > 1) fail("fresh evidence directory contains unknown entries; preserving them")
  if (entries.includes(LOCK_NAME)) requireSafeFile(join(evidenceDir, LOCK_NAME), "soak lock", 0o600)
  const normalized = createSupervisorBinding(binding.vmC, binding.fixtures)
  const encodedBinding = bindingBytes(normalized)
  const bindingFD = openSync(bindingPath(evidenceDir), "wx", 0o600)
  try { writeAll(bindingFD, encodedBinding); fsyncSync(bindingFD); fchmodSync(bindingFD, 0o400); fsyncSync(bindingFD) }
  finally { closeSync(bindingFD) }
  fsyncDirectory(evidenceDir)
  const fd = openSync(manifestPath(evidenceDir), "wx", 0o600)
  try { fsyncSync(fd) } finally { closeSync(fd) }
  fsyncDirectory(evidenceDir)
  writeAnchor(evidenceDir, { seq: 0, lineSha256: ZERO_SHA256, byteLength: 0 })
  const snapshots = join(evidenceDir, SNAPSHOTS_NAME)
  mkdirSync(snapshots, { mode: 0o700 })
  fsyncDirectory(evidenceDir)
  return sha256(encodedBinding)
}

export function verifyTail(evidenceDir: string, options: { allowOneLineAhead?: boolean } = {}): TailVerification {
  const problems: string[] = []
  let lines: ManifestLine[] = []
  let seq = 0
  let lineSha256 = ZERO_SHA256
  let byteLength = 0
  let anchoredSeq = -1
  let oneLineAhead = false
  try {
    requireDirectory(evidenceDir, "evidence directory")
    const path = manifestPath(evidenceDir)
    requireSafeFile(path, "manifest", 0o600)
    const bytes = readFileSync(path)
    let text: string
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { fail("manifest is not valid UTF-8") }
    if (bytes.length > 0 && !text!.endsWith("\n")) fail("manifest has an incomplete final line")
    const rawLines = text!.length === 0 ? [] : text!.slice(0, -1).split("\n")
    let previous = ZERO_SHA256
    let offset = 0
    for (let index = 0; index < rawLines.length; index++) {
      const rawLine = rawLines[index]!
      if (!rawLine) fail(`manifest line ${index + 1} is empty`)
      let parsed: unknown
      try { parsed = JSON.parse(rawLine) } catch { fail(`manifest line ${index + 1} is invalid JSON`) }
      if (isRecord(parsed) && parsed.schema === LEGACY_MANIFEST_SCHEMA) {
        fail(`manifest line ${index + 1} uses the incomplete legacy v1 schema; refusing historical evidence without migration because invocation-end lacks explicit driver-owned orderedTermination`)
      }
      if (!validateManifestLine(parsed)) {
        if (isRecord(parsed) && parsed.event === "invocation-end" && typeof parsed.orderedTermination !== "boolean") {
          fail(`manifest line ${index + 1} has an incomplete invocation-end schema; refusing it without migration because driver-owned orderedTermination must be explicit`)
        }
        fail(`manifest line ${index + 1} has an invalid schema`)
      }
      if (JSON.stringify(parsed) !== rawLine) fail(`manifest line ${index + 1} is not canonical JSON`)
      if (parsed.seq !== index + 1 || parsed.prevSha256 !== previous) fail(`manifest hash chain breaks at line ${index + 1}`)
      const lineBytes = Buffer.from(rawLine)
      previous = sha256(lineBytes)
      offset += lineBytes.length + 1
      lines.push(parsed)
    }
    seq = lines.length
    lineSha256 = seq ? sha256(Buffer.from(JSON.stringify(lines.at(-1)))) : ZERO_SHA256
    byteLength = bytes.length

    const anchorFile = anchorPath(evidenceDir)
    requireSafeFile(anchorFile, "anchor", 0o600)
    const anchorBytes = readFileSync(anchorFile)
    const anchorText = new TextDecoder("utf-8", { fatal: true }).decode(anchorBytes)
    if (!anchorText.endsWith("\n")) fail("anchor is incomplete")
    const anchor = JSON.parse(anchorText.slice(0, -1)) as unknown
    if (!isRecord(anchor) || !exactKeys(anchor, ["seq", "lineSha256", "byteLength"]) ||
      !Number.isSafeInteger(anchor.seq) || (anchor.seq as number) < 0 || !validHash(anchor.lineSha256) ||
      !Number.isSafeInteger(anchor.byteLength) || (anchor.byteLength as number) < 0 || JSON.stringify(anchor) !== anchorText.slice(0, -1)) {
      fail("anchor has an invalid schema")
    }
    anchoredSeq = anchor.seq as number
    if (anchoredSeq === 0) {
      if (anchor.lineSha256 !== ZERO_SHA256 || anchor.byteLength !== 0) fail("genesis anchor is invalid")
    } else {
      if (anchoredSeq > lines.length) fail("manifest tail is behind its anchor")
      const anchoredLine = lines[anchoredSeq - 1]!
      const anchoredHash = sha256(Buffer.from(JSON.stringify(anchoredLine)))
      const anchoredBytes = rawLines.slice(0, anchoredSeq).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
      if (anchoredHash !== anchor.lineSha256 || anchoredBytes !== anchor.byteLength) fail("manifest tail does not match its anchor")
    }
    if (lines.length === anchoredSeq && bytes.length === anchor.byteLength) {
      // Exact, independently anchored tail.
    } else if (options.allowOneLineAhead && lines.length === anchoredSeq + 1 && offset === bytes.length &&
      lines.at(-1)?.prevSha256 === anchor.lineSha256 &&
      Buffer.byteLength(rawLines.at(-1)!) + 1 + (anchor.byteLength as number) === bytes.length) {
      oneLineAhead = true
    } else {
      fail("manifest is not exactly at its anchor")
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "manifest verification failed")
  }
  return { ok: problems.length === 0, problems, lines, seq, lineSha256, byteLength, anchoredSeq, oneLineAhead }
}

export function appendEvent(evidenceDir: string, event: string, payload: Record<string, unknown>, at = new Date().toISOString()): ManifestLine {
  if (!validTimestamp(at) || !isRecord(payload) || Object.keys(payload).some(key => ["schema", "seq", "prevSha256", "at", "event"].includes(key))) {
    fail("invalid event timestamp or payload")
  }
  const tail = verifyTail(evidenceDir)
  if (!tail.ok) fail(`refusing to append to unverified manifest: ${tail.problems.join("; ")}`)
  const line: ManifestLine = {
    schema: MANIFEST_SCHEMA,
    seq: tail.seq + 1,
    prevSha256: tail.lineSha256,
    at,
    event,
    ...payload,
  }
  if (!validateManifestLine(line)) fail(`invalid ${event} event payload`)
  const encoded = Buffer.from(`${JSON.stringify(line)}\n`)
  const fd = openSync(manifestPath(evidenceDir), "a")
  try { writeAll(fd, encoded); fsyncSync(fd) } finally { closeSync(fd) }
  const hash = sha256(encoded.subarray(0, encoded.length - 1))
  writeAnchor(evidenceDir, { seq: line.seq, lineSha256: hash, byteLength: tail.byteLength + encoded.length })
  return line
}

function isOutcomeUnexpected(outcome: unknown): boolean {
  return outcome !== "pass" && outcome !== "expected-fail-closed"
}

function expectedCount(family: Family): number { return FAMILY_TABLE[family].invocationCount }

export function validateGrammar(lines: ManifestLine[], options: { allowIncomplete?: boolean } = {}): GrammarVerification {
  const problems: string[] = []
  const allowIncomplete = options.allowIncomplete === true
  let supervisorStarted = false
  let supervisorEnded = false
  let provisionOpen: string | null = null
  let provisionFailed = false
  let lineage: { id: string; family: Family; invocations: ManifestLine[]; unexpected: boolean } | null = null
  let invocationStart: ManifestLine | null = null
  const seenLineages = new Set<string>()
  const seenFixtureIDs = new Set<string>()
  const provisionVMs = new Set<string>()
  let unexpected = 0
  let completedLineages = 0

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const event = line.event
    if (supervisorEnded) { problems.push("events appear after supervisor-end"); break }
    if (!supervisorStarted) {
      if (event !== "supervisor-start" || index !== 0) { problems.push("manifest must begin with supervisor-start"); break }
      supervisorStarted = true
      continue
    }
    if (event === "supervisor-start") { problems.push("supervisor-start is duplicated"); break }
    if (provisionFailed && event !== "supervisor-end") { problems.push("failed provisioning must be followed only by supervisor-end"); break }
    if (event === "supervisor-restart") {
      if (invocationStart || provisionOpen) { problems.push("restart event occurs inside an unfinished child operation"); break }
      if (line.recoveredSeq !== line.seq - 1) { problems.push("restart recovery sequence does not match the verified manifest prefix"); break }
      continue
    }
    if (event === "provision-start") {
      if (lineage || provisionOpen || completedLineages > 0 || provisionVMs.has(String(line.vm))) { problems.push("provision-start is out of order or duplicated"); break }
      provisionOpen = String(line.vm)
      provisionVMs.add(provisionOpen)
      continue
    }
    if (event === "provision-end") {
      if (!provisionOpen || line.vm !== provisionOpen) { problems.push("provision-end does not match its start"); break }
      provisionOpen = null
      if (line.outcome === "failed") { provisionFailed = true; unexpected++ }
      continue
    }
    if (provisionOpen) { problems.push("provision child has no matching end"); break }
    if (event === "lineage-start") {
      if (lineage || provisionVMs.size === 0) { problems.push("lineage-start is out of order or provisioning is absent"); break }
      const id = String(line.lineage)
      if (seenLineages.has(id) || seenFixtureIDs.has(String(line.fixtureID))) { problems.push("lineage or fixture identity is duplicated"); break }
      seenLineages.add(id)
      seenFixtureIDs.add(String(line.fixtureID))
      lineage = { id, family: line.family as Family, invocations: [], unexpected: false }
      continue
    }
    if (event === "invocation-start") {
      if (!lineage || invocationStart || line.lineage !== lineage.id || line.invocationIndex !== lineage.invocations.length + 1) {
        problems.push("invocation-start is unmatched or out of order"); break
      }
      const expectedScenario = line.invocationIndex === 1 ? FAMILY_TABLE[lineage.family].scenario : "resume"
      if (line.scenario !== expectedScenario || (line.invocationIndex as number) > expectedCount(lineage.family)) {
        problems.push("invocation-start does not match the fixed family table"); break
      }
      invocationStart = line
      continue
    }
    if (event === "invocation-end") {
      if (!lineage || !invocationStart || line.lineage !== lineage.id || line.invocationIndex !== invocationStart.invocationIndex) {
        problems.push("invocation-end has no matching invocation-start"); break
      }
      const expectedInjection = invocationStart.invocationIndex === 1 ? FAMILY_TABLE[lineage.family].expectedInjection : null
      if (line.expectedInjection !== expectedInjection) { problems.push("invocation expectedInjection does not match the fixed family table"); break }
      lineage.invocations.push(line)
      if (isOutcomeUnexpected(line.outcome)) { lineage.unexpected = true; unexpected++ }
      invocationStart = null
      continue
    }
    if (event === "lineage-end") {
      if (!lineage || invocationStart || line.lineage !== lineage.id || lineage.invocations.length < 1) {
        problems.push("lineage-end is unmatched or out of order"); break
      }
      const expectedInvocations = expectedCount(lineage.family)
      if (lineage.invocations.length !== expectedInvocations && !lineage.unexpected) {
        lineage.unexpected = true
        unexpected++
      }
      const outcome = lineage.unexpected ? "unexpected" : "pass"
      if (line.outcome !== outcome) { problems.push("lineage-end outcome disagrees with its invocation evidence"); break }
      completedLineages++
      lineage = null
      continue
    }
    if (event === "supervisor-end") {
      if (lineage || invocationStart || provisionOpen) { problems.push("supervisor-end occurs with an unfinished operation"); break }
      if (provisionFailed ? completedLineages !== 0 : completedLineages !== 24) {
        problems.push("supervisor-end requires either failed provisioning with zero lineages or 24 complete lineages")
        break
      }
      if (line.lineages !== completedLineages || line.unexpected !== unexpected) { problems.push("supervisor-end summary does not match the event stream"); break }
      supervisorEnded = true
      continue
    }
    problems.push(`unexpected event ${event}`)
    break
  }

  if (!supervisorStarted) problems.push("supervisor-start is missing")
  if (provisionOpen) problems.push("provisioning start is unmatched")
  if (invocationStart) problems.push("invocation start is unmatched")
  if (lineage && !allowIncomplete) problems.push("lineage block is incomplete")
  if (!supervisorEnded && !allowIncomplete) problems.push("supervisor-end is missing")
  if (supervisorEnded && !provisionFailed) {
    if (completedLineages !== 24) problems.push("manifest does not contain 24 complete lineages")
    const expectedIDs = new Set(FAMILY_NAMES.flatMap(family => [1, 2, 3].map(repetition => `${family}-r${repetition}`)))
    if (seenLineages.size !== 24 || [...expectedIDs].some(id => !seenLineages.has(id))) problems.push("manifest does not contain each unique family repetition")
  }
  return { ok: problems.length === 0, complete: supervisorEnded, problems, unexpected, lineages: completedLineages, provisionFailed }
}

function valueAt(root: unknown, keys: string[]): unknown {
  let current = root
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function asRun(receipt: unknown, runIndex = -1): Record<string, unknown> | null {
  const runs = valueAt(receipt, ["runs"])
  if (!Array.isArray(runs)) return null
  const run = runs.at(runIndex)
  return isRecord(run) ? run : null
}

function hasModelAbort(value: unknown, seen = new Set<object>()): boolean {
  const pending: unknown[] = [value]
  let visitedCount = 0
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    if (++visitedCount > 100_000) return true
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child)
      continue
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (/model.?abort/i.test(key) && child !== null && child !== false && child !== 0 && child !== "" &&
        !(Array.isArray(child) && child.length === 0)) return true
      pending.push(child)
    }
  }
  return false
}

function limitErrorNames(values: Iterable<string>): string[] {
  const sorted = [...new Set(values)].sort()
  const required = sorted.filter(name => /MessageAbortedError/i.test(name)).slice(0, 32)
  return [...new Set([...required, ...sorted.filter(name => !required.includes(name)).slice(0, 32 - required.length)])].sort()
}

function familyAssertions(family: Family, invocationIndex: number, receipt: unknown, expectedReceiptPath?: string): boolean {
  if (!isRecord(receipt) || receipt.schemaVersion !== 2 || !Array.isArray(receipt.modelAborts) ||
    !isSessionID(valueAt(receipt, ["nativeSessionIDs", "parentSessionID"]))) return false
  const expectedReceiptScenario = invocationIndex === 1 ? FAMILY_TABLE[family].scenario : "resume"
  if (receipt.scenario !== expectedReceiptScenario || !isRemoteReceiptPath(receipt.receiptPath) ||
    (expectedReceiptPath !== undefined && receipt.receiptPath !== expectedReceiptPath) ||
    valueAt(receipt, ["baseIdentity", "verifier"]) !== "linux-production") return false
  const runs = receipt.runs
  if (!Array.isArray(runs) || !runs.length || !runs.every(isRecord)) return false
  const run = asRun(receipt)
  if (!run) return false
  const failures = receipt.failures
  if (!Array.isArray(failures) || failures.length !== 0 || (typeof run.failureCount === "number" && run.failureCount !== 0)) return false
  const native = valueAt(receipt, ["nativeSessionIDs", "parentSessionID"])

  if (invocationIndex === 1) {
    if (run.scenario !== FAMILY_TABLE[family].scenario || run.parentSessionID !== native) return false
    if (family === "success") {
      const acceptance = run.nativeAcceptance
      return isRecord(acceptance) && acceptance.done === 1 && acceptance.reviewerVerdict === "accept" &&
        Array.isArray(acceptance.verifierExitCodes) && acceptance.verifierExitCodes.length === 1 && acceptance.verifierExitCodes[0] === 0
    }
    if (family === "retry") {
      const injection = isRecord(run.driver_fault_injection) ? run.driver_fault_injection : null
      const acceptance = run.nativeAcceptance
      const exits = isRecord(acceptance) ? acceptance.verifierExitCodes : null
      return !!injection && injection.applicationCount === 1 && injection.source === "driver_fault_injection" &&
        isRecord(acceptance) && acceptance.done === 1 && acceptance.reviewerVerdict === "accept" &&
        Array.isArray(exits) && exits.length === 2 && exits[0] !== 0 && exits[1] === 0
    }
    if (family === "reject") {
      const injection = run.injection
      const review = run.observedReview
      return isRecord(injection) && typeof injection.appliedAt === "string" && isRecord(review) &&
        typeof review.verdict === "string" && review.verdict.toUpperCase() === "REJECT"
    }
    if (family === "cancel") {
      const busy = run.firstWorkerBusyObservation
      const queueAbort = run.queueAbort
      const result = run.queueResult
      return isRecord(busy) && busy.observed === "busy" && isRecord(queueAbort) && queueAbort.invoked === true && queueAbort.reason === "user_stop" &&
        isRecord(result) && result.aborted === true && result.done === 0 && result.failed === 0
    }
    if (family === "verifier-cancel") {
      const retirement = run.nativeRetirement
      const result = isRecord(retirement) ? retirement.result : null
      const resumed = run.explicitResumedQueueResult
      return isRecord(retirement) && retirement.authenticated === true && isRecord(result) && result.cancelled === true &&
        result.domainState === "empty" && isRecord(run.queueResult) && run.queueResult.aborted === true &&
        isRecord(resumed) && resumed.aborted === false && resumed.done === 0 && resumed.failed === 0 &&
        Array.isArray(resumed.taskIds) && resumed.taskIds.length === 0
    }
    const interruption = run.interruption
    if (!isRecord(interruption) || interruption.parentSessionID !== native) return false
    if (family === "interrupt") {
      const busy = run.secondTaskWorkerBusyObservation
      const completed = interruption.completedTaskIDs
      return isRecord(busy) && busy.observed === "busy" && busy.lastStatus === "busy" &&
        Number.isSafeInteger(busy.polls) && (busy.polls as number) > 0 &&
        typeof interruption.vendorChildSessionID === "string" && busy.vendorSessionID === interruption.vendorChildSessionID &&
        interruption.vendorChildSessionID.length > 0 && typeof interruption.targetTaskID === "string" &&
        busy.taskID === interruption.targetTaskID &&
        interruption.targetTaskID.length > 0 && interruption.runningTaskID === interruption.targetTaskID &&
        Array.isArray(completed) && completed.length > 0 && completed.every(id => typeof id === "string") &&
        !completed.includes(interruption.targetTaskID)
    }
    if (family === "checkpoint") {
      const completed = interruption.completedTaskIDs
      return interruption.boundary === "verified_task_checkpoint_before_next_execution_intent" &&
        Array.isArray(completed) && completed.includes("t1")
    }
    return interruption.boundary === "active_native_verifier_before_t2_retirement" &&
      interruption.verifierDispatch === "started" && interruption.cgroupPopulated === true &&
      isRecord(interruption.boundaryRef) && interruption.boundaryRef.kind === "verifier" &&
      interruption.boundaryRef.profile === "linux-single-use"
  }

  if (run.scenario !== "resume" || run.parentSessionID !== native || run.interruption !== undefined && family !== "active-verifier") return false
  if (family === "active-verifier" && invocationIndex === 2) {
    const retirement = run.nativeRetirement
    return run.activeVerifierStage === "retirement-recorded" && isRecord(retirement) && retirement.authenticated === true &&
      isRecord(retirement.result) && retirement.result.cancelled === false && isRecord(run.queueResult) &&
      run.queueResult.aborted === true && run.queueResult.done === 0 && run.queueResult.failed === 0
  }
  const result = run.queueResult
  if (!isRecord(result) || result.aborted === true || result.done !== 2 || result.failed !== 0) return false
  const completed = run.completedTaskIDsAfter
  if (!Array.isArray(completed) || completed.length !== 3 || !completed.every(id => typeof id === "string") || new Set(completed).size !== 3) return false
  if (family === "active-verifier") {
    return run.activeVerifierStage === "remaining-tasks-completed" && isRecord(run.remainingTaskAcceptance) && run.remainingTaskAcceptance.done === 2
  }
  const firstRun = asRun(receipt, 0)
  const previouslyCompleted = isRecord(firstRun?.interruption) ? firstRun.interruption.completedTaskIDs : null
  return Array.isArray(previouslyCompleted) && previouslyCompleted.every(taskID => completed.includes(taskID))
}

function receiptHasAbort(receipt: unknown, errorNames: string[]): boolean {
  if (errorNames.some(name => /MessageAbortedError/i.test(name))) return true
  return hasModelAbort(receipt)
}

export function classify(input: ClassificationInput): InvocationOutcome {
  const { family, invocationIndex, scenario, exit, receipt, expectedInjection, receiptPath } = input
  const errors = input.errorNames ?? []
  if (errors.some(name => /MessageAbortedError/i.test(name)) || hasModelAbort(receipt)) return "unexpected-failure"
  if (exit.signal !== null && !input.orderedTermination) return "killed"
  if (receipt === null) return "snapshot-missing"
  if (!isRecord(receipt) || receipt.schemaVersion !== 2 || !Array.isArray(receipt.modelAborts) || receiptHasAbort(receipt, errors)) return "unexpected-failure"
  const policy = FAMILY_TABLE[family]
  if (invocationIndex < 1 || invocationIndex > policy.invocationCount) return "unexpected-failure"
  const initial = invocationIndex === 1
  const expectedScenario: InvocationScenario = initial ? policy.scenario : "resume"
  const expectedInjectionForInvocation = initial ? policy.expectedInjection : null
  if (scenario !== expectedScenario || expectedInjection !== expectedInjectionForInvocation) return "unexpected-failure"
  if (!Array.isArray(receipt.failures) || receipt.failures.length !== 0 || errors.length !== 0) return "unexpected-failure"
  if (input.orderedTermination) return "unexpected-failure"

  if (initial && family !== "success") {
    if (exit.code === policy.expectedExitCode && familyAssertions(family, invocationIndex, receipt, receiptPath)) return "expected-fail-closed"
    return exit.code === 137 ? "killed" : "unexpected-failure"
  }
  if (exit.code === 137) return "killed"
  if (exit.code !== 0 || !familyAssertions(family, invocationIndex, receipt, receiptPath)) return "unexpected-failure"
  if (family === "active-verifier" && invocationIndex === 2) return "expected-fail-closed"
  return "pass"
}

export function expectedSnapshotPath(lineage: string, invocationIndex: number): string {
  if (!/^[a-z-]+-r[1-3]$/.test(lineage) || !Number.isSafeInteger(invocationIndex) || invocationIndex < 1) fail("invalid snapshot identity")
  return `${SNAPSHOTS_NAME}/${lineage}/${invocationIndex}.receipt.json`
}

function openExistingSnapshot(evidenceDir: string, lineage: string, invocationIndex: number): Buffer | null {
  const path = join(evidenceDir, ...expectedSnapshotPath(lineage, invocationIndex).split("/"))
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { return null }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400 || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES) {
    fail(`snapshot ${expectedSnapshotPath(lineage, invocationIndex)} is not an immutable bounded regular file`)
  }
  return readFileSync(path)
}

function ensureSnapshotsDirectory(evidenceDir: string, lineage: string): string {
  const root = join(evidenceDir, SNAPSHOTS_NAME)
  requireDirectory(root, "snapshots directory")
  const directory = join(root, lineage)
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: 0o700 })
    fsyncDirectory(root)
  }
  requireDirectory(directory, "lineage snapshot directory")
  return directory
}

function writeSnapshot(evidenceDir: string, lineage: string, invocationIndex: number, bytes: Buffer): { path: string; sha256: string } {
  if (bytes.length > MAX_RECEIPT_BYTES) fail("receipt snapshot exceeds the configured bound")
  const directory = ensureSnapshotsDirectory(evidenceDir, lineage)
  const relativePath = expectedSnapshotPath(lineage, invocationIndex)
  const path = join(evidenceDir, ...relativePath.split("/"))
  const fd = openSync(path, "wx", 0o600)
  try {
    writeAll(fd, bytes)
    fsyncSync(fd)
    fchmodSync(fd, 0o400)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  fsyncDirectory(directory)
  return { path: relativePath, sha256: sha256(bytes) }
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function validateSshTarget(value: string): string {
  if (value.length > 255 || value.startsWith("-") || /[\s\0\r\n]/.test(value) ||
    !/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/.test(value)) {
    fail("--vm-c must be a host, user@host, or SSH config alias; options and shell syntax are not accepted")
  }
  return value
}

export function remoteReceiptArgv(targetValue: string, path: string): string[] {
  const target = validateSshTarget(targetValue)
  if (!isRemoteReceiptPath(path)) fail("remote receipt path must be an absolute POSIX path without traversal or control characters")
  const remoteCommand = `cat -- ${posixQuote(path)}`
  return [
    "ssh", "-a", "-T", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
    "-o", "ConnectTimeout=10", "--", target, remoteCommand,
  ]
}

function collectErrorNames(receipt: unknown): string[] {
  const result = new Set<string>()
  const visited = new Set<object>()
  if (isRecord(receipt) && Array.isArray(receipt.failures)) {
    for (const failure of receipt.failures) {
      if (isRecord(failure) && typeof failure.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(failure.name)) result.add(failure.name)
    }
  }
  const pending: unknown[] = [receipt]
  let visitedCount = 0
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== "object" || visited.has(value)) continue
    visited.add(value)
    if (++visitedCount > 100_000) {
      result.add("ReceiptTraversalLimitError")
      break
    }
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child)
      continue
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "errorName" && typeof child === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(child)) result.add(child)
      pending.push(child)
    }
  }
  if (hasModelAbort(receipt)) result.add("ModelAbort")
  return limitErrorNames(result)
}

type OwnedProcessResult = { exit: ExitStatus; errorNames: string[]; timedOut: boolean; orderedTermination: boolean; interrupted: boolean }
let stopSignal: "SIGINT" | "SIGTERM" | null = null
const activeOwnedChildren = new Map<ReturnType<typeof spawn>, (errorName: string) => void>()

function signalOwnedChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const recordError = activeOwnedChildren.get(child)
  if (!recordError) return
  try {
    if (!child.kill(signal)) recordError("ChildSignalError")
  } catch { recordError("ChildSignalError") }
}

function installStopHandlers(): void {
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (stopSignal) return
    stopSignal = signal
    for (const child of activeOwnedChildren.keys()) signalOwnedChild(child, "SIGTERM")
    setTimeout(() => {
      for (const child of activeOwnedChildren.keys()) signalOwnedChild(child, "SIGKILL")
    }, CHILD_SIGNAL_ESCALATION_MS).unref()
  }
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))
}

function signalName(value: NodeJS.Signals | null): string | null {
  return value === null ? null : value
}

async function runOwned(argv: string[], cwd: string, limitMs: number, stdio: "inherit" | "receipt"): Promise<OwnedProcessResult & { bytes?: Buffer }> {
  if (stopSignal) return { exit: { code: null, signal: null }, errorNames: ["SupervisorTerminationError"], timedOut: false, orderedTermination: true, interrupted: true }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "ignore"] })
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(error.name) ? error.name : "SpawnError"
    return { exit: { code: null, signal: null }, errorNames: [name], timedOut: false, orderedTermination: false, interrupted: false }
  }
  const errorNames = new Set<string>()
  let timedOut = false
  let interrupted = false
  let orderedTermination = false
  let spawned = false
  let spawnFailure = false
  let output: Buffer[] = []
  let outputBytes = 0
  let tooLarge = false
  let captureIncomplete = false
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined
  const recordChildError = (name: string) => errorNames.add(name)
  activeOwnedChildren.set(child, recordChildError)
  let killTimer!: ReturnType<typeof setTimeout>
  let stopCheck!: ReturnType<typeof setInterval>
  const clearRuntimeTimers = () => {
    clearTimeout(killTimer)
    if (hardKillTimer) clearTimeout(hardKillTimer)
    clearInterval(stopCheck)
  }
  const scheduleHardKill = () => {
    if (hardKillTimer) return
    hardKillTimer = setTimeout(() => {
      hardKillTimer = undefined
      signalOwnedChild(child, "SIGKILL")
    }, CHILD_SIGNAL_ESCALATION_MS)
    hardKillTimer.unref()
  }
  killTimer = setTimeout(() => {
    timedOut = true
    orderedTermination = true
    signalOwnedChild(child, "SIGTERM")
    scheduleHardKill()
  }, limitMs)
  killTimer.unref()
  stopCheck = setInterval(() => {
    if (stopSignal && !interrupted) {
      interrupted = true
      orderedTermination = true
      signalOwnedChild(child, "SIGTERM")
    }
  }, 50)
  stopCheck.unref()
  if (stdio === "receipt" && child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      if (tooLarge) return
      outputBytes += chunk.length
      if (outputBytes > MAX_RECEIPT_BYTES) {
        tooLarge = true
        orderedTermination = true
        signalOwnedChild(child, "SIGKILL")
        scheduleHardKill()
        child.stdout?.destroy()
        return
      }
      output.push(Buffer.from(chunk))
    })
  }
  let exited!: { code: number | null; signal: NodeJS.Signals | null }
  await new Promise<void>(resolveExit => {
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let captureSettled = stdio !== "receipt" || !child.stdout
    let captureDrainTimer: ReturnType<typeof setTimeout> | undefined
    let resolved = false
    const finish = () => {
      if (!resolved && exitStatus && captureSettled) {
        resolved = true
        exited = exitStatus
        resolveExit()
      }
    }
    const settleCapture = () => {
      captureSettled = true
      if (captureDrainTimer) clearTimeout(captureDrainTimer)
      finish()
    }
    child.once("spawn", () => {
      spawned = true
      spawnFailure = false
    })
    child.on("error", (error: Error) => {
      const name = /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(error.name) ? error.name : "ChildProcessError"
      errorNames.add(name)
      if (spawned || child.pid !== undefined) errorNames.add("ChildSignalError")
      else spawnFailure = true
    })
    child.stdout?.once("end", settleCapture)
    child.stdout?.once("close", () => {
      if (!child.stdout?.readableEnded && !tooLarge && !captureIncomplete) {
        captureIncomplete = true
        errorNames.add("ReceiptCaptureIncompleteError")
      }
      settleCapture()
    })
    child.stdout?.once("error", () => {
      captureIncomplete = true
      errorNames.add("ReceiptStreamError")
      child.stdout?.destroy()
      settleCapture()
    })
    child.once("exit", (code, signal) => {
      activeOwnedChildren.delete(child)
      clearRuntimeTimers()
      if (stopSignal) interrupted = true
      exitStatus = { code, signal }
      if (!captureSettled) {
        captureDrainTimer = setTimeout(() => {
          captureIncomplete = true
          errorNames.add("ReceiptCaptureIncompleteError")
          child.stdout?.destroy()
          settleCapture()
        }, RECEIPT_DRAIN_AFTER_EXIT_MS)
      }
      finish()
    })
    child.once("close", () => {
      if (exitStatus || !spawnFailure || spawned || child.pid !== undefined) return
      activeOwnedChildren.delete(child)
      clearRuntimeTimers()
      captureDrainTimer && clearTimeout(captureDrainTimer)
      exitStatus = { code: null, signal: null }
      child.stdout?.destroy()
      captureSettled = true
      finish()
    })
  })
  activeOwnedChildren.delete(child)
  if (timedOut) errorNames.add("SupervisorTimeoutError")
  if (interrupted) errorNames.add("SupervisorTerminationError")
  if (tooLarge) errorNames.add("ReceiptTooLargeError")
  const bytes = outputBytes <= MAX_RECEIPT_BYTES && !captureIncomplete && !tooLarge ? Buffer.concat(output, outputBytes) : undefined
  return {
    exit: { code: exited.code, signal: signalName(exited.signal) },
    errorNames: [...errorNames].sort(),
    timedOut,
    orderedTermination,
    interrupted,
    ...(bytes === undefined ? {} : { bytes }),
  }
}

async function readRemoteReceipt(target: string, path: string): Promise<{ bytes: Buffer | null; errorNames: string[] }> {
  const argv = remoteReceiptArgv(target, path)
  const result = await runOwned(argv, process.cwd(), RECEIPT_TIMEOUT_MS, "receipt")
  if (result.exit.code !== 0 || result.exit.signal !== null || result.timedOut || result.interrupted || result.bytes === undefined || result.errorNames.length) {
    const errorNames = [...result.errorNames, "ReceiptReadError"].sort()
    return { bytes: null, errorNames }
  }
  return { bytes: result.bytes, errorNames: [] }
}

function readJsonReceipt(bytes: Buffer | null): unknown | null {
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) return null
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : null
  } catch { return null }
}

function parentSessionID(receipt: unknown): string | null {
  const value = valueAt(receipt, ["nativeSessionIDs", "parentSessionID"])
  return isSessionID(value) ? value : null
}

export function materializeArgv(invocation: InvocationSpec, sessionID: string | null): string[] {
  if (invocation.scenario !== "resume") return [...invocation.argv]
  if (!sessionID || !isSessionID(sessionID)) fail("resume requires a validated parentSessionID from the earlier immutable receipt snapshot")
  const markerIndex = invocation.argv.indexOf("@otter-soak-parent-session")
  if (markerIndex < 1 || invocation.argv[markerIndex - 1] !== "--session" || invocation.argv.lastIndexOf("@otter-soak-parent-session") !== markerIndex) {
    fail("resume session marker is not a single argv value after --session")
  }
  const argv = [...invocation.argv]
  argv[markerIndex] = sessionID
  return argv
}

function appendSupervisorEnd(evidenceDir: string, lineages: number, unexpected: number): void {
  appendEvent(evidenceDir, "supervisor-end", { lineages, unexpected })
}

function eventLines(evidenceDir: string): ManifestLine[] {
  const tail = verifyTail(evidenceDir)
  if (!tail.ok) fail(`manifest became unverifiable: ${tail.problems.join("; ")}`)
  return tail.lines
}

function provisionState(lines: ManifestLine[]): { completed: string[]; failed: boolean; open: string | null } {
  const completed: string[] = []
  let open: string | null = null
  let failed = false
  for (const line of lines) {
    if (line.event === "provision-start") open = String(line.vm)
    if (line.event === "provision-end") {
      if (line.outcome === "ok") completed.push(String(line.vm))
      else failed = true
      open = null
    }
  }
  return { completed, failed, open }
}

function assertExistingProvisionMatches(lines: ManifestLine[], specs: ProvisionSpec[]): void {
  const starts = lines.filter(line => line.event === "provision-start")
  if (starts.length > specs.length || starts.some((line, index) => line.vm !== specs[index]?.vm)) fail("existing provisioning events differ from the trusted fixtures manifest")
}

function assertExistingLineagesMatch(lines: ManifestLine[], specs: LineageSpec[]): void {
  const starts = lines.filter(line => line.event === "lineage-start")
  if (starts.length > specs.length) fail("existing manifest has more lineages than the trusted fixtures manifest")
  for (let index = 0; index < starts.length; index++) {
    const line = starts[index]!
    const spec = specs[index]!
    if (line.lineage !== spec.lineage || line.family !== spec.family || line.repetition !== spec.repetition ||
      line.fixtureID !== spec.fixtureID || line.fixtureTree !== spec.fixtureTree) fail("existing lineage identity differs from the trusted fixtures manifest")
  }
}

function assertEvidenceEntries(evidenceDir: string, allowLock: boolean): void {
  const expected = new Set([MANIFEST_NAME, ANCHOR_NAME, BINDING_NAME, SNAPSHOTS_NAME, ...(allowLock ? [LOCK_NAME] : [])])
  const entries = readdirSync(evidenceDir)
  for (const entry of entries) if (!expected.has(entry)) fail(`unrecognized evidence entry ${entry}; preserving it without cleanup`)
  for (const entry of [MANIFEST_NAME, ANCHOR_NAME, BINDING_NAME, SNAPSHOTS_NAME]) if (!entries.includes(entry)) fail(`required evidence entry ${entry} is missing`)
}

function assertSnapshotTree(evidenceDir: string, lines: ManifestLine[]): void {
  const root = join(evidenceDir, SNAPSHOTS_NAME)
  requireDirectory(root, "snapshots directory")
  const expected = new Map<string, Set<string>>()
  for (const line of lines.filter(item => item.event === "invocation-end")) {
    const lineage = String(line.lineage)
    const index = line.invocationIndex as number
    const relativePath = expectedSnapshotPath(lineage, index)
    const target = join(evidenceDir, ...relativePath.split("/"))
    let exists = true
    try { lstatSync(target) } catch { exists = false }
    if (line.snapshotSha256 === null) {
      if (exists) fail(`unreferenced snapshot exists for ${lineage} invocation ${index}; preserving it without cleanup`)
      continue
    }
    const files = expected.get(lineage) ?? new Set<string>()
    files.add(`${index}.receipt.json`)
    expected.set(lineage, files)
    const bytes = openExistingSnapshot(evidenceDir, lineage, index)
    if (!bytes || sha256(bytes) !== line.snapshotSha256) fail(`snapshot digest differs from its invocation event: ${relativePath}`)
  }
  const actualDirectories = readdirSync(root)
  for (const directory of actualDirectories) {
    const expectedFiles = expected.get(directory)
    if (!expectedFiles) fail(`unreferenced snapshot directory ${directory}; preserving it without cleanup`)
    const path = join(root, directory)
    requireDirectory(path, `snapshot directory ${directory}`)
    const actualFiles = readdirSync(path)
    for (const file of actualFiles) if (!expectedFiles.has(file)) fail(`unreferenced snapshot ${directory}/${file}; preserving it without cleanup`)
    for (const file of expectedFiles) if (!actualFiles.includes(file)) fail(`referenced snapshot ${directory}/${file} is missing`)
  }
  for (const directory of expected.keys()) if (!actualDirectories.includes(directory)) fail(`snapshot directory ${directory} is missing`)
}

function snapshotFromInvocation(evidenceDir: string, lineage: string, index: number): unknown | null {
  const bytes = openExistingSnapshot(evidenceDir, lineage, index)
  return bytes === null ? null : readJsonReceipt(bytes)
}

function existingInvocationEnds(lines: ManifestLine[], lineage: string): Map<number, ManifestLine> {
  return new Map(lines.filter(line => line.event === "invocation-end" && line.lineage === lineage).map(line => [line.invocationIndex as number, line]))
}

function existingLineageEnd(lines: ManifestLine[], lineage: string): ManifestLine | undefined {
  return lines.find(line => line.event === "lineage-end" && line.lineage === lineage)
}

function existingLineageStart(lines: ManifestLine[], lineage: string): boolean {
  return lines.some(line => line.event === "lineage-start" && line.lineage === lineage)
}

function countUnexpected(lines: ManifestLine[]): number {
  let count = 0
  for (const line of lines) {
    if (line.event === "provision-end" && line.outcome === "failed") count++
    if (line.event === "invocation-end" && isOutcomeUnexpected(line.outcome)) count++
    if (line.event === "lineage-end" && line.outcome === "unexpected") {
      const outcomes = lines.filter(candidate => candidate.event === "invocation-end" && candidate.lineage === line.lineage)
      const start = lines.find(candidate => candidate.event === "lineage-start" && candidate.lineage === line.lineage)
      if (typeof start?.family === "string" && FAMILY_NAMES.includes(start.family as Family) &&
        outcomes.length < expectedCount(start.family as Family) && outcomes.every(candidate => !isOutcomeUnexpected(candidate.outcome))) count++
    }
  }
  return count
}

async function runProvisioning(evidenceDir: string, manifest: FixtureManifest): Promise<boolean> {
  const lines = eventLines(evidenceDir)
  assertExistingProvisionMatches(lines, manifest.provisioning)
  const state = provisionState(lines)
  if (state.open) fail("refusing to infer the outcome of an interrupted provisioning child")
  if (state.failed) {
    appendSupervisorEnd(evidenceDir, 0, countUnexpected(lines))
    return false
  }
  for (let index = state.completed.length; index < manifest.provisioning.length; index++) {
    const spec = manifest.provisioning[index]!
    appendEvent(evidenceDir, "provision-start", { vm: spec.vm })
    const child = await runOwned(spec.argv, spec.cwd, spec.timeoutMs, "inherit")
    const success = child.exit.code === 0 && child.exit.signal === null && !child.timedOut && !child.interrupted && child.errorNames.length === 0
    const errorKind = success ? null : child.timedOut ? "timeout" : child.interrupted || child.exit.signal ? "signal" : child.errorNames.length ? "spawn-error" : "exit-nonzero"
    appendEvent(evidenceDir, "provision-end", { vm: spec.vm, outcome: success ? "ok" : "failed", errorKind })
    if (!success) {
      appendSupervisorEnd(evidenceDir, 0, countUnexpected(eventLines(evidenceDir)))
      return false
    }
    if (stopSignal) return false
  }
  return true
}

function validateExistingPrefix(
  evidenceDir: string,
  lines: ManifestLine[],
  binding: SupervisorBinding,
  bindingHash: string,
  allowLock: boolean,
): void {
  assertEvidenceEntries(evidenceDir, allowLock)
  assertSnapshotTree(evidenceDir, lines)
  const grammar = validateGrammar(lines, { allowIncomplete: true })
  if (!grammar.ok) fail(`existing manifest grammar is invalid: ${grammar.problems.join("; ")}`)
  const start = lines[0]
  if (start?.event !== "supervisor-start" || start.bindingSha256 !== bindingHash) fail("supervisor-start does not authenticate the immutable run binding")
  if (grammar.complete) fail("manifest already has supervisor-end; it cannot be restarted")
  if (lines.some(line => line.event === "invocation-start" && !lines.some(end => end.event === "invocation-end" && end.lineage === line.lineage && end.invocationIndex === line.invocationIndex))) {
    fail("refusing to infer the outcome of an invocation without its matching invocation-end")
  }
  if (lines.some(line => line.event === "provision-end" && line.outcome === "failed")) fail("failed provisioning is terminal and cannot be restarted")
  assertExistingProvisionMatches(lines, binding.fixtures.provisioning)
  assertExistingLineagesMatch(lines, binding.fixtures.lineages)
  const state = provisionState(lines)
  if (state.open) fail("refusing to infer the outcome of an interrupted provisioning child")
  for (const start of lines.filter(line => line.event === "lineage-start")) {
    const spec = binding.fixtures.lineages.find(item => item.lineage === start.lineage)
    if (!spec) fail("existing lineage is not in the trusted fixture manifest")
    const ends = existingInvocationEnds(lines, spec.lineage)
    const starts = new Map(lines.filter(line => line.event === "invocation-start" && line.lineage === spec.lineage)
      .map(line => [line.invocationIndex as number, line]))
    const firstReceipt = snapshotFromInvocation(evidenceDir, spec.lineage, 1)
    const firstParent = parentSessionID(firstReceipt)
    for (const [index, end] of ends) {
      const invocationStart = starts.get(index)
      if (!invocationStart) fail("existing invocation end has no matching start")
      const invocation = spec.invocations[index - 1]
      if (!invocation) fail("existing invocation is absent from the immutable run binding")
      const expectedPath = expectedSnapshotPath(spec.lineage, end.invocationIndex as number)
      if (end.snapshotPath !== expectedPath) fail("existing invocation snapshot path does not match the unique lineage/index path")
      let receipt: unknown | null = null
      if (end.snapshotSha256) {
        const bytes = openExistingSnapshot(evidenceDir, spec.lineage, index)
        if (!bytes || sha256(bytes) !== end.snapshotSha256) fail("existing immutable receipt snapshot does not match its event digest")
        receipt = readJsonReceipt(bytes) ?? {}
      }
      const errorNames = end.errorNames as string[]
      const orderedTermination = end.orderedTermination as boolean
      const outcome = classify({
        family: spec.family,
        invocationIndex: index,
        scenario: invocationStart.scenario as InvocationScenario,
        exit: end.exit as ExitStatus,
        receipt,
        receiptPath: invocation.receiptPath,
        expectedInjection: end.expectedInjection as string | null,
        errorNames,
        orderedTermination,
      })
      if (outcome !== end.outcome) fail("existing invocation outcome does not match its immutable receipt snapshot")
      if (index === 1) {
        if (invocationStart.parentSessionID !== null) fail("existing initial invocation has a parent session")
      } else {
        if (!firstParent || invocationStart.parentSessionID !== firstParent) fail("existing resume is not linked to invocation 1's parent session")
        const resumedParent = parentSessionID(receipt)
        if (resumedParent && resumedParent !== firstParent) fail("existing resume snapshot parent session does not match invocation 1")
      }
      const effectiveArgv = materializeArgv(invocation, index === 1 ? null : firstParent)
      const expectedArgvHash = sha256(Buffer.from(JSON.stringify(effectiveArgv)))
      if (invocationStart.argvSha256 !== expectedArgvHash) fail(`existing invocation argv hash differs from the immutable run binding: ${spec.lineage} invocation ${index}`)
    }
  }
}

async function runLineage(evidenceDir: string, target: string, spec: LineageSpec): Promise<void> {
  let lines = eventLines(evidenceDir)
  if (!existingLineageStart(lines, spec.lineage)) {
    appendEvent(evidenceDir, "lineage-start", {
      lineage: spec.lineage,
      family: spec.family,
      repetition: spec.repetition,
      fixtureID: spec.fixtureID,
      fixtureTree: spec.fixtureTree,
    })
  }
  lines = eventLines(evidenceDir)
  if (existingLineageEnd(lines, spec.lineage)) return
  let lineageUnexpected = false
  const ends = existingInvocationEnds(lines, spec.lineage)
  const firstSnapshot = () => snapshotFromInvocation(evidenceDir, spec.lineage, 1)
  for (let index = 1; index <= spec.invocations.length; index++) {
    const priorEnd = ends.get(index)
    if (priorEnd) {
      if (isOutcomeUnexpected(priorEnd.outcome)) lineageUnexpected = true
      continue
    }
    if (index > 1 && lineageUnexpected) break
    const invocation = spec.invocations[index - 1]!
    const parentID = index === 1 ? null : parentSessionID(firstSnapshot())
    const argv = materializeArgv(invocation, index === 1 ? null : parentID)
    const argvSha256 = sha256(Buffer.from(JSON.stringify(argv)))
    appendEvent(evidenceDir, "invocation-start", {
      lineage: spec.lineage,
      invocationIndex: index,
      scenario: invocation.scenario,
      parentSessionID: parentID,
      argvSha256,
    })

    const child = await runOwned(argv, invocation.cwd, invocation.timeoutMs, "inherit")
    let receiptBytes: Buffer | null = null
    let receiptReadErrors: string[] = []
    const remote = await readRemoteReceipt(target, invocation.receiptPath)
    receiptBytes = remote.bytes
    receiptReadErrors = remote.errorNames
    let snapshotFile: { path: string; sha256: string } | null = null
    let receipt: unknown | null = null
    if (receiptBytes) {
      try {
        snapshotFile = writeSnapshot(evidenceDir, spec.lineage, index, receiptBytes)
        receipt = readJsonReceipt(receiptBytes)
        if (receipt === null) {
          receipt = {}
          receiptReadErrors.push("ReceiptInvalidError")
        }
      } catch {
        // An occupied snapshot path is unknown evidence; it is never overwritten.
        receiptReadErrors.push("SnapshotWriteError")
      }
    }
    const errorNames = limitErrorNames([...child.errorNames, ...receiptReadErrors, ...collectErrorNames(receipt)])
    const outcome: InvocationOutcome = classify({
      family: spec.family,
      invocationIndex: index,
      scenario: invocation.scenario,
      exit: child.exit,
      receipt,
      receiptPath: invocation.receiptPath,
      expectedInjection: invocation.expectedInjection,
      errorNames,
      orderedTermination: child.orderedTermination,
    })
    appendEvent(evidenceDir, "invocation-end", {
      lineage: spec.lineage,
      invocationIndex: index,
      exit: child.exit,
      snapshotPath: expectedSnapshotPath(spec.lineage, index),
      snapshotSha256: snapshotFile?.sha256 ?? null,
      outcome,
      expectedInjection: invocation.expectedInjection,
      errorNames,
      orderedTermination: child.orderedTermination,
    })
    if (isOutcomeUnexpected(outcome)) {
      lineageUnexpected = true
      break
    }
    if (child.interrupted || stopSignal) break
  }
  lines = eventLines(evidenceDir)
  const actualEnds = existingInvocationEnds(lines, spec.lineage)
  if (actualEnds.size !== spec.invocations.length && !lineageUnexpected) lineageUnexpected = true
  appendEvent(evidenceDir, "lineage-end", { lineage: spec.lineage, outcome: lineageUnexpected ? "unexpected" : "pass" })
}

function parseArgs(argv: string[]): { evidenceRoot: string; vmC: string; fixturesManifest: string; restart: boolean } {
  const values = new Map<string, string>()
  let restart = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (flag === "--restart") {
      if (restart) fail("--restart was specified more than once")
      restart = true
      continue
    }
    if (!["--evidence-root", "--vm-c", "--fixtures-manifest"].includes(flag) || values.has(flag)) fail(`invalid or duplicate option ${flag}`)
    const value = argv[++index]
    if (!value || value.startsWith("--")) fail(`missing value for ${flag}`)
    values.set(flag, value)
  }
  const evidenceRoot = values.get("--evidence-root")
  const vmC = values.get("--vm-c")
  const fixturesManifest = values.get("--fixtures-manifest")
  if (!evidenceRoot || !vmC || !fixturesManifest || !isAbsolute(evidenceRoot) || !isAbsolute(fixturesManifest)) {
    fail("usage: bun scripts/otter-soak-supervisor.ts --evidence-root ABS --vm-c SSH_TARGET --fixtures-manifest ABS [--restart]")
  }
  return { evidenceRoot, vmC: validateSshTarget(vmC), fixturesManifest, restart }
}

function readFixtureManifest(path: string): FixtureManifest {
  requireSafeFile(path, "fixtures manifest")
  const stat = statSync(path)
  if (stat.size > MAX_FIXTURE_BYTES) fail("fixtures manifest exceeds the configured size bound")
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, "utf8")) } catch { return fail("fixtures manifest is invalid JSON") }
  return validateFixtureManifest(parsed)
}

function canonicalExistingDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) fail(`${label} must be absolute`)
  requireDirectory(path, label)
  const canonical = realpathSync(path)
  if (canonical !== path) fail(`${label} must be canonical`)
  return canonical
}

function createEvidenceDirectory(root: string): string {
  const canonicalRoot = canonicalExistingDirectory(root, "evidence root")
  const stamp = new Date().toISOString().replace(/:/g, "")
  const path = join(canonicalRoot, `linux-eligibility-${stamp}`)
  mkdirSync(path, { mode: 0o700 })
  fsyncDirectory(canonicalRoot)
  return path
}

export type SoakLock = { path: string; fd: number; dev: number; ino: number }

export function acquireLock(evidenceDir: string): SoakLock {
  const path = join(evidenceDir, LOCK_NAME)
  let fd: number
  try { fd = openSync(path, "wx", 0o600) } catch { fail("soak.lock exists or cannot be created; refusing without stale-PID cleanup") }
  const startedAt = new Date().toISOString()
  try { writeAll(fd, Buffer.from(`${JSON.stringify({ pid: process.pid, startedAt })}\n`)); fsyncSync(fd) } catch (error) { closeSync(fd); throw error }
  const stat = fstatSync(fd)
  fsyncDirectory(evidenceDir)
  return { path, fd, dev: stat.dev, ino: stat.ino }
}

export function releaseLock(evidenceDir: string, lock: SoakLock): void {
  closeSync(lock.fd)
  try {
    const current = lstatSync(lock.path)
    if (current.isFile() && !current.isSymbolicLink() && current.dev === lock.dev && current.ino === lock.ino) {
      unlinkSync(lock.path)
      fsyncDirectory(evidenceDir)
    }
  } catch { /* Never remove a lock that cannot be proven to be ours. */ }
}

function restartEvidenceDirectory(path: string): string {
  const canonical = canonicalExistingDirectory(path, "restart evidence directory")
  const stat = requireDirectory(canonical, "restart evidence directory")
  if ((stat.mode & 0o777) !== 0o700 || !/^linux-eligibility-\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z$/.test(basename(canonical)) ||
    !existsSync(manifestPath(canonical)) || !existsSync(anchorPath(canonical))) {
    fail("--restart requires an existing linux-eligibility-<UTC> evidence directory")
  }
  return canonical
}

type RestartState = { tail: TailVerification }

function preflightRestart(evidenceDir: string, binding: SupervisorBinding, allowLock: boolean): RestartState {
  const stored = readSupervisorBinding(evidenceDir)
  if (!stored.bytes.equals(bindingBytes(binding))) {
    fail("restart refused: supplied target or normalized fixture manifest differs from the immutable run binding")
  }
  const tail = verifyTail(evidenceDir, { allowOneLineAhead: true })
  if (!tail.ok) fail(`restart refused because manifest tail/anchor integrity failed: ${tail.problems.join("; ")}`)
  validateExistingPrefix(evidenceDir, tail.lines, binding, stored.sha256, allowLock)
  return { tail }
}

async function runSupervisor(evidenceDir: string, binding: SupervisorBinding, restartState: RestartState | null): Promise<number> {
  const fixtures = binding.fixtures
  if (restartState === null) {
    const bindingHash = initializeManifest(evidenceDir, binding)
    appendEvent(evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: bindingHash })
  } else {
    const { tail } = restartState
    if (tail.oneLineAhead) {
      const lastLine = tail.lines.at(-1)!
      writeAnchor(evidenceDir, { seq: lastLine.seq, lineSha256: tail.lineSha256, byteLength: tail.byteLength })
    }
    appendEvent(evidenceDir, "supervisor-restart", { recoveredSeq: tail.seq })
  }
  installStopHandlers()
  const provisioned = await runProvisioning(evidenceDir, fixtures)
  if (!provisioned) return countUnexpected(eventLines(evidenceDir))

  let lines = eventLines(evidenceDir)
  assertExistingLineagesMatch(lines, fixtures.lineages)
  for (const spec of fixtures.lineages) {
    if (stopSignal) break
    await runLineage(evidenceDir, binding.vmC, spec)
  }
  lines = eventLines(evidenceDir)
  const openLineage = [...lines].reverse().find(line => line.event === "lineage-start" && !lines.some(end => end.event === "lineage-end" && end.lineage === line.lineage))
  if (openLineage) {
    appendEvent(evidenceDir, "lineage-end", { lineage: openLineage.lineage, outcome: "unexpected" })
  }
  const completed = lines.filter(line => line.event === "lineage-end").length + (openLineage ? 1 : 0)
  const unexpected = countUnexpected(eventLines(evidenceDir))
  appendSupervisorEnd(evidenceDir, completed, unexpected)
  return unexpected
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>
  try { args = parseArgs(process.argv.slice(2)) }
  catch (error) {
    console.error(`otter-soak-supervisor: ${error instanceof Error ? error.message : "invalid arguments"}`)
    process.exitCode = 2
    return
  }
  let fixtures: FixtureManifest
  try { fixtures = readFixtureManifest(args.fixturesManifest) }
  catch (error) {
    console.error(`otter-soak-supervisor: ${error instanceof Error ? error.message : "invalid fixtures manifest"}`)
    process.exitCode = 2
    return
  }
  const binding = createSupervisorBinding(args.vmC, fixtures)
  let evidenceDir: string
  try { evidenceDir = args.restart ? restartEvidenceDirectory(args.evidenceRoot) : createEvidenceDirectory(args.evidenceRoot) }
  catch (error) {
    console.error(`otter-soak-supervisor: ${error instanceof Error ? error.message : "evidence directory unavailable"}`)
    process.exitCode = 2
    return
  }
  if (args.restart) {
    try { preflightRestart(evidenceDir, binding, false) }
    catch (error) {
      console.error(`otter-soak-supervisor: ${error instanceof Error ? error.message : "restart binding preflight failed"}`)
      process.exitCode = 2
      return
    }
  }
  let lock: SoakLock
  try { lock = acquireLock(evidenceDir) }
  catch (error) {
    console.error(`otter-soak-supervisor: ${error instanceof Error ? error.message : "soak lock unavailable"}`)
    process.exitCode = 2
    return
  }
  try {
    const restartState = args.restart ? preflightRestart(evidenceDir, binding, true) : null
    process.stderr.write(`${JSON.stringify({ event: "soak-evidence", path: evidenceDir })}\n`)
    const unexpected = await runSupervisor(evidenceDir, binding, restartState)
    process.exitCode = stopSignal ? 3 : unexpected > 0 ? 3 : 0
  } catch (error) {
    console.error(`otter-soak-supervisor: ${error instanceof Error ? error.message : "supervisor failed; evidence preserved"}`)
    process.exitCode = 2
  } finally {
    releaseLock(evidenceDir, lock)
  }
}

if (import.meta.main) void main()
