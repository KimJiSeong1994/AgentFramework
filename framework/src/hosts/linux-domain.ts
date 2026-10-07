import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"
import { spawn } from "node:child_process"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs"
import { isAbsolute, join, normalize, parse, sep } from "node:path"
import type {
  VerificationPreflight, VerificationReference, VerificationResult,
} from "../orchestration/verifier.ts"

const PROFILE_PATH = "/etc/lca-verifier/profile.json"
const CLIENT_PATH = "/usr/local/libexec/lca-verifier/client.py"
const UNIT_PATH = "/etc/systemd/system/lca-verifier.service"
const PRIVILEGED_POLICY_FILES = new Set([
  "/etc/polkit-1/rules.d/90-lca-verifier.rules",
  "/etc/sudoers.d/00-lca-verifier-deny",
])
const REQUIRED_PROFILE_FILES = [
  "/usr/local/libexec/lca-verifier/gate.py",
  "/usr/local/libexec/lca-verifier/runner.py",
  CLIENT_PATH,
  UNIT_PATH,
  "/etc/systemd/system/lca-verifier-gate.service",
  "/etc/systemd/system/lca.slice",
  "/etc/polkit-1/rules.d/90-lca-verifier.rules",
  "/etc/sudoers.d/00-lca-verifier-deny",
] as const
const PROTOCOL = "lca.linux-verifier.v1"
const PROFILE_SCHEMA = "lca.linux-verifier.profile.v1"
const RECEIPT_SCHEMA = "lca.linux-verifier.retirement.v1"
const RECEIPT_EVIDENCE = "authenticated Linux gate retirement"
const UNIT = "lca-verifier.service"
const CONTROL_GROUP = "/lca.slice/lca-verifier.service"
const MAX_PROFILE_BYTES = 1024 * 1024
const MAX_PROFILE_FILE_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_CLIENT_REQUEST_BYTES = Math.ceil(MAX_ARCHIVE_BYTES * 4 / 3) + 256 * 1024
const MAX_CLIENT_RESPONSE_BYTES = 1024 * 1024
const RETIREMENT_MESSAGE_IDS = new Set([
  "9d1aaa27d60140bd96365438aad20286", // Stopped.
  "7ad2d189f7e94e70a38c781354912448", // Deactivated.
  "d9b373ed55a64feb8242e02dbe79a49c", // Failed after the owned domain retired.
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TICKET = /^[0-9a-f]{32}$/
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/

type LinuxVerifierProfile = {
  schema: typeof PROFILE_SCHEMA
  unit: typeof UNIT
  controllerUID: number
  verifierUID: number
  publicKeyPem: string
  files: Record<string, string>
  qualified: boolean
}

export type LinuxRootPathMetadata = {
  uid: number
  mode: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}
export type LinuxRootFileMetadata = LinuxRootPathMetadata & { size: number }

type TrustedProfile = { profile: LinuxVerifierProfile; publicKey: ReturnType<typeof createPublicKey> }
type NativeProfile = { trusted?: TrustedProfile; problems: string[] }
export type LinuxVerifierOperation = "preflight" | "prepare" | "start" | "inspect" | "cancel"

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const ownKeysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0
const bool = (value: unknown): value is boolean => typeof value === "boolean"

/** Pure metadata predicate used by profile validation; it does not authenticate a verifier result. */
export function linuxRootPathMetadataTrusted(metadata: LinuxRootPathMetadata, expected: "file" | "directory"): boolean {
  return Number.isSafeInteger(metadata.uid) && metadata.uid === 0 && Number.isSafeInteger(metadata.mode) &&
    (metadata.mode & 0o022) === 0 && !metadata.isSymbolicLink &&
    (expected === "file" ? metadata.isFile && !metadata.isDirectory : metadata.isDirectory && !metadata.isFile)
}

/** Requires the complete initial-namespace mapping, not a partial or subordinate user namespace. */
export function linuxUserNamespaceMapTrusted(contents: string): boolean {
  if (typeof contents !== "string") return false
  const line = contents.endsWith("\r\n") ? contents.slice(0, -2) : contents.endsWith("\n") ? contents.slice(0, -1) : contents
  return !/[\r\n]/.test(line) && /^[\t ]*0[\t ]+0[\t ]+4294967295[\t ]*$/.test(line)
}

/** Open-FD metadata predicate for bounded root-owned regular files. */
export function linuxRootFileMetadataTrusted(metadata: LinuxRootFileMetadata, maxBytes: number): boolean {
  return linuxRootPathMetadataTrusted(metadata, "file") && Number.isSafeInteger(maxBytes) && maxBytes >= 0 &&
    Number.isSafeInteger(metadata.size) && metadata.size >= 0 && metadata.size <= maxBytes
}

function pathMetadata(stats: Stats): LinuxRootPathMetadata {
  return {
    uid: stats.uid,
    mode: stats.mode,
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  }
}

function secureRootOwnedPath(path: string, finalType: "file" | "directory"): boolean {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) return false
  const root = parse(path).root
  let current = root
  const components = path.slice(root.length).split(sep).filter(Boolean)
  if (components.length === 0) return false
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!)
    let stats: Stats
    try { stats = lstatSync(current) } catch { return false }
    const expected = index === components.length - 1 ? finalType : "directory"
    if (!linuxRootPathMetadataTrusted(pathMetadata(stats), expected)) return false
  }
  return true
}

function readSecureRootFile(path: string, maxBytes: number): Buffer {
  if (!secureRootOwnedPath(path, "file")) throw new Error(`untrusted root-owned verifier path: ${path}`)
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(path, flags)
  try {
    const before = fstatSync(fd)
    const metadata = { ...pathMetadata(before), size: before.size }
    if (!linuxRootFileMetadataTrusted(metadata, maxBytes)) throw new Error(`untrusted or oversized verifier file: ${path}`)
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (count === 0) break
      size += count
    }
    const after = fstatSync(fd)
    const afterMetadata = { ...pathMetadata(after), size: after.size }
    if (!linuxRootFileMetadataTrusted(afterMetadata, maxBytes) || after.size !== before.size || size !== before.size) {
      throw new Error(`verifier file changed while reading: ${path}`)
    }
    return bytes.subarray(0, size)
  } finally { closeSync(fd) }
}

function safeProfileShape(value: unknown): value is LinuxVerifierProfile {
  if (!object(value) || !ownKeysAre(value, ["schema", "unit", "controllerUID", "verifierUID", "publicKeyPem", "files", "qualified"])) return false
  if (value.schema !== PROFILE_SCHEMA || value.unit !== UNIT || !positiveInteger(value.controllerUID) ||
    !positiveInteger(value.verifierUID) || value.controllerUID === value.verifierUID ||
    !text(value.publicKeyPem, 8192) || !bool(value.qualified) || !object(value.files) ||
    Object.keys(value.files).length !== REQUIRED_PROFILE_FILES.length) return false
  const filePaths = Object.keys(value.files)
  if (!REQUIRED_PROFILE_FILES.every(path => Object.hasOwn(value.files as object, path)) ||
    !filePaths.every(path => (REQUIRED_PROFILE_FILES as readonly string[]).includes(path))) return false
  for (const path of filePaths) {
    if (!isAbsolute(path) || normalize(path) !== path || typeof value.files[path] !== "string" ||
      !SHA256.test(value.files[path] as string)) return false
  }
  return true
}

function bootID(): string | null {
  if (process.platform !== "linux") return null
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    return UUID.test(value) ? value : null
  } catch { return null }
}

function loadNativeProfile(options: { qualification: boolean }): NativeProfile {
  const problems: string[] = []
  if (process.platform !== "linux") return { problems: ["native Linux verifier authority is unavailable off Linux"] }
  if (typeof process.getuid !== "function") return { problems: ["controller UID cannot be established"] }
  try {
    if (!linuxUserNamespaceMapTrusted(readFileSync("/proc/self/uid_map", "utf8")) ||
      !linuxUserNamespaceMapTrusted(readFileSync("/proc/self/gid_map", "utf8"))) {
      return { problems: ["current process is not in the full initial user namespace"] }
    }
  } catch { return { problems: ["current process namespace maps are unavailable"] } }
  if (!bootID()) problems.push("current Linux boot identity is unavailable")
  let bytes: Buffer
  try { bytes = readSecureRootFile(PROFILE_PATH, MAX_PROFILE_BYTES) }
  catch { return { problems: [...problems, "fixed root-owned verifier profile is absent or unsafe"] } }
  let parsed: unknown
  try {
    const source = bytes.toString("utf8")
    if (!Buffer.from(source, "utf8").equals(bytes)) throw new TypeError("invalid UTF-8")
    parsed = JSON.parse(source)
  } catch { return { problems: [...problems, "fixed verifier profile is invalid JSON"] } }
  if (!safeProfileShape(parsed)) return { problems: [...problems, "fixed verifier profile has an unsupported schema"] }
  const profile = parsed
  if (process.getuid() !== profile.controllerUID) problems.push("current UID is not the configured verifier controller")
  if (!options.qualification && !profile.qualified) problems.push("root verifier profile is not qualified for production")
  for (const path of Object.keys(profile.files)) {
    // These root-only policy directories are intentionally inaccessible to the controller.
    // Their hashes remain mandatory in the profile; the authenticated gate verifies them
    // before activation and signing. Never broaden this exception to caller-selected paths.
    if (PRIVILEGED_POLICY_FILES.has(path)) continue
    try {
      const content = readSecureRootFile(path, MAX_PROFILE_FILE_BYTES)
      const digest = createHash("sha256").update(content).digest("hex")
      if (digest !== profile.files[path]) problems.push(`installed verifier file hash mismatch: ${path}`)
    } catch { problems.push(`installed verifier file is absent or unsafe: ${path}`) }
  }
  if (problems.length) return { problems }
  try {
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(profile.publicKeyPem)) throw new TypeError("private key material is forbidden in the verifier profile")
    const publicKey = createPublicKey(profile.publicKeyPem)
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("expected Ed25519 public key")
    return { trusted: { profile, publicKey }, problems: [] }
  } catch { return { problems: ["root verifier profile public key is invalid"] } }
}

function validReference(value: unknown): value is VerificationReference {
  if (!object(value) || !ownKeysAre(value, [
    "kind", "executionID", "profile", "invocationID", "inputSnapshotID", "inputDigest",
    "deadlineAt", "maxOutputChars", "unit", "bootID",
  ])) return false
  return value.kind === "verifier" && text(value.executionID, 256) && value.profile === "linux-single-use" &&
    typeof value.invocationID === "string" && TICKET.test(value.invocationID) &&
    typeof value.inputSnapshotID === "string" && TREE_ID.test(value.inputSnapshotID) &&
    typeof value.inputDigest === "string" && SHA256.test(value.inputDigest) &&
    createHash("sha256").update(value.inputSnapshotID, "utf8").digest("hex") === value.inputDigest &&
    Number.isSafeInteger(value.deadlineAt) && (value.deadlineAt as number) > 0 &&
    Number.isSafeInteger(value.maxOutputChars) && (value.maxOutputChars as number) > 0 &&
    (value.maxOutputChars as number) <= 65536 && value.unit === UNIT &&
    typeof value.bootID === "string" && UUID.test(value.bootID)
}

function sameReference(left: unknown, right: VerificationReference): boolean {
  if (!validReference(left)) return false
  return left.kind === right.kind && left.executionID === right.executionID && left.profile === right.profile &&
    left.invocationID === right.invocationID && left.inputSnapshotID === right.inputSnapshotID &&
    left.inputDigest === right.inputDigest && left.deadlineAt === right.deadlineAt &&
    left.maxOutputChars === right.maxOutputChars && left.unit === right.unit && left.bootID === right.bootID
}

function validReceipt(value: unknown, reference: VerificationReference): value is Record<string, unknown> {
  if (!object(value) || !ownKeysAre(value, ["schema", "reference", "binding", "retirement", "result"]) ||
    value.schema !== RECEIPT_SCHEMA || !sameReference(value.reference, reference) || !object(value.binding) ||
    !object(value.retirement) || !object(value.result)) return false
  const binding = value.binding
  if (!ownKeysAre(binding, ["unit", "bootID", "systemdInvocationID", "mainPID", "startTimeTicks", "cgroupPath", "device", "inode"]) ||
    binding.unit !== UNIT || binding.bootID !== reference.bootID ||
    typeof binding.systemdInvocationID !== "string" || !/^[0-9a-f]{32}$/.test(binding.systemdInvocationID) ||
    !Number.isSafeInteger(binding.mainPID) || (binding.mainPID as number) <= 1 ||
    !Number.isSafeInteger(binding.startTimeTicks) || (binding.startTimeTicks as number) < 0 ||
    binding.cgroupPath !== CONTROL_GROUP || !nonnegativeDecimal(binding.device) || !positiveDecimal(binding.inode)) return false
  const retirement = value.retirement
  if (!ownKeysAre(retirement, ["kind", "messageID"]) ||
    !["held-deleted-journal", "recovered-journal"].includes(String(retirement.kind)) ||
    typeof retirement.messageID !== "string" || !RETIREMENT_MESSAGE_IDS.has(retirement.messageID)) return false
  const result = value.result
  return ownKeysAre(result, ["parentExit", "timedOut", "cancelled", "inputIntegrity", "outputSha256"]) &&
    (result.parentExit === null || Number.isSafeInteger(result.parentExit) && (result.parentExit as number) >= -255 && (result.parentExit as number) <= 255) &&
    bool(result.timedOut) && bool(result.cancelled) &&
    ["unchanged", "changed", "unknown"].includes(String(result.inputIntegrity)) &&
    typeof result.outputSha256 === "string" && SHA256.test(result.outputSha256)
}

function positiveDecimal(value: unknown): boolean {
  return typeof value === "string" ? /^[1-9][0-9]{0,19}$/.test(value) : positiveInteger(value)
}

function nonnegativeDecimal(value: unknown): boolean {
  return typeof value === "string" ? /^(?:0|[1-9][0-9]{0,19})$/.test(value) :
    Number.isSafeInteger(value) && (value as number) >= 0
}

function integrityIsConservative(result: VerificationResult["integrity"], signed: unknown): boolean {
  if (signed === "unchanged") return ["unchanged", "changed", "unknown"].includes(result)
  if (signed === "changed") return result === "changed" || result === "unknown"
  return signed === "unknown" && result === "unknown"
}

/**
 * Cryptographic/schema conformance only. A caller-supplied key here never establishes native Linux authority;
 * use authenticateLinuxVerification for production admission.
 */
export function verifyLinuxVerificationCrypto(
  result: VerificationResult,
  reference: VerificationReference,
  publicKeyPem: string,
): boolean {
  try {
    if (!validReference(reference) || !object(result) || !ownKeysAre(result, [
      "profile", "parentExit", "timedOut", "cancelled", "isolationEstablished", "domainState", "integrity", "output", "proof",
    ]) || result.profile !== "linux-single-use" || result.parentExit !== null &&
      (!Number.isSafeInteger(result.parentExit) || result.parentExit < -255 || result.parentExit > 255) ||
      !bool(result.timedOut) || !bool(result.cancelled) || result.isolationEstablished !== true ||
      result.domainState !== "empty" || !["unchanged", "changed", "unknown"].includes(result.integrity) ||
      typeof result.output !== "string" || result.output.length > reference.maxOutputChars ||
      !object(result.proof) || !ownKeysAre(result.proof, ["reference", "evidence", "receipt", "signature"]) ||
      !sameReference(result.proof.reference, reference) || result.proof.evidence !== RECEIPT_EVIDENCE ||
      typeof result.proof.receipt !== "string" || Buffer.byteLength(result.proof.receipt, "utf8") > 16384 ||
      typeof result.proof.signature !== "string" || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(result.proof.signature)) return false
    const receiptBytes = Buffer.from(result.proof.receipt, "utf8")
    if (receiptBytes.toString("utf8") !== result.proof.receipt) return false
    const outputBytes = Buffer.from(result.output, "utf8")
    if (outputBytes.toString("utf8") !== result.output) return false
    const signature = Buffer.from(result.proof.signature, "base64")
    if (signature.byteLength !== 64 || signature.toString("base64") !== result.proof.signature) return false
    const publicKey = createPublicKey(publicKeyPem)
    if (publicKey.asymmetricKeyType !== "ed25519" || !verifySignature(null, receiptBytes, publicKey, signature)) return false
    const receipt = JSON.parse(result.proof.receipt) as unknown
    if (!validReceipt(receipt, reference)) return false
    const signedResult = receipt.result as Record<string, unknown>
    return signedResult.parentExit === result.parentExit && signedResult.timedOut === result.timedOut &&
      signedResult.cancelled === result.cancelled && integrityIsConservative(result.integrity, signedResult.inputIntegrity) &&
      createHash("sha256").update(outputBytes).digest("hex") === signedResult.outputSha256
  } catch { return false }
}

/** Native authority boundary: fixed root profile, installed file hashes and current boot are mandatory. */
export function authenticateLinuxVerification(result: VerificationResult, reference: VerificationReference): boolean {
  try {
    if (process.platform !== "linux" || !validReference(reference) || reference.bootID !== bootID()) return false
    const native = loadNativeProfile({ qualification: true })
    if (!native.trusted) return false
    if (native.trusted.profile.unit !== reference.unit || native.trusted.profile.controllerUID !== process.getuid?.()) return false
    return verifyLinuxVerificationCrypto(result, reference, native.trusted.profile.publicKeyPem)
  } catch { return false }
}

function parseClientResponse(bytes: Buffer): Record<string, unknown> {
  if (bytes.byteLength > MAX_CLIENT_RESPONSE_BYTES) throw new Error("Linux verifier client response exceeds limit")
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new TypeError("Linux verifier client response is not UTF-8")
  const response = JSON.parse(text) as unknown
  if (!object(response)) throw new TypeError("invalid Linux verifier client response")
  if (response.ok !== true) {
    const message = typeof response.error === "string" ? response.error.slice(0, 1024) : "gate refused the request"
    throw new Error(message)
  }
  return response
}

function clientRequest(operation: LinuxVerifierOperation, data?: Record<string, unknown>): string {
  if (data && (Object.hasOwn(data, "protocol") || Object.hasOwn(data, "op"))) throw new TypeError("invalid Linux verifier request envelope")
  const envelope: Record<string, unknown> = { ...(data ?? {}), protocol: PROTOCOL, op: operation }
  const serialized = JSON.stringify(envelope)
  if (Buffer.byteLength(serialized, "utf8") > MAX_CLIENT_REQUEST_BYTES) throw new Error("Linux verifier client request exceeds limit")
  return serialized
}

function checkClientReference(reference: VerificationReference): void {
  if (!validReference(reference)) throw new TypeError("invalid Linux verifier reference")
  if (reference.bootID !== bootID()) throw new Error("Linux verifier reference belongs to another boot")
}

function validateClientInput(operation: LinuxVerifierOperation, data: Record<string, unknown> | undefined): void {
  if (!["preflight", "prepare", "start", "inspect", "cancel"].includes(operation)) {
    throw new TypeError("unsupported Linux verifier operation")
  }
  if (operation === "preflight") {
    if (data !== undefined) throw new TypeError("preflight takes no caller data")
    return
  }
  if (operation !== "prepare") {
    if (!object(data) || !ownKeysAre(data, ["reference"])) throw new TypeError("invalid Linux verifier reference request")
    checkClientReference(data.reference as VerificationReference)
    return
  }
  if (!object(data) || !ownKeysAre(data, ["request"]) || !object(data.request) || !ownKeysAre(data.request, [
    "executionID", "profile", "command", "cwd", "inputSnapshotID", "inputDigest", "deadlineAt", "maxOutputChars", "inputArchive",
  ])) throw new TypeError("invalid Linux verifier prepare request")
  const request = data.request
  if (typeof request.executionID !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.executionID) ||
    request.profile !== "linux-single-use" ||
    typeof request.command !== "string" || request.command.length > 262_144 || request.command.includes("\0") ||
    typeof request.cwd !== "string" || request.cwd.length > 4096 || request.cwd.includes("\0") ||
    typeof request.inputSnapshotID !== "string" || !TREE_ID.test(request.inputSnapshotID) ||
    typeof request.inputDigest !== "string" || !SHA256.test(request.inputDigest) ||
    createHash("sha256").update(request.inputSnapshotID, "utf8").digest("hex") !== request.inputDigest ||
    !Number.isSafeInteger(request.deadlineAt) || (request.deadlineAt as number) <= Date.now() ||
    !Number.isSafeInteger(request.maxOutputChars) || (request.maxOutputChars as number) < 1 || (request.maxOutputChars as number) > 65536 ||
    typeof request.inputArchive !== "string" || request.inputArchive.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.inputArchive)) {
    throw new TypeError("invalid Linux verifier prepare request")
  }
  const archive = Buffer.from(request.inputArchive, "base64")
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES || archive.toString("base64") !== request.inputArchive) {
    throw new TypeError("Linux verifier input archive exceeds the fixed limit")
  }
}

/** Fixed-path client transport. The child receives a replacement environment and no caller-controlled key/path. */
export async function runLinuxVerifierClient(
  operation: LinuxVerifierOperation,
  data: Record<string, unknown> | undefined,
  deadlineAt: number,
  qualification = false,
): Promise<Record<string, unknown>> {
  if (typeof qualification !== "boolean") throw new TypeError("invalid Linux verifier qualification mode")
  if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) throw new Error("Linux verifier client deadline expired")
  validateClientInput(operation, data)
  const native = loadNativeProfile({ qualification })
  if (!native.trusted) throw new Error(native.problems.join("; ") || "Linux verifier authority is unavailable")
  const input = clientRequest(operation, data)
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(CLIENT_PATH, [], {
      shell: false,
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        PYTHONNOUSERSITE: "1",
        PYTHONSAFEPATH: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    const stdout = child.stdout
    const stdin = child.stdin
    if (!stdout || !stdin) {
      child.kill("SIGKILL")
      reject(new Error("Linux verifier client pipes are unavailable"))
      return
    }
    let settled = false
    let outputBytes = 0
    const chunks: Buffer[] = []
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      reject(error)
    }
    const timer = setTimeout(() => finishError(new Error("Linux verifier client deadline expired")), Math.max(1, deadlineAt - Date.now()))
    stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_CLIENT_RESPONSE_BYTES) {
        finishError(new Error("Linux verifier client response exceeds limit"))
        return
      }
      chunks.push(chunk)
    })
    stdin.on("error", error => finishError(error))
    child.once("error", error => finishError(error))
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (Date.now() >= deadlineAt) {
        reject(new Error("Linux verifier client deadline expired"))
        return
      }
      if (code !== 0) {
        reject(new Error(`Linux verifier client exited (${code ?? signal ?? "unknown"})`))
        return
      }
      try { resolve(parseClientResponse(Buffer.concat(chunks))) }
      catch (error) { reject(error) }
    })
    stdin.end(input, "utf8")
  })
}

/** A structural/current-boot check only; it does not establish native proof or inspect gate state. */
export function isCurrentLinuxVerifierReference(reference: VerificationReference): boolean {
  return validReference(reference) && reference.bootID === bootID()
}

/** Validates the fixed profile and installed files only; it does not verify gate connectivity or a result. */
export function inspectLinuxVerifierProfile(qualification: boolean): VerificationPreflight {
  if (typeof qualification !== "boolean") throw new TypeError("invalid Linux verifier qualification mode")
  const native = loadNativeProfile({ qualification })
  return { compatible: !!native.trusted, problems: native.problems }
}
