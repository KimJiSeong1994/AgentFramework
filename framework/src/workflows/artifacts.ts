// Artifact verification (P5a, plan S7 "Readable artifacts"). A leaf module: safe regular-file open, existence and
// hash verification. There is deliberately no schema validator here; a nonsense file whose hash matches is verified.
// Missing, unreadable, non-regular, symlinked or hash-mismatching files are `incomplete`. Workers and models never
// set a verified flag: state is always recomputed from the bytes on disk, and display/restore recompute it again.
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { durableWriteBytes } from "../state/durable.ts"
import type { ArtifactRef, WorkflowEnvelope } from "./types.ts"

export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024

export type ArtifactState = "verified" | "present-unhashed" | "incomplete"
export type ArtifactVerification = { key: string; path: string; state: ArtifactState; reason: string }

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Readable, model-addressable artifact directory: `<worktree>/.lca/workflows/<sid>/<wid>/`. */
export function workflowArtifactDirectory(worktree: string, sessionID: string, workflowID: string): string {
  return join(worktree, ".lca", "workflows", sessionID, workflowID)
}

export type ArtifactBytes = { ok: true; bytes: Buffer } | { ok: false; reason: string }

/** No-follow, bounded, regular-file-only read. Never creates or modifies anything. */
export function readArtifactBytes(absolute: string, maxBytes = ARTIFACT_MAX_BYTES): ArtifactBytes {
  let fd: number
  try { fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { ok: false, reason: "missing" }
    if (code === "ELOOP") return { ok: false, reason: "symlink refused" }
    return { ok: false, reason: `unreadable: ${code ?? "error"}` }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, reason: "not a regular file" }
    if (stat.size > maxBytes) return { ok: false, reason: "oversize" }
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== buffer.length || fstatSync(fd).size !== buffer.length) return { ok: false, reason: "file changed while reading" }
    return { ok: true, bytes: buffer }
  } catch (error) {
    return { ok: false, reason: `unreadable: ${(error as NodeJS.ErrnoException).code ?? "error"}` }
  } finally {
    try { closeSync(fd) } catch { /* the read result stands */ }
  }
}

/** Refuse a path whose directory chain below `root` contains a symlink or a non-directory. */
function chainRefusal(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "path escapes the worktree"
  const parts = rel.split(sep)
  let current = root
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]!)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) return "symlinked path component refused"
      if (!stat.isDirectory()) return "path component is not a directory"
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable path component"
    }
  }
  return undefined
}

export function verifyArtifactFile(absolute: string, expectedSha256?: string): { state: ArtifactState; reason: string } {
  const read = readArtifactBytes(absolute)
  if (!read.ok) return { state: "incomplete", reason: read.reason }
  if (expectedSha256 === undefined) return { state: "present-unhashed", reason: "present; no recorded hash, existence only" }
  return sha256(read.bytes) === expectedSha256
    ? { state: "verified", reason: "hash matches" }
    : { state: "incomplete", reason: "hash mismatch" }
}

/** Verify a worktree-relative artifact reference. */
export function verifyArtifact(worktree: string, ref: ArtifactRef): ArtifactVerification {
  const base = { key: ref.key, path: ref.path }
  if (typeof ref.path !== "string" || ref.path.length === 0 || isAbsolute(ref.path)) {
    return { ...base, state: "incomplete", reason: "artifact path must be relative to the worktree" }
  }
  const root = resolve(worktree)
  const absolute = resolve(root, ref.path)
  const refusal = chainRefusal(root, absolute)
  if (refusal) return { ...base, state: "incomplete", reason: refusal }
  return { ...base, ...verifyArtifactFile(absolute, ref.sha256) }
}

export function verifyWorkflowArtifacts(worktree: string, wf: Pick<WorkflowEnvelope, "artifacts">): ArtifactVerification[] {
  return wf.artifacts.map(ref => verifyArtifact(worktree, ref))
}

export function artifactsIncomplete(results: readonly ArtifactVerification[]): ArtifactVerification[] {
  return results.filter(result => result.state === "incomplete")
}

/** Rendered plan reference for a plan workflow: the worktree-relative markdown view bound by its committed hash. */
export function planArtifactRefs(wf: { planRef?: { mdPath: string; mdSha: string } }): ArtifactRef[] {
  return wf.planRef ? [{ key: "plan.md", path: wf.planRef.mdPath, sha256: wf.planRef.mdSha }] : []
}

/** Every artifact an operator sees for a workflow, recomputed from disk on each call (display and restore). */
export function describeArtifacts(worktree: string, wf: Pick<WorkflowEnvelope, "artifacts"> & { planRef?: { mdPath: string; mdSha: string } }): ArtifactVerification[] {
  return [...planArtifactRefs(wf), ...wf.artifacts].map(ref => verifyArtifact(worktree, ref))
}

/**
 * Write-once, content-addressed copy `<directory>/<sha256>.<ext>`. An existing file is accepted only when
 * `acceptExisting` approves its bytes; otherwise the copy is refused rather than overwritten.
 */
export function retainContentAddressed(
  directory: string,
  bytes: Buffer,
  extension: string,
  address: string,
  acceptExisting: (existing: Buffer) => boolean = existing => sha256(existing) === address,
): string {
  if (!/^[a-f0-9]{64}$/.test(address) || !/^[a-z0-9]{1,8}$/.test(extension)) throw new TypeError("invalid content address")
  const path = join(directory, `${address}.${extension}`)
  const existing = readArtifactBytes(path)
  if (existing.ok) {
    if (!acceptExisting(existing.bytes)) throw new Error(`retained artifact ${path} exists with different content; refusing overwrite`)
    return path
  }
  if (existing.reason !== "missing") throw new Error(`retained artifact ${path} is unreadable: ${existing.reason}`)
  durableWriteBytes(path, bytes)
  return path
}

/**
 * Completion/restore display line: null when every artifact verifies from disk, otherwise the keys, paths and reasons
 * of the incomplete ones. Always recomputed; there is no stored "verified" flag to trust.
 */
export function incompleteArtifactSummary(worktree: string, wf: Pick<WorkflowEnvelope, "artifacts"> & { planRef?: { mdPath: string; mdSha: string } }): string | null {
  const incomplete = artifactsIncomplete(describeArtifacts(worktree, wf))
  return incomplete.length === 0 ? null : `artifacts incomplete: ${incomplete.map(item => `${item.key} (${item.path}: ${item.reason})`).join(", ")}`
}

// ------------------------------------------------------------------ bounded status reads
/** Status artifact-read budget: at most this many refs are considered and this many bytes read per status call. */
export const STATUS_ARTIFACT_REFS = 16
export const STATUS_ARTIFACT_BYTES = 32 * 1024 * 1024

export type BudgetedArtifactState = ArtifactState | "unverified"
export type BudgetedVerification = { key: string; path: string; state: BudgetedArtifactState; reason: string }
export type BudgetedArtifacts = { items: BudgetedVerification[]; omitted: number; bytes: number }

/**
 * Like `describeArtifacts`, but bounded: refs are sliced BEFORE any read, and once the cumulative size of verified files
 * would exceed the byte budget the remaining refs are reported `unverified` (never silently `verified`). A file's size
 * is taken from lstat before it is opened, so an oversized file is never read just to be rejected.
 */
export function describeArtifactsBudgeted(
  worktree: string,
  wf: Pick<WorkflowEnvelope, "artifacts"> & { planRef?: { mdPath: string; mdSha: string } },
  limits: { refs?: number; bytes?: number } = {},
): BudgetedArtifacts {
  const maxRefs = limits.refs ?? STATUS_ARTIFACT_REFS
  const maxBytes = limits.bytes ?? STATUS_ARTIFACT_BYTES
  const all = [...planArtifactRefs(wf), ...wf.artifacts]
  const considered = all.slice(0, maxRefs)
  const items: BudgetedVerification[] = []
  let bytes = 0
  for (const ref of considered) {
    let size = 0
    if (typeof ref.path === "string" && ref.path.length > 0 && !isAbsolute(ref.path)) {
      try { size = lstatSync(resolve(worktree, ref.path)).size } catch { size = 0 }
    }
    if (bytes + size > maxBytes) {
      items.push({ key: ref.key, path: ref.path, state: "unverified", reason: "unverified (budget)" })
      continue
    }
    const result = verifyArtifact(worktree, ref)
    if (result.state !== "incomplete" || result.reason === "hash mismatch") bytes += size
    items.push(result)
  }
  return { items, omitted: all.length - considered.length, bytes }
}
