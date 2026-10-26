import type { Terminal } from "../hosts/interactive-session.ts"
import { captureAdmissionLease, isAdmissionLeaseCurrent, type AdmissionLease } from "../sessions/admission.ts"
import { getOwnedSession, type SessionStore } from "../sessions/store.ts"
import { registerSkillPermissionActivity } from "./activity.ts"
import {
  authenticSkillClassification, captureSkill, isAuthenticSkillCapture, readCapturedSkill,
  revalidateSkillCapture, SkillCaptureError,
} from "./capture.ts"
import { discoverSkills, skillRootTier } from "./roots.ts"
import { NO_SKILL_TRUST, skillTrusted, type SkillAutoPolicy, type SkillTrust } from "./trust.ts"
import type { SkillCapture, SkillDescriptor, SkillDiscovery, SkillRoots, SkillToolName } from "./types.ts"

const CLI_ENGINES = new Set(["local", "codex", "claude"])
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const CONSENT_TIMEOUT_MS = 60_000
const MAX_EXTERNAL_CONSENT_ROUNDS = 16

type SkillTerminal = Pick<Terminal, "stdinIsTTY" | "stderrIsTTY" | "choose" | "resume">
export type SkillGrant = Readonly<{
  name: string
  identity: string
  source: SkillCapture["source"]
  contentHash: string
  classification: "common" | "custom"
  allowedTools?: readonly SkillToolName[]
  /** Granted by the operator's `skill_trust` user config instead of a prompt. */
  trusted?: true
}>
export type SkillCatalogEntry = Readonly<{
  descriptor: SkillDescriptor
  classification: "common" | "custom" | "unavailable"
  refusal?: string
  /** Usable without the source-consent prompt because user config trusts it. */
  trusted?: true
}>
export type SkillCatalog = Readonly<{ entries: readonly SkillCatalogEntry[]; refusals: SkillDiscovery["refusals"] }>
/** A skill the per-turn selector may apply: usable without any prompt, policy-eligible and within the byte budget. */
export type AutoSkillCandidate = Readonly<{ name: string; description: string; bytes: number }>
export type SkillConsent = "prompt" | "never"

declare const preparedSkillBrand: unique symbol
export type PreparedSkillInvocation = Readonly<{ name: string; contentHash: string; [preparedSkillBrand]: never }>
type PreparedState = {
  session: SkillSession
  capture: SkillCapture
  lease: AdmissionLease
  revision: number
  claimed: boolean
  freshWitnessInvocation: boolean
}
const preparedInvocations = new WeakMap<object, PreparedState>()
const skillSessionStores = new WeakSet<object>()

export class SkillAdmissionError extends Error {
  constructor(message: string) { super(message); this.name = "SkillAdmissionError" }
}

function abortError(): Error {
  const error = new Error("Skill invocation cancelled; no skill authority was granted.")
  error.name = "AbortError"
  return error
}
function grantKey(capture: SkillCapture): string {
  return JSON.stringify([capture.identity, capture.name, capture.contentHash])
}
function sameCapture(left: SkillCapture, right: SkillCapture): boolean {
  return left.identity === right.identity && left.name === right.name && left.contentHash === right.contentHash &&
    authenticSkillClassification(left) === authenticSkillClassification(right)
}

/** Memory-only source consent. Neither transcripts nor persisted audit identities can construct a grant. */
export class SkillSession {
  readonly roots: SkillRoots
  readonly store: SessionStore
  private readonly terminal?: SkillTerminal
  private readonly trust: SkillTrust
  private readonly baseline = new Set<string>()
  private readonly grants = new Map<string, SkillGrant>()
  private readonly captureTargets = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly pendingChoices = new Map<AbortController, string>()
  private readonly pendingCaptures = new Map<AbortController, string | undefined>()
  private readonly invocationControllers = new Map<AbortController, string>()
  private readonly lifecycle = new AbortController()
  private readonly freshWitnessAttachment: boolean
  private preparedInvocationCount = 0
  private lease?: AdmissionLease
  private closed = false

  private constructor(input: { roots: SkillRoots; store: SessionStore; terminal?: SkillTerminal; trust?: SkillTrust }) {
    this.roots = input.roots
    this.store = input.store
    this.terminal = input.terminal
    this.trust = input.trust ?? NO_SKILL_TRUST
    this.freshWitnessAttachment = !input.store.restored && !skillSessionStores.has(input.store)
    skillSessionStores.add(input.store)
    this.assertOwned()
  }

  /** Restored held readers establish a new common baseline without admitting work or restoring grants. */
  static async create(input: { roots: SkillRoots; store: SessionStore; terminal?: SkillTerminal; trust?: SkillTrust }, signal: AbortSignal): Promise<SkillSession> {
    const session = new SkillSession(input)
    try {
      const discovery = await session.captureWork(signal, active => discoverSkills(session.roots, { signal: active }))
      for (const descriptor of discovery.descriptors) {
        session.checkSignal(signal)
        if (descriptor.kind !== "skill" || descriptor.source !== "project") continue
        try {
          const capture = await session.captureWork(signal, active => captureSkill(session.roots, descriptor, { signal: active }), descriptor.name)
          session.checkSignal(signal)
          if (authenticSkillClassification(capture) === "common") session.baseline.add(grantKey(capture))
        } catch (error) {
          session.checkSignal(signal)
          if (!(error instanceof SkillCaptureError)) throw error
        }
      }
      session.checkSignal(signal)
      return session
    } catch (error) {
      session.close()
      throw error
    }
  }

  private assertOwned(): void {
    if (this.closed || getOwnedSession(this.roots.projectRoot, this.store.sessionID) !== this.store) {
      throw new SkillAdmissionError("Skill session attachment is no longer owned.")
    }
    this.store.assertOwner()
  }

  private checkSignal(signal: AbortSignal): void {
    if (signal.aborted || this.lifecycle.signal.aborted) throw abortError()
    this.assertOwned()
  }

  private async captureWork<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>, name?: string): Promise<T> {
    this.checkSignal(signal)
    const controller = new AbortController()
    const stop = () => controller.abort(abortError())
    const unregister = registerSkillPermissionActivity(this.roots.projectRoot, this.store.sessionID, this.store.epoch, controller)
    this.pendingCaptures.set(controller, name)
    signal.addEventListener("abort", stop, { once: true })
    this.lifecycle.signal.addEventListener("abort", stop, { once: true })
    try {
      if (signal.aborted || this.lifecycle.signal.aborted) stop()
      this.checkSignal(controller.signal)
      const result = await operation(controller.signal)
      this.checkSignal(controller.signal)
      return result
    } finally {
      signal.removeEventListener("abort", stop)
      this.lifecycle.signal.removeEventListener("abort", stop)
      controller.abort()
      this.pendingCaptures.delete(controller)
      unregister()
    }
  }

  private expireStaleAuthority(): void {
    if (this.lease && !isAdmissionLeaseCurrent(this.roots.projectRoot, this.store.sessionID, this.lease)) {
      this.lease = undefined
      this.grants.clear()
      this.captureTargets.clear()
    }
  }

  private requireLease(): AdmissionLease {
    this.assertOwned()
    this.expireStaleAuthority()
    this.lease ??= captureAdmissionLease(this.roots.projectRoot, this.store.sessionID)
    if (!this.lease) throw new SkillAdmissionError("Skill invocation remains held; explicitly resume this session first.")
    return this.lease
  }

  private assertLease(lease: AdmissionLease, signal?: AbortSignal): void {
    if (signal) this.checkSignal(signal)
    else this.assertOwned()
    if (!isAdmissionLeaseCurrent(this.roots.projectRoot, this.store.sessionID, lease)) {
      this.expireStaleAuthority()
      throw new SkillAdmissionError("Skill authorization expired with its admission incarnation.")
    }
  }

  private assertRevision(name: string, revision: number): void {
    if ((this.revisions.get(name) ?? 0) !== revision) throw new SkillAdmissionError("Skill invocation was revoked.")
  }

  private async choose(name: string, revision: number, title: string, choices: readonly string[], lease: AdmissionLease, signal: AbortSignal, consent: SkillConsent): Promise<number | undefined> {
    this.assertLease(lease, signal)
    this.assertRevision(name, revision)
    if (consent === "never") throw new SkillAdmissionError(`Skill ${name} needs consent; automatic selection never prompts.`)
    const terminal = this.terminal
    if (!CLI_ENGINES.has(this.store.metadata.engine) || terminal?.stdinIsTTY !== true || terminal.stderrIsTTY !== true || !terminal.choose) {
      throw new SkillAdmissionError("This skill requires consent from an attached foreground CLI; no authority was granted.")
    }
    const controller = new AbortController()
    const stop = () => controller.abort(abortError())
    const unregister = registerSkillPermissionActivity(this.roots.projectRoot, this.store.sessionID, this.store.epoch, controller)
    this.pendingChoices.set(controller, name)
    signal.addEventListener("abort", stop, { once: true })
    this.lifecycle.signal.addEventListener("abort", stop, { once: true })
    const timer = setTimeout(stop, CONSENT_TIMEOUT_MS)
    let onAbort: (() => void) | undefined
    try {
      if (signal.aborted || this.lifecycle.signal.aborted) stop()
      if (controller.signal.aborted) throw abortError()
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError())
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      const answer = await Promise.race([Promise.resolve().then(() => terminal.choose!(title, choices, controller.signal)), cancelled])
      if (controller.signal.aborted) throw abortError()
      this.assertLease(lease, signal)
      this.assertRevision(name, revision)
      return answer
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      this.lifecycle.signal.removeEventListener("abort", stop)
      if (onAbort) controller.signal.removeEventListener("abort", onAbort)
      controller.abort()
      unregister()
      this.pendingChoices.delete(controller)
      if (!this.closed && getOwnedSession(this.roots.projectRoot, this.store.sessionID) === this.store) terminal.resume?.()
    }
  }

  private async consentToCapture(name: string, revision: number, targets: readonly string[], lease: AdmissionLease, signal: AbortSignal, consent: SkillConsent): Promise<void> {
    const missing = [...new Set(targets)].filter(target => !this.captureTargets.has(target))
    if (!missing.length) throw new SkillAdmissionError("External skill source changed or is not safely capturable.")
    const answer = await this.choose(name, revision,
      `External skill capture read only\n${missing.join("\n")}\nAllow these targets for source capture in this session only. This grants no tool, execution, or outside-write authority.`,
      ["Allow capture read", "Deny"], lease, signal, consent,
    )
    if (answer !== 0) throw new SkillAdmissionError("External source capture was denied; no skill was invoked.")
    this.assertLease(lease, signal)
    this.assertRevision(name, revision)
    for (const target of missing) this.captureTargets.add(target)
  }

  private async freshCapture(name: string, revision: number, lease: AdmissionLease, signal: AbortSignal, consent: SkillConsent): Promise<SkillCapture> {
    for (let attempt = 0; attempt <= MAX_EXTERNAL_CONSENT_ROUNDS; attempt++) {
      this.assertLease(lease, signal)
      this.assertRevision(name, revision)
      const options = { consentedExternalTargets: [...this.captureTargets] }
      const discovery = await this.captureWork(signal, active => discoverSkills(this.roots, { ...options, signal: active }), name)
      this.assertLease(lease, signal)
      const descriptor = discovery.descriptors.find(candidate => candidate.name === name)
      if (descriptor?.kind === "protected-workflow") {
        throw new SkillAdmissionError(`Protected workflow ${name} cannot be expanded as an ordinary skill.`)
      }
      if (!descriptor) {
        const refusals = discovery.refusals.filter(refusal => refusal.name === name)
        const targets = refusals.flatMap(refusal => refusal.reason === "external-consent-required" ? refusal.externalTargets ?? [] : [])
        if (targets.length && refusals.every(refusal => refusal.reason === "external-consent-required") && attempt < MAX_EXTERNAL_CONSENT_ROUNDS) {
          await this.consentToCapture(name, revision, targets, lease, signal, consent)
          continue
        }
        throw new SkillAdmissionError(`Skill ${name} is unavailable${refusals.length ? `: ${refusals.map(refusal => refusal.reason).join(", ")}` : ""}.`)
      }
      try {
        const capture = await this.captureWork(signal, active => captureSkill(this.roots, descriptor, { ...options, signal: active }), name)
        this.assertLease(lease, signal)
        this.assertRevision(name, revision)
        return capture
      } catch (error) {
        this.assertLease(lease, signal)
        if (!(error instanceof SkillCaptureError) || error.reason !== "external-consent-required" || attempt === MAX_EXTERNAL_CONSENT_ROUNDS) throw error
        await this.consentToCapture(name, revision, error.externalTargets, lease, signal, consent)
      }
    }
    throw new SkillAdmissionError("External skill capture consent limit reached.")
  }

  async catalog(signal: AbortSignal): Promise<SkillCatalog> {
    this.checkSignal(signal)
    this.expireStaleAuthority()
    const options = { consentedExternalTargets: [...this.captureTargets] }
    const discovery = await this.captureWork(signal, active => discoverSkills(this.roots, { ...options, signal: active }))
    const entries: SkillCatalogEntry[] = []
    for (const descriptor of discovery.descriptors) {
      this.checkSignal(signal)
      const trusted = skillTrusted(this.trust, this.roots, descriptor) ? { trusted: true as const } : {}
      if (descriptor.kind === "protected-workflow") entries.push(Object.freeze({ descriptor, classification: "common" }))
      else if (descriptor.source === "home") entries.push(Object.freeze({ descriptor, classification: "custom", ...trusted }))
      else {
        try {
          const capture = await this.captureWork(signal, active => captureSkill(this.roots, descriptor, { ...options, signal: active }), descriptor.name)
          this.checkSignal(signal)
          const classification = authenticSkillClassification(capture)
          if (!classification) throw new SkillAdmissionError("Skill capture authenticity is unavailable.")
          entries.push(Object.freeze({ descriptor, classification, ...trusted }))
        } catch (error) {
          this.checkSignal(signal)
          if (!(error instanceof SkillCaptureError)) throw error
          entries.push(Object.freeze({ descriptor, classification: "unavailable", refusal: error.reason }))
        }
      }
    }
    this.checkSignal(signal)
    return Object.freeze({ entries: Object.freeze(entries), refusals: discovery.refusals })
  }

  /**
   * Whether automatic selection may use this captured content without any prompt. Project skills qualify only as the
   * unchanged common baseline or under a trusted *folder*: name trust is for the operator's home skills, because a
   * cloned repository could otherwise shadow a trusted home name with its own untracked `.agents/skills/<name>`.
   * Session grants from an earlier prompt never qualify, so automatic use cannot widen what the operator configured.
   */
  private autoAuthorized(capture: SkillCapture): boolean {
    if (capture.descriptor.kind !== "skill") return false
    // allowed-tools pre-approves; the automatic path runs with the base role tools and never binds the declared scope.
    if (capture.descriptor.disableModelInvocation) return false
    if (authenticSkillClassification(capture) === "common" && this.baseline.has(grantKey(capture))) return true
    if (capture.descriptor.source === "home") return skillTrusted(this.trust, this.roots, capture.descriptor)
    return skillTrusted({ names: new Set(), folders: this.trust.folders }, this.roots, capture.descriptor)
  }

  /**
   * Skills the per-turn selector may apply: consent-free content (see autoAuthorized), native tier unless `include`
   * names it, not excluded, not `disable-model-invocation`, and at most `maxBytes`. A declared allowed-tools scope does
   * not exclude a skill: automatic use never binds it, so the turn keeps the role's own tools.
   * Uncapturable skills are skipped, never prompted for.
   */
  async autoCandidates(policy: SkillAutoPolicy, maxBytes: number, signal: AbortSignal): Promise<readonly AutoSkillCandidate[]> {
    this.checkSignal(signal)
    if (policy.mode === "off") return Object.freeze([])
    const discovery = await this.captureWork(signal, active => discoverSkills(this.roots, { signal: active }))
    const result: AutoSkillCandidate[] = []
    for (const descriptor of discovery.descriptors) {
      this.checkSignal(signal)
      if (descriptor.kind !== "skill" || policy.exclude.has(descriptor.name)) continue
      const tier = skillRootTier(descriptor)
      if (tier === undefined || (tier === "import" && !policy.include.has(descriptor.name))) continue
      let capture: SkillCapture
      try {
        capture = await this.captureWork(signal, active => captureSkill(this.roots, descriptor, { signal: active }), descriptor.name)
      } catch (error) {
        this.checkSignal(signal)
        if (error instanceof SkillCaptureError) continue
        throw error
      }
      if (!this.autoAuthorized(capture)) continue
      const bytes = readCapturedSkill(capture)?.byteLength
      if (bytes === undefined || bytes > maxBytes) continue
      result.push(Object.freeze({ name: descriptor.name, description: descriptor.description, bytes }))
    }
    this.checkSignal(signal)
    return Object.freeze(result)
  }

  /**
   * `consent: "never"` refuses instead of prompting (automatic selection) and re-applies the autoCandidates rule to the
   * fresh capture; the default asks on the foreground CLI.
   */
  async prepare(name: string, signal: AbortSignal, options: { consent?: "prompt" | "never" } = {}): Promise<PreparedSkillInvocation> {
    if (!NAME.test(name)) throw new SkillAdmissionError("Exactly one valid ordinary skill name is required.")
    const freshWitnessInvocation = this.freshWitnessAttachment && !this.store.restored && this.preparedInvocationCount === 0
    this.preparedInvocationCount++
    const consent = options.consent ?? "prompt"
    const lease = this.requireLease()
    const revision = this.revisions.get(name) ?? 0
    let capture = await this.freshCapture(name, revision, lease, signal, consent)
    // Automatic use applies the same rule as autoCandidates at prepare time: content may have changed since listing.
    if (options.consent === "never" && !this.autoAuthorized(capture)) {
      throw new SkillAdmissionError(`Skill ${name} is not usable without consent; automatic selection never prompts.`)
    }
    if (!this.authorizes(capture, lease, revision) && skillTrusted(this.trust, this.roots, capture.descriptor)) {
      // Operator-configured trust stands in for the prompt; the grant still binds to this captured content.
      const scope = capture.descriptor.kind === "skill" ? capture.descriptor.allowedTools : undefined
      this.grants.set(grantKey(capture), Object.freeze({
        name: capture.name, identity: capture.identity, source: capture.source,
        contentHash: capture.contentHash, classification: capture.classification, trusted: true as const,
        ...(scope === undefined ? {} : { allowedTools: Object.freeze([...scope]) }),
      }))
    }
    if (!this.authorizes(capture, lease, revision)) {
      const scope = capture.descriptor.kind === "skill" ? capture.descriptor.allowedTools : undefined
      const answer = await this.choose(name, revision,
        `Skill: ${capture.name}\nSource: ${capture.source} · ${capture.identity}\nClass: ${capture.classification}\nHash: ${capture.contentHash}\nDeclared scope: ${scope === undefined ? "current role's permitted tools" : scope.join(", ") || "no tools"}\nBase role, path, and execution approval restrictions remain unchanged.`,
        ["Allow this content in this session", "Deny"], lease, signal, consent,
      )
      if (answer !== 0) throw new SkillAdmissionError("Skill invocation was denied; no instructions were dispatched.")
      const checked = await this.freshCapture(name, revision, lease, signal, consent)
      if (!sameCapture(capture, checked)) throw new SkillAdmissionError("Skill content or classification changed during consent; invoke it again.")
      capture = checked
      this.assertLease(lease, signal)
      this.grants.set(grantKey(capture), Object.freeze({
        name: capture.name, identity: capture.identity, source: capture.source,
        contentHash: capture.contentHash, classification: capture.classification,
        ...(scope === undefined ? {} : { allowedTools: Object.freeze([...scope]) }),
      }))
    }
    this.assertLease(lease, signal)
    this.assertRevision(name, revision)
    const prepared = Object.freeze({ name: capture.name, contentHash: capture.contentHash }) as PreparedSkillInvocation
    preparedInvocations.set(prepared, {
      session: this, capture, lease, revision, claimed: false, freshWitnessInvocation,
    })
    return prepared
  }

  authorizes(capture: SkillCapture, lease: AdmissionLease, revision: number): boolean {
    try {
      this.assertLease(lease)
      this.assertRevision(capture.name, revision)
      if (!isAuthenticSkillCapture(capture)) return false
      return authenticSkillClassification(capture) === "common" && this.baseline.has(grantKey(capture)) || this.grants.has(grantKey(capture))
    } catch { return false }
  }

  async recapture(capture: SkillCapture, lease: AdmissionLease, revision: number, signal: AbortSignal): Promise<SkillCapture> {
    this.assertLease(lease, signal)
    if (!this.authorizes(capture, lease, revision)) throw new SkillAdmissionError("Skill authorization was revoked or expired.")
    const result = await this.captureWork(signal, active => revalidateSkillCapture(this.roots, capture, {
      consentedExternalTargets: [...this.captureTargets], signal: active,
    }), capture.name)
    this.assertLease(lease, signal)
    if (!result.unchanged || !sameCapture(capture, result.capture) || !this.authorizes(result.capture, lease, revision)) {
      throw new SkillAdmissionError("Skill content, scope, or classification changed; a new invocation is required.")
    }
    return result.capture
  }

  listGrants(): readonly SkillGrant[] {
    this.assertOwned()
    this.expireStaleAuthority()
    return Object.freeze([...this.grants.values()])
  }

  captureReadScopes(): readonly string[] {
    this.assertOwned()
    this.expireStaleAuthority()
    return Object.freeze([...this.captureTargets])
  }

  registerInvocationCancellation(name: string, revision: number, controller: AbortController): () => void {
    this.assertOwned()
    this.assertRevision(name, revision)
    if (!(controller instanceof AbortController) || controller.signal.aborted || this.invocationControllers.has(controller)) {
      throw new SkillAdmissionError("A fresh invocation cancellation owner is required.")
    }
    this.invocationControllers.set(controller, name)
    return () => { this.invocationControllers.delete(controller) }
  }

  revoke(name: string): number {
    this.assertOwned()
    this.expireStaleAuthority()
    if (!NAME.test(name)) throw new SkillAdmissionError("A valid skill name is required.")
    this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1)
    for (const [controller, pendingName] of this.pendingChoices) {
      if (pendingName === name) controller.abort(abortError())
    }
    for (const [controller, pendingName] of this.pendingCaptures) {
      if (pendingName === name) controller.abort(abortError())
    }
    for (const [controller, invocationName] of this.invocationControllers) {
      if (invocationName === name) controller.abort(abortError())
    }
    let removed = 0
    for (const [key, grant] of this.grants) {
      if (grant.name !== name) continue
      this.grants.delete(key)
      removed++
    }
    this.captureTargets.clear()
    return removed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.lifecycle.abort(abortError())
    for (const controller of this.invocationControllers.keys()) controller.abort(abortError())
    this.invocationControllers.clear()
    this.lease = undefined
    this.grants.clear()
    this.captureTargets.clear()
    this.baseline.clear()
  }
}

/** One-use handoff to the execution builder; a copied or persisted identity is never accepted. */
export function claimPreparedSkillInvocation(value: unknown): Readonly<{
  session: SkillSession
  capture: SkillCapture
  lease: AdmissionLease
  revision: number
  text: string
  freshWitnessInvocation: boolean
}> {
  const state = value && typeof value === "object" ? preparedInvocations.get(value) : undefined
  if (!state || state.claimed || !state.session.authorizes(state.capture, state.lease, state.revision)) {
    throw new SkillAdmissionError("Skill invocation is absent, copied, expired, or already bound.")
  }
  state.claimed = true
  const bytes = readCapturedSkill(state.capture)
  if (!bytes) throw new SkillAdmissionError("Captured skill instructions are unavailable.")
  return Object.freeze({
    session: state.session, capture: state.capture, lease: state.lease, revision: state.revision,
    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    freshWitnessInvocation: state.freshWitnessInvocation,
  })
}
