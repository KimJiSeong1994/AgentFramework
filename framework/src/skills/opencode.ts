import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { HookDeps } from "../hooks/types.ts"
import { formatCliReadResult } from "../hosts/cli-tools.ts"
import { createOpenCodeSkillPermissionSource } from "../hosts/opencode-skill-source.ts"
import { captureOpenCodeToolTurn, isOpenCodeToolTurnCurrent, type OpenCodeToolTurn } from "../hosts/opencode-system.ts"
import {
  currentOpenCodeToolCall, openCodeToolCallArgumentsMatch,
  type OpenCodeToolCall, type OpenCodeToolCallInput,
} from "../hosts/opencode-tool-call.ts"
import { getOwnedSession, inspectCurrentSessionAttachment, inspectSessionAttachment, type SessionStore } from "../sessions/store.ts"
import { policyBindingForOpenCodeSession } from "../hosts/opencode-runtime.ts"
import { authenticSkillClassification, captureSkill, readCapturedSkill, revalidateSkillCapture } from "./capture.ts"
import { registerSkillPermissionActivity } from "./activity.ts"
import { skillPermissionAllowed } from "./permission-source.ts"
import { discoverSkills, resolveSkillRoots } from "./roots.ts"
import { readCapturedSkillResource } from "./resources.ts"
import type { SkillCapture, SkillRoots } from "./types.ts"

const MAX_SCOPES = 256
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const OPERATION_TIMEOUT_MS = 60_000
type Baseline = { roots: SkillRoots; common: ReadonlyMap<string, string> }
type BaselineOwner =
  | { kind: "main"; ownerWorktree: string; supervisorSessionID: string; attachmentEpoch: string; store: SessionStore }
  | { kind: "child"; ownerWorktree: string; supervisorSessionID: string; attachmentEpoch: string }
type BaselineEntry = { owner: BaselineOwner; pending: Promise<Baseline> }
const sessions = new Map<string, BaselineEntry>()
type Source = { roots: SkillRoots; capture: SkillCapture; text: string }
type Scope = { deps: HookDeps; turn: OpenCodeToolTurn; source: Source; audit: Readonly<Record<string, string>>; signal?: AbortSignal; invocationID: string; bytes: number }
const scopes = new Map<string, Scope>()
const loadResults = new WeakMap<OpenCodeToolCall, Scope>()

export class OpenCodeSkillRefused extends Error {
  constructor() { super("lca: native skill source or scope is not currently authorized"); this.name = "OpenCodeSkillRefused" }
}
const refuse = (): never => { throw new OpenCodeSkillRefused() }
const key = (deps: HookDeps, sessionID: string): string => JSON.stringify([deps.worktree, sessionID])
function ownerWorktree(deps: HookDeps, turn: OpenCodeToolTurn): string {
  if (!isOpenCodeToolTurnCurrent(deps, turn)) return refuse()
  if (turn.kind === "main") return deps.worktree
  const child = policyBindingForOpenCodeSession(deps, turn.sessionID)
  if (!child || child.ownerSessionID !== turn.supervisorSessionID || child.ownerEpoch !== turn.attachmentEpoch) return refuse()
  return child.ownerWorktree
}
// Keep execution identity out: replacement children in one supervisor epoch reuse this exact source baseline.
const baselineKey = (deps: HookDeps, turn: OpenCodeToolTurn) =>
  JSON.stringify([deps.worktree, turn.sessionID, turn.supervisorSessionID, turn.attachmentEpoch, turn.role, turn.policy.id])
const captureKey = (capture: SkillCapture) => JSON.stringify([capture.identity, capture.name])
function baselineOwner(deps: HookDeps, turn: OpenCodeToolTurn): BaselineOwner {
  const worktree = ownerWorktree(deps, turn)
  if (turn.kind === "main") {
    const store = getOwnedSession(worktree, turn.supervisorSessionID)
    if (!store || store.epoch !== turn.attachmentEpoch) return refuse()
    return {
      kind: "main", ownerWorktree: worktree, supervisorSessionID: turn.supervisorSessionID,
      attachmentEpoch: turn.attachmentEpoch, store,
    }
  }
  return {
    kind: "child", ownerWorktree: worktree, supervisorSessionID: turn.supervisorSessionID,
    attachmentEpoch: turn.attachmentEpoch,
  }
}
function sameBaselineOwner(a: BaselineOwner, b: BaselineOwner): boolean {
  return a.kind === b.kind && a.ownerWorktree === b.ownerWorktree &&
    a.supervisorSessionID === b.supervisorSessionID && a.attachmentEpoch === b.attachmentEpoch &&
    (a.kind !== "main" || (b.kind === "main" && a.store === b.store))
}
function baselineOwnerReleased(owner: BaselineOwner): boolean {
  if (owner.kind === "main") return owner.store.isReleased
  try {
    const current = inspectCurrentSessionAttachment(owner.ownerWorktree, owner.supervisorSessionID)
    if (current?.state === "attached" && current.identity !== "ambiguous" && current.epoch !== owner.attachmentEpoch) return true
    return inspectSessionAttachment(owner.ownerWorktree, owner.supervisorSessionID, owner.attachmentEpoch)?.state === "released"
  } catch {
    // An absent, unreadable, or ambiguous remote owner is not evidence that its baseline is disposable.
    return false
  }
}
/** A stale turn or hold is not retirement evidence; only a released local handle or durable remote epoch is. */
function pruneReleasedBaselines(): void {
  for (const [id, entry] of sessions) if (baselineOwnerReleased(entry.owner)) sessions.delete(id)
}
async function sourceWork<T>(deps: HookDeps, turn: OpenCodeToolTurn, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return refuse()
  const controller = new AbortController()
  const unregister = registerSkillPermissionActivity(ownerWorktree(deps, turn), turn.supervisorSessionID, turn.attachmentEpoch, controller)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS)
  try {
    const result = await operation(controller.signal)
    if (controller.signal.aborted || !isOpenCodeToolTurnCurrent(deps, turn)) return refuse()
    return result
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
    controller.abort()
    unregister()
  }
}
function assertCall(deps: HookDeps, call: OpenCodeToolCall, args: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || !openCodeToolCallArgumentsMatch(deps, call, args)) refuse()
}
function currentScope(deps: HookDeps, call: OpenCodeToolCall): Scope | undefined {
  const id = key(deps, call.sessionID)
  const scope = scopes.get(id)
  if (!scope) return undefined
  if (!isOpenCodeToolTurnCurrent(scope.deps, scope.turn)) { scopes.delete(id); return undefined }
  // OpenCode aborts each tool's own signal when that tool finishes, so it only guards the loading call itself;
  // later continuation calls are fenced by turn currentness (stop/hold/new turn) checked above.
  if (scope.signal?.aborted && call.callID === scope.audit.callID) return refuse()
  if (scope.turn.userMessageID !== call.userMessageID || scope.turn.supervisorSessionID !== call.supervisorSessionID ||
      scope.turn.attachmentEpoch !== call.attachmentEpoch || scope.turn.role !== call.role || scope.turn.policy !== call.policy) return refuse()
  return scope
}
async function revalidateSource(deps: HookDeps, call: OpenCodeToolCall, args: unknown, scope: Scope, signal: AbortSignal): Promise<void> {
  const active = scope.signal && call.callID === scope.audit.callID ? AbortSignal.any([signal, scope.signal]) : signal
  const result = await sourceWork(deps, scope.turn, work => revalidateSkillCapture(scope.source.roots, scope.source.capture, { signal: work }), active)
  assertCall(deps, call, args)
  if (!result.unchanged || authenticSkillClassification(result.capture) !== "common" ||
      result.capture.contentHash !== scope.source.capture.contentHash || currentScope(deps, call) !== scope) refuse()
}
async function permission(deps: HookDeps, call: OpenCodeToolCall, args: unknown, name: string, signal: AbortSignal): Promise<void> {
  assertCall(deps, call, args, signal)
  const turn = captureOpenCodeToolTurn(deps, call.sessionID)
  if (!turn) return refuse()
  const source = await sourceWork(deps, turn, active => createOpenCodeSkillPermissionSource(deps, call.role)(active), signal)
  assertCall(deps, call, args, signal)
  if (!source || source.skillEnabled !== true || !skillPermissionAllowed(source.permissions, name)) refuse()
}

/** Establish the baseline at authenticated turn/attachment admission, never lazily at skill loading. */
export async function initializeOpenCodeSkillSession(deps: HookDeps, turn: OpenCodeToolTurn): Promise<void> {
  const owner = baselineOwner(deps, turn)
  const id = baselineKey(deps, turn)
  let entry = sessions.get(id)
  if (entry && !sameBaselineOwner(entry.owner, owner)) return refuse()
  if (!entry) {
    pruneReleasedBaselines()
    if (sessions.size >= MAX_SCOPES) return refuse()
    entry = { owner, pending: sourceWork(deps, turn, async signal => {
      const roots = await resolveSkillRoots({ projectRoot: deps.worktree, homeDirectory: homedir() })
      if (signal.aborted || !isOpenCodeToolTurnCurrent(deps, turn)) return refuse()
      const discovered = await discoverSkills(roots, { signal })
      const common = new Map<string, string>()
      for (const descriptor of discovered.descriptors) {
        if (signal.aborted || !isOpenCodeToolTurnCurrent(deps, turn)) return refuse()
        if (descriptor.kind !== "skill" || descriptor.source !== "project") continue
        try {
          const capture = await captureSkill(roots, descriptor, { signal })
          if (authenticSkillClassification(capture) === "common") common.set(captureKey(capture), capture.contentHash)
        } catch {
          if (signal.aborted || !isOpenCodeToolTurnCurrent(deps, turn)) return refuse()
          // A source without an exact baseline cannot be loaded by this headless adapter.
        }
      }
      return { roots, common }
    }) }
    sessions.set(id, entry)
  }
  try {
    await entry.pending
    ownerWorktree(deps, turn)
  } catch {
    if (sessions.get(id) === entry) sessions.delete(id)
    refuse()
  }
}

/** No UI or allow-once exists here. This narrows an already proven native call; it never admits one. */
export async function beforeOpenCodeSkillTool(deps: HookDeps, call: OpenCodeToolCall, args: unknown): Promise<void> {
  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS)
  assertCall(deps, call, args, signal)
  const scope = currentScope(deps, call)
  if (!scope) return
  if (call.tool === "skill" || scope.source.capture.descriptor.kind !== "skill" ||
      (scope.source.capture.descriptor.allowedTools !== undefined && !scope.source.capture.descriptor.allowedTools.some(tool => tool === call.tool))) refuse()
  await permission(deps, call, args, scope.source.capture.name, signal)
  await revalidateSource(deps, call, args, scope, signal)
  assertCall(deps, call, args, signal)
  if (currentScope(deps, call) !== scope) refuse()
}

/** The registered tool adapter receives genuine host context, not a model-declared invocation identity. */
export async function loadOpenCodeSkill(
  deps: HookDeps,
  input: OpenCodeToolCallInput & { assistantMessageID: string },
  args: { name: string },
  nativeSignal?: AbortSignal,
): Promise<{ title: string; output: string; metadata: Record<string, string> }> {
  try {
    const timeout = AbortSignal.timeout(OPERATION_TIMEOUT_MS)
    const signal = nativeSignal ? AbortSignal.any([nativeSignal, timeout]) : timeout
    const call = currentOpenCodeToolCall(deps, input)
    if (!call || call.tool !== "skill" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(args.name)) return refuse()
    assertCall(deps, call, args, signal)
    if (currentScope(deps, call)) return refuse()
    await permission(deps, call, args, args.name, signal)
    const turn = captureOpenCodeToolTurn(deps, call.sessionID)
    if (!turn) return refuse()
    const worktree = ownerWorktree(deps, turn)
    const entry = sessions.get(baselineKey(deps, turn))
    if (!entry) return refuse()
    const baseline = await entry.pending
    assertCall(deps, call, args, signal)
    const capture = await sourceWork(deps, turn, async active => {
      const discovered = await discoverSkills(baseline.roots, { signal: active })
      assertCall(deps, call, args, active)
      const descriptor = discovered.descriptors.find(item => item.name === args.name)
      if (!descriptor || descriptor.kind !== "skill" || descriptor.source !== "project") return refuse()
      return captureSkill(baseline.roots, descriptor, { signal: active })
    }, signal)
    assertCall(deps, call, args, signal)
    if (authenticSkillClassification(capture) !== "common" || baseline.common.get(captureKey(capture)) !== capture.contentHash) return refuse()
    const instructions = readCapturedSkill(capture)
    if (!instructions) return refuse()
    const source: Source = { roots: baseline.roots, capture, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(instructions) }
    await permission(deps, call, args, args.name, signal)
    const checked = await sourceWork(deps, turn, active => revalidateSkillCapture(baseline.roots, capture, { signal: active }), signal)
    if (!checked.unchanged || authenticSkillClassification(checked.capture) !== "common") return refuse()
    assertCall(deps, call, args, signal)
    if (ownerWorktree(deps, turn) !== worktree || currentScope(deps, call)) return refuse()
    for (const [id, scope] of scopes) if (!isOpenCodeToolTurnCurrent(scope.deps, scope.turn)) scopes.delete(id)
    const bytes = source.capture.files.reduce((sum, file) => sum + file.size, 0)
    if (scopes.size >= MAX_SCOPES || [...scopes.values()].reduce((sum, scope) => sum + scope.bytes, bytes) > MAX_CAPTURE_BYTES) return refuse()
    const invocationID = randomUUID()
    const audit = {
      invocationID, sdkSessionID: call.sessionID, userMessageID: call.userMessageID,
      assistantMessageID: call.assistantMessageID, callID: call.callID, attachmentEpoch: call.attachmentEpoch,
      name: source.capture.name, source: source.capture.source, contentHash: source.capture.contentHash,
    }
    const scope: Scope = { deps, turn, source, audit: Object.freeze(audit), signal: nativeSignal, invocationID, bytes }
    const store = getOwnedSession(worktree, call.supervisorSessionID)
    if (store?.epoch === call.attachmentEpoch) store.append("notice", { text: `Skill invocation audit ${JSON.stringify(audit)}` })
    else if (call.kind === "main") return refuse()
    // A remote child's audit facts are retained in SDK tool metadata, never through a forged parent writer.
    assertCall(deps, call, args, signal)
    scopes.set(key(deps, call.sessionID), scope)
    loadResults.set(call, scope)
    return { title: "LCA skill loaded", output: source.text, metadata: audit }
  } catch { return refuse() }
}

/** Replaces any vendor truncation/reread with the exact captured instruction bytes before inference. */
export async function afterOpenCodeSkillTool(
  deps: HookDeps, call: OpenCodeToolCall, args: unknown,
  output: { title: string; output: string; metadata: unknown },
): Promise<() => void> {
  try {
    assertCall(deps, call, args)
    const scope = currentScope(deps, call)
    let capturedOutput: string | undefined
    if (scope) {
      const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS)
      await permission(deps, call, args, scope.source.capture.name, signal)
      await revalidateSource(deps, call, args, scope, signal)
      assertCall(deps, call, args, signal)
      if (currentScope(deps, call) !== scope) return refuse()
    }
    if (call.tool === "skill") {
      if (!scope || loadResults.get(call) !== scope) return refuse()
      capturedOutput = scope.source.text
    } else if (scope && call.tool === "read") {
      if (!args || typeof args !== "object" || Array.isArray(args)) return refuse()
      const input = args as Record<string, unknown>
      if (typeof input.filePath !== "string") return refuse()
      const resource = readCapturedSkillResource(scope.source.roots, scope.source.capture, resolve(deps.directory, input.filePath))
      if (resource) {
        const offset = input.offset ?? 1
        const limit = input.limit ?? 2000
        if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1) return refuse()
        const directoryStart = Math.max(offset as number, 1) - 1
        const directoryEnd = directoryStart + Math.min(limit as number, 200)
        const bytes = resource.kind === "file" ? resource.bytes : Buffer.from(
          JSON.stringify(resource.entries.slice(directoryStart, directoryEnd)) +
          (resource.entries.length > directoryEnd ? "\n[partial captured directory]" : ""),
        )
        const rendered = formatCliReadResult(bytes, {
          path: "captured-source", startLine: resource.kind === "file" ? Math.max(offset as number, 1) : 1,
          maxLines: resource.kind === "file" ? Math.min(limit as number, 2000) : 2,
        })
        if (!rendered.ok) return refuse()
        capturedOutput = rendered.text
      }
    }
    const finalize = () => {
      assertCall(deps, call, args)
      if (currentScope(deps, call) !== scope) return refuse()
      if (capturedOutput !== undefined && scope) {
        const attachments = (output as { attachments?: unknown }).attachments
        if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length !== 0)) return refuse()
        output.title = call.tool === "skill" ? "LCA skill loaded" : "LCA captured source"
        output.output = capturedOutput
        output.metadata = { ...scope.audit }
      }
    }
    finalize()
    return finalize
  } catch { return refuse() }
}
