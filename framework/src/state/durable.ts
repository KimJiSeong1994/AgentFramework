import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path"

const noFollow = fs.constants.O_NOFOLLOW ?? 0
const directoryOnly = fs.constants.O_DIRECTORY ?? 0

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined
}

function assertDirectory(path: string): void {
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink directory: ${path}`)
  if (!stat.isDirectory()) throw new Error(`path component is not a directory: ${path}`)
}

function syncDirectory(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | directoryOnly | noFollow)
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error(`not a directory: ${path}`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Create every missing directory with private permissions and durably record each new entry. */
export function ensureDurableDirectory(path: string): void {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("directory path must be non-empty")
  const absolute = resolve(path)
  const root = parse(absolute).root
  if (!root || !isAbsolute(absolute)) throw new TypeError("directory path must be absolute after resolution")
  assertDirectory(root)
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    const next = join(current, part)
    let created = false
    try {
      fs.lstatSync(next)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
      try {
        fs.mkdirSync(next, { mode: 0o700 })
        created = true
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError
      }
    }
    assertDirectory(next)
    if (created) syncDirectory(current)
    current = next
  }
}

function assertWritableTarget(path: string): void {
  try {
    const stat = fs.lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink file: ${path}`)
    if (!stat.isFile()) throw new Error(`durable JSON target is not a regular file: ${path}`)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
}

export type DurableWriteStage = "write" | "fsync" | "rename" | "dirfsync"

/** Persist bytes using a private adjacent temporary file, atomic rename, and directory fsync. `hook` fires before each step (fault injection). */
export function durableWriteBytes(path: string, bytes: Buffer, hook?: (stage: DurableWriteStage) => void, options: { createParents?: boolean } = {}): void {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("file path must be non-empty")
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (options.createParents !== false) ensureDurableDirectory(parent)
  assertWritableTarget(absolute)

  const temporary = join(parent, `.${basename(absolute)}.${randomUUID()}.tmp`)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow
  let temporaryExists = false
  try {
    const fd = fs.openSync(temporary, flags, 0o600)
    temporaryExists = true
    try {
      hook?.("write")
      let offset = 0
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error("short write while persisting file")
        offset += written
      }
      hook?.("fsync")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    assertWritableTarget(absolute)
    hook?.("rename")
    fs.renameSync(temporary, absolute)
    temporaryExists = false
    hook?.("dirfsync")
    syncDirectory(parent)
  } finally {
    if (temporaryExists) fs.unlinkSync(temporary)
  }
}

/** Persist JSON using a private adjacent temporary file, atomic rename, and directory fsync. */
export function durableWriteJson(path: string, value: unknown): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError("value is not JSON serializable")
  durableWriteBytes(path, Buffer.from(`${serialized}\n`, "utf8"))
}
