// Durable workflow receipts (P6a S1). Panel, consensus, choice and verification receipts are write-once files beside the snapshot,
// `sessions/<sid>/workflows/<wid>/receipts/<revision>-<action>.json`, in the external state root (a worker cannot edit
// them). Each is bound to its workflow, session, the revision it was produced at and an input hash, and is referenced
// as `"<state-relative path>#<sha256 of the file bytes>"` (the checkpoint.ts pattern). The model never writes one: the
// engine writes it after parsing typed output, and `commitRevision` re-reads and verifies every receipt it is given.
import { join } from "node:path"
import { durableWriteBytes } from "../state/durable.ts"
import { stateRoot } from "../state/store.ts"
import { ID_RE } from "./types.ts"
import { readArtifactBytes, sha256 } from "./artifacts.ts"

export const RECEIPT_KINDS = ["panel", "consensus", "choice", "verification"] as const
export type ReceiptKind = (typeof RECEIPT_KINDS)[number]
export const RECEIPT_MAX_BYTES = 256 * 1024
const ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const SHA_RE = /^[a-f0-9]{64}$/

export type Receipt = {
  v: 1
  kind: ReceiptKind
  wid: string
  sid: string
  /** The workflow revision the receipt was produced against. */
  revision: number
  /** Unique within (wid, revision): e.g. `panel-r3-contrarian`, `consensus-o2`, `choice-topology`. */
  action: string
  /** Hash of the exact input the receipt judges (panel input, plan sha, choice subject). */
  inputSha: string
  body: Readonly<Record<string, unknown>>
}

export type ReceiptInput = Omit<Receipt, "v">

export function receiptRelativePath(sid: string, wid: string, revision: number, action: string): string {
  return `sessions/${sid}/workflows/${wid}/receipts/${revision}-${action}.json`
}

function assertInput(input: ReceiptInput): void {
  if (!RECEIPT_KINDS.includes(input.kind) || !ID_RE.test(input.wid) || !ID_RE.test(input.sid) || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
    !ACTION_RE.test(input.action) || !SHA_RE.test(input.inputSha) || input.body === null || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new TypeError("invalid receipt")
  }
}

/** Write-once. Identical bytes are idempotent; a different receipt for the same slot is refused, never overwritten. */
export function writeReceipt(worktree: string, input: ReceiptInput): string {
  assertInput(input)
  const relative = receiptRelativePath(input.sid, input.wid, input.revision, input.action)
  const bytes = Buffer.from(`${JSON.stringify({ v: 1, ...input })}\n`, "utf8")
  if (bytes.length > RECEIPT_MAX_BYTES) throw new Error("receipt exceeds the size limit")
  const path = join(stateRoot(worktree), relative)
  const existing = readArtifactBytes(path, RECEIPT_MAX_BYTES)
  if (existing.ok) {
    if (!existing.bytes.equals(bytes)) throw new Error(`receipt ${relative} already exists with different content; refusing overwrite`)
    return `${relative}#${sha256(bytes)}`
  }
  if (existing.reason !== "missing") throw new Error(`receipt ${relative} is unreadable: ${existing.reason}`)
  durableWriteBytes(path, bytes)
  return `${relative}#${sha256(bytes)}`
}

export type ReceiptBinding = { sessionID: string; workflowID: string; kind?: ReceiptKind; revision?: number; inputSha?: string; action?: string }
export type ReceiptRead = { ok: true; receipt: Receipt; ref: string } | { ok: false; reason: string }

/** Verify bytes against the recorded hash and the receipt's own identity against the expected binding. */
export function verifyReceiptRef(worktree: string, ref: string, expected: ReceiptBinding): ReceiptRead {
  const at = ref.lastIndexOf("#")
  if (at < 1) return { ok: false, reason: "receipt reference is malformed" }
  const relative = ref.slice(0, at)
  const hash = ref.slice(at + 1)
  if (!SHA_RE.test(hash)) return { ok: false, reason: "receipt reference hash is malformed" }
  const prefix = `sessions/${expected.sessionID}/workflows/${expected.workflowID}/receipts/`
  const name = relative.startsWith(prefix) ? relative.slice(prefix.length) : ""
  const match = /^(\d+)-(.+)\.json$/.exec(name)
  if (!match || name.includes("/") || !ACTION_RE.test(match[2]!)) return { ok: false, reason: "receipt path does not belong to this workflow" }
  const read = readArtifactBytes(join(stateRoot(worktree), relative), RECEIPT_MAX_BYTES)
  if (!read.ok) return { ok: false, reason: `receipt ${read.reason}` }
  if (sha256(read.bytes) !== hash) return { ok: false, reason: "receipt bytes changed" }
  let value: Receipt
  try { value = JSON.parse(read.bytes.toString("utf8")) as Receipt } catch { return { ok: false, reason: "receipt is not valid JSON" } }
  try { assertInput(value); if (value.v !== 1) throw new TypeError("version") } catch { return { ok: false, reason: "receipt is malformed" } }
  if (value.wid !== expected.workflowID || value.sid !== expected.sessionID) return { ok: false, reason: "receipt names another workflow or session" }
  if (relative !== receiptRelativePath(value.sid, value.wid, value.revision, value.action)) return { ok: false, reason: "receipt path does not match its content" }
  if (expected.kind !== undefined && value.kind !== expected.kind) return { ok: false, reason: "receipt kind mismatch" }
  if (expected.revision !== undefined && value.revision !== expected.revision) return { ok: false, reason: "receipt is bound to another revision" }
  if (expected.inputSha !== undefined && value.inputSha !== expected.inputSha) return { ok: false, reason: "receipt is bound to another input" }
  if (expected.action !== undefined && value.action !== expected.action) return { ok: false, reason: "receipt action mismatch" }
  return { ok: true, receipt: value, ref }
}

/** Read-only list of the receipt refs of a workflow (names only; callers verify each through `verifyReceiptRef`). */
export function receiptsDirectory(worktree: string, sid: string, wid: string): string {
  return join(stateRoot(worktree), "sessions", sid, "workflows", wid, "receipts")
}
