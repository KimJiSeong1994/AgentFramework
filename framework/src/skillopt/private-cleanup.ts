import * as fs from "node:fs"
import type { BigIntStats } from "node:fs"
import { dirname } from "node:path"
import { sha256 } from "./pilot.ts"

export type PrivateCleanupFileIdentity = Readonly<{
  dev: string
  ino: string
  uid: string
  mode: string
  nlink: string
  size: string
  mtimeNs: string
  ctimeNs: string
}>

export type PrivateCleanupFileSnapshot = Readonly<{
  identity: PrivateCleanupFileIdentity
  sha256: string
}>

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY ?? 0

function identity(stat: BigIntStats): PrivateCleanupFileIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid),
    mode: String(stat.mode & 0o7777n), nlink: String(stat.nlink), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) })
}

function readFile(path: string, maximumBytes: number): Readonly<{ bytes: Buffer; identity: PrivateCleanupFileIdentity }> {
  const beforeName = fs.lstatSync(path, { bigint: true })
  if (beforeName.isSymbolicLink() || !beforeName.isFile()) throw new Error("cleanup_file_invalid")
  const fd = fs.openSync(path, fs.constants.O_RDONLY | NO_FOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.dev !== beforeName.dev || before.ino !== beforeName.ino ||
        before.uid !== BigInt(process.geteuid?.() ?? -1) || before.nlink !== 1n || before.size < 0n ||
        before.size > BigInt(maximumBytes) || (before.mode & 0o0022n) !== 0n) throw new Error("cleanup_file_invalid")
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    for (;;) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
      if (offset > maximumBytes) throw new Error("cleanup_file_limit")
    }
    const after = fs.fstatSync(fd, { bigint: true })
    const afterName = fs.lstatSync(path, { bigint: true })
    if (offset !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino ||
        after.uid !== before.uid || after.nlink !== before.nlink || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || afterName.isSymbolicLink() ||
        afterName.dev !== before.dev || afterName.ino !== before.ino) throw new Error("cleanup_file_changed")
    return Object.freeze({ bytes: bytes.subarray(0, offset), identity: identity(after) })
  } finally { fs.closeSync(fd) }
}

function exactIdentity(actual: PrivateCleanupFileIdentity, expected: PrivateCleanupFileIdentity): boolean {
  return Object.keys(expected).every(key =>
    actual[key as keyof PrivateCleanupFileIdentity] === expected[key as keyof PrivateCleanupFileIdentity])
}

function exactSnapshot(actual: PrivateCleanupFileSnapshot, expected: PrivateCleanupFileSnapshot): boolean {
  return actual.sha256 === expected.sha256 && exactIdentity(actual.identity, expected.identity)
}

function sameAfterRename(actual: PrivateCleanupFileSnapshot, expected: PrivateCleanupFileSnapshot): boolean {
  return actual.sha256 === expected.sha256 &&
    actual.identity.dev === expected.identity.dev && actual.identity.ino === expected.identity.ino &&
    actual.identity.uid === expected.identity.uid && actual.identity.mode === expected.identity.mode &&
    actual.identity.nlink === expected.identity.nlink && actual.identity.size === expected.identity.size &&
    actual.identity.mtimeNs === expected.identity.mtimeNs
}

export function inspectPrivateCleanupFile(path: string, maximumBytes: number): PrivateCleanupFileSnapshot {
  const read = readFile(path, maximumBytes)
  return Object.freeze({ identity: read.identity, sha256: sha256(read.bytes) })
}

/** Atomically moves a candidate into a caller-created private quarantine and verifies the captured inode and bytes. */
export function capturePrivateCleanupFile(
  sourcePath: string,
  capturedPath: string,
  expected: PrivateCleanupFileSnapshot,
  maximumBytes: number,
): PrivateCleanupFileSnapshot {
  const retained = fs.openSync(sourcePath, fs.constants.O_RDONLY | NO_FOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(retained, { bigint: true })
    if (!stat.isFile() || !exactIdentity(identity(stat), expected.identity)) {
      throw new Error("cleanup_file_changed")
    }
    const before = inspectPrivateCleanupFile(sourcePath, maximumBytes)
    if (!exactSnapshot(before, expected)) throw new Error("cleanup_file_changed")
    try { fs.lstatSync(capturedPath); throw new Error("cleanup_capture_exists") }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error }
    fs.renameSync(sourcePath, capturedPath)
    syncDirectory(dirname(sourcePath))
    syncDirectory(dirname(capturedPath))
    const captured = inspectPrivateCleanupFile(capturedPath, maximumBytes)
    const retainedAfter = fs.fstatSync(retained, { bigint: true })
    if (!sameAfterRename(captured, expected) ||
        !exactIdentity(identity(retainedAfter), captured.identity)) {
      throw new Error("cleanup_capture_changed")
    }
    try { fs.lstatSync(sourcePath); throw new Error("cleanup_source_recreated") }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error }
    return captured
  } finally { fs.closeSync(retained) }
}

export function verifyCapturedPrivateCleanupFile(
  capturedPath: string,
  expected: PrivateCleanupFileSnapshot,
  maximumBytes: number,
): PrivateCleanupFileSnapshot {
  const captured = inspectPrivateCleanupFile(capturedPath, maximumBytes)
  if (!exactSnapshot(captured, expected)) throw new Error("cleanup_capture_changed")
  return captured
}

export function captureEmptyPrivateCleanupDirectory(
  sourcePath: string,
  capturedPath: string,
  expected: Readonly<{ dev: string; ino: string; uid: string; mode: string }>,
): void {
  const before = fs.lstatSync(sourcePath, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory() || String(before.dev) !== expected.dev ||
      String(before.ino) !== expected.ino || String(before.uid) !== expected.uid ||
      String(before.mode & 0o7777n) !== expected.mode || fs.readdirSync(sourcePath).length !== 0) {
    throw new Error("cleanup_directory_changed")
  }
  try { fs.lstatSync(capturedPath); throw new Error("cleanup_capture_exists") }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error }
  fs.renameSync(sourcePath, capturedPath)
  syncDirectory(dirname(sourcePath))
  syncDirectory(dirname(capturedPath))
  const captured = fs.lstatSync(capturedPath, { bigint: true })
  if (captured.isSymbolicLink() || !captured.isDirectory() || String(captured.dev) !== expected.dev ||
      String(captured.ino) !== expected.ino || String(captured.uid) !== expected.uid ||
      String(captured.mode & 0o7777n) !== expected.mode || fs.readdirSync(capturedPath).length !== 0) {
    throw new Error("cleanup_capture_changed")
  }
  try { fs.lstatSync(sourcePath); throw new Error("cleanup_source_recreated") }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error }
}

export function syncPrivateCleanupDirectory(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW)
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error("cleanup_directory_invalid")
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function syncDirectory(path: string): void {
  syncPrivateCleanupDirectory(path)
}
