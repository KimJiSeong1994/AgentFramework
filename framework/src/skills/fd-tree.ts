import { dlopen, FFIType, ptr, read, toBuffer } from "bun:ffi"
import { constants, fstatSync, lstatSync, type BigIntStats } from "node:fs"
import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const MAX_NAME_BYTES = 4096
const MAX_LINK_BYTES = 4096
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 20_000
const MAX_OPEN_DIRECTORIES = 256
const MAX_DIRECTORY_DEPTH = 64

type Profile = Readonly<{
  name: string
  library: string
  errnoSymbol: "__error" | "__errno_location"
  atFdcwd: number
  oCloexec: number
  oDirectory: number
  oNoFollow: number
  atSymlinkNoFollow: number
  statSize: number
  statModeOffset: number
  statModeWidth: 2 | 4
  statNlinkOffset: number
  statNlinkWidth: 2 | 4 | 8
  statDevOffset: number
  statDevWidth: 4 | 8
  statInoOffset: number
  statSizeOffset: number
  statMtimeOffset: number
  statCtimeOffset: number
  direntReclenOffset: number
  direntNamlenOffset?: number
  direntNameOffset: number
}>

const PROFILES: Readonly<Record<string, Profile>> = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "darwin-arm64-libsystem",
    library: "libSystem.B.dylib",
    errnoSymbol: "__error",
    atFdcwd: -2,
    oCloexec: 0x01000000,
    oDirectory: 0x00100000,
    oNoFollow: 0x00000100,
    atSymlinkNoFollow: 0x0020,
    statSize: 144,
    statModeOffset: 4,
    statModeWidth: 2,
    statNlinkOffset: 6,
    statNlinkWidth: 2,
    statDevOffset: 0,
    statDevWidth: 4,
    statInoOffset: 8,
    statSizeOffset: 96,
    statMtimeOffset: 48,
    statCtimeOffset: 64,
    direntReclenOffset: 16,
    direntNamlenOffset: 18,
    direntNameOffset: 21,
  }),
  "darwin-x64": Object.freeze({
    name: "darwin-x64-libsystem",
    library: "libSystem.B.dylib",
    errnoSymbol: "__error",
    atFdcwd: -2,
    oCloexec: 0x01000000,
    oDirectory: 0x00100000,
    oNoFollow: 0x00000100,
    atSymlinkNoFollow: 0x0020,
    statSize: 144,
    statModeOffset: 4,
    statModeWidth: 2,
    statNlinkOffset: 6,
    statNlinkWidth: 2,
    statDevOffset: 0,
    statDevWidth: 4,
    statInoOffset: 8,
    statSizeOffset: 96,
    statMtimeOffset: 48,
    statCtimeOffset: 64,
    direntReclenOffset: 16,
    direntNamlenOffset: 18,
    direntNameOffset: 21,
  }),
  "linux-x64": Object.freeze({
    name: "linux-x64-glibc",
    library: "libc.so.6",
    errnoSymbol: "__errno_location",
    atFdcwd: -100,
    oCloexec: 0x00080000,
    oDirectory: 0x00010000,
    oNoFollow: 0x00020000,
    atSymlinkNoFollow: 0x0100,
    statSize: 144,
    statModeOffset: 24,
    statModeWidth: 4,
    statNlinkOffset: 16,
    statNlinkWidth: 8,
    statDevOffset: 0,
    statDevWidth: 8,
    statInoOffset: 8,
    statSizeOffset: 48,
    statMtimeOffset: 88,
    statCtimeOffset: 104,
    direntReclenOffset: 16,
    direntNameOffset: 19,
  }),
  "linux-arm64": Object.freeze({
    name: "linux-arm64-glibc",
    library: "libc.so.6",
    errnoSymbol: "__errno_location",
    atFdcwd: -100,
    oCloexec: 0x00080000,
    oDirectory: 0x00004000,
    oNoFollow: 0x00008000,
    atSymlinkNoFollow: 0x0100,
    statSize: 128,
    statModeOffset: 16,
    statModeWidth: 4,
    statNlinkOffset: 20,
    statNlinkWidth: 4,
    statDevOffset: 0,
    statDevWidth: 8,
    statInoOffset: 8,
    statSizeOffset: 48,
    statMtimeOffset: 88,
    statCtimeOffset: 104,
    direntReclenOffset: 16,
    direntNameOffset: 19,
  }),
})

export type FdStat = Readonly<{
  dev: bigint
  ino: bigint
  mode: number
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}>

export type FdName = Readonly<{ name: string; rawName: Buffer }>
export type FdEntry = FdName & Readonly<{ stat: FdStat }>
export type FdLinkResolution = Readonly<{
  target: Uint8Array
  canonicalTarget: string
  internal: boolean
  relativeTarget?: string
}>

export type FdTreeFailureReason = "unsafe" | "race" | "unsupported" | "unreadable"

export class FdTreeError extends Error {
  readonly reason: FdTreeFailureReason
  readonly code?: number

  constructor(reason: FdTreeFailureReason, message: string, code?: number) {
    super(message)
    this.name = "FdTreeError"
    this.reason = reason
    if (code !== undefined) this.code = code
  }
}

type Symbols = {
  openat: (dirfd: number, path: NativePointer, flags: number, mode: number) => number
  close: (fd: number) => number
  fstat: (fd: number, statbuf: NativePointer) => number
  fstatat: (dirfd: number, path: NativePointer, statbuf: NativePointer, flags: number) => number
  fdopendir: (fd: number) => NativePointer | null
  readdir: (dir: NativePointer) => NativePointer | null
  closedir: (dir: NativePointer) => number
  readlinkat: (dirfd: number, path: NativePointer, buffer: NativePointer, size: bigint) => bigint
  read: (fd: number, buffer: NativePointer, size: bigint) => bigint
  memset: (pointer: NativePointer, value: number, size: bigint) => NativePointer
  errno: () => NativePointer
}

type NativePointer = ReturnType<typeof ptr>

type EntryWatch = Readonly<{
  parent: FdDirectory
  name: FdName
  stat: FdStat
  kind: "entry" | "file" | "symlink"
  bytes?: Buffer
  canonicalTarget?: string
}>

type FdTreeCheckpoint = Readonly<{ directoryIndex: number; watchIndex: number }>
type LinkIdentity = Readonly<{ canonicalTarget: string; internal: boolean; relativeTarget?: string; identityPath?: string }>

function profileForRuntime(): Profile {
  const key = `${process.platform}-${process.arch}`
  const profile = PROFILES[key]
  if (!profile || (process.platform !== "darwin" && process.platform !== "linux")) {
    throw new FdTreeError("unsupported", `unsupported POSIX ABI: ${key}`)
  }
  if (profile.oDirectory !== constants.O_DIRECTORY || profile.oNoFollow !== constants.O_NOFOLLOW) {
    throw new FdTreeError("unsupported", `POSIX open flags do not match the runtime ABI: ${key}`)
  }
  return profile
}

const PROFILE = profileForRuntime()
const C = FFIType
const native = (() => {
  try {
    const library = dlopen(PROFILE.library, {
      openat: { args: [C.i32, C.ptr, C.i32, C.u32], returns: C.i32 },
      close: { args: [C.i32], returns: C.i32 },
      fstat: { args: [C.i32, C.ptr], returns: C.i32 },
      fstatat: { args: [C.i32, C.ptr, C.ptr, C.i32], returns: C.i32 },
      fdopendir: { args: [C.i32], returns: C.ptr },
      readdir: { args: [C.ptr], returns: C.ptr },
      closedir: { args: [C.ptr], returns: C.i32 },
      readlinkat: { args: [C.i32, C.ptr, C.ptr, C.u64], returns: C.i64 },
      read: { args: [C.i32, C.ptr, C.u64], returns: C.i64 },
      memset: { args: [C.ptr, C.i32, C.u64], returns: C.ptr },
      [PROFILE.errnoSymbol]: { args: [], returns: C.ptr },
    })
    return {
      ...library.symbols,
      errno: library.symbols[PROFILE.errnoSymbol] as () => NativePointer,
      closeLibrary: () => library.close(),
    } as Symbols & { closeLibrary: () => void }
  } catch (error) {
    throw new FdTreeError("unsupported", `POSIX FFI symbols unavailable for ${PROFILE.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
})()

function errnoNumber(): number {
  return read.i32(native.errno())
}

function errnoName(errno: number): string {
  switch (errno) {
    case 1: return "EPERM"
    case 2: return "ENOENT"
    case 5: return "EIO"
    case 9: return "EBADF"
    case 13: return "EACCES"
    case 20: return "ENOTDIR"
    case 21: return "EISDIR"
    case 22: return "EINVAL"
    case 24: return "EMFILE"
    case 28: return "ENOSPC"
    case 36: return "ENAMETOOLONG"
    case 40: return "ELOOP"
    case 116: return "ESTALE"
    default: return `errno ${errno}`
  }
}

function mapErrno(errno: number, message: string): FdTreeError {
  const reason: FdTreeFailureReason = [2, 11, 116].includes(errno) ? "race" :
    [1, 13].includes(errno) ? "unreadable" : errno === 40 ? "unsafe" : "unsafe"
  return new FdTreeError(reason, `${message}: ${errnoName(errno)}`, errno)
}

function pathBytes(value: string): Buffer {
  if (value.includes("\0")) throw new FdTreeError("unsafe", "NUL is not allowed in a filesystem path")
  return Buffer.from(`${value}\0`, "utf8")
}

function componentName(value: string | FdName): FdName {
  if (typeof value === "string") {
    if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
      throw new FdTreeError("unsafe", "invalid filesystem component")
    }
    const rawName = Buffer.from(value, "utf8")
    if (assertUtf8(rawName) !== value) throw new FdTreeError("unsafe", "filesystem component is not canonical UTF-8")
    return Object.freeze({ name: value, rawName })
  }
  const rawName = Buffer.from(value.rawName)
  if (value.name === "." || value.name === ".." || assertUtf8(rawName) !== value.name) {
    throw new FdTreeError("unsafe", "filesystem component bytes do not match its validated name")
  }
  return Object.freeze({ name: value.name, rawName })
}

function nullTerminatedName(value: string | FdName): Buffer {
  const name = componentName(value)
  return Buffer.concat([name.rawName, Buffer.from([0])])
}

function callStat(call: (buffer: NativePointer) => number, message: string): FdStat {
  const bytes = new Uint8Array(Math.max(PROFILE.statSize, 256))
  const status = call(ptr(bytes))
  if (status !== 0) throw mapErrno(errnoNumber(), message)
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u64 = (offset: number) => data.getBigUint64(offset, true)
  const i64 = (offset: number) => data.getBigInt64(offset, true)
  const integer = (offset: number, width: 2 | 4 | 8): bigint => width === 2 ? BigInt(data.getUint16(offset, true)) : width === 4 ? BigInt(data.getUint32(offset, true)) : u64(offset)
  const mode = Number(integer(PROFILE.statModeOffset, PROFILE.statModeWidth))
  const size = i64(PROFILE.statSizeOffset)
  const timespec = (offset: number) => i64(offset) * 1_000_000_000n + i64(offset + 8)
  return Object.freeze({
    dev: integer(PROFILE.statDevOffset, PROFILE.statDevWidth),
    ino: u64(PROFILE.statInoOffset),
    mode,
    nlink: integer(PROFILE.statNlinkOffset, PROFILE.statNlinkWidth),
    size,
    mtimeNs: timespec(PROFILE.statMtimeOffset),
    ctimeNs: timespec(PROFILE.statCtimeOffset),
  })
}

function nativeFstat(fd: number): FdStat {
  return callStat((buffer) => native.fstat(fd, buffer), "fstat failed")
}

function nativeFstatat(fd: number, name: string | FdName): FdStat {
  const component = componentName(name)
  return callStat((buffer) => native.fstatat(fd, ptr(nullTerminatedName(component)), buffer, PROFILE.atSymlinkNoFollow), `fstatat failed for ${component.name}`)
}

function fromNodeStat(stat: BigIntStats): FdStat {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: Number(stat.mode), nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs })
}

function sameStat(a: FdStat, b: FdStat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function assertPathStillNamesDirectory(directory: FdDirectory): void {
  try {
    const named = fromNodeStat(lstatSync(directory.path, { bigint: true }))
    if (modeKind(named.mode) !== "directory" || !sameStat(named, nativeFstat(directory.fd))) {
      throw new FdTreeError("race", `directory path no longer names its held fd: ${directory.path}`)
    }
  } catch (error) {
    if (error instanceof FdTreeError) throw error
    throw new FdTreeError("race", `directory path became unavailable: ${directory.path}`)
  }
}

function validateLayout(fd: number): void {
  const nativeStat = nativeFstat(fd)
  let nodeStat: FdStat
  try {
    nodeStat = fromNodeStat(fstatSync(fd, { bigint: true }))
  } catch (error) {
    throw new FdTreeError("unsupported", `Node cannot validate native fstat layout: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!sameStat(nativeStat, nodeStat)) {
    throw new FdTreeError("unsupported", `native stat layout validation failed for ${PROFILE.name}`)
  }
}

function assertUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_NAME_BYTES) throw new FdTreeError("unsafe", "filesystem name exceeds limit")
  let value: string
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new FdTreeError("unsafe", "filesystem name is not valid UTF-8")
  }
  if (!Buffer.from(value, "utf8").equals(Buffer.from(bytes)) || value === "" || value.includes("/") || value.includes("\0")) {
    throw new FdTreeError("unsafe", "filesystem name is not canonical UTF-8")
  }
  return value
}

function rawNameCompare(a: FdName, b: FdName): number {
  return Buffer.compare(a.rawName, b.rawName)
}

function sameNames(a: readonly FdName[], b: readonly FdName[]): boolean {
  return a.length === b.length && a.every((name, index) => name.rawName.equals(b[index]!.rawName))
}

function modeKind(mode: number): "file" | "directory" | "symlink" | "unsupported" {
  switch (mode & 0o170000) {
    case 0o100000: return "file"
    case 0o040000: return "directory"
    case 0o120000: return "symlink"
    default: return "unsupported"
  }
}

function fromDirectoryEntry(pointer: NativePointer): FdName {
  const recordLength = read.u16(pointer, PROFILE.direntReclenOffset)
  const nameLength = PROFILE.direntNamlenOffset === undefined
    ? undefined
    : read.u16(pointer, PROFILE.direntNamlenOffset)
  const maxName = nameLength ?? Math.min(MAX_NAME_BYTES, recordLength - PROFILE.direntNameOffset)
  if (recordLength < PROFILE.direntNameOffset + 1 || maxName < 0 || maxName > MAX_NAME_BYTES) {
    throw new FdTreeError("unsupported", `invalid dirent layout for ${PROFILE.name}`)
  }
  let length = nameLength ?? 0
  if (nameLength !== undefined && PROFILE.direntNameOffset + nameLength > recordLength) {
    throw new FdTreeError("unsupported", `invalid dirent name length for ${PROFILE.name}`)
  }
  if (nameLength === undefined) {
    while (length < maxName && read.u8(pointer, PROFILE.direntNameOffset + length) !== 0) length++
    if (length === maxName) throw new FdTreeError("unsupported", `unterminated dirent for ${PROFILE.name}`)
  }
  const rawName = Buffer.from(toBuffer(pointer, PROFILE.direntNameOffset, length))
  const name = assertUtf8(rawName)
  return Object.freeze({ name, rawName })
}

function readDirectoryNames(fd: number): readonly FdName[] {
  const dot = pathBytes(".")
  const duplicate = native.openat(fd, ptr(dot), PROFILE.oDirectory | PROFILE.oNoFollow | PROFILE.oCloexec, 0)
  if (duplicate < 0) throw mapErrno(errnoNumber(), "directory fd duplication failed")
  const directory = native.fdopendir(duplicate)
  if (!directory) {
    const errno = errnoNumber()
    native.close(duplicate)
    throw mapErrno(errno, "fdopendir failed")
  }
  const result: FdName[] = []
  try {
    while (true) {
      native.memset(native.errno(), 0, 4n)
      const entry = native.readdir(directory)
      if (!entry) {
        const errno = errnoNumber()
        if (errno !== 0) throw mapErrno(errno, "readdir failed")
        break
      }
      const name = fromDirectoryEntry(entry)
      if (name.name === "." || name.name === "..") continue
      if (name.name.includes("/") || name.name.includes("\0")) throw new FdTreeError("unsafe", "invalid directory entry component")
      result.push(name)
      if (result.length > MAX_DIRECTORY_ENTRIES) throw new FdTreeError("unsafe", "directory entry limit exceeded")
    }
  } finally {
    if (native.closedir(directory) !== 0) throw mapErrno(errnoNumber(), "closedir failed")
  }
  result.sort(rawNameCompare)
  return Object.freeze(result)
}

function readSymlinkBytes(parentFd: number, name: string | FdName): Buffer {
  const storage = new Uint8Array(MAX_LINK_BYTES)
  const component = componentName(name)
  const length = native.readlinkat(parentFd, ptr(nullTerminatedName(component)), ptr(storage), BigInt(storage.byteLength))
  if (length < 0n) throw mapErrno(errnoNumber(), `readlinkat failed for ${component.name}`)
  if (length >= BigInt(storage.byteLength)) throw new FdTreeError("unsafe", "symlink target exceeds limit")
  return Buffer.from(storage.subarray(0, Number(length)))
}

function readAll(fd: number, expectedSize: bigint): Buffer {
  if (expectedSize < 0n || expectedSize > BigInt(MAX_FILE_BYTES)) throw new FdTreeError("unsafe", "file exceeds snapshot byte limit")
  const expected = Number(expectedSize)
  const chunks: Buffer[] = []
  let remaining = expected
  const buffer = new Uint8Array(Math.min(64 * 1024, Math.max(1, expected)))
  while (remaining > 0) {
    const amount = Math.min(remaining, buffer.byteLength)
    const count = native.read(fd, ptr(buffer), BigInt(amount))
    if (count < 0n) throw mapErrno(errnoNumber(), "read failed")
    if (count === 0n) throw new FdTreeError("race", "file reached EOF before captured size")
    chunks.push(Buffer.from(buffer.subarray(0, Number(count))))
    remaining -= Number(count)
  }
  const result = Buffer.concat(chunks, expected)
  if (result.byteLength !== expected) throw new FdTreeError("race", "file read length changed")
  return result
}

export class FdDirectory {
  readonly path: string
  readonly relativePath: string
  readonly parent?: FdDirectory
  readonly name?: FdName
  readonly openedStat: FdStat
  private closed = false

  constructor(
    private readonly tree: FdTree,
    readonly fd: number,
    path: string,
    relativePath: string,
    openedStat: FdStat,
    parent?: FdDirectory,
    name?: FdName,
  ) {
    this.path = path
    this.relativePath = relativePath
    this.openedStat = openedStat
    if (parent !== undefined) this.parent = parent
    if (name !== undefined) this.name = name
  }

  assertOpen(): void {
    if (this.closed) throw new FdTreeError("unsafe", "directory capability is closed")
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (native.close(this.fd) !== 0) throw mapErrno(errnoNumber(), "close directory fd failed")
  }
}

export class FdTree {
  readonly root: FdDirectory
  readonly #directories: FdDirectory[] = []
  readonly #entryWatches: EntryWatch[] = []
  readonly #directoryNames = new Map<FdDirectory, readonly FdName[]>()
  readonly #rootPath: string
  #closed = false

  private constructor(rootFd: number, rootPath: string, rootStat: FdStat, anchor?: Readonly<{ fd: number; path: string; stat: FdStat; name: FdName }>) {
    this.#rootPath = rootPath
    let parent: FdDirectory | undefined
    if (anchor) {
      parent = new FdDirectory(this, anchor.fd, anchor.path, ".", anchor.stat)
      this.#directories.push(parent)
    }
    this.root = new FdDirectory(this, rootFd, rootPath, ".", rootStat, parent, anchor?.name)
    this.#directories.push(this.root)
  }

  static openRoot(path: string, expectedIdentity?: Readonly<Pick<FdStat, "dev" | "ino">>): FdTree {
    let canonical: string
    let before: BigIntStats
    try {
      canonical = realpathSync(path)
      if (canonical !== path) throw new FdTreeError("race", "trusted root canonical path changed")
      before = lstatSync(path, { bigint: true })
    } catch (error) {
      if (error instanceof FdTreeError) throw error
      const code = (error as NodeJS.ErrnoException).code
      throw new FdTreeError("unreadable", `cannot resolve trusted root: ${error instanceof Error ? error.message : String(error)}`, code === "ENOENT" ? 2 : undefined)
    }
    if (!before.isDirectory()) throw new FdTreeError("unsafe", "trusted root is not a directory")
    if (expectedIdentity && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino)) {
      throw new FdTreeError("race", "trusted root inode changed")
    }
    let anchorFd: number | undefined
    let fd: number
    let anchor: Readonly<{ fd: number; path: string; stat: FdStat; name: FdName }> | undefined
    if (canonical !== sep) {
      const parentPath = dirname(canonical)
      const name = componentName(basename(canonical))
      let parentBefore: FdStat
      try { parentBefore = fromNodeStat(lstatSync(parentPath, { bigint: true })) } catch {
        throw new FdTreeError("race", "trusted root parent became unavailable")
      }
      anchorFd = native.openat(PROFILE.atFdcwd, ptr(pathBytes(parentPath)), PROFILE.oDirectory | PROFILE.oNoFollow | PROFILE.oCloexec, 0)
      if (anchorFd < 0) throw mapErrno(errnoNumber(), "open trusted root parent failed")
      try {
        validateLayout(anchorFd)
        const parentStat = nativeFstat(anchorFd)
        const nodeParent = fromNodeStat(fstatSync(anchorFd, { bigint: true }))
        const parentAfter = fromNodeStat(lstatSync(parentPath, { bigint: true }))
        if (!sameStat(parentBefore, parentStat) || !sameStat(parentStat, nodeParent) || !sameStat(parentAfter, parentStat)) {
          throw new FdTreeError("race", "trusted root parent changed while opening")
        }
        anchor = Object.freeze({ fd: anchorFd, path: parentPath, stat: parentStat, name })
        fd = native.openat(anchorFd, ptr(nullTerminatedName(name)), PROFILE.oDirectory | PROFILE.oNoFollow | PROFILE.oCloexec, 0)
      } catch (error) {
        native.close(anchorFd)
        throw error
      }
    } else {
      fd = native.openat(PROFILE.atFdcwd, ptr(pathBytes(canonical)), PROFILE.oDirectory | PROFILE.oNoFollow | PROFILE.oCloexec, 0)
    }
    if (fd < 0) {
      if (anchorFd !== undefined) native.close(anchorFd)
      throw mapErrno(errnoNumber(), "open trusted root failed")
    }
    try {
      validateLayout(fd)
      const opened = nativeFstat(fd)
      const nodeOpened = fromNodeStat(fstatSync(fd, { bigint: true }))
      const after = fromNodeStat(lstatSync(canonical, { bigint: true }))
      const anchored = anchor ? nativeFstatat(anchor.fd, anchor.name) : opened
      if (expectedIdentity && (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino)) {
        throw new FdTreeError("race", "opened trusted root inode changed")
      }
      if (!sameStat(opened, nodeOpened) || !sameStat(fromNodeStat(before), opened) || !sameStat(after, opened) || !sameStat(anchored, opened)) {
        throw new FdTreeError("race", "trusted root changed while opening")
      }
      if (modeKind(opened.mode) !== "directory") throw new FdTreeError("unsafe", "trusted root is not a directory")
      return new FdTree(fd, canonical, opened, anchor)
    } catch (error) {
      native.close(fd)
      if (anchorFd !== undefined) native.close(anchorFd)
      throw error
    }
  }

  static assertRootAbsent(path: string): void {
    try {
      lstatSync(path)
      throw new FdTreeError("race", "previously absent trusted root appeared")
    } catch (error) {
      if (error instanceof FdTreeError) throw error
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new FdTreeError("race", "previously absent trusted root path changed")
    }
  }

  get rootPath(): string { return this.#rootPath }

  #assertOpen(): void {
    if (this.#closed) throw new FdTreeError("unsafe", "fd tree is closed")
  }

  #rememberDirectory(directory: FdDirectory): FdDirectory {
    if (this.#directories.length >= MAX_OPEN_DIRECTORIES) throw new FdTreeError("unsafe", "open directory capability limit exceeded")
    this.#directories.push(directory)
    return directory
  }

  checkpoint(): FdTreeCheckpoint {
    this.#assertOpen()
    return Object.freeze({ directoryIndex: this.#directories.length, watchIndex: this.#entryWatches.length })
  }

  releaseSince(checkpoint: FdTreeCheckpoint): void {
    this.#assertOpen()
    if (!Number.isSafeInteger(checkpoint.directoryIndex) || checkpoint.directoryIndex < 1 || checkpoint.directoryIndex > this.#directories.length) {
      throw new FdTreeError("unsafe", "invalid directory capability checkpoint")
    }
    const released = new Set(this.#directories.splice(checkpoint.directoryIndex))
    for (const directory of released) this.#directoryNames.delete(directory)
    for (let index = this.#entryWatches.length - 1; index >= 0; index--) {
      if (released.has(this.#entryWatches[index]!.parent)) this.#entryWatches.splice(index, 1)
    }
    let closeError: unknown
    for (const directory of [...released].reverse()) {
      try { directory.close() } catch (error) { closeError ??= error }
    }
    if (closeError !== undefined) throw closeError
  }

  assertStableSince(checkpoint: FdTreeCheckpoint): void {
    this.#assertOpen()
    for (const directory of this.#directories.slice(checkpoint.directoryIndex)) {
      directory.assertOpen()
      assertPathStillNamesDirectory(directory)
      if (!sameStat(directory.openedStat, nativeFstat(directory.fd))) throw new FdTreeError("race", `held directory changed: ${directory.path}`)
      if (directory.parent && directory.name && !sameStat(directory.openedStat, nativeFstatat(directory.parent.fd, directory.name))) {
        throw new FdTreeError("race", `directory path changed: ${directory.relativePath}`)
      }
      const names = this.#directoryNames.get(directory)
      if (names) {
        const now = readDirectoryNames(directory.fd)
        if (!sameNames(names, now)) {
          throw new FdTreeError("race", `directory names changed: ${directory.relativePath}`)
        }
      }
    }
    for (const watch of this.#entryWatches.slice(checkpoint.watchIndex)) {
      if (!sameStat(watch.stat, nativeFstatat(watch.parent.fd, watch.name))) throw new FdTreeError("race", `entry changed: ${watch.name.name}`)
      if (watch.kind === "symlink") {
        if (!watch.bytes?.equals(readSymlinkBytes(watch.parent.fd, watch.name))) throw new FdTreeError("race", `symlink changed: ${watch.name.name}`)
        if (watch.canonicalTarget && realpathSync(join(watch.parent.path, watch.name.name)) !== watch.canonicalTarget) {
          throw new FdTreeError("race", `symlink identity changed: ${watch.name.name}`)
        }
      }
    }
  }

  statAt(parent: FdDirectory, name: string | FdName): FdStat {
    this.#assertOpen()
    parent.assertOpen()
    const component = componentName(name)
    const value = nativeFstatat(parent.fd, component)
    this.#entryWatches.push({ parent, name: component, stat: value, kind: "entry" })
    return value
  }

  list(directory: FdDirectory): readonly FdEntry[] {
    this.#assertOpen()
    directory.assertOpen()
    const names = readDirectoryNames(directory.fd)
    const previousNames = this.#directoryNames.get(directory)
    if (previousNames && !sameNames(previousNames, names)) throw new FdTreeError("race", `directory names changed: ${directory.relativePath}`)
    if (!previousNames) this.#directoryNames.set(directory, Object.freeze(names.map(componentName)))
    const result = names.map((name) => Object.freeze({ ...name, rawName: Buffer.from(name.rawName), stat: nativeFstatat(directory.fd, name) }))
    for (const item of result) this.#entryWatches.push({ parent: directory, name: componentName(item), stat: item.stat, kind: "entry" })
    return Object.freeze(result)
  }

  openDirectoryAt(parent: FdDirectory, name: string | FdName): FdDirectory {
    this.#assertOpen()
    parent.assertOpen()
    const component = componentName(name)
    const before = nativeFstatat(parent.fd, component)
    if (modeKind(before.mode) !== "directory") throw new FdTreeError("unsafe", `entry is not a no-follow directory: ${component.name}`)
    const fd = native.openat(parent.fd, ptr(nullTerminatedName(component)), PROFILE.oDirectory | PROFILE.oNoFollow | PROFILE.oCloexec, 0)
    if (fd < 0) throw mapErrno(errnoNumber(), `openat directory failed for ${component.name}`)
    try {
      const statFd = nativeFstat(fd)
      const nodeFd = fromNodeStat(fstatSync(fd, { bigint: true }))
      const after = nativeFstatat(parent.fd, name)
      if (!sameStat(before, statFd) || !sameStat(statFd, nodeFd) || !sameStat(after, statFd)) {
        throw new FdTreeError("race", `directory changed while opening: ${component.name}`)
      }
      const path = join(parent.path, component.name)
      const relativePath = parent.relativePath === "." ? component.name : join(parent.relativePath, component.name)
      const child = new FdDirectory(this, fd, path, relativePath.split(sep).join("/"), statFd, parent, component)
      this.#entryWatches.push({ parent, name: component, stat: statFd, kind: "entry" })
      return this.#rememberDirectory(child)
    } catch (error) {
      native.close(fd)
      throw error
    }
  }

  openDirectoryRelative(relativePath: string): FdDirectory {
    this.#assertOpen()
    const components = relativePath.split(sep).filter(Boolean)
    if (relativePath.startsWith("/") || components.some((part) => part === "." || part === ".." || part.includes("\0"))) {
      throw new FdTreeError("unsafe", "relative path contains unsupported components")
    }
    if (components.length > MAX_DIRECTORY_DEPTH) throw new FdTreeError("unsafe", "directory depth limit exceeded")
    let current = this.root
    for (const component of components) current = this.openDirectoryAt(current, component)
    return current
  }

  readFileAt(parent: FdDirectory, name: string | FdName): Readonly<{ bytes: Buffer; stat: FdStat }> {
    this.#assertOpen()
    parent.assertOpen()
    const component = componentName(name)
    const before = nativeFstatat(parent.fd, component)
    if (modeKind(before.mode) !== "file") throw new FdTreeError("unsafe", `entry is not a no-follow regular file: ${component.name}`)
    if (before.nlink !== 1n) throw new FdTreeError("unsafe", "hard-linked source files are not capturable")
    if (before.size < 0n || before.size > BigInt(MAX_FILE_BYTES)) throw new FdTreeError("unsafe", "file exceeds snapshot byte limit")
    const fd = native.openat(parent.fd, ptr(nullTerminatedName(component)), constants.O_RDONLY | constants.O_NONBLOCK | PROFILE.oNoFollow | PROFILE.oCloexec, 0)
    if (fd < 0) throw mapErrno(errnoNumber(), `openat file failed for ${component.name}`)
    try {
      const opened = nativeFstat(fd)
      const nodeOpened = fromNodeStat(fstatSync(fd, { bigint: true }))
      if (modeKind(opened.mode) !== "file" || opened.nlink !== 1n || !sameStat(before, opened) || !sameStat(opened, nodeOpened)) {
        throw new FdTreeError("race", `file changed before read: ${component.name}`)
      }
      const bytes = readAll(fd, opened.size)
      const afterFd = nativeFstat(fd)
      const afterName = nativeFstatat(parent.fd, component)
      if (!sameStat(opened, afterFd) || !sameStat(opened, afterName) || bytes.byteLength !== Number(opened.size)) {
        throw new FdTreeError("race", `file changed during read: ${component.name}`)
      }
      this.#entryWatches.push({ parent, name: component, stat: opened, kind: "file" })
      return Object.freeze({ bytes, stat: opened })
    } finally {
      if (native.close(fd) !== 0) throw mapErrno(errnoNumber(), "close file fd failed")
    }
  }

  readFileRelative(relativePath: string): Readonly<{ bytes: Buffer; stat: FdStat }> {
    const components = relativePath.split(sep).filter(Boolean)
    if (relativePath.startsWith("/") || components.length === 0 ||
      components.some((part) => part === "." || part === ".." || part.includes("\0"))) {
      throw new FdTreeError("unsafe", "relative file path contains unsupported components")
    }
    if (components.length > MAX_DIRECTORY_DEPTH) throw new FdTreeError("unsafe", "file path depth limit exceeded")
    const fileName = components.pop()!
    const parent = components.length === 0 ? this.root : this.openDirectoryRelative(components.join("/"))
    return this.readFileAt(parent, fileName)
  }

  statRelative(relativePath: string): FdStat {
    if (relativePath === "" || relativePath === ".") return this.root.openedStat
    const components = relativePath.split(sep).filter(Boolean)
    if (relativePath.startsWith("/") || components.length === 0 ||
      components.some((part) => part === "." || part === ".." || part.includes("\0"))) {
      throw new FdTreeError("unsafe", "relative entry path contains unsupported components")
    }
    if (components.length > MAX_DIRECTORY_DEPTH) throw new FdTreeError("unsafe", "entry path depth limit exceeded")
    const name = components.pop()!
    const parent = components.length === 0 ? this.root : this.openDirectoryRelative(components.join("/"))
    return this.statAt(parent, name)
  }

  readLinkAt(parent: FdDirectory, name: string | FdName): Readonly<{ bytes: Buffer; stat: FdStat }> {
    this.#assertOpen()
    parent.assertOpen()
    const component = componentName(name)
    const before = nativeFstatat(parent.fd, component)
    if (modeKind(before.mode) !== "symlink") throw new FdTreeError("unsafe", `entry is not a no-follow symlink: ${component.name}`)
    const bytes = readSymlinkBytes(parent.fd, component)
    const after = nativeFstatat(parent.fd, component)
    if (!sameStat(before, after)) throw new FdTreeError("race", `symlink changed while reading: ${component.name}`)
    this.#entryWatches.push({ parent, name: component, stat: before, kind: "symlink", bytes })
    return Object.freeze({ bytes, stat: before })
  }

  resolveLinkAt(
    parent: FdDirectory,
    name: string | FdName,
  ): FdLinkResolution {
    return this.#resolveLinkAtInternal(parent, componentName(name), 0, new Set())
  }

  #resolveLinkAtInternal(
    parent: FdDirectory,
    name: FdName,
    depth: number,
    activeLinks: Set<string>,
  ): FdLinkResolution {
    if (depth > 40) throw new FdTreeError("unsafe", "symlink resolution depth exceeded")
    const link = this.readLinkAt(parent, name)
    const identity = `${link.stat.dev}:${link.stat.ino}`
    if (activeLinks.has(identity)) throw new FdTreeError("unsafe", "symlink cycle detected")
    activeLinks.add(identity)
    try {
      let targetText: string
      try {
        targetText = new TextDecoder("utf-8", { fatal: true }).decode(link.bytes)
      } catch {
        throw new FdTreeError("unsafe", "symlink target is not valid UTF-8")
      }
      const targetPath = isAbsolute(targetText)
        ? resolve(targetText)
        : resolve(this.#rootPath, parent.relativePath === "." ? "" : parent.relativePath, targetText)
      const candidateRelative = relative(this.#rootPath, targetPath)
      const candidateInternal = candidateRelative === "" ||
        (!isAbsolute(candidateRelative) && candidateRelative !== ".." && !candidateRelative.startsWith(`..${sep}`))
      let result: LinkIdentity
      if (candidateInternal) {
        result = this.#resolveInternalPath(candidateRelative.split(sep).join("/"), depth + 1, activeLinks)
      } else {
        const externalIdentity = this.#resolveExternalIdentity(parent, name)
        result = this.#classifyCanonicalTarget(externalIdentity.canonicalTarget, depth + 1, activeLinks)
      }
      this.#entryWatches.push({
        parent,
        name,
        stat: link.stat,
        kind: "symlink",
        bytes: link.bytes,
        ...(result.internal && result.identityPath === undefined ? {} : { canonicalTarget: result.identityPath ?? result.canonicalTarget }),
      })
      return Object.freeze({
        target: Uint8Array.from(link.bytes),
        canonicalTarget: result.canonicalTarget,
        internal: result.internal,
        ...(result.relativeTarget === undefined ? {} : { relativeTarget: result.relativeTarget }),
      })
    } finally {
      activeLinks.delete(identity)
    }
  }

  #resolveInternalPath(relativeTarget: string, depth: number, activeLinks: Set<string>): LinkIdentity {
    if (depth > 40) throw new FdTreeError("unsafe", "symlink resolution depth exceeded")
    if (relativeTarget === "" || relativeTarget === ".") {
      return Object.freeze({ canonicalTarget: this.#rootPath, internal: true, relativeTarget: "" })
    }
    const components = relativeTarget.split("/").filter(Boolean)
    if (components.length > MAX_DIRECTORY_DEPTH || components.some((part) => part === "." || part === ".." || part.includes("\0"))) {
      throw new FdTreeError("unsafe", "symlink target path is unsupported")
    }
    let directory = this.root
    for (let index = 0; index < components.length; index++) {
      const component = components[index]!
      const stat = this.statAt(directory, component)
      const kind = modeKind(stat.mode)
      if (kind === "symlink") {
        const nested = this.#resolveLinkAtInternal(directory, componentName(component), depth + 1, activeLinks)
        const suffix = components.slice(index + 1)
        if (!nested.internal) {
          let canonicalTarget = nested.canonicalTarget
          if (suffix.length > 0) {
            try { canonicalTarget = realpathSync(join(canonicalTarget, ...suffix)) } catch {
              throw new FdTreeError("race", "external symlink suffix changed during identity resolution")
            }
          }
          return this.#classifyCanonicalTarget(canonicalTarget, depth + 1, activeLinks)
        }
        const combined = [nested.relativeTarget, ...suffix].filter(Boolean).join("/")
        return this.#resolveInternalPath(combined, depth + 1, activeLinks)
      }
      if (index === components.length - 1) {
        if (kind !== "file" && kind !== "directory") throw new FdTreeError("unsafe", "symlink target has an unsupported file type")
        const target = components.join("/")
        return Object.freeze({ canonicalTarget: join(this.#rootPath, target), internal: true, relativeTarget: target })
      }
      if (kind !== "directory") throw new FdTreeError("unsafe", "symlink target has a non-directory ancestor")
      directory = this.openDirectoryAt(directory, component)
    }
    throw new FdTreeError("unsafe", "symlink target path is empty")
  }

  #classifyCanonicalTarget(canonicalTarget: string, depth: number, activeLinks: Set<string>): LinkIdentity {
    const canonicalRelative = relative(this.#rootPath, canonicalTarget)
    const internal = canonicalRelative === "" ||
      (!isAbsolute(canonicalRelative) && canonicalRelative !== ".." && !canonicalRelative.startsWith(`..${sep}`))
    if (!internal) return Object.freeze({ canonicalTarget, internal: false })
    const resolved = this.#resolveInternalPath(canonicalRelative.split(sep).join("/"), depth, activeLinks)
    return Object.freeze({ ...resolved, identityPath: canonicalTarget })
  }

  #resolveExternalIdentity(parent: FdDirectory, name: FdName): LinkIdentity {
    try {
      assertPathStillNamesDirectory(parent)
      const canonicalTarget = realpathSync(join(parent.path, name.name))
      assertPathStillNamesDirectory(parent)
      return Object.freeze({ canonicalTarget, internal: false })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ELOOP") throw new FdTreeError("unsafe", "symlink cycle detected")
      if (code === "ENOENT" || code === "ESTALE") throw new FdTreeError("race", "symlink target changed during identity resolution")
      if (error instanceof FdTreeError) throw error
      throw new FdTreeError("unsafe", `cannot resolve external symlink identity: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  assertStable(): void {
    this.#assertOpen()
    for (const directory of this.#directories) {
      directory.assertOpen()
      assertPathStillNamesDirectory(directory)
      const openedNow = nativeFstat(directory.fd)
      if (!sameStat(directory.openedStat, openedNow)) throw new FdTreeError("race", `held directory changed: ${directory.path}`)
      if (directory.parent && directory.name) {
        const namedNow = nativeFstatat(directory.parent.fd, directory.name)
        if (!sameStat(directory.openedStat, namedNow)) throw new FdTreeError("race", `directory path changed: ${directory.relativePath}`)
      }
      const previousNames = this.#directoryNames.get(directory)
      if (previousNames) {
        const currentNames = readDirectoryNames(directory.fd)
        if (!sameNames(previousNames, currentNames)) {
          throw new FdTreeError("race", `directory names changed: ${directory.relativePath}`)
        }
      }
    }
    for (const watch of this.#entryWatches) {
      const current = nativeFstatat(watch.parent.fd, watch.name)
      if (!sameStat(watch.stat, current)) throw new FdTreeError("race", `entry changed: ${watch.name.name}`)
      if (watch.kind === "symlink") {
        const bytes = readSymlinkBytes(watch.parent.fd, watch.name)
        if (!watch.bytes?.equals(bytes)) throw new FdTreeError("race", `symlink changed: ${watch.name.name}`)
        if (watch.canonicalTarget && realpathSync(join(watch.parent.path, watch.name.name)) !== watch.canonicalTarget) {
          throw new FdTreeError("race", `symlink identity changed: ${watch.name.name}`)
        }
      }
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const errors: unknown[] = []
    for (const directory of [...this.#directories].reverse()) {
      try { directory.close() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors[0]
  }
}

export function fdStatKind(stat: FdStat): "file" | "directory" | "symlink" | "unsupported" {
  return modeKind(stat.mode)
}

