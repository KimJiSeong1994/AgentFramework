import { createHash, randomBytes } from "node:crypto"
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, writeSync, type Stats,
} from "node:fs"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { basename, dirname, join, resolve } from "node:path"
import { once } from "node:events"

const JOURNAL_SCHEMA = "skillopt.promotion-journal.v1" as const
const WITNESS_SCHEMA = "skillopt.live-skill-witness.v1" as const
const TARGET_RELATIVE_PATH = ".agents/skills/llm-wiki/SKILL.md" as const
const MAX_SKILL_BYTES = 16_384
const MAX_RECORD_BYTES = 64 * 1024
const MAX_JOURNAL_BYTES = 1024 * 1024
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const NATIVE_HELPER_PROTOCOL = "skillopt-darwin.v2"
// Darwin sys/fcntl.h: O_CLOEXEC = 0x01000000. Node's constants typings omit this Darwin flag.
const DARWIN_O_CLOEXEC = 0x01000000

/** Values are pinned by the independent run and rechecked by the required code-owned verifier. */
export type PromotionBindings = {
  runId: string
  rootBinding: string
  sourceSha256: string
  originalSha256: string
  candidateSha256: string
  protocolSha256: string
  evaluatorSha256: string
  runtimeSha256: string
  resultsSha256: string
  witnessSha256: string
}

export type PromotionRecordRef = { path: string; sha256: string }
export type PromotionEvidence = {
  qualification: PromotionRecordRef
  review: PromotionRecordRef
  approval: PromotionRecordRef
}

export type PromotionFaultPoint =
  | "RUN_DIRECTORY_CREATED"
  | "ORIGINAL_BACKUP_DURABLE"
  | "MANIFEST_DURABLE"
  | "PREPARED"
  | "STAGE_DURABLE"
  | "STAGED"
  | "APPROVAL_CONSUMED"
  | "SWAP_INTENT"
  | "BEFORE_EXCHANGE"
  | "EXCHANGE_COMPLETED"
  | "RACE_HELD_JOURNALED"
  | "SWAPPED_EXPECTED"
  | "LOAD_VERIFIED"
  | "COMMIT_RECEIPT_DURABLE"
  | "COMMITTED"
  | "ROLLBACK_STAGE_DURABLE"
  | "ROLLBACK_PREPARED"
  | "ROLLBACK_SWAP_INTENT"
  | "BEFORE_ROLLBACK_EXCHANGE"
  | "ROLLBACK_EXCHANGE_COMPLETED"
  | "ROLLBACK_RACE_HELD_JOURNALED"
  | "ROLLBACK_LOAD_VERIFIED"
  | "ROLLED_BACK"

export type PromotionCommon = {
  targetPath: string
  transactionRoot: string
  nativeHelperPath: string
  nativeHelperSha256: string
  bindings: PromotionBindings
}

export type PromotionPrimitiveProbeInput = {
  targetDirectory: string
  transactionRoot: string
  nativeHelperPath: string
  nativeHelperSha256: string
}

export type ApplySkillOptPromotionInput = PromotionCommon & {
  candidateBytes: Uint8Array
  evidence: PromotionEvidence
  /** Mandatory code-owned source/runtime/qualification verifier. No boolean or JSON-only bypass. */
  verifyEvidence: () => Promise<void>
  /** Test-only crash injection; it can stop at a durable boundary but cannot skip checks. */
  faultInjection?: (point: PromotionFaultPoint) => void
}

export type PromotionStatus =
  | "SWAPPED_EXPECTED"
  | "RACE_PRESERVED"
  | "RECOVERY_REQUIRED"
  | "LOAD_VERIFIED"
  | "COMMITTED"
  | "ROLLBACK_SWAP_INTENT"
  | "ROLLBACK_RACE_PRESERVED"
  | "ROLLED_BACK"

export type PromotionResult = {
  state: PromotionStatus
  idempotent: boolean
  raceMayHavePublishedCandidate: boolean
  reason?: string
}

export type PromotionLoadWitness = {
  schema: typeof WITNESS_SCHEMA
  experimentId: string
  rootBinding: string
  runtimeSha256: string
  observedAt: number
  hostVersion: "1.18.33"
  executableSha256: string
  pluginSha256: string
  sdkSha256: string
  configSha256: string
  sessionId: string
  messageId: string
  parentMessageId: string
  callId: string
  skillName: "llm-wiki"
  targetRelativePath: typeof TARGET_RELATIVE_PATH
  stagedFileSha256Before: string
  stagedFileSha256After: string
  expectedBodySha256: string
  returnedBodySha256: string
  returnedPayloadSha256: string
  parserVersion: "opencode-1.18.33.skill-output.v1"
  hashBases: {
    stagedFile: "staged-file-utf8.v1"
    expectedBody: "expected-host-body-1.18.33.v1"
    returnedBody: "observed-returned-body-1.18.33.v1"
    returnedPayload: "returned-payload-utf8.v1"
  }
  loadedOriginalFileSha256: null
  originalLoadedByteAttestation: false
}

export type RecordLoadVerificationInput = Omit<PromotionCommon, "targetPath"> & {
  targetPath: string
  witness: PromotionRecordRef
  /** Must revalidate the actual host API/tool-part receipt, not infer success from this JSON alone. */
  verifyWitness: (bytes: Uint8Array, bindings: PromotionBindings, expectedFileSha256: string) => Promise<void>
  faultInjection?: (point: PromotionFaultPoint) => void
}

export type RecoverSkillOptPromotionInput = PromotionCommon & {
  evidence: PromotionEvidence
  verifyEvidence: () => Promise<void>
}

export type RollbackSkillOptPromotionInput = PromotionCommon & {
  /** Owner policy bound to this exact apply receipt; a consumed apply approval is not rollback authority. */
  verifyRollback: () => Promise<void>
  faultInjection?: (point: PromotionFaultPoint) => void
}

export class PromotionError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = "PromotionError"
  }
}

type JournalState =
  | "PREPARED" | "STAGED" | "SWAP_INTENT" | "SWAPPED_EXPECTED" | "RACE_CAPTURED" | "RACE_PRESERVED"
  | "RECOVERY_REQUIRED" | "LOAD_VERIFIED" | "COMMITTED" | "ROLLBACK_PREPARED"
  | "ROLLBACK_SWAP_INTENT" | "ROLLBACK_CAPTURED" | "ROLLBACK_RACE_PRESERVED" | "ROLLED_BACK"

type JournalCore = {
  schema: typeof JOURNAL_SCHEMA
  seq: number
  state: JournalState
  previous: string | null
  details: Record<string, unknown>
}
type JournalRecord = JournalCore & { checksum: string }
type FileSnapshot = {
  dev: string
  ino: string
  uid: number
  mode: number
  nlink: number
  size: number
  mtimeNs: string
  ctimeNs: string
  bytes: Buffer
  sha256: string
}
type DirectoryContext = { path: string; dev: string; ino: string; mode: number }
type PreparedContext = {
  common: PromotionCommon
  target: DirectoryContext
  transactionRoot: DirectoryContext
  runDir: DirectoryContext
  retention: DirectoryContext | undefined
  runDirPath: string
  bindings: PromotionBindings
  bindingsSha256: string
  targetPath: string
  runId: string
  helperPath: string
  helperSha256: string
}
type VerifiedEvidence = {
  qualificationSha256: string
  reviewSha256: string
  approvalSha256: string
  approvalId: string
}

type Manifest = {
  schema: "skillopt.promotion-manifest.v1"
  runId: string
  targetRelativePath: typeof TARGET_RELATIVE_PATH
  targetDirectoryDev: string
  targetDirectoryIno: string
  bindings: PromotionBindings
  bindingsSha256: string
  qualificationSha256: string
  reviewSha256: string
  approvalSha256: string
  approvalId: string
  originalSha256: string
  candidateSha256: string
  originalMode: number
  backupName: "original.bin"
  stageName: string
  retentionDirectoryDev: string
  retentionDirectoryIno: string
}

type ActiveDescriptor = { fd: number; dev: string; ino: string }
const retainedOriginalDescriptors = new Map<string, ActiveDescriptor>()
const retainedRollbackDescriptors = new Map<string, ActiveDescriptor>()

type NativeExchangeSnapshot = Omit<FileSnapshot, "bytes" | "sha256">
type NativeExchangeReport = {
  protocol: typeof NATIVE_HELPER_PROTOCOL
  status: "EXCHANGED" | "RACE_CAPTURED" | "RACE_HELD"
  exchangeOccurred: true
  reason: string | null
  target: NativeExchangeSnapshot | null
  stage: NativeExchangeSnapshot | null
  capture: { name: string; dev: string; ino: string; size: number } | null
}
type PendingHeldExchange = {
  child: ChildProcessWithoutNullStreams
  report: NativeExchangeReport
  operation: "apply" | "rollback"
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}
const pendingHeldExchanges = new Map<string, PendingHeldExchange>()

const descriptorKey = (ctx: PreparedContext): string =>
  `${ctx.transactionRoot.dev}:${ctx.transactionRoot.ino}:${ctx.target.dev}:${ctx.target.ino}:${ctx.runId}:${ctx.bindingsSha256}`
function closeRetainedExchangeDescriptor(ctx: PreparedContext, operation: "apply" | "rollback"): void {
  const key = descriptorKey(ctx)
  const descriptors = operation === "apply" ? retainedOriginalDescriptors : retainedRollbackDescriptors
  const retained = descriptors.get(key)
  if (!retained) return
  try { closeSync(retained.fd) } finally { descriptors.delete(key) }
}
function fail(code: string): never { throw new PromotionError(code) }
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) fail("invalid-json-value")
  return encoded
}
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const sameIdentity = (left: FileSnapshot, right: FileSnapshot): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
  left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.sha256 === right.sha256
const sameRecordedSnapshot = (file: FileSnapshot, details: Record<string, unknown>, prefix: string): boolean =>
  file.dev === String(details[`${prefix}Dev`]) && file.ino === String(details[`${prefix}Ino`]) &&
  file.sha256 === details[`${prefix}Sha256`] && file.size === details[`${prefix}Size`] &&
  file.mode === details[`${prefix}Mode`] && file.mtimeNs === details[`${prefix}MtimeNs`] && file.ctimeNs === details[`${prefix}CtimeNs`]
const randomName = (runId: string, suffix: string): string =>
  `.skillopt-${runId.slice(0, 32)}-${randomBytes(12).toString("hex")}.${suffix}`
const validTransactionName = (runId: string, value: unknown, suffix: "stage" | "rollback"): value is string => {
  if (typeof value !== "string") return false
  const prefix = `.skillopt-${runId.slice(0, 32)}-`
  return value.startsWith(prefix) && basename(value) === value && /^[a-f0-9]{24}\.(?:stage|rollback)$/.test(value.slice(prefix.length)) &&
    value.endsWith(`.${suffix}`)
}

function validBindings(value: PromotionBindings): void {
  if (!isObject(value) || !sameKeys(value, [
    "runId", "rootBinding", "sourceSha256", "originalSha256", "candidateSha256", "protocolSha256",
    "evaluatorSha256", "runtimeSha256", "resultsSha256", "witnessSha256",
  ])) fail("invalid-bindings")
  if (!ID.test(value.runId)) fail("invalid-run-id")
  for (const key of ["rootBinding", "sourceSha256", "originalSha256", "candidateSha256", "protocolSha256", "evaluatorSha256", "runtimeSha256", "resultsSha256", "witnessSha256"] as const) {
    if (typeof value[key] !== "string" || !HASH.test(value[key])) fail(`invalid-binding-${key}`)
  }
}

function directoryContext(path: string, mode: number): DirectoryContext {
  if (!path || !resolve(path) || !path.startsWith("/")) fail("directory-path-not-absolute")
  const canonical = realpathSync.native(path)
  if (canonical !== resolve(path)) fail("directory-path-not-canonical")
  const st = lstatSync(canonical)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== mode || (st.mode & 0o022)) {
    fail("unsafe-directory")
  }
  return { path: canonical, dev: String(st.dev), ino: String(st.ino), mode: st.mode & 0o7777 }
}

function preparePaths(input: PromotionCommon): PreparedContext {
  requireDarwin()
  validBindings(input.bindings)
  if (input.targetPath !== resolve(input.targetPath) || !input.targetPath.startsWith("/")) fail("target-path-not-canonical")
  if (basename(input.targetPath) !== "SKILL.md") fail("wrong-target-name")
  const targetPath = resolve(input.targetPath)
  const targetDir = dirname(targetPath)
  if (basename(targetDir) !== "llm-wiki" || basename(dirname(targetDir)) !== "skills" || basename(dirname(dirname(targetDir))) !== ".agents") {
    fail("wrong-target-location")
  }
  const target = directoryContext(targetDir, (lstatSync(targetDir).mode & 0o7777))
  const worktree = resolve(targetDir, "../../..")
  const canonicalWorktree = realpathSync.native(worktree)
  if (canonicalWorktree !== worktree) fail("worktree-path-not-canonical")
  for (const directory of [worktree, join(worktree, ".agents"), join(worktree, ".agents", "skills"), targetDir]) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) fail("unsafe-target-parent-directory")
  }
  const transactionRoot = directoryContext(input.transactionRoot, DIRECTORY_MODE)
  if (input.transactionRoot !== resolve(input.transactionRoot)) fail("transaction-root-not-canonical")
  if (!HASH.test(input.nativeHelperSha256)) fail("invalid-helper-digest")
  const helperResolved = realpathSync.native(input.nativeHelperPath)
  if (helperResolved !== resolve(input.nativeHelperPath)) fail("helper-path-not-canonical")
  const helperStat = lstatSync(helperResolved)
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.nlink !== 1 || helperStat.uid !== process.getuid?.() ||
      !(helperStat.mode & 0o111) || (helperStat.mode & 0o7000)) {
    fail("unsafe-native-helper")
  }
  const runDirPath = join(transactionRoot.path, input.bindings.runId)
  return {
    common: input,
    target,
    transactionRoot,
    runDir: { path: "", dev: "", ino: "", mode: DIRECTORY_MODE },
    retention: undefined,
    runDirPath,
    bindings: input.bindings,
    bindingsSha256: sha256(stable(input.bindings)),
    targetPath,
    runId: input.bindings.runId,
    helperPath: helperResolved,
    helperSha256: input.nativeHelperSha256,
  }
}

/** Capability probe for parent-owned scratch paths only; it never targets the production skill file. */
export function preflightSkillOptPromotion(input: PromotionPrimitiveProbeInput): { protocol: typeof NATIVE_HELPER_PROTOCOL; probedDirectories: 2 } {
  requireDarwin()
  if (!HASH.test(input.nativeHelperSha256) || input.nativeHelperPath !== resolve(input.nativeHelperPath)) fail("invalid-helper-path-or-digest")
  const helperPath = realpathSync.native(input.nativeHelperPath)
  if (helperPath !== input.nativeHelperPath) fail("helper-path-not-canonical")
  const helperStat = lstatSync(helperPath)
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.nlink !== 1 || helperStat.uid !== process.getuid?.() ||
      !(helperStat.mode & 0o111) || (helperStat.mode & 0o7000)) fail("unsafe-native-helper")
  const target = directoryContext(input.targetDirectory, lstatSync(input.targetDirectory).mode & 0o7777)
  if (basename(target.path) === "llm-wiki" && basename(dirname(target.path)) === "skills" &&
      basename(dirname(dirname(target.path))) === ".agents") fail("production-directory-probe-forbidden")
  const transaction = directoryContext(input.transactionRoot, DIRECTORY_MODE)
  const version = runNative(helperPath, input.nativeHelperSha256, ["protocol"])
  if (version !== `${NATIVE_HELPER_PROTOCOL}\n`) fail("native-helper-protocol-mismatch")
  runNative(helperPath, input.nativeHelperSha256, ["probe", target.path, target.dev, target.ino])
  runNative(helperPath, input.nativeHelperSha256, ["probe", transaction.path, transaction.dev, transaction.ino])
  return { protocol: NATIVE_HELPER_PROTOCOL, probedDirectories: 2 }
}

function requireDarwin(): void {
  if (process.platform !== "darwin") fail("darwin-only-promotion")
}

function runNative(helperPath: string, expectedHelperSha256: string, args: readonly string[], maxBuffer = 256 * 1024): string {
  verifyNativeHelper(helperPath, expectedHelperSha256)
  const result = spawnSync(helperPath, args, { encoding: "utf8", maxBuffer, windowsHide: true, shell: false })
  if (result.error || result.status !== 0) fail("native-helper-failed")
  return result.stdout
}

function verifyNativeHelper(helperPath: string, expectedHelperSha256: string): void {
  const st = lstatSync(helperPath)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || !(st.mode & 0o111)) fail("unsafe-native-helper")
  const bytes = readStablePath(helperPath, 8 * 1024 * 1024, null, true)
  if (sha256(bytes) !== expectedHelperSha256) fail("native-helper-digest-mismatch")
}

function parseNativeExchangeReport(line: string): NativeExchangeReport {
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return fail("native-exchange-invalid-json") }
  if (!isObject(parsed) || !sameKeys(parsed, ["protocol", "status", "exchangeOccurred", "reason", "target", "stage", "capture"]) ||
      parsed.protocol !== NATIVE_HELPER_PROTOCOL ||
      !["EXCHANGED", "RACE_CAPTURED", "RACE_HELD"].includes(String(parsed.status)) || parsed.exchangeOccurred !== true ||
      !(parsed.reason === null || typeof parsed.reason === "string")) fail("native-exchange-invalid-report")
  const parseSnapshot = (value: unknown): NativeExchangeSnapshot | null => {
    if (value === null) return null
    if (!isObject(value) || !sameKeys(value, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) ||
        typeof value.dev !== "string" || !/^\d+$/.test(value.dev) || typeof value.ino !== "string" || !/^\d+$/.test(value.ino) ||
        typeof value.uid !== "number" || !Number.isSafeInteger(value.uid) || value.uid !== process.getuid?.() ||
        typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) ||
        typeof value.nlink !== "number" || !Number.isSafeInteger(value.nlink) || value.nlink < 0 ||
        typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
        typeof value.mtimeNs !== "string" || !/^-?\d+$/.test(value.mtimeNs) ||
        typeof value.ctimeNs !== "string" || !/^-?\d+$/.test(value.ctimeNs)) fail("native-exchange-invalid-snapshot")
    return value as unknown as NativeExchangeSnapshot
  }
  let capture: NativeExchangeReport["capture"] = null
  if (parsed.capture !== null) {
    if (!isObject(parsed.capture) || !sameKeys(parsed.capture, ["name", "dev", "ino", "size"]) ||
        typeof parsed.capture.name !== "string" || basename(parsed.capture.name) !== parsed.capture.name ||
        !/^[A-Za-z0-9._-]{1,200}$/.test(parsed.capture.name) || typeof parsed.capture.dev !== "string" || !/^\d+$/.test(parsed.capture.dev) ||
        typeof parsed.capture.ino !== "string" || !/^\d+$/.test(parsed.capture.ino) ||
        typeof parsed.capture.size !== "number" || !Number.isSafeInteger(parsed.capture.size) ||
        parsed.capture.size < 0 || parsed.capture.size > MAX_SKILL_BYTES) fail("native-exchange-invalid-capture")
    capture = parsed.capture as NativeExchangeReport["capture"]
  }
  const target = parseSnapshot(parsed.target)
  const stage = parseSnapshot(parsed.stage)
  if (parsed.status === "EXCHANGED" && (parsed.reason !== null || !target || !stage || target.nlink !== 1 || stage.nlink !== 1 || capture)) {
    fail("native-exchange-exchanged-report-invalid")
  }
  if (parsed.status === "RACE_CAPTURED" && (parsed.reason !== "unexpected-displaced-inode" || !target || !capture)) {
    fail("native-exchange-capture-report-invalid")
  }
  if (parsed.status === "RACE_HELD" && typeof parsed.reason !== "string") fail("native-exchange-held-report-invalid")
  return {
    protocol: NATIVE_HELPER_PROTOCOL,
    status: parsed.status as NativeExchangeReport["status"],
    exchangeOccurred: true,
    reason: parsed.reason as string | null,
    target,
    stage,
    capture,
  }
}

function makePendingHeldExchange(child: ChildProcessWithoutNullStreams, report: NativeExchangeReport, operation: PendingHeldExchange["operation"],
  closed: PendingHeldExchange["closed"]): PendingHeldExchange {
  return { child, report, operation, closed }
}

async function runNativeExchange(
  ctx: PreparedContext,
  args: readonly string[],
  operation: PendingHeldExchange["operation"],
  onHeld: (report: NativeExchangeReport) => Promise<void>,
): Promise<NativeExchangeReport> {
  verifyNativeHelper(ctx.helperPath, ctx.helperSha256)
  const child: ChildProcessWithoutNullStreams = spawn(ctx.helperPath, args, {
    stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  })
  const closed: PendingHeldExchange["closed"] = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }))
  })
  let stdout = ""
  let stderr = ""
  let lineSettled = false
  let protocolError: Error | undefined
  let resolveLine!: (line: string) => void
  let rejectLine!: (error: Error) => void
  const lineReady = new Promise<string>((resolveLineReady, rejectLineReady) => {
    resolveLine = resolveLineReady
    rejectLine = rejectLineReady
  })
  const onData = (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
    if (Buffer.byteLength(stdout) > MAX_RECORD_BYTES) {
      protocolError = new PromotionError("native-exchange-output-too-large")
      const firstNewline = stdout.indexOf("\n")
      if (!lineSettled && firstNewline >= 0) { lineSettled = true; resolveLine(stdout.slice(0, firstNewline)) }
      else if (!lineSettled) { lineSettled = true; rejectLine(protocolError) }
      return
    }
    const newline = stdout.indexOf("\n")
    if (newline >= 0) {
      if (newline !== stdout.length - 1) {
        protocolError = new PromotionError("native-exchange-extra-output")
        if (!lineSettled) { lineSettled = true; resolveLine(stdout.slice(0, newline)) }
        return
      }
      if (!lineSettled) { lineSettled = true; resolveLine(stdout.slice(0, newline)) }
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
    if (Buffer.byteLength(stderr) > MAX_RECORD_BYTES) stderr = "native helper diagnostic exceeded limit"
  })
  child.once("error", () => {
    if (!lineSettled) { lineSettled = true; rejectLine(new PromotionError("native-exchange-start-failed")) }
  })
  child.once("close", (code) => {
    if (!lineSettled) {
      lineSettled = true
      rejectLine(new PromotionError(code === 0 ? "native-exchange-response-missing" : "native-exchange-failed"))
    }
  })
  const line = await lineReady
  const report = parseNativeExchangeReport(line)
  if (report.status === "RACE_HELD") {
    const key = descriptorKey(ctx)
    const pending = makePendingHeldExchange(child, report, operation, closed)
    pendingHeldExchanges.set(key, pending)
    await onHeld(report)
    if (protocolError) throw protocolError
    // Recovery metadata is not authority to discard an uncaptured user inode.
    return report
  }
  const result = await closed
  if (protocolError || result.code !== 0 || result.signal !== null) {
    fail(protocolError ? "native-exchange-extra-output" : stderr ? "native-exchange-failed" : "native-exchange-exit-invalid")
  }
  return report
}

function retentionDirectory(ctx: PreparedContext): DirectoryContext {
  if (!ctx.retention) fail("retention-directory-unbound")
  return ctx.retention
}

function nativeSnapshotMatches(file: FileSnapshot, observed: NativeExchangeSnapshot): boolean {
  return file.dev === observed.dev && file.ino === observed.ino && file.uid === observed.uid && file.mode === observed.mode &&
    file.nlink === observed.nlink && file.size === observed.size && file.mtimeNs === observed.mtimeNs && file.ctimeNs === observed.ctimeNs
}

type RetainedArtifact = {
  directoryDev: string
  directoryIno: string
  name: string
  dev: string
  ino: string
  size: number
  sha256: string
}

function inspectReportedCapture(ctx: PreparedContext, report: NativeExchangeReport, expectedName: string): RetainedArtifact {
  const capture = report.capture
  if (!capture || capture.name !== expectedName) fail("native-capture-name-mismatch")
  const dir = retentionDirectory(ctx)
  const file = helperInspect(ctx, dir, capture.name)
  if (file.dev !== capture.dev || file.ino !== capture.ino || file.size !== capture.size || file.nlink !== 1 ||
      (file.mode & 0o7777) !== FILE_MODE || file.uid !== process.getuid?.()) fail("native-capture-inspection-mismatch")
  return {
    directoryDev: dir.dev, directoryIno: dir.ino, name: capture.name,
    dev: file.dev, ino: file.ino, size: file.size, sha256: file.sha256,
  }
}

function verifyRetainedArtifact(ctx: PreparedContext, value: unknown): { details: RetainedArtifact; file: FileSnapshot } {
  if (!isObject(value) || !sameKeys(value, ["directoryDev", "directoryIno", "name", "dev", "ino", "size", "sha256"]) ||
      typeof value.directoryDev !== "string" || typeof value.directoryIno !== "string" ||
      typeof value.name !== "string" || basename(value.name) !== value.name || !/^[A-Za-z0-9._-]{1,200}$/.test(value.name) ||
      typeof value.dev !== "string" || !/^\d+$/.test(value.dev) || typeof value.ino !== "string" || !/^\d+$/.test(value.ino) ||
      typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_SKILL_BYTES ||
      typeof value.sha256 !== "string" || !HASH.test(value.sha256)) fail("retained-artifact-record-invalid")
  const dir = retentionDirectory(ctx)
  if (value.directoryDev !== dir.dev || value.directoryIno !== dir.ino) fail("retained-artifact-directory-mismatch")
  const file = helperInspect(ctx, dir, value.name)
  if (file.dev !== value.dev || file.ino !== value.ino || file.size !== value.size || file.sha256 !== value.sha256 ||
      file.nlink !== 1 || (file.mode & 0o7777) !== FILE_MODE || file.uid !== process.getuid?.()) fail("retained-artifact-drift")
  return { details: value as unknown as RetainedArtifact, file }
}

function capturedRaceResult(ctx: PreparedContext, records: JournalRecord[], report: NativeExchangeReport, operation: "apply" | "rollback",
  stageName: string, captureName: string): PromotionResult {
  const retainedArtifact = inspectReportedCapture(ctx, report, captureName)
  const state = operation === "apply" ? "RACE_CAPTURED" : "ROLLBACK_CAPTURED"
  appendJournal(ctx, records, state, {
    nativeHelperProtocol: report.protocol,
    nativeHelperStatus: report.status,
    reason: report.reason,
    targetObservation: report.target,
    stageObservation: report.stage,
    retainedArtifact,
    stageName,
  })
  const captured = records.at(-1)!
  const terminalState = operation === "apply" ? "RACE_PRESERVED" : "ROLLBACK_RACE_PRESERVED"
  appendJournal(ctx, records, terminalState, {
    reason: "native-helper-captured-displaced-raced-inode",
    ...(operation === "apply" ? { stageName } : { rollbackStageName: stageName }),
    retainedArtifact,
    captureRecordSeq: captured.seq,
    captureRecordChecksum: captured.checksum,
    targetName: "SKILL.md",
  })
  closeRetainedExchangeDescriptor(ctx, operation)
  return {
    state: terminalState,
    idempotent: false,
    raceMayHavePublishedCandidate: operation === "apply",
    reason: "native-helper-captured-displaced-raced-inode",
  }
}

function finishCapturedRace(ctx: PreparedContext, records: JournalRecord[], operation: "apply" | "rollback"): PromotionResult {
  const state = operation === "apply" ? "RACE_CAPTURED" : "ROLLBACK_CAPTURED"
  const capture = recordsByName(records, state)
  if (!capture) fail("retained-artifact-journal-record-missing")
  verifyRetainedArtifact(ctx, capture.details.retainedArtifact)
  const terminalState = operation === "apply" ? "RACE_PRESERVED" : "ROLLBACK_RACE_PRESERVED"
  appendJournal(ctx, records, terminalState, {
    reason: "recovered-native-helper-capture",
    ...(operation === "apply" ? { stageName: capture.details.stageName } : { rollbackStageName: capture.details.stageName }),
    retainedArtifact: capture.details.retainedArtifact,
    captureRecordSeq: capture.seq,
    captureRecordChecksum: capture.checksum,
    targetName: "SKILL.md",
  })
  closeRetainedExchangeDescriptor(ctx, operation)
  return {
    state: terminalState,
    idempotent: false,
    raceMayHavePublishedCandidate: operation === "apply",
    reason: "recovered-native-helper-capture",
  }
}

function heldRecoveryDetails(ctx: PreparedContext, report: NativeExchangeReport, operation: "apply" | "rollback",
  captureName: string): Record<string, unknown> {
  let retainedArtifact: RetainedArtifact | null = null
  let captureVerificationError: string | null = null
  if (report.capture) {
    try { retainedArtifact = inspectReportedCapture(ctx, report, captureName) }
    catch (error) { captureVerificationError = error instanceof PromotionError ? error.code : "capture-inspection-failed" }
  }
  return {
    reason: "native-helper-held-open-inodes-for-recovery",
    nativeHelperProtocol: report.protocol,
    nativeHelperStatus: report.status,
    helperPid: pendingHeldExchanges.get(descriptorKey(ctx))?.child.pid ?? null,
    exchangeKind: operation,
    exchangeOccurred: report.exchangeOccurred,
    helperReason: report.reason,
    captureName,
    retentionDirectoryDev: retentionDirectory(ctx).dev,
    retentionDirectoryIno: retentionDirectory(ctx).ino,
    targetObservation: report.target,
    stageObservation: report.stage,
    captureObservation: report.capture,
    retainedArtifact,
    captureVerificationError,
  }
}

function nativeExchangeArgs(ctx: PreparedContext, targetName: string, target: FileSnapshot, stageName: string,
  stage: FileSnapshot, captureName: string): string[] {
  const retention = retentionDirectory(ctx)
  return [
    "exchange", ctx.target.path, ctx.target.dev, ctx.target.ino,
    targetName, target.dev, target.ino, stageName, stage.dev, stage.ino,
    retention.path, retention.dev, retention.ino, captureName,
  ]
}

function nativeVersion(ctx: PreparedContext): void {
  const result = runNative(ctx.helperPath, ctx.helperSha256, ["protocol"])
  if (result !== `${NATIVE_HELPER_PROTOCOL}\n`) fail("native-helper-protocol-mismatch")
}

function helperDirectoryPath(ctx: PreparedContext, dir: DirectoryContext, command: string, ...tail: string[]): string {
  return runNative(ctx.helperPath, ctx.helperSha256, [command, dir.path, dir.dev, dir.ino, ...tail])
}

function syncDirectory(ctx: PreparedContext, dir: DirectoryContext): void {
  helperDirectoryPath(ctx, dir, "sync-dir")
}

function flushFile(ctx: PreparedContext, dir: DirectoryContext, name: string, snapshot: Pick<FileSnapshot, "dev" | "ino">): void {
  helperDirectoryPath(ctx, dir, "flush-file", name, snapshot.dev, snapshot.ino)
}

function helperInspect(ctx: PreparedContext, dir: DirectoryContext, name: string): FileSnapshot {
  const output = helperDirectoryPath(ctx, dir, "inspect", name)
  let value: unknown
  try { value = JSON.parse(output) } catch { return fail("native-inspect-invalid-json") }
  if (!isObject(value) || !sameKeys(value, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "base64"])) fail("native-inspect-invalid-record")
  if (typeof value.dev !== "string" || typeof value.ino !== "string" || typeof value.uid !== "number" || !Number.isSafeInteger(value.uid) ||
      value.uid !== process.getuid?.() || typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) ||
      typeof value.nlink !== "number" || !Number.isSafeInteger(value.nlink) || typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) || typeof value.mtimeNs !== "string" ||
      typeof value.ctimeNs !== "string" || typeof value.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
    fail("native-inspect-invalid-fields")
  }
  const bytes = Buffer.from(value.base64, "base64")
  if (bytes.toString("base64") !== value.base64 || bytes.length !== value.size || bytes.length > MAX_SKILL_BYTES || value.nlink !== 1 ||
      (value.mode & 0o170000) !== 0o100000 || (value.mode & 0o7000) !== 0) fail("unsafe-regular-file")
  return {
    dev: value.dev, ino: value.ino, uid: value.uid as number, mode: value.mode, nlink: value.nlink, size: value.size,
    mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs, bytes, sha256: sha256(bytes),
  }
}

function readFdStable(fd: number, expectedBytes: number): Buffer {
  const before = fstatSync(fd)
  if (!before.isFile() || before.nlink !== 1 || before.size !== expectedBytes || expectedBytes > MAX_SKILL_BYTES) fail("unsafe-open-file")
  const bytes: Buffer = Buffer.alloc(expectedBytes)
  let offset = 0
  while (offset < expectedBytes) {
    const count = readSync(fd, bytes, offset, expectedBytes - offset, offset)
    if (count <= 0) fail("short-file-read")
    offset += count
  }
  const after = fstatSync(fd)
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mode !== after.mode || before.nlink !== after.nlink || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    fail("file-changed-during-read")
  }
  return bytes
}

function statMatchesSnapshot(st: Stats, expected: FileSnapshot): boolean {
  return st.isFile() && String(st.dev) === expected.dev && String(st.ino) === expected.ino &&
    st.nlink === 1 && st.size === expected.size && (st.mode & 0o7777) === (expected.mode & 0o7777)
}

function openTargetDescriptor(ctx: PreparedContext, expected: FileSnapshot): number {
  const fd = openSync(ctx.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | DARWIN_O_CLOEXEC)
  try {
    const st = fstatSync(fd)
    if (!statMatchesSnapshot(st, expected)) fail("target-descriptor-drift")
    const bytes = readFdStable(fd, expected.size)
    if (sha256(bytes) !== expected.sha256) fail("target-descriptor-content-drift")
    const again = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(again, expected)) fail("target-changed-during-open")
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function readStablePath(path: string, maximum: number, mode: number | null, requireOwner: boolean): Buffer {
  if (!path.startsWith("/") || path !== resolve(path) || realpathSync.native(path) !== path) fail("unsafe-file-path")
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum || (mode !== null && (before.mode & 0o7777) !== mode) ||
      (requireOwner && before.uid !== process.getuid?.())) fail("unsafe-file")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | DARWIN_O_CLOEXEC)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        (mode !== null && (opened.mode & 0o7777) !== mode) || (requireOwner && opened.uid !== process.getuid?.())) fail("file-replaced-during-open")
    const bytes: Buffer = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) fail("short-file-read")
      offset += count
    }
    const after = fstatSync(fd)
    const pathAfter = lstatSync(path)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.nlink !== 1) {
      fail("file-changed-during-read")
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

function readSecureRecord(reference: PromotionRecordRef): { bytes: Buffer; value: Record<string, unknown> } {
  if (!isObject(reference) || !sameKeys(reference, ["path", "sha256"]) || typeof reference.path !== "string" ||
      !HASH.test(reference.sha256) || !reference.path.startsWith("/")) fail("invalid-record-reference")
  const bytes = readStablePath(reference.path, MAX_RECORD_BYTES, FILE_MODE, true)
  if (sha256(bytes) !== reference.sha256) fail("record-digest-mismatch")
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("record-invalid-utf8")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return fail("record-invalid-json") }
  if (!isObject(parsed)) fail("record-not-object")
  return { bytes, value: parsed }
}

function exactBindings(candidate: unknown, expected: PromotionBindings): boolean {
  return isObject(candidate) && stable(candidate) === stable(expected)
}

function validateEvidence(evidence: PromotionEvidence, bindings: PromotionBindings): VerifiedEvidence {
  if (!isObject(evidence) || !sameKeys(evidence, ["qualification", "review", "approval"])) fail("invalid-evidence")
  const qualification = readSecureRecord(evidence.qualification as PromotionRecordRef)
  const review = readSecureRecord(evidence.review as PromotionRecordRef)
  const approval = readSecureRecord(evidence.approval as PromotionRecordRef)
  const q = qualification.value
  const r = review.value
  const a = approval.value
  if (!sameKeys(q, ["schemaVersion", "bindings", "decision", "reasons"]) || q.schemaVersion !== 1 ||
      q.decision !== "qualified" || !Array.isArray(q.reasons) || q.reasons.length !== 0 || !exactBindings(q.bindings, bindings)) {
    fail("qualification-record-invalid")
  }
  const qualificationSha256 = sha256(qualification.bytes)
  if (!sameKeys(r, ["schemaVersion", "bindings", "qualificationSha256", "reviewerId", "verdict"]) || r.schemaVersion !== 1 ||
      r.verdict !== "approve" || typeof r.reviewerId !== "string" || !ID.test(r.reviewerId) ||
      r.qualificationSha256 !== qualificationSha256 || !exactBindings(r.bindings, bindings)) {
    fail("review-record-invalid")
  }
  const reviewSha256 = sha256(review.bytes)
  if (!sameKeys(a, ["schemaVersion", "bindings", "qualificationSha256", "reviewSha256", "approvalId", "observedAt", "action"]) ||
      a.schemaVersion !== 1 || a.action !== "approve-production-apply" || typeof a.approvalId !== "string" || !ID.test(a.approvalId) ||
      typeof a.observedAt !== "number" || !Number.isSafeInteger(a.observedAt) || a.observedAt <= 0 || a.qualificationSha256 !== qualificationSha256 ||
      a.reviewSha256 !== reviewSha256 || !exactBindings(a.bindings, bindings)) fail("approval-record-invalid")
  return {
    qualificationSha256,
    reviewSha256,
    approvalSha256: sha256(approval.bytes),
    approvalId: a.approvalId as string,
  }
}

function ensureRunDirectory(ctx: PreparedContext): void {
  const rootStat = lstatSync(ctx.transactionRoot.path)
  if (String(rootStat.dev) !== ctx.transactionRoot.dev || String(rootStat.ino) !== ctx.transactionRoot.ino) fail("transaction-root-replaced")
  mkdirSync(ctx.runDirPath, { mode: DIRECTORY_MODE })
  const dir = directoryContext(ctx.runDirPath, DIRECTORY_MODE)
  ctx.runDir = dir
  syncDirectory(ctx, ctx.transactionRoot)
}

function createRetentionDirectory(ctx: PreparedContext): DirectoryContext {
  const path = join(ctx.runDir.path, "retained")
  mkdirSync(path, { mode: DIRECTORY_MODE })
  const retention = directoryContext(path, DIRECTORY_MODE)
  syncDirectory(ctx, ctx.runDir)
  ctx.retention = retention
  return retention
}

function setRunDirectory(ctx: PreparedContext): void {
  ctx.runDir = directoryContext(ctx.runDirPath, DIRECTORY_MODE)
}

function setRetentionDirectory(ctx: PreparedContext, manifest: Manifest): DirectoryContext {
  const retention = directoryContext(join(ctx.runDirPath, "retained"), DIRECTORY_MODE)
  if (retention.dev !== manifest.retentionDirectoryDev || retention.ino !== manifest.retentionDirectoryIno) {
    fail("retention-directory-binding-mismatch")
  }
  ctx.retention = retention
  return retention
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (count <= 0) fail("short-file-write")
    offset += count
  }
}

function writeExclusive(ctx: PreparedContext, dir: DirectoryContext, name: string, bytes: Uint8Array, mode: number): FileSnapshot {
  if (basename(name) !== name || name === "." || name === ".." || name.includes("/")) fail("unsafe-artifact-name")
  const path = join(dir.path, name)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | DARWIN_O_CLOEXEC, mode)
  try {
    writeAll(fd, bytes)
    fchmodSync(fd, mode)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const snapshot = helperInspect(ctx, dir, name)
  if (!snapshot.bytes.equals(Buffer.from(bytes)) || (snapshot.mode & 0o7777) !== mode) fail("artifact-write-verification-failed")
  flushFile(ctx, dir, name, snapshot)
  const flushed = helperInspect(ctx, dir, name)
  if (!sameIdentity(snapshot, flushed) || !flushed.bytes.equals(Buffer.from(bytes))) fail("artifact-changed-during-fullsync")
  syncDirectory(ctx, dir)
  return flushed
}

function readJournal(ctx: PreparedContext): JournalRecord[] {
  const journalPath = join(ctx.runDirPath, "journal.jsonl")
  let bytes: Buffer
  try {
    bytes = readStablePath(journalPath, MAX_JOURNAL_BYTES, FILE_MODE, true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) fail("journal-torn-record")
  const lines = bytes.toString("utf8").slice(0, -1).split("\n")
  if (!lines.length || lines.some((line) => !line)) fail("journal-empty-record")
  const records: JournalRecord[] = []
  let previous: string | null = null
  for (let index = 0; index < lines.length; index++) {
    let parsed: unknown
    try { parsed = JSON.parse(lines[index]!) } catch { return fail("journal-invalid-json") }
    if (!isObject(parsed) || !sameKeys(parsed, ["schema", "seq", "state", "previous", "details", "checksum"]) ||
        parsed.schema !== JOURNAL_SCHEMA || parsed.seq !== index + 1 || typeof parsed.state !== "string" ||
        !isObject(parsed.details) || parsed.previous !== previous || typeof parsed.checksum !== "string" || !HASH.test(parsed.checksum)) {
      fail("journal-invalid-record")
    }
    const core: JournalCore = {
      schema: JOURNAL_SCHEMA,
      seq: parsed.seq as number,
      state: parsed.state as JournalState,
      previous: parsed.previous as string | null,
      details: parsed.details,
    }
    if (!journalTransitionAllowed(records.at(-1)?.state ?? null, core.state) || sha256(stable(core)) !== parsed.checksum) fail("journal-checksum-or-state-invalid")
    const record = { ...core, checksum: parsed.checksum }
    records.push(record)
    previous = record.checksum
  }
  return records
}

function journalTransitionAllowed(previous: JournalState | null, next: JournalState): boolean {
  if (previous === null) return next === "PREPARED"
  const allowed: Record<JournalState, readonly JournalState[]> = {
    PREPARED: ["STAGED", "RECOVERY_REQUIRED"],
    STAGED: ["SWAP_INTENT", "RECOVERY_REQUIRED"],
    SWAP_INTENT: ["SWAPPED_EXPECTED", "RACE_CAPTURED", "RACE_PRESERVED", "RECOVERY_REQUIRED"],
    RACE_CAPTURED: ["RACE_PRESERVED", "RECOVERY_REQUIRED"],
    SWAPPED_EXPECTED: ["LOAD_VERIFIED", "RACE_PRESERVED", "RECOVERY_REQUIRED", "ROLLBACK_PREPARED"],
    RACE_PRESERVED: [],
    RECOVERY_REQUIRED: ["RECOVERY_REQUIRED"],
    LOAD_VERIFIED: ["COMMITTED", "RACE_PRESERVED", "RECOVERY_REQUIRED", "ROLLBACK_PREPARED"],
    COMMITTED: ["RECOVERY_REQUIRED", "ROLLBACK_PREPARED"],
    ROLLBACK_PREPARED: ["ROLLBACK_SWAP_INTENT", "RECOVERY_REQUIRED"],
    ROLLBACK_SWAP_INTENT: ["ROLLED_BACK", "ROLLBACK_CAPTURED", "ROLLBACK_RACE_PRESERVED", "RECOVERY_REQUIRED"],
    ROLLBACK_CAPTURED: ["ROLLBACK_RACE_PRESERVED", "RECOVERY_REQUIRED"],
    ROLLBACK_RACE_PRESERVED: [],
    ROLLED_BACK: ["RECOVERY_REQUIRED"],
  }
  return allowed[previous]?.includes(next) === true
}

function appendJournal(ctx: PreparedContext, records: JournalRecord[], state: JournalState, details: Record<string, unknown>): JournalRecord {
  if (!journalTransitionAllowed(records.at(-1)?.state ?? null, state)) fail("invalid-journal-transition")
  const core: JournalCore = {
    schema: JOURNAL_SCHEMA,
    seq: records.length + 1,
    state,
    previous: records.at(-1)?.checksum ?? null,
    details,
  }
  const record: JournalRecord = { ...core, checksum: sha256(stable(core)) }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
  const path = join(ctx.runDirPath, "journal.jsonl")
  const created = records.length === 0
  let fd: number
  if (created) fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW | DARWIN_O_CLOEXEC, FILE_MODE)
  else fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | DARWIN_O_CLOEXEC)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== FILE_MODE) fail("unsafe-journal")
    writeAll(fd, bytes)
    fsyncSync(fd)
    flushFile(ctx, ctx.runDir, "journal.jsonl", { dev: String(st.dev), ino: String(st.ino) })
  } finally {
    closeSync(fd)
  }
  if (created) syncDirectory(ctx, ctx.runDir)
  const persisted = readJournal(ctx)
  if (persisted.length !== records.length + 1 || persisted.at(-1)?.checksum !== record.checksum) fail("journal-write-verification-failed")
  records.push(record)
  return record
}

function readManifest(ctx: PreparedContext): Manifest {
  const bytes = readStablePath(join(ctx.runDirPath, "manifest.json"), MAX_RECORD_BYTES, FILE_MODE, true)
  const text = bytes.toString("utf8")
  if (!Buffer.from(text).equals(bytes)) fail("manifest-invalid-utf8")
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail("manifest-invalid-json") }
  if (!isObject(value) || value.schema !== "skillopt.promotion-manifest.v1" || value.runId !== ctx.runId ||
      value.targetRelativePath !== TARGET_RELATIVE_PATH || !exactBindings(value.bindings, ctx.bindings) ||
      value.bindingsSha256 !== ctx.bindingsSha256 || value.targetDirectoryDev !== ctx.target.dev || value.targetDirectoryIno !== ctx.target.ino ||
      value.backupName !== "original.bin" || value.originalSha256 !== ctx.bindings.originalSha256 || value.candidateSha256 !== ctx.bindings.candidateSha256 ||
      !validTransactionName(ctx.runId, value.stageName, "stage") ||
      typeof value.retentionDirectoryDev !== "string" || !/^\d+$/.test(value.retentionDirectoryDev) ||
      typeof value.retentionDirectoryIno !== "string" || !/^\d+$/.test(value.retentionDirectoryIno) ||
      typeof value.originalMode !== "number" || !Number.isSafeInteger(value.originalMode) || value.originalMode < 0 || value.originalMode > 0o777 ||
      typeof value.qualificationSha256 !== "string" || !HASH.test(value.qualificationSha256) ||
      typeof value.reviewSha256 !== "string" || !HASH.test(value.reviewSha256) ||
      typeof value.approvalSha256 !== "string" || !HASH.test(value.approvalSha256) ||
      typeof value.approvalId !== "string" || !ID.test(value.approvalId)) fail("manifest-binding-mismatch")
  return value as unknown as Manifest
}

function descriptorSnapshot(fd: number, expectedBytes: number): { bytes: Buffer; sha256: string; stable: boolean } {
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_SKILL_BYTES || before.size !== expectedBytes) {
      return { bytes: Buffer.alloc(0), sha256: "", stable: false }
    }
    const bytes = readFdStable(fd, expectedBytes)
    const after = fstatSync(fd)
    return {
      bytes,
      sha256: sha256(bytes),
      stable: before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    }
  } catch {
    return { bytes: Buffer.alloc(0), sha256: "", stable: false }
  }
}

function captureEvidence(ctx: PreparedContext, evidence: PromotionEvidence): VerifiedEvidence {
  const verified = validateEvidence(evidence, ctx.bindings)
  const manifestPath = join(ctx.runDirPath, "manifest.json")
  try {
    const existing = readStablePath(manifestPath, MAX_RECORD_BYTES, FILE_MODE, true)
    const value = JSON.parse(existing.toString("utf8")) as Manifest
    if (value.qualificationSha256 !== verified.qualificationSha256 || value.reviewSha256 !== verified.reviewSha256 ||
        value.approvalSha256 !== verified.approvalSha256 || value.approvalId !== verified.approvalId) fail("evidence-manifest-drift")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return verified
}

function ensureConsumedApproval(ctx: PreparedContext, evidence: VerifiedEvidence): void {
  const directoryPath = join(ctx.transactionRoot.path, "consumed-approvals")
  let dir: DirectoryContext
  try {
    dir = directoryContext(directoryPath, DIRECTORY_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    mkdirSync(directoryPath, { mode: DIRECTORY_MODE })
    dir = directoryContext(directoryPath, DIRECTORY_MODE)
    syncDirectory(ctx, ctx.transactionRoot)
  }
  const name = `${sha256(evidence.approvalId)}.json`
  const path = join(dir.path, name)
  try {
    lstatSync(path)
    fail("approval-already-consumed")
  } catch (error) {
    if (error instanceof PromotionError) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const receipt = Buffer.from(`${JSON.stringify({
    schema: "skillopt.consumed-approval.v1",
    approvalId: evidence.approvalId,
    approvalSha256: evidence.approvalSha256,
    runId: ctx.runId,
    bindingsSha256: ctx.bindingsSha256,
    targetRelativePath: TARGET_RELATIVE_PATH,
    candidateSha256: ctx.bindings.candidateSha256,
  })}\n`)
  let snapshot: FileSnapshot
  try { snapshot = writeExclusive(ctx, dir, name, receipt, FILE_MODE) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("approval-already-consumed")
    throw error
  }
  if (snapshot.sha256 !== sha256(receipt)) fail("approval-consumption-write-failed")
}

function lockNative(ctx: PreparedContext): Promise<() => Promise<void>> {
  nativeVersion(ctx)
  return new Promise((resolveLock, rejectLock) => {
    const child: ChildProcessWithoutNullStreams = spawn(ctx.helperPath, ["lock", ctx.transactionRoot.path, ctx.transactionRoot.dev, ctx.transactionRoot.ino], {
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    })
    const closed = once(child, "close")
    let stdout = ""
    let stderr = ""
    let settled = false
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      if (stdout.includes("\n") && !settled) {
        settled = true
        if (stdout !== "LOCKED\n") {
          child.stdin.end()
          rejectLock(new PromotionError("native-lock-protocol-invalid"))
          return
        }
        resolveLock(async () => {
          child.stdin.end()
          await closed
        })
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
    child.once("error", () => {
      if (!settled) { settled = true; rejectLock(new PromotionError("native-lock-start-failed")) }
    })
    child.once("close", (code) => {
      if (!settled) { settled = true; rejectLock(new PromotionError(code === 73 ? "promotion-busy" : "native-lock-failed")) }
      else if (code !== 0 && stderr.length) { /* lock is already gone; do not surface paths or helper diagnostics */ }
    })
  })
}

function fault(input: { faultInjection?: (point: PromotionFaultPoint) => void }, point: PromotionFaultPoint): void {
  input.faultInjection?.(point)
}

function openRetainedInode(ctx: PreparedContext, name: string, expected: FileSnapshot): number {
  const key = descriptorKey(ctx)
  const existing = retainedOriginalDescriptors.get(key)
  if (existing && existing.dev === expected.dev && existing.ino === expected.ino) return existing.fd
  const fd = openSync(join(ctx.target.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | DARWIN_O_CLOEXEC)
  if (!statMatchesSnapshot(fstatSync(fd), expected)) {
    closeSync(fd)
    fail("displaced-descriptor-drift")
  }
  retainedOriginalDescriptors.set(key, { fd, dev: expected.dev, ino: expected.ino })
  return fd
}

function classifySwap(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest, originalFd: number | undefined,
  allowAppend: boolean, exchangeAttempted: boolean, allowRaceAppend = allowAppend, nativeReport?: NativeExchangeReport): PromotionResult {
  let live: FileSnapshot
  let displaced: FileSnapshot
  let stageName: string
  try {
    live = helperInspect(ctx, ctx.target, "SKILL.md")
    const intent = records.findLast((record) => record.state === "SWAP_INTENT")
    stageName = typeof intent?.details.stageName === "string" ? intent.details.stageName : ""
    if (!stageName) fail("missing-stage-name")
    displaced = helperInspect(ctx, ctx.target, stageName)
  } catch {
    return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: exchangeAttempted, reason: "objects-uninspectable" }
  }
  const prepared = records.find((record) => record.state === "PREPARED")
  const staged = records.findLast((record) => record.state === "STAGED")
  const originalDev = String(prepared?.details.originalDev)
  const originalIno = String(prepared?.details.originalIno)
  const candidateDev = String(staged?.details.stageDev)
  const candidateIno = String(staged?.details.stageIno)
  const targetStillOriginal = live.sha256 === ctx.bindings.originalSha256 && live.dev === originalDev && live.ino === originalIno &&
    displaced.sha256 === ctx.bindings.candidateSha256 && displaced.dev === candidateDev && displaced.ino === candidateIno &&
    (live.mode & 0o7777) === manifest.originalMode && (displaced.mode & 0o7777) === manifest.originalMode
  if (targetStillOriginal) {
    if (allowAppend && records.at(-1)?.state === "SWAP_INTENT") {
      try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "swap-intent-without-observed-exchange" }) }
      catch { /* The unexchanged target and stage stay untouched. */ }
    }
    return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "exchange-not-observed" }
  }

  const targetIsCandidate = live.sha256 === ctx.bindings.candidateSha256 && live.dev === candidateDev && live.ino === candidateIno &&
    displaced.sha256 === ctx.bindings.originalSha256 && displaced.dev === originalDev && displaced.ino === originalIno &&
    (live.mode & 0o7777) === manifest.originalMode && (displaced.mode & 0o7777) === manifest.originalMode
  let original: { bytes: Buffer; sha256: string; stable: boolean } = { bytes: Buffer.alloc(0), sha256: "", stable: false }
  if (targetIsCandidate) {
    try {
      const fd = originalFd ?? openRetainedInode(ctx, stageName, displaced)
      original = descriptorSnapshot(fd, manifestBytesLength(ctx))
    } catch { /* A closed/replaced old inode is not evidence for expected publication. */ }
  }
  const reportStable = !nativeReport || (nativeReport.status === "EXCHANGED" && nativeReport.target !== null && nativeReport.stage !== null &&
    nativeSnapshotMatches(live, nativeReport.target) && nativeSnapshotMatches(displaced, nativeReport.stage))
  const expected = targetIsCandidate && reportStable && original.sha256 === ctx.bindings.originalSha256 && original.stable
  if (!expected) {
    if (allowRaceAppend && records.at(-1)?.state === "SWAP_INTENT") {
      try {
        appendJournal(ctx, records, "RACE_PRESERVED", {
          reason: "objects-differ-from-approved-inodes-or-bytes",
          targetName: "SKILL.md",
          stageName,
          liveSha256: live.sha256,
          liveDev: live.dev,
          liveIno: live.ino,
          displacedSha256: displaced.sha256,
          displacedDev: displaced.dev,
          displacedIno: displaced.ino,
          displacedStable: original.stable,
        })
      } catch {
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: exchangeAttempted,
          reason: "race-preserved-but-journal-not-durable" }
      }
    }
    return { state: allowRaceAppend ? "RACE_PRESERVED" : "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: exchangeAttempted,
      reason: "live-or-displaced-object-drift" }
  }
  if (allowAppend && records.at(-1)?.state === "SWAP_INTENT") {
    appendJournal(ctx, records, "SWAPPED_EXPECTED", {
      targetName: "SKILL.md",
      stageName: records.findLast((record) => record.state === "SWAP_INTENT")!.details.stageName,
      candidateSha256: live.sha256,
      candidateDev: live.dev,
      candidateIno: live.ino,
      candidateMode: live.mode,
      candidateSize: live.size,
      candidateMtimeNs: live.mtimeNs,
      candidateCtimeNs: live.ctimeNs,
      originalSha256: displaced.sha256,
      originalDev: displaced.dev,
      originalIno: displaced.ino,
      originalMode: displaced.mode,
      originalSize: displaced.size,
      originalMtimeNs: displaced.mtimeNs,
      originalCtimeNs: displaced.ctimeNs,
      originalStable: original.stable,
      nativeHelperProtocol: nativeReport?.protocol ?? NATIVE_HELPER_PROTOCOL,
      nativeHelperStatus: nativeReport?.status ?? "RECOVERY_CLASSIFICATION",
      ...(nativeReport ? { nativeTargetObservation: nativeReport.target, nativeStageObservation: nativeReport.stage } : {}),
    })
  }
  return { state: "SWAPPED_EXPECTED", idempotent: !allowAppend, raceMayHavePublishedCandidate: true }
}

function manifestBytesLength(ctx: PreparedContext): number {
  const backup = helperInspect(ctx, ctx.runDir, "original.bin")
  if (backup.sha256 !== ctx.bindings.originalSha256) fail("backup-digest-mismatch")
  return backup.size
}

function readBindingsFromRecords(records: readonly JournalRecord[]): Record<string, unknown> | null {
  const first = records[0]
  return first && isObject(first.details) ? first.details : null
}

function verifyRunJournal(ctx: PreparedContext, records: JournalRecord[]): Manifest {
  if (!records.length) fail("journal-missing")
  const first = readBindingsFromRecords(records)
  if (!first || first.runId !== ctx.runId || first.bindingsSha256 !== ctx.bindingsSha256 ||
      first.targetDirectoryDev !== ctx.target.dev || first.targetDirectoryIno !== ctx.target.ino) fail("journal-binding-mismatch")
  const manifest = readManifest(ctx)
  setRetentionDirectory(ctx, manifest)
  const prepared = records[0]!
  if (prepared.details.originalSha256 !== manifest.originalSha256 || prepared.details.candidateSha256 !== manifest.candidateSha256 ||
      prepared.details.backupName !== manifest.backupName || prepared.details.stageName !== manifest.stageName ||
      prepared.details.retentionDirectoryDev !== manifest.retentionDirectoryDev ||
      prepared.details.retentionDirectoryIno !== manifest.retentionDirectoryIno) fail("journal-manifest-mismatch")
  const staged = recordsByName(records, "STAGED")
  const swapIntent = recordsByName(records, "SWAP_INTENT")
  const swapped = recordsByName(records, "SWAPPED_EXPECTED")
  if (staged && (staged.details.stageName !== manifest.stageName || staged.details.candidateSha256 !== ctx.bindings.candidateSha256 ||
      staged.details.originalDev !== prepared.details.originalDev || staged.details.originalIno !== prepared.details.originalIno)) fail("staged-record-mismatch")
  if (swapIntent && (!validTransactionName(ctx.runId, swapIntent.details.stageName, "stage") ||
      swapIntent.details.stageName !== manifest.stageName || swapIntent.details.targetName !== "SKILL.md" ||
      swapIntent.details.stageDev !== staged?.details.stageDev || swapIntent.details.stageIno !== staged?.details.stageIno ||
      swapIntent.details.targetDev !== prepared.details.originalDev || swapIntent.details.targetIno !== prepared.details.originalIno ||
      swapIntent.details.approvalSha256 !== manifest.approvalSha256)) fail("swap-intent-mismatch")
  if (swapped && (!swapIntent || swapped.details.stageName !== manifest.stageName ||
      swapped.details.candidateSha256 !== ctx.bindings.candidateSha256 || swapped.details.originalSha256 !== ctx.bindings.originalSha256 ||
      swapped.details.candidateDev !== swapIntent.details.stageDev || swapped.details.candidateIno !== swapIntent.details.stageIno ||
      swapped.details.originalDev !== swapIntent.details.targetDev || swapped.details.originalIno !== swapIntent.details.targetIno ||
      swapped.details.originalStable !== true)) fail("swap-observation-mismatch")
  const rollbackPrepared = recordsByName(records, "ROLLBACK_PREPARED")
  const rollbackIntent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  const captured = recordsByName(records, "RACE_CAPTURED")
  const rollbackCaptured = recordsByName(records, "ROLLBACK_CAPTURED")
  if (rollbackPrepared && (!validTransactionName(ctx.runId, rollbackPrepared.details.rollbackStageName, "rollback") ||
      rollbackPrepared.details.stagePending !== true || rollbackPrepared.details.originalSha256 !== ctx.bindings.originalSha256 ||
      rollbackPrepared.details.candidateSha256 !== ctx.bindings.candidateSha256 || rollbackPrepared.details.approvalSha256 !== manifest.approvalSha256 ||
      rollbackPrepared.details.targetDev !== swapped?.details.candidateDev || rollbackPrepared.details.targetIno !== swapped?.details.candidateIno)) {
    fail("rollback-prepared-mismatch")
  }
  if (rollbackIntent && (!rollbackPrepared || !validTransactionName(ctx.runId, rollbackIntent.details.rollbackStageName, "rollback") ||
      rollbackIntent.details.rollbackStageName !== rollbackPrepared.details.rollbackStageName || rollbackIntent.details.targetName !== "SKILL.md" ||
      typeof rollbackIntent.details.captureName !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(rollbackIntent.details.captureName) ||
      rollbackIntent.details.retentionDirectoryDev !== manifest.retentionDirectoryDev ||
      rollbackIntent.details.retentionDirectoryIno !== manifest.retentionDirectoryIno ||
      rollbackIntent.details.originalSha256 !== ctx.bindings.originalSha256 || rollbackIntent.details.candidateSha256 !== ctx.bindings.candidateSha256 ||
      rollbackIntent.details.targetDev !== swapped?.details.candidateDev || rollbackIntent.details.targetIno !== swapped?.details.candidateIno ||
      rollbackIntent.details.rollbackStageDev === rollbackIntent.details.targetDev && rollbackIntent.details.rollbackStageIno === rollbackIntent.details.targetIno)) {
    fail("rollback-intent-mismatch")
  }
  if (captured && (!swapIntent || !validTransactionName(ctx.runId, captured.details.stageName, "stage") ||
      captured.details.stageName !== manifest.stageName || captured.details.nativeHelperProtocol !== NATIVE_HELPER_PROTOCOL ||
      captured.details.nativeHelperStatus !== "RACE_CAPTURED")) fail("race-capture-record-mismatch")
  if (rollbackCaptured && (!rollbackIntent || !validTransactionName(ctx.runId, rollbackCaptured.details.stageName, "rollback") ||
      rollbackCaptured.details.stageName !== rollbackIntent.details.rollbackStageName ||
      rollbackCaptured.details.nativeHelperProtocol !== NATIVE_HELPER_PROTOCOL ||
      rollbackCaptured.details.nativeHelperStatus !== "RACE_CAPTURED")) fail("rollback-capture-record-mismatch")
  for (const record of records) {
    if (record.state === "SWAP_INTENT" && (typeof record.details.captureName !== "string" ||
        !/^[A-Za-z0-9._-]{1,200}$/.test(record.details.captureName) ||
        record.details.retentionDirectoryDev !== manifest.retentionDirectoryDev ||
        record.details.retentionDirectoryIno !== manifest.retentionDirectoryIno)) fail("swap-intent-retention-binding-mismatch")
    if (record.state === "RACE_CAPTURED" && record.details.retainedArtifact !== undefined) {
      verifyRetainedArtifact(ctx, record.details.retainedArtifact)
    }
    if (record.state === "ROLLBACK_CAPTURED" && record.details.retainedArtifact !== undefined) {
      verifyRetainedArtifact(ctx, record.details.retainedArtifact)
    }
    if (record.state === "RACE_PRESERVED" && record.details.stageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.stageName, "stage")) fail("race-stage-name-invalid")
    if (record.state === "RACE_CAPTURED" && record.details.stageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.stageName, "stage")) fail("race-capture-stage-name-invalid")
    if (record.state === "ROLLBACK_RACE_PRESERVED" && record.details.rollbackStageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.rollbackStageName, "rollback")) fail("rollback-race-stage-name-invalid")
    if (record.state === "ROLLBACK_CAPTURED" && record.details.stageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.stageName, "rollback")) fail("rollback-capture-stage-name-invalid")
  }
  for (const state of ["RACE_PRESERVED", "ROLLBACK_RACE_PRESERVED"] as const) {
    const terminal = recordsByName(records, state)
    if (terminal?.details.captureRecordChecksum !== undefined) {
      const captureState = state === "RACE_PRESERVED" ? "RACE_CAPTURED" : "ROLLBACK_CAPTURED"
      const captureRecord = recordsByName(records, captureState)
      if (!captureRecord || terminal.details.captureRecordSeq !== captureRecord.seq ||
          terminal.details.captureRecordChecksum !== captureRecord.checksum ||
          stable(terminal.details.retainedArtifact) !== stable(captureRecord.details.retainedArtifact)) fail("retained-artifact-terminal-link-mismatch")
    }
  }
  return manifest
}

async function verifyEvidenceNow(input: { evidence: PromotionEvidence; verifyEvidence: () => Promise<void> }, ctx: PreparedContext): Promise<VerifiedEvidence> {
  const first = captureEvidence(ctx, input.evidence)
  await input.verifyEvidence()
  const second = captureEvidence(ctx, input.evidence)
  if (stable(first) !== stable(second)) fail("evidence-changed-during-verification")
  return second
}

function journalStateResult(state: JournalState, idempotent: boolean, raceMayHavePublishedCandidate = false): PromotionResult {
  if (state === "COMMITTED" || state === "LOAD_VERIFIED" || state === "SWAPPED_EXPECTED" || state === "RACE_PRESERVED" ||
      state === "RECOVERY_REQUIRED" || state === "ROLLBACK_SWAP_INTENT" || state === "ROLLBACK_RACE_PRESERVED" || state === "ROLLED_BACK") {
    return { state, idempotent, raceMayHavePublishedCandidate }
  }
  return { state: "RECOVERY_REQUIRED", idempotent, raceMayHavePublishedCandidate, reason: "publication-not-complete" }
}

function classifyCommitted(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest, rollback: boolean): PromotionResult {
  const latest = records.at(-1)
  if (!rollback && latest?.state === "COMMITTED" &&
      (typeof latest.details.witnessSha256 !== "string" || !HASH.test(latest.details.witnessSha256) ||
       !hasCommitReceipt(ctx, manifest, latest.details.witnessSha256))) {
    return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "commit-receipt-drift" }
  }
  try {
    const target = helperInspect(ctx, ctx.target, "SKILL.md")
    if (rollback) {
      if (latest?.state === "ROLLED_BACK" && sameRecordedSnapshot(target, latest.details, "original") &&
          (target.mode & 0o7777) === manifest.originalMode) return journalStateResult(latest.state, true)
    } else {
      const committedSnapshot = recordsByName(records, "SWAPPED_EXPECTED")?.details
      if (committedSnapshot && sameRecordedSnapshot(target, committedSnapshot, "candidate") &&
          (target.mode & 0o7777) === manifest.originalMode) return journalStateResult(latest!.state, true)
    }
  } catch { /* unsafe or missing target is drift */ }
  return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "terminal-target-drift" }
}

/** Performs only the durable exchange. It never reports application success; the fresh host witness is separate. */
export async function applySkillOptPromotion(input: ApplySkillOptPromotionInput): Promise<PromotionResult> {
  if (typeof input.verifyEvidence !== "function") fail("verify-evidence-callback-required")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  let targetFd: number | undefined
  let keepTargetFd = false
  try {
    nativeVersion(ctx)
    let existing = false
    try { setRunDirectory(ctx); existing = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (existing) {
      const records = readJournal(ctx)
      if (!records.length) return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "existing-run-without-journal" }
      const manifest = verifyRunJournal(ctx, records)
      const latest = records.at(-1)!
      const key = descriptorKey(ctx)
      const pending = pendingHeldExchanges.get(key)
      if (latest.state === "RECOVERY_REQUIRED" && pending?.operation === "apply" && pending.report.status === "RACE_HELD" &&
          latest.details.nativeHelperStatus === "RACE_HELD") {
        if (latest.details.retainedArtifact) verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
        return journalStateResult(latest.state, true, true)
      }
      if (latest.state === "RACE_CAPTURED") return finishCapturedRace(ctx, records, "apply")
      if (["SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"].includes(latest.state)) {
        return classifyCommitted(ctx, records, manifest, false)
      }
      if (latest.state === "SWAP_INTENT") {
        if (pending?.operation === "apply" && pending.report.status === "RACE_HELD") {
          await verifyEvidenceNow(input, ctx)
          appendJournal(ctx, records, "RECOVERY_REQUIRED", {
            ...heldRecoveryDetails(ctx, pending.report, "apply", String(latest.details.captureName)),
            stageName: latest.details.stageName,
          })
          return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true,
            reason: "native-helper-held-open-inodes-for-recovery" }
        }
        await verifyEvidenceNow(input, ctx)
        return classifySwap(ctx, records, manifest, retainedOriginalDescriptors.get(key)?.fd,
          true, true)
      }
      if (latest.state === "RACE_PRESERVED" && latest.details.retainedArtifact) verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
      return journalStateResult(latest.state, true, latest.state === "RACE_PRESERVED")
    }

    const evidence = await verifyEvidenceNow(input, ctx)
    const candidate = Buffer.from(input.candidateBytes)
    if (candidate.length === 0 || candidate.length > MAX_SKILL_BYTES || sha256(candidate) !== ctx.bindings.candidateSha256 ||
        ctx.bindings.candidateSha256 === ctx.bindings.originalSha256) fail("candidate-binding-invalid")
    const original = helperInspect(ctx, ctx.target, "SKILL.md")
    if (original.sha256 !== ctx.bindings.originalSha256 || original.mode & 0o7000) fail("original-binding-or-mode-invalid")
    targetFd = openTargetDescriptor(ctx, original)
    try {
      const stableOriginal = readFdStable(targetFd, original.size)
      if (!stableOriginal.equals(original.bytes) || sha256(stableOriginal) !== ctx.bindings.originalSha256) fail("original-unstable")
    } catch (error) { throw error }

    ensureRunDirectory(ctx)
    fault(input, "RUN_DIRECTORY_CREATED")
    const retention = createRetentionDirectory(ctx)
    const backup = writeExclusive(ctx, ctx.runDir, "original.bin", original.bytes, original.mode & 0o777)
    if (backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o777) !== (original.mode & 0o777)) fail("backup-verification-failed")
    fault(input, "ORIGINAL_BACKUP_DURABLE")
    const stageName = randomName(ctx.runId, "stage")
    const manifest: Manifest = {
      schema: "skillopt.promotion-manifest.v1",
      runId: ctx.runId,
      targetRelativePath: TARGET_RELATIVE_PATH,
      targetDirectoryDev: ctx.target.dev,
      targetDirectoryIno: ctx.target.ino,
      bindings: ctx.bindings,
      bindingsSha256: ctx.bindingsSha256,
      qualificationSha256: evidence.qualificationSha256,
      reviewSha256: evidence.reviewSha256,
      approvalSha256: evidence.approvalSha256,
      approvalId: evidence.approvalId,
      originalSha256: original.sha256,
      candidateSha256: ctx.bindings.candidateSha256,
      originalMode: original.mode & 0o7777,
      backupName: "original.bin",
      stageName,
      retentionDirectoryDev: retention.dev,
      retentionDirectoryIno: retention.ino,
    }
    writeExclusive(ctx, ctx.runDir, "manifest.json", Buffer.from(`${JSON.stringify(manifest)}\n`), FILE_MODE)
    fault(input, "MANIFEST_DURABLE")
    const records: JournalRecord[] = []
    appendJournal(ctx, records, "PREPARED", {
      runId: ctx.runId,
      bindingsSha256: ctx.bindingsSha256,
      targetDirectoryDev: ctx.target.dev,
      targetDirectoryIno: ctx.target.ino,
      targetRelativePath: TARGET_RELATIVE_PATH,
      originalSha256: original.sha256,
      candidateSha256: ctx.bindings.candidateSha256,
      originalDev: original.dev,
      originalIno: original.ino,
      originalMode: manifest.originalMode,
      backupName: "original.bin",
      stageName,
      retentionDirectoryDev: retention.dev,
      retentionDirectoryIno: retention.ino,
      approvalSha256: evidence.approvalSha256,
    })
    fault(input, "PREPARED")

    const staged = writeExclusive(ctx, ctx.target, stageName, candidate, original.mode & 0o777)
    fault(input, "STAGE_DURABLE")
    if (staged.sha256 !== ctx.bindings.candidateSha256 || (staged.mode & 0o777) !== (original.mode & 0o777)) fail("stage-verification-failed")
    appendJournal(ctx, records, "STAGED", {
      targetName: "SKILL.md", stageName, stageDev: staged.dev, stageIno: staged.ino,
      candidateSha256: staged.sha256, originalDev: original.dev, originalIno: original.ino,
    })
    fault(input, "STAGED")

    const freshEvidence = await verifyEvidenceNow(input, ctx)
    if (stable(freshEvidence) !== stable(evidence)) fail("evidence-drift-before-exchange")
    const current = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(current, original)) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-before-exchange", currentSha256: current.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "target-drift-before-exchange" }
    }
    ensureConsumedApproval(ctx, evidence)
    fault(input, "APPROVAL_CONSUMED")
    const stageRecheck = helperInspect(ctx, ctx.target, stageName)
    if (!sameIdentity(stageRecheck, staged)) fail("stage-drift-before-exchange")
    const captureName = randomName(ctx.runId, "capture")
    appendJournal(ctx, records, "SWAP_INTENT", {
      targetName: "SKILL.md", targetDev: original.dev, targetIno: original.ino,
      stageName, stageDev: staged.dev, stageIno: staged.ino,
      captureName, retentionDirectoryDev: retention.dev, retentionDirectoryIno: retention.ino,
      originalSha256: original.sha256, candidateSha256: staged.sha256,
      approvalSha256: evidence.approvalSha256,
    })
    fault(input, "SWAP_INTENT")

    const immediatelyFreshEvidence = await verifyEvidenceNow(input, ctx)
    if (stable(immediatelyFreshEvidence) !== stable(evidence)) fail("evidence-drift-before-exchange")
    const finalTarget = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(finalTarget, original)) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-at-exchange-boundary", currentSha256: finalTarget.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "target-drift-at-exchange-boundary" }
    }

    retainedOriginalDescriptors.set(descriptorKey(ctx), { fd: targetFd, dev: original.dev, ino: original.ino })
    keepTargetFd = true
    fault(input, "BEFORE_EXCHANGE")
    let exchangeError: unknown
    let exchangeReport: NativeExchangeReport | undefined
    try {
      exchangeReport = await runNativeExchange(ctx, nativeExchangeArgs(ctx, "SKILL.md", original, stageName, staged, captureName), "apply", async (report) => {
        appendJournal(ctx, records, "RECOVERY_REQUIRED", {
          ...heldRecoveryDetails(ctx, report, "apply", captureName), stageName,
        })
        fault(input, "RACE_HELD_JOURNALED")
      })
    } catch (error) {
      if (pendingHeldExchanges.has(descriptorKey(ctx))) throw error
      exchangeError = error
    }
    if (exchangeReport?.status === "RACE_HELD") {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (exchangeReport?.status === "RACE_CAPTURED") {
      let capturedResult: PromotionResult
      try {
        capturedResult = capturedRaceResult(ctx, records, exchangeReport, "apply", stageName, captureName)
      }
      catch (error) {
        if (records.at(-1)?.state === "SWAP_INTENT" || records.at(-1)?.state === "RACE_CAPTURED") {
          try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "native-capture-record-incomplete" }) } catch { /* Keep the last durable record. */ }
        }
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true,
          reason: error instanceof PromotionError ? error.code : "native-capture-record-incomplete" }
      }
      fault(input, "EXCHANGE_COMPLETED")
      return capturedResult
    }
    if (exchangeReport) fault(input, "EXCHANGE_COMPLETED")
    let result: PromotionResult
    try {
      result = classifySwap(ctx, records, manifest, targetFd, !exchangeError, true, true, exchangeReport)
    } catch {
      result = { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "exchange-classification-failed" }
    }
    if (exchangeError && result.state === "SWAPPED_EXPECTED") {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "exchange-flush-ambiguous" }
    }
    if (result.state === "SWAPPED_EXPECTED") fault(input, "SWAPPED_EXPECTED")
    return result
  } finally {
    if (targetFd !== undefined && !keepTargetFd) closeSync(targetFd)
    await release()
  }
}

function parseWitness(bytes: Uint8Array, bindings: PromotionBindings, expectedFileSha256: string): PromotionLoadWitness {
  const buffer = Buffer.from(bytes)
  if (buffer.length === 0 || buffer.length > MAX_RECORD_BYTES) fail("witness-size-invalid")
  const text = buffer.toString("utf8")
  if (!Buffer.from(text).equals(buffer)) fail("witness-invalid-utf8")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return fail("witness-invalid-json") }
  if (!isObject(parsed) || !sameKeys(parsed, [
    "schema", "experimentId", "rootBinding", "runtimeSha256", "observedAt", "hostVersion", "executableSha256", "pluginSha256",
    "sdkSha256", "configSha256", "sessionId", "messageId", "parentMessageId", "callId", "skillName", "targetRelativePath",
    "stagedFileSha256Before", "stagedFileSha256After", "expectedBodySha256", "returnedBodySha256", "returnedPayloadSha256",
    "parserVersion", "hashBases", "loadedOriginalFileSha256", "originalLoadedByteAttestation",
  ]) || parsed.schema !== WITNESS_SCHEMA || parsed.experimentId !== bindings.runId || parsed.rootBinding !== bindings.rootBinding ||
      parsed.runtimeSha256 !== bindings.runtimeSha256 || parsed.hostVersion !== "1.18.33" || parsed.skillName !== "llm-wiki" ||
      parsed.targetRelativePath !== TARGET_RELATIVE_PATH || parsed.parserVersion !== "opencode-1.18.33.skill-output.v1" ||
      parsed.stagedFileSha256Before !== expectedFileSha256 || parsed.stagedFileSha256After !== expectedFileSha256 ||
      typeof parsed.expectedBodySha256 !== "string" || !HASH.test(parsed.expectedBodySha256) || parsed.expectedBodySha256 !== parsed.returnedBodySha256 ||
      typeof parsed.returnedPayloadSha256 !== "string" || !HASH.test(parsed.returnedPayloadSha256) ||
      typeof parsed.observedAt !== "number" || !Number.isSafeInteger(parsed.observedAt) || parsed.observedAt <= 0 || parsed.loadedOriginalFileSha256 !== null ||
      parsed.originalLoadedByteAttestation !== false || !ID.test(String(parsed.sessionId)) || !ID.test(String(parsed.messageId)) ||
      !ID.test(String(parsed.parentMessageId)) || !ID.test(String(parsed.callId))) fail("witness-binding-invalid")
  for (const key of ["executableSha256", "pluginSha256", "sdkSha256", "configSha256"] as const) {
    if (typeof parsed[key] !== "string" || !HASH.test(parsed[key] as string)) fail("witness-runtime-digest-invalid")
  }
  const bases = parsed.hashBases
  if (!isObject(bases) || !sameKeys(bases, ["stagedFile", "expectedBody", "returnedBody", "returnedPayload"]) ||
      bases.stagedFile !== "staged-file-utf8.v1" || bases.expectedBody !== "expected-host-body-1.18.33.v1" ||
      bases.returnedBody !== "observed-returned-body-1.18.33.v1" || bases.returnedPayload !== "returned-payload-utf8.v1") fail("witness-hash-bases-invalid")
  return parsed as unknown as PromotionLoadWitness
}

function verifyArtifactsAtExpectedSwap(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest): {
  live: FileSnapshot; displaced: FileSnapshot; stageName: string; candidate: FileSnapshot; original: FileSnapshot
} {
  const intent = records.findLast((record) => record.state === "SWAP_INTENT")
  const observed = recordsByName(records, "SWAPPED_EXPECTED")?.details
  const stageName = intent?.details.stageName
  if (typeof stageName !== "string" || !observed) fail("missing-swap-observation")
  const live = helperInspect(ctx, ctx.target, "SKILL.md")
  const displaced = helperInspect(ctx, ctx.target, stageName)
  if (!sameRecordedSnapshot(live, observed, "candidate") || !sameRecordedSnapshot(displaced, observed, "original") ||
      (live.mode & 0o7777) !== manifest.originalMode || (displaced.mode & 0o7777) !== manifest.originalMode ||
      displaced.dev !== String(intent?.details.targetDev) || displaced.ino !== String(intent?.details.targetIno)) fail("swapped-artifacts-drift")
  return { live, displaced, stageName, candidate: live, original: displaced }
}

function preserveSwapRace(ctx: PreparedContext, records: JournalRecord[], reason: string): PromotionResult {
  const intent = recordsByName(records, "SWAP_INTENT")
  const stageName = intent?.details.stageName
  if (typeof stageName !== "string") return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason }
  let liveSha256: string | null = null
  let displacedSha256: string | null = null
  try {
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, stageName)
    liveSha256 = live.sha256
    displacedSha256 = displaced.sha256
  } catch { /* Keep both names untouched when safe descriptor inspection fails. */ }
  if (records.at(-1)?.state === "SWAPPED_EXPECTED" || records.at(-1)?.state === "LOAD_VERIFIED") {
    try {
      appendJournal(ctx, records, "RACE_PRESERVED", {
        reason, targetName: "SKILL.md", stageName, liveSha256, displacedSha256,
      })
    } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "race-state-not-durable" }
    }
  }
  return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason }
}

function getRetainedOriginal(ctx: PreparedContext, name: string, expected: FileSnapshot): number {
  const key = descriptorKey(ctx)
  const current = retainedOriginalDescriptors.get(key)
  if (current && current.dev === expected.dev && current.ino === expected.ino) return current.fd
  const fd = openSync(join(ctx.target.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | DARWIN_O_CLOEXEC)
  const st = fstatSync(fd)
  if (!statMatchesSnapshot(st, expected)) { closeSync(fd); fail("displaced-descriptor-drift") }
  retainedOriginalDescriptors.set(key, { fd, dev: expected.dev, ino: expected.ino })
  return fd
}

function validateWitnessReference(reference: PromotionRecordRef): Buffer {
  const result = readSecureRecord(reference)
  return result.bytes
}

function commitReceiptPayload(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema: "skillopt.promotion-commit.v1",
    runId: ctx.runId,
    rootBinding: ctx.bindings.rootBinding,
    bindingsSha256: ctx.bindingsSha256,
    qualificationSha256: manifest.qualificationSha256,
    reviewSha256: manifest.reviewSha256,
    approvalSha256: manifest.approvalSha256,
    originalSha256: ctx.bindings.originalSha256,
    candidateSha256: ctx.bindings.candidateSha256,
    witnessSha256,
  })}\n`)
}

function hasCommitReceipt(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): boolean {
  try { return readStablePath(join(ctx.runDirPath, "commit.json"), MAX_RECORD_BYTES, FILE_MODE, true).equals(commitReceiptPayload(ctx, manifest, witnessSha256)) }
  catch { return false }
}

function createCommitReceipt(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): void {
  const payload = commitReceiptPayload(ctx, manifest, witnessSha256)
  const path = join(ctx.runDirPath, "commit.json")
  try {
    const prior = readStablePath(path, MAX_RECORD_BYTES, FILE_MODE, true)
    if (!prior.equals(payload)) fail("commit-receipt-conflict")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    writeExclusive(ctx, ctx.runDir, "commit.json", payload, FILE_MODE)
  }
}

/** Adds the independently observed, hash-bound production load witness and commits only after rechecking both inodes. */
export async function recordLoadVerification(input: RecordLoadVerificationInput): Promise<PromotionResult> {
  if (typeof input.verifyWitness !== "function") fail("verify-witness-callback-required")
  validBindings(input.bindings)
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    if (latest.state === "COMMITTED") {
      if (latest.details.witnessSha256 !== input.witness.sha256) fail("committed-witness-mismatch")
      return classifyCommitted(ctx, records, manifest, false)
    }
    if (latest.state !== "SWAPPED_EXPECTED" && latest.state !== "LOAD_VERIFIED") fail("not-awaiting-load-witness")
    if (latest.state === "LOAD_VERIFIED" && latest.details.witnessSha256 !== input.witness.sha256) fail("load-witness-replay-mismatch")
    const bytes = validateWitnessReference(input.witness)
    const witness = parseWitness(bytes, ctx.bindings, ctx.bindings.candidateSha256)
    if (witness.runtimeSha256 !== ctx.bindings.runtimeSha256) fail("witness-runtime-binding-mismatch")
    let before: ReturnType<typeof verifyArtifactsAtExpectedSwap>
    try { before = verifyArtifactsAtExpectedSwap(ctx, records, manifest) }
    catch { return preserveSwapRace(ctx, records, "objects-drifted-before-live-witness") }
    const originalFd = getRetainedOriginal(ctx, before.stageName, before.displaced)
    const old = descriptorSnapshot(originalFd, before.displaced.size)
    if (!old.stable || old.sha256 !== ctx.bindings.originalSha256) {
      if (latest.state === "SWAPPED_EXPECTED") appendJournal(ctx, records, "RACE_PRESERVED", {
        reason: "displaced-original-changed-through-retained-descriptor", stageName: before.stageName,
        displacedStable: old.stable, displacedSha256: old.sha256,
      })
      return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "displaced-original-changed" }
    }
    await input.verifyWitness(bytes, ctx.bindings, ctx.bindings.candidateSha256)
    const reread = validateWitnessReference(input.witness)
    if (sha256(reread) !== sha256(bytes)) fail("witness-changed-during-verification")
    let after: ReturnType<typeof verifyArtifactsAtExpectedSwap>
    try { after = verifyArtifactsAtExpectedSwap(ctx, records, manifest) }
    catch { return preserveSwapRace(ctx, records, "objects-drifted-during-live-witness") }
    const oldAfter = descriptorSnapshot(originalFd, after.displaced.size)
    if (!sameIdentity(before.live, after.live) || !sameIdentity(before.displaced, after.displaced) || !oldAfter.stable ||
        oldAfter.sha256 !== ctx.bindings.originalSha256) {
      if (latest.state === "SWAPPED_EXPECTED") appendJournal(ctx, records, "RACE_PRESERVED", {
        reason: "objects-changed-during-live-witness", stageName: before.stageName, displacedStable: oldAfter.stable,
        targetSha256: after.live.sha256, displacedSha256: oldAfter.sha256,
      })
      return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "objects-changed-during-live-witness" }
    }
    if (latest.state === "SWAPPED_EXPECTED") {
      appendJournal(ctx, records, "LOAD_VERIFIED", {
        witnessSha256: input.witness.sha256,
        targetSha256: after.live.sha256,
        returnedBodySha256: witness.returnedBodySha256,
        expectedBodySha256: witness.expectedBodySha256,
      })
      input.faultInjection?.("LOAD_VERIFIED")
    }
    createCommitReceipt(ctx, manifest, input.witness.sha256)
    input.faultInjection?.("COMMIT_RECEIPT_DURABLE")
    if (records.at(-1)?.state === "LOAD_VERIFIED") appendJournal(ctx, records, "COMMITTED", {
      witnessSha256: input.witness.sha256, candidateSha256: ctx.bindings.candidateSha256,
    })
    const final = helperInspect(ctx, ctx.target, "SKILL.md")
    if (final.sha256 !== ctx.bindings.candidateSha256 || final.dev !== after.live.dev || final.ino !== after.live.ino) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-after-commit-marker", targetSha256: final.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "target-drift-after-commit-marker" }
    }
    input.faultInjection?.("COMMITTED")
    const key = descriptorKey(ctx)
    const retained = retainedOriginalDescriptors.get(key)
    if (retained) { closeSync(retained.fd); retainedOriginalDescriptors.delete(key) }
    return { state: "COMMITTED", idempotent: latest.state === "LOAD_VERIFIED", raceMayHavePublishedCandidate: true }
  } finally {
    await release()
  }
}

function recordsByName(records: readonly JournalRecord[], state: JournalState): JournalRecord | undefined {
  return [...records].reverse().find((record) => record.state === state)
}

function classifyRollback(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest, allowAppend: boolean): PromotionResult {
  const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  if (!intent || typeof intent.details.rollbackStageName !== "string") return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-intent-missing" }
  try {
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, intent.details.rollbackStageName)
    const approvedCandidate = recordsByName(records, "SWAPPED_EXPECTED")?.details
    const notExchanged = approvedCandidate !== undefined && sameRecordedSnapshot(live, approvedCandidate, "candidate") &&
      live.dev === String(intent.details.targetDev) && live.ino === String(intent.details.targetIno) && displaced.sha256 === ctx.bindings.originalSha256 &&
      displaced.dev === String(intent.details.rollbackStageDev) && displaced.ino === String(intent.details.rollbackStageIno)
    if (notExchanged) {
      if (allowAppend && records.at(-1)?.state === "ROLLBACK_SWAP_INTENT") {
        try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "rollback-intent-without-observed-exchange" }) }
        catch { /* The candidate and original stage remain untouched. */ }
      }
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-exchange-not-observed" }
    }
    const ok = live.sha256 === ctx.bindings.originalSha256 && live.dev === String(intent.details.rollbackStageDev) &&
      live.ino === String(intent.details.rollbackStageIno) && displaced.sha256 === ctx.bindings.candidateSha256 &&
      displaced.dev === String(intent.details.targetDev) && displaced.ino === String(intent.details.targetIno) &&
      (live.mode & 0o7777) === manifest.originalMode && (displaced.mode & 0o7777) === manifest.originalMode
    if (!ok) {
      if (allowAppend && records.at(-1)?.state === "ROLLBACK_SWAP_INTENT") appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-live-or-displaced-object-drift", rollbackStageName: intent.details.rollbackStageName,
        liveSha256: live.sha256, displacedSha256: displaced.sha256,
        liveDev: live.dev, liveIno: live.ino, displacedDev: displaced.dev, displacedIno: displaced.ino,
      })
      return { state: allowAppend ? "ROLLBACK_RACE_PRESERVED" : "RECOVERY_REQUIRED", idempotent: false,
        raceMayHavePublishedCandidate: false, reason: "rollback-object-drift" }
    }
    return { state: "ROLLBACK_SWAP_INTENT", idempotent: true, raceMayHavePublishedCandidate: false }
  } catch {
    return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-uninspectable" }
  }
}

/** Classifies durable recovery evidence; it never repeats an exchange or deletes an artifact. */
export async function recoverSkillOptPromotion(input: RecoverSkillOptPromotionInput): Promise<PromotionResult> {
  if (typeof input.verifyEvidence !== "function") fail("verify-evidence-callback-required")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    let records: JournalRecord[]
    try { records = readJournal(ctx) } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "journal-invalid-or-torn" }
    }
    if (!records.length) return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "journal-missing" }
    let manifest: Manifest
    try { manifest = verifyRunJournal(ctx, records) } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "journal-binding-mismatch" }
    }
    const latest = records.at(-1)!
    const pending = pendingHeldExchanges.get(descriptorKey(ctx))
    try {
      const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
      if (backup.sha256 !== manifest.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) {
        return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "backup-drift" }
      }
    } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "backup-unavailable" }
    }
    if (pending?.report.status === "RACE_HELD" && latest.state === "RECOVERY_REQUIRED" &&
        latest.details.nativeHelperStatus === "RACE_HELD" && latest.details.exchangeKind === pending.operation) {
      if (latest.details.retainedArtifact) verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
      return journalStateResult(latest.state, true, true)
    }
    if (pending?.report.status === "RACE_HELD" &&
        ((latest.state === "SWAP_INTENT" && pending.operation === "apply") ||
         (latest.state === "ROLLBACK_SWAP_INTENT" && pending.operation === "rollback"))) {
      await verifyEvidenceNow(input, ctx)
      const intent = latest.details
      const stageName = pending.operation === "apply" ? intent.stageName : intent.rollbackStageName
      const captureName = intent.captureName
      appendJournal(ctx, records, "RECOVERY_REQUIRED", {
        ...heldRecoveryDetails(ctx, pending.report, pending.operation, String(captureName)),
        ...(pending.operation === "apply" ? { stageName } : { rollbackStageName: stageName }),
      })
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: pending.operation === "apply",
        reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (latest.state === "RECOVERY_REQUIRED" && latest.details.nativeHelperStatus === "RACE_HELD" && latest.details.retainedArtifact) {
      try { verifyRetainedArtifact(ctx, latest.details.retainedArtifact) }
      catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "held-capture-artifact-unavailable" } }
    }
    if (latest.state === "SWAP_INTENT") {
      await verifyEvidenceNow(input, ctx)
      const status = classifySwap(ctx, records, manifest, retainedOriginalDescriptors.get(descriptorKey(ctx))?.fd, true, true)
      if (status.state !== "SWAPPED_EXPECTED") return status
      return status
    }
    if (latest.state === "RACE_CAPTURED") return finishCapturedRace(ctx, records, "apply")
    if (latest.state === "ROLLBACK_CAPTURED") return finishCapturedRace(ctx, records, "rollback")
    if (latest.state === "ROLLBACK_SWAP_INTENT") return classifyRollback(ctx, records, manifest, true)
    if (latest.state === "COMMITTED" || latest.state === "ROLLED_BACK") {
      const terminal = classifyCommitted(ctx, records, manifest, latest.state === "ROLLED_BACK")
      if (terminal.state === "RECOVERY_REQUIRED") {
        try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "terminal-target-drift" }) } catch { /* Keep contradictory history intact. */ }
        return terminal
      }
      const displacedName = latest.state === "ROLLED_BACK"
        ? recordsByName(records, "ROLLBACK_SWAP_INTENT")?.details.rollbackStageName
        : recordsByName(records, "SWAP_INTENT")?.details.stageName
      try {
        if (typeof displacedName !== "string") fail("terminal-displaced-name-missing")
        const displaced = helperInspect(ctx, ctx.target, displacedName)
        const expected = recordsByName(records, "SWAP_INTENT")?.details
        const expectedSha = latest.state === "ROLLED_BACK" ? ctx.bindings.candidateSha256 : ctx.bindings.originalSha256
        const expectedDev = latest.state === "ROLLED_BACK" ? expected?.stageDev : expected?.targetDev
        const expectedIno = latest.state === "ROLLED_BACK" ? expected?.stageIno : expected?.targetIno
        const originalSnapshot = recordsByName(records, "SWAPPED_EXPECTED")?.details
        const snapshotMatches = latest.state === "COMMITTED"
          ? originalSnapshot !== undefined && sameRecordedSnapshot(displaced, originalSnapshot, "original")
          : sameRecordedSnapshot(displaced, latest.details, "candidate")
        if (displaced.sha256 !== expectedSha || displaced.dev !== String(expectedDev) || displaced.ino !== String(expectedIno) || !snapshotMatches) {
          appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "terminal-displaced-object-drift", displacedSha256: displaced.sha256 })
          return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "terminal-displaced-object-drift" }
        }
      } catch {
        if (records.at(-1)?.state === "COMMITTED" || records.at(-1)?.state === "ROLLED_BACK") {
          try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "terminal-displaced-object-unavailable" }) } catch { /* Preserve terminal history. */ }
        }
        return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "terminal-displaced-object-unavailable" }
      }
      return terminal
    }
    if (latest.state === "SWAPPED_EXPECTED" || latest.state === "LOAD_VERIFIED") {
      await verifyEvidenceNow(input, ctx)
      try { verifyArtifactsAtExpectedSwap(ctx, records, manifest) } catch {
        try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "post-exchange-object-drift" }) } catch { /* Prior records remain evidence. */ }
        return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "post-exchange-object-drift" }
      }
      const status = classifyCommitted(ctx, records, manifest, false)
      if (status.state !== "RECOVERY_REQUIRED") return status
      try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "post-exchange-live-target-drift" }) } catch { /* Preserve state if durability fails. */ }
      return status
    }
    if (latest.state === "RACE_PRESERVED") {
      if (latest.details.retainedArtifact) {
        try { verifyRetainedArtifact(ctx, latest.details.retainedArtifact); return journalStateResult(latest.state, true, true) }
        catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "retained-race-artifact-unavailable" } }
      }
      const stageName = latest.details.stageName
      try {
        helperInspect(ctx, ctx.target, "SKILL.md")
        if (typeof stageName === "string") helperInspect(ctx, ctx.target, stageName)
        return journalStateResult(latest.state, true, true)
      } catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "preserved-object-unavailable" } }
    }
    if (latest.state === "ROLLBACK_RACE_PRESERVED") {
      if (latest.details.retainedArtifact) {
        try { verifyRetainedArtifact(ctx, latest.details.retainedArtifact); return journalStateResult(latest.state, true, false) }
        catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "retained-rollback-artifact-unavailable" } }
      }
      const stageName = latest.details.rollbackStageName
      try {
        helperInspect(ctx, ctx.target, "SKILL.md")
        if (typeof stageName === "string") helperInspect(ctx, ctx.target, stageName)
        return journalStateResult(latest.state, true, false)
      } catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "preserved-rollback-object-unavailable" } }
    }
    if (latest.state === "PREPARED" || latest.state === "STAGED" || latest.state === "RECOVERY_REQUIRED") {
      if (latest.state === "PREPARED" || latest.state === "STAGED") {
        try {
          const prepared = records.find((record) => record.state === "PREPARED")!
          const live = helperInspect(ctx, ctx.target, "SKILL.md")
          if (live.sha256 !== ctx.bindings.originalSha256 || live.dev !== String(prepared.details.originalDev) ||
              live.ino !== String(prepared.details.originalIno)) {
            return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "pre-swap-target-drift" }
          }
          const stageName = manifest.stageName
          try {
            const staged = helperInspect(ctx, ctx.target, stageName)
            if (latest.state === "STAGED" && (staged.sha256 !== ctx.bindings.candidateSha256 ||
                staged.dev !== String(latest.details.stageDev) || staged.ino !== String(latest.details.stageIno))) {
              return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "staged-object-drift" }
            }
          } catch {
            if (latest.state === "STAGED") return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "staged-object-unavailable" }
          }
        } catch {
          return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "pre-swap-objects-uninspectable" }
        }
      }
      return journalStateResult(latest.state, true)
    }
    return journalStateResult(latest.state, true)
  } finally {
    await release()
  }
}

/** Restores only the immutable backup after rechecking the live approved candidate; displaced objects remain named. */
export async function rollbackSkillOptPromotion(input: RollbackSkillOptPromotionInput): Promise<PromotionResult> {
  if (typeof input.verifyRollback !== "function") fail("verify-rollback-callback-required")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    if (latest.state === "ROLLED_BACK") return classifyCommitted(ctx, records, manifest, true)
    if (latest.state === "ROLLBACK_CAPTURED") return finishCapturedRace(ctx, records, "rollback")
    if (latest.state === "ROLLBACK_RACE_PRESERVED" && latest.details.retainedArtifact) {
      verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
      return journalStateResult(latest.state, true)
    }
    if (latest.state === "ROLLBACK_SWAP_INTENT" && pendingHeldExchanges.has(descriptorKey(ctx))) {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false,
        reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (latest.state === "ROLLBACK_SWAP_INTENT") return classifyRollback(ctx, records, manifest, true)
    if (!["SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"].includes(latest.state)) fail("rollback-not-authorized-for-state")
    await input.verifyRollback()
    const target = helperInspect(ctx, ctx.target, "SKILL.md")
    const expectedCandidate = recordsByName(records, "SWAPPED_EXPECTED")
    if (!expectedCandidate || !sameRecordedSnapshot(target, expectedCandidate.details, "candidate") ||
        (target.mode & 0o7777) !== manifest.originalMode) {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-live-target-drift" }
    }
    const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
    if (backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) fail("rollback-backup-invalid")
    const rollbackStageName = randomName(ctx.runId, "rollback")
    appendJournal(ctx, records, "ROLLBACK_PREPARED", {
      originalSha256: ctx.bindings.originalSha256, candidateSha256: ctx.bindings.candidateSha256,
      rollbackStageName, stagePending: true,
      targetDev: target.dev, targetIno: target.ino, approvalSha256: manifest.approvalSha256,
    })
    input.faultInjection?.("ROLLBACK_PREPARED")
    const stage = writeExclusive(ctx, ctx.target, rollbackStageName, backup.bytes, manifest.originalMode & 0o777)
    input.faultInjection?.("ROLLBACK_STAGE_DURABLE")
    if (stage.sha256 !== ctx.bindings.originalSha256 || (stage.mode & 0o7777) !== manifest.originalMode) fail("rollback-stage-invalid")
    await input.verifyRollback()
    const targetAgain = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(target, targetAgain)) return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-target-changed-before-exchange" }
    const targetFd = openTargetDescriptor(ctx, targetAgain)
    retainedRollbackDescriptors.set(descriptorKey(ctx), { fd: targetFd, dev: target.dev, ino: target.ino })
    const captureName = randomName(ctx.runId, "capture")
    appendJournal(ctx, records, "ROLLBACK_SWAP_INTENT", {
      targetName: "SKILL.md", targetDev: target.dev, targetIno: target.ino, targetMode: target.mode,
      targetSize: target.size, targetMtimeNs: target.mtimeNs, targetCtimeNs: target.ctimeNs,
      rollbackStageName, rollbackStageDev: stage.dev, rollbackStageIno: stage.ino,
      captureName, retentionDirectoryDev: retentionDirectory(ctx).dev, retentionDirectoryIno: retentionDirectory(ctx).ino,
      originalSha256: backup.sha256, candidateSha256: target.sha256,
    })
    input.faultInjection?.("ROLLBACK_SWAP_INTENT")
    input.faultInjection?.("BEFORE_ROLLBACK_EXCHANGE")
    let exchangeError: unknown
    let exchangeReport: NativeExchangeReport | undefined
    try {
      exchangeReport = await runNativeExchange(ctx, nativeExchangeArgs(ctx, "SKILL.md", target, rollbackStageName, stage, captureName), "rollback", async (report) => {
        appendJournal(ctx, records, "RECOVERY_REQUIRED", {
          ...heldRecoveryDetails(ctx, report, "rollback", captureName), rollbackStageName,
        })
        input.faultInjection?.("ROLLBACK_RACE_HELD_JOURNALED")
      })
    } catch (error) {
      if (pendingHeldExchanges.has(descriptorKey(ctx))) throw error
      exchangeError = error
    }
    if (exchangeReport?.status === "RACE_HELD") {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false,
        reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (exchangeReport?.status === "RACE_CAPTURED") {
      let capturedResult: PromotionResult
      try {
        capturedResult = capturedRaceResult(ctx, records, exchangeReport, "rollback", rollbackStageName, captureName)
      }
      catch (error) {
        if (records.at(-1)?.state === "ROLLBACK_SWAP_INTENT" || records.at(-1)?.state === "ROLLBACK_CAPTURED") {
          try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "native-capture-record-incomplete" }) } catch { /* Keep the last durable record. */ }
        }
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false,
          reason: error instanceof PromotionError ? error.code : "native-capture-record-incomplete" }
      }
      input.faultInjection?.("ROLLBACK_EXCHANGE_COMPLETED")
      return capturedResult
    }
    if (exchangeReport) input.faultInjection?.("ROLLBACK_EXCHANGE_COMPLETED")
    const result = classifyRollback(ctx, records, manifest, true)
    if (exchangeError && result.state === "ROLLBACK_SWAP_INTENT") return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-flush-ambiguous" }
    return result
  } finally {
    await release()
  }
}

/** Completes rollback only after the actual fresh original-byte load witness and the displaced candidate both recheck. */
export async function recordRollbackLoadVerification(input: RecordLoadVerificationInput): Promise<PromotionResult> {
  if (typeof input.verifyWitness !== "function") fail("verify-witness-callback-required")
  validBindings(input.bindings)
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    if (latest.state === "ROLLED_BACK") {
      if (latest.details.witnessSha256 !== input.witness.sha256) fail("committed-rollback-witness-mismatch")
      return classifyCommitted(ctx, records, manifest, true)
    }
    if (latest.state !== "ROLLBACK_SWAP_INTENT") fail("not-awaiting-rollback-witness")
    const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")!
    if (latest.details.witnessSha256 !== undefined && latest.details.witnessSha256 !== input.witness.sha256) fail("rollback-witness-replay-mismatch")
    const witnessBytes = validateWitnessReference(input.witness)
    parseWitness(witnessBytes, ctx.bindings, ctx.bindings.originalSha256)
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, String(intent.details.rollbackStageName))
    const approvedCandidate = recordsByName(records, "SWAPPED_EXPECTED")?.details
    const notExchanged = approvedCandidate !== undefined && sameRecordedSnapshot(live, approvedCandidate, "candidate") &&
      live.dev === String(intent.details.targetDev) && live.ino === String(intent.details.targetIno) && displaced.sha256 === ctx.bindings.originalSha256 &&
      displaced.dev === String(intent.details.rollbackStageDev) && displaced.ino === String(intent.details.rollbackStageIno)
    if (notExchanged) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "rollback-intent-without-observed-exchange" })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-exchange-not-observed" }
    }
    if (live.sha256 !== ctx.bindings.originalSha256 || live.dev !== String(intent.details.rollbackStageDev) ||
        live.ino !== String(intent.details.rollbackStageIno) || displaced.sha256 !== ctx.bindings.candidateSha256 ||
        displaced.dev !== String(intent.details.targetDev) || displaced.ino !== String(intent.details.targetIno)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-objects-drifted-before-witness", rollbackStageName: intent.details.rollbackStageName,
        liveSha256: live.sha256, displacedSha256: displaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-drifted" }
    }
    const retainedKey = descriptorKey(ctx)
    const heldCandidate = retainedRollbackDescriptors.get(retainedKey)
    if (heldCandidate) {
      const descriptor = descriptorSnapshot(heldCandidate.fd, displaced.size)
      if (!descriptor.stable || descriptor.sha256 !== ctx.bindings.candidateSha256) {
        appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
          reason: "displaced-candidate-changed-through-retained-descriptor", displacedStable: descriptor.stable,
          rollbackStageName: intent.details.rollbackStageName, displacedSha256: descriptor.sha256,
        })
        return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "displaced-candidate-changed" }
      }
    }
    await input.verifyWitness(witnessBytes, ctx.bindings, ctx.bindings.originalSha256)
    const afterTarget = helperInspect(ctx, ctx.target, "SKILL.md")
    const afterDisplaced = helperInspect(ctx, ctx.target, String(intent.details.rollbackStageName))
    if (!sameIdentity(live, afterTarget) || !sameIdentity(displaced, afterDisplaced)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-objects-drifted-during-witness", rollbackStageName: intent.details.rollbackStageName,
        liveSha256: afterTarget.sha256, displacedSha256: afterDisplaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-drifted-during-witness" }
    }
    if (heldCandidate) {
      const descriptor = descriptorSnapshot(heldCandidate.fd, afterDisplaced.size)
      if (!descriptor.stable || descriptor.sha256 !== ctx.bindings.candidateSha256) {
        appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
          reason: "displaced-candidate-changed-during-witness", displacedStable: descriptor.stable,
          rollbackStageName: intent.details.rollbackStageName, displacedSha256: descriptor.sha256,
        })
        return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "displaced-candidate-changed-during-witness" }
      }
    }
    input.faultInjection?.("ROLLBACK_LOAD_VERIFIED")
    appendJournal(ctx, records, "ROLLED_BACK", {
      witnessSha256: input.witness.sha256, originalSha256: ctx.bindings.originalSha256,
      originalDev: afterTarget.dev, originalIno: afterTarget.ino, originalMode: afterTarget.mode,
      originalSize: afterTarget.size, originalMtimeNs: afterTarget.mtimeNs, originalCtimeNs: afterTarget.ctimeNs,
      candidateSha256: afterDisplaced.sha256, candidateDev: afterDisplaced.dev, candidateIno: afterDisplaced.ino,
      candidateMode: afterDisplaced.mode, candidateSize: afterDisplaced.size,
      candidateMtimeNs: afterDisplaced.mtimeNs, candidateCtimeNs: afterDisplaced.ctimeNs,
    })
    input.faultInjection?.("ROLLED_BACK")
    if (heldCandidate) { closeSync(heldCandidate.fd); retainedRollbackDescriptors.delete(retainedKey) }
    return { state: "ROLLED_BACK", idempotent: false, raceMayHavePublishedCandidate: false }
  } finally {
    await release()
  }
}
