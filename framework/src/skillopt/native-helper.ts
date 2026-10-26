import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  realpathSync, rmdirSync, unlinkSync, type BigIntStats,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path"
import { readSkillOptNativeClock, type PromotionNativeHelperInput, type SkillOptNativeClockSample } from "./promotion.ts"

const NATIVE_SOURCE = resolve(import.meta.dir, "native.c")
const NATIVE_COMPILER = "/usr/bin/cc"
const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_COMPILER_BYTES = 256 * 1024 * 1024
const MAX_HELPER_BYTES = 8 * 1024 * 1024
const MAX_COMPILER_OUTPUT_BYTES = 64 * 1024
const BUILD_TIMEOUT_MS = 30_000
const PRIVATE_DIRECTORY_MODE = 0o700
const HELPER_FILE_MODE = 0o700

export type BuiltSkillOptNativeHelper = Readonly<{
  helper: PromotionNativeHelperInput
  sourcePath: string
  sourceSha256: string
  compilerPath: string
  compilerSha256: string
  /** Parsed protocol/clock readiness sample only; this is not model or OS-containment evidence. */
  clock: SkillOptNativeClockSample
  /** Removes only the unchanged helper artifact created by this build; never recursively removes the directory. */
  dispose(): void
}>

type FileIdentity = Readonly<{
  dev: bigint
  ino: bigint
  mode: bigint
  uid: bigint
  gid: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}>

type DirectoryIdentity = Readonly<{ dev: bigint; ino: bigint; mode: bigint; uid: bigint }>
type StableFile = Readonly<{ identity: FileIdentity; sha256: string; bytes?: Buffer }>
type CompilerIdentity = Readonly<{
  canonicalPath: string
  alias: FileIdentity
  binary: FileIdentity
  sha256: string
}>

function fail(reason: string): never {
  throw new Error(`native-helper-provider:${reason}`)
}

function fileIdentity(stat: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
    nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  })
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid })
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
}

function readStableFile(path: string, maxBytes: number, collect: boolean): StableFile {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch { return fail("file-open-refused") }
  try {
    const before = fstatSync(fd, { bigint: true })
    const namedBefore = lstatSync(path, { bigint: true })
    if (!before.isFile() || namedBefore.isSymbolicLink() || !sameFileIdentity(fileIdentity(before), fileIdentity(namedBefore)) ||
        before.size < 1n || before.size > BigInt(maxBytes)) return fail("file-shape-invalid")
    const hash = createHash("sha256")
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      total += count
      if (total > maxBytes) return fail("file-size-limit")
      const chunk = buffer.subarray(0, count)
      hash.update(chunk)
      if (collect) chunks.push(Buffer.from(chunk))
    }
    const after = fstatSync(fd, { bigint: true })
    const namedAfter = lstatSync(path, { bigint: true })
    if (BigInt(total) !== before.size || !sameFileIdentity(fileIdentity(before), fileIdentity(after)) ||
        !sameFileIdentity(fileIdentity(after), fileIdentity(namedAfter))) return fail("file-changed-during-read")
    return Object.freeze({ identity: fileIdentity(after), sha256: hash.digest("hex"), ...(collect ? { bytes: Buffer.concat(chunks, total) } : {}) })
  } finally {
    closeSync(fd)
  }
}

function trustedDirectoryChain(path: string): void {
  if (!isAbsolute(path)) return fail("compiler-path-invalid")
  const root = parse(path).root
  let cursor = root
  let rootStat: BigIntStats
  try { rootStat = lstatSync(cursor, { bigint: true }) } catch { return fail("compiler-path-unavailable") }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0n || (rootStat.mode & 0o022n) !== 0n) {
    return fail("compiler-path-untrusted")
  }
  const components = path.slice(root.length).split(sep).filter(Boolean)
  for (const component of components) {
    cursor = join(cursor, component)
    let stat: BigIntStats
    try { stat = lstatSync(cursor, { bigint: true }) } catch { return fail("compiler-path-unavailable") }
    const final = cursor === path
    if (stat.isSymbolicLink()) {
      if (final || stat.uid !== 0n) return fail("compiler-path-untrusted")
    } else if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
      return fail("compiler-path-untrusted")
    }
  }
}

function trustedCompilerIdentity(expectedCanonicalPath?: string): CompilerIdentity {
  const uid = process.getuid?.()
  const euid = process.geteuid?.()
  if (uid === undefined || euid === undefined || uid !== euid) return fail("process-identity-unavailable")
  if (process.platform !== "darwin" && process.platform !== "linux") return fail("unsupported-platform")
  trustedDirectoryChain(dirname(NATIVE_COMPILER))
  let aliasStat: BigIntStats
  let canonicalPath: string
  try {
    aliasStat = lstatSync(NATIVE_COMPILER, { bigint: true })
    canonicalPath = realpathSync.native(NATIVE_COMPILER)
  } catch { return fail("compiler-unavailable") }
  if (aliasStat.uid !== 0n || (aliasStat.isSymbolicLink() && aliasStat.nlink < 1n) ||
      (!aliasStat.isSymbolicLink() && (!aliasStat.isFile() || (aliasStat.mode & 0o022n) !== 0n)) ||
      (expectedCanonicalPath !== undefined && canonicalPath !== expectedCanonicalPath)) return fail("compiler-identity-invalid")
  trustedDirectoryChain(dirname(canonicalPath))
  const binary = readStableFile(canonicalPath, MAX_COMPILER_BYTES, false)
  if (binary.identity.uid !== 0n || !((binary.identity.mode & 0o111n) !== 0n) ||
      (binary.identity.mode & 0o022n) !== 0n || (binary.identity.mode & 0o7000n) !== 0n || binary.identity.nlink < 1n) {
    return fail("compiler-identity-invalid")
  }
  return Object.freeze({ canonicalPath, alias: fileIdentity(aliasStat), binary: binary.identity, sha256: binary.sha256 })
}

function checkedCompilerIdentity(expectedCanonicalPath?: string): CompilerIdentity {
  try { return trustedCompilerIdentity(expectedCanonicalPath) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("native-helper-provider:")) throw error
    return fail("compiler-identity-invalid")
  }
}

function sameCompilerIdentity(left: CompilerIdentity, right: CompilerIdentity): boolean {
  return left.canonicalPath === right.canonicalPath && left.sha256 === right.sha256 &&
    sameFileIdentity(left.alias, right.alias) && sameFileIdentity(left.binary, right.binary)
}

function privateDirectory(path: string): DirectoryIdentity {
  const canonical = realpathSync.native(path)
  if (canonical !== path) return fail("private-directory-not-canonical")
  const stat = lstatSync(canonical, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE)) return fail("private-directory-invalid")
  return directoryIdentity(stat)
}

function helperPathIdentity(path: string, expected: FileIdentity, expectedSha256: string): boolean {
  try {
    if (realpathSync.native(path) !== path) return false
    const before = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid!()) ||
        before.nlink !== 1n || (before.mode & 0o777n) !== BigInt(HELPER_FILE_MODE) ||
        (before.mode & 0o7000n) !== 0n || !sameFileIdentity(fileIdentity(before), expected)) return false
    return readStableFile(path, MAX_HELPER_BYTES, false).sha256 === expectedSha256
  } catch { return false }
}

function currentDirectoryIdentity(path: string, expected: DirectoryIdentity): boolean {
  try {
    if (realpathSync.native(path) !== path) return false
    const stat = lstatSync(path, { bigint: true })
    return stat.isDirectory() && !stat.isSymbolicLink() && sameDirectoryIdentity(directoryIdentity(stat), expected)
  } catch { return false }
}

function removeOwnHelper(path: string, expected?: FileIdentity, expectedSha256?: string): boolean {
  if (!expected || !expectedSha256 || !helperPathIdentity(path, expected, expectedSha256)) return false
  try {
    unlinkSync(path)
    return true
  } catch { return false }
}

function removeFailedCompilerArtifact(path: string, expected?: FileIdentity, expectedSha256?: string): boolean {
  if (!expected || !expectedSha256) return false
  try {
    if (realpathSync.native(path) !== path) return false
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || stat.nlink !== 1n ||
        (stat.mode & 0o7000n) !== 0n || !sameFileIdentity(fileIdentity(stat), expected) ||
        readStableFile(path, MAX_HELPER_BYTES, false).sha256 !== expectedSha256) return false
    unlinkSync(path)
    return true
  } catch { return false }
}

function removeEmptyOwnedDirectory(path: string, expected: DirectoryIdentity): boolean {
  if (!currentDirectoryIdentity(path, expected)) return false
  try {
    rmdirSync(path)
    return true
  } catch { return false }
}

function captureCompilerOutput(path: string): FileIdentity | undefined {
  try {
    if (realpathSync.native(path) !== path) return undefined
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || stat.nlink !== 1n ||
        (stat.mode & 0o7000n) !== 0n) return undefined
    return fileIdentity(stat)
  } catch { return undefined }
}

function requireAbsentOutput(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return
    return fail("output-path-unavailable")
  }
  return fail("output-path-already-exists")
}

function cleanupFailedBuild(directory: string | undefined, directoryId: DirectoryIdentity | undefined,
  outputPath: string | undefined, outputId: FileIdentity | undefined, outputSha256: string | undefined): void {
  if (outputPath && outputId && outputSha256) removeFailedCompilerArtifact(outputPath, outputId, outputSha256)
  if (directory && directoryId) removeEmptyOwnedDirectory(directory, directoryId)
}

/** Compile the packaged native helper on explicit demand with the fixed system compiler; no model or user input is accepted. */
export function buildSkillOptNativeHelper(): BuiltSkillOptNativeHelper {
  if (arguments.length !== 0) return fail("caller-input-forbidden")
  if (process.platform !== "darwin" && process.platform !== "linux") return fail("unsupported-platform")
  let source: StableFile
  try {
    if (realpathSync.native(NATIVE_SOURCE) !== NATIVE_SOURCE) return fail("source-path-not-canonical")
    source = readStableFile(NATIVE_SOURCE, MAX_SOURCE_BYTES, true)
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes!)
    if (Buffer.from(decoded, "utf8").compare(source.bytes!) !== 0 || decoded.includes("\0")) return fail("source-encoding-invalid")
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("native-helper-provider:")) throw error
    return fail("source-unavailable")
  }

  const compilerBefore = checkedCompilerIdentity()
  let directory: string | undefined
  let directoryId: DirectoryIdentity | undefined
  let outputPath: string | undefined
  let outputId: FileIdentity | undefined
  let outputSha256: string | undefined
  try {
    try { directory = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-skillopt-native-helper-"))) }
    catch { return fail("private-directory-unavailable") }
    directoryId = privateDirectory(directory)
    outputPath = join(directory, `skillopt-native-${randomBytes(16).toString("hex")}`)
    requireAbsentOutput(outputPath)
    const compilerBeforeDispatch = checkedCompilerIdentity(compilerBefore.canonicalPath)
    if (!sameCompilerIdentity(compilerBefore, compilerBeforeDispatch)) return fail("compiler-identity-changed")
    const env = Object.freeze({ PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, LC_ALL: "C", LANG: "C" })
    const result = (() => {
      const priorUmask = process.umask(0o077)
      try {
        return spawnSync(compilerBefore.canonicalPath, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-x", "c", "-", "-o", outputPath], {
          cwd: directory,
          env,
          input: source.bytes,
          encoding: "buffer",
          maxBuffer: MAX_COMPILER_OUTPUT_BYTES,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: BUILD_TIMEOUT_MS,
          killSignal: "SIGKILL",
          windowsHide: true,
          shell: false,
        })
      } finally {
        process.umask(priorUmask)
      }
    })()
    const compilerAfter = checkedCompilerIdentity(compilerBefore.canonicalPath)
    if (!sameCompilerIdentity(compilerBefore, compilerAfter)) return fail("compiler-identity-changed")
    if (result.error || result.status !== 0 || result.signal !== null) {
      outputId = captureCompilerOutput(outputPath)
      if (outputId) {
        try { outputSha256 = readStableFile(outputPath, MAX_HELPER_BYTES, false).sha256 } catch { /* Preserve unverified output. */ }
      }
      return fail("compile-failed")
    }
    const initialOutput = captureCompilerOutput(outputPath)
    if (!initialOutput) return fail("compiled-helper-invalid")
    const initialBytes = readStableFile(outputPath, MAX_HELPER_BYTES, false)
    outputId = initialBytes.identity
    outputSha256 = initialBytes.sha256
    chmodSync(outputPath, HELPER_FILE_MODE)
    outputId = fileIdentity(lstatSync(outputPath, { bigint: true }))
    const built = readStableFile(outputPath, MAX_HELPER_BYTES, false)
    outputId = built.identity
    outputSha256 = built.sha256
    if (built.identity.uid !== BigInt(process.getuid!()) || built.identity.nlink !== 1n ||
        (built.identity.mode & 0o777n) !== BigInt(HELPER_FILE_MODE) || (built.identity.mode & 0o7000n) !== 0n ||
        built.identity.size < 1n || built.sha256 !== initialBytes.sha256 ||
        !helperPathIdentity(outputPath, built.identity, built.sha256)) return fail("compiled-helper-invalid")

    const helper: PromotionNativeHelperInput = Object.freeze({ nativeHelperPath: outputPath, nativeHelperSha256: built.sha256 })
    let artifactRemoved = false
    let disposed = false
    const dispose = () => {
      if (disposed) return
      if (!currentDirectoryIdentity(directory!, directoryId!)) return fail("cleanup-identity-changed")
      if (!artifactRemoved) {
        if (!helperPathIdentity(outputPath!, built.identity, built.sha256)) return fail("cleanup-identity-changed")
        if (!removeOwnHelper(outputPath!, built.identity, built.sha256)) return fail("cleanup-refused")
        artifactRemoved = true
      }
      if (!removeEmptyOwnedDirectory(directory!, directoryId!)) return fail("cleanup-directory-not-empty-or-changed")
      disposed = true
    }
    const clock = readSkillOptNativeClock(helper)
    if (clock.protocol !== "skillopt-promotion.v3" || clock.platform !== process.platform ||
        !helperPathIdentity(outputPath, built.identity, built.sha256)) return fail("native-readiness-invalid")
    return Object.freeze({
      helper,
      sourcePath: NATIVE_SOURCE,
      sourceSha256: source.sha256,
      compilerPath: compilerBefore.canonicalPath,
      compilerSha256: compilerBefore.sha256,
      clock: Object.freeze({ ...clock }),
      dispose,
    })
  } catch (error) {
    cleanupFailedBuild(directory, directoryId, outputPath, outputId, outputSha256)
    if (error instanceof Error && error.message.startsWith("native-helper-provider:")) throw error
    return fail("build-failed")
  }
}
