import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { EXECUTION_TOOL_NAMES } from "../hosts/types.ts"
import { FdTree, FdTreeError, fdStatKind, type FdDirectory } from "./fd-tree.ts"
import type {
  LocalSkillDescriptor,
  ProtectedWorkflowDescriptor,
  ProtectedWorkflowName,
  SkillDescriptor,
  SkillDiscovery,
  SkillRefusal,
  SkillRoots,
  SkillToolName,
} from "./types.ts"

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_DESCRIPTOR_BYTES = 16 * 1024
const PROTECTED_NAMES = new Set<ProtectedWorkflowName>(["deep-interview", "ralplan", "ultragoal", "autoresearch"])
const KNOWN_TOOL_SET = new Set<string>(EXECUTION_TOOL_NAMES)
const PROJECT_ROOTS = [".opencode/skills", ".agents/skills"] as const
const HOME_ROOTS = [".agents/skills", ".claude/skills", ".config/opencode/skills"] as const

export const PROTECTED_WORKFLOWS: readonly ProtectedWorkflowDescriptor[] = Object.freeze([
  Object.freeze({
    kind: "protected-workflow",
    source: "builtin",
    identity: "builtin:deep-interview",
    name: "deep-interview",
    description: "Protected deep-interview workflow.",
    workflow: "deep-interview",
  } satisfies ProtectedWorkflowDescriptor),
  Object.freeze({
    kind: "protected-workflow",
    source: "builtin",
    identity: "builtin:ralplan",
    name: "ralplan",
    description: "Protected ralplan workflow.",
    workflow: "ralplan",
  } satisfies ProtectedWorkflowDescriptor),
  Object.freeze({
    kind: "protected-workflow",
    source: "builtin",
    identity: "builtin:ultragoal",
    name: "ultragoal",
    description: "Protected ultragoal workflow.",
    workflow: "ultragoal",
  } satisfies ProtectedWorkflowDescriptor),
  Object.freeze({
    kind: "protected-workflow",
    source: "builtin",
    identity: "builtin:autoresearch",
    name: "autoresearch",
    description: "Protected autoresearch workflow.",
    workflow: "autoresearch",
  } satisfies ProtectedWorkflowDescriptor),
])

const metadataSchema = z.object({
  name: z.string().regex(NAME),
  description: z.string().trim().min(1).max(800),
  "allowed-tools": z.unknown().optional(),
})

export type SkillFrontmatter = Readonly<{
  name: string
  description: string
  allowedTools?: readonly SkillToolName[]
}>

type SkillRootSpec = Readonly<{ source: "project" | "home"; base: string; root: string }>
type Candidate = Readonly<{
  source: "project" | "home"
  base: string
  name: string
  identity: string
  descriptor?: LocalSkillDescriptor
  refusal?: SkillRefusal
}>

type SkillRootPin = Readonly<{ path: string; dev: bigint; ino: bigint } | { path: string; absent: true }>
type SkillRootPins = Readonly<{ project: SkillRootPin; home?: SkillRootPin }>

const ROOT_PINS = new WeakMap<SkillRoots, SkillRootPins>()

class ExternalDescriptorConsentRequired extends Error {
  readonly target: string
  constructor(target: string) {
    super("external descriptor target requires explicit capture-read consent")
    this.target = target
  }
}

export type ExternalTargetConsent = ReadonlyMap<string, "file" | "directory">

export class SkillOperationAbortError extends Error {
  constructor() {
    super("Skill source operation was aborted")
    this.name = "AbortError"
  }
}

export function throwIfSkillOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SkillOperationAbortError()
}

export async function canonicalExternalTargetConsent(
  targets: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ExternalTargetConsent> {
  throwIfSkillOperationAborted(signal)
  if (!Array.isArray(targets)) throw new TypeError("external target consent must be a list of canonical paths")
  const consent = new Map<string, "file" | "directory">()
  for (const target of targets) {
    throwIfSkillOperationAborted(signal)
    if (typeof target !== "string" || !isAbsolute(target) || target.includes("\0")) {
      throw new TypeError("external target consent must contain canonical absolute paths")
    }
    let canonical: string
    try { canonical = await realpath(target) } catch (error) {
      if (signal?.aborted) throw new SkillOperationAbortError()
      throw error
    }
    throwIfSkillOperationAborted(signal)
    if (canonical !== target) throw new TypeError("external target consent path is stale or noncanonical")
    let info: Awaited<ReturnType<typeof stat>>
    try { info = await stat(canonical) } catch (error) {
      if (signal?.aborted) throw new SkillOperationAbortError()
      throw error
    }
    throwIfSkillOperationAborted(signal)
    if (!info.isFile() && !info.isDirectory()) throw new TypeError("external target consent must refer to a file or directory")
    consent.set(canonical, info.isDirectory() ? "directory" : "file")
  }
  return consent
}

export function hasExternalTargetConsent(consent: ExternalTargetConsent, target: string): boolean {
  for (const [path, kind] of consent) {
    if (target === path || (kind === "directory" && isWithin(path, target))) return true
  }
  return false
}

export function mayTraverseExternalAncestor(consent: ExternalTargetConsent, target: string): boolean {
  if (hasExternalTargetConsent(consent, target)) return true
  for (const path of consent.keys()) if (isWithin(target, path)) return true
  return false
}

function errCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

function frozenRefusal(
  source: "project" | "home",
  reason: SkillRefusal["reason"],
  identity: string,
  name?: string,
  externalTargets?: readonly string[],
): SkillRefusal {
  return Object.freeze({
    source,
    ...(name ? { name } : {}),
    identities: Object.freeze([identity]),
    reason,
    ...(externalTargets === undefined ? {} : { externalTargets: Object.freeze([...externalTargets]) }),
  })
}

function parseAllowedTools(value: unknown): readonly SkillToolName[] | undefined {
  if (value === undefined) return undefined
  let tools: unknown[]
  if (Array.isArray(value)) tools = value
  else if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) throw new TypeError("allowed-tools must not be empty")
    tools = trimmed.includes(",") ? trimmed.split(/\s*,\s*/) : trimmed.split(/\s+/)
  } else throw new TypeError("allowed-tools must be a list or a delimited string")

  const result: SkillToolName[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (typeof tool !== "string" || !KNOWN_TOOL_SET.has(tool) || seen.has(tool)) {
      throw new TypeError("allowed-tools contains an unknown or duplicate tool")
    }
    seen.add(tool)
    result.push(tool as SkillToolName)
  }
  return Object.freeze(result)
}

/** Parse the standard SKILL.md frontmatter while preserving the original document bytes elsewhere. */
export function parseSkillFrontmatter(bytes: Uint8Array, expectedName: string): SkillFrontmatter {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new TypeError("descriptor is not valid UTF-8")
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new TypeError("missing or malformed frontmatter")
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(match[1]!)
  } catch {
    throw new TypeError("invalid frontmatter YAML")
  }
  const result = metadataSchema.safeParse(parsed)
  if (!result.success || result.data.name !== expectedName) throw new TypeError("invalid skill metadata")
  const allowedTools = parseAllowedTools(result.data["allowed-tools"])
  return Object.freeze({
    name: result.data.name,
    description: result.data.description,
    ...(allowedTools === undefined ? {} : { allowedTools }),
  })
}

/** Resolve explicit roots once; callers must provide the home directory rather than inheriting ambient HOME. */
export async function resolveSkillRoots(input: { projectRoot: string; homeDirectory?: string }): Promise<SkillRoots> {
  const existingPins = ROOT_PINS.get(input as SkillRoots)
  if (existingPins) return input as SkillRoots

  const projectRoot = await realpath(resolve(input.projectRoot))
  const projectTree = FdTree.openRoot(projectRoot)
  const projectPin: SkillRootPin = Object.freeze({
    path: projectRoot,
    dev: projectTree.root.openedStat.dev,
    ino: projectTree.root.openedStat.ino,
  })
  projectTree.close()

  let homeDirectory: string | undefined
  let homePin: SkillRootPin | undefined
  if (input.homeDirectory !== undefined) {
    const requestedHome = resolve(input.homeDirectory)
    try {
      const realHome = await realpath(requestedHome)
      const homeTree = FdTree.openRoot(realHome)
      homePin = Object.freeze({ path: realHome, dev: homeTree.root.openedStat.dev, ino: homeTree.root.openedStat.ino })
      homeTree.close()
      homeDirectory = realHome
    } catch (error) {
      if (errCode(error) !== "ENOENT") throw error
      FdTree.assertRootAbsent(requestedHome)
      homeDirectory = requestedHome
      homePin = Object.freeze({ path: requestedHome, absent: true })
    }
  }
  const roots = Object.freeze({ projectRoot, ...(homeDirectory === undefined ? {} : { homeDirectory }) })
  ROOT_PINS.set(roots, Object.freeze({ project: projectPin, ...(homePin === undefined ? {} : { home: homePin }) }))
  return roots
}

/** @internal Opens the pinned root; callers close it. Undefined only means home was initially absent. */
export function openSkillRoot(roots: SkillRoots, source: "project" | "home"): FdTree | undefined {
  const pins = ROOT_PINS.get(roots)
  if (!pins) throw new TypeError("skill roots must be resolved before use")
  const pin = source === "project" ? pins.project : pins.home
  if (!pin) return undefined
  if ("absent" in pin) {
    FdTree.assertRootAbsent(pin.path)
    return undefined
  }
  try {
    return FdTree.openRoot(pin.path, pin)
  } catch (error) {
    if (error instanceof FdTreeError && error.code === 2) {
      throw new FdTreeError("race", "pinned skill source root disappeared")
    }
    throw error
  }
}

function rootSpecs(roots: SkillRoots): readonly SkillRootSpec[] {
  return [
    ...PROJECT_ROOTS.map((base) => ({ source: "project" as const, base, root: roots.projectRoot })),
    ...(roots.homeDirectory === undefined ? [] : HOME_ROOTS.map((base) => ({ source: "home" as const, base, root: roots.homeDirectory! }))),
  ]
}

function validName(name: string): boolean {
  return NAME.test(name) && name !== "none"
}

async function scanRoot(
  spec: SkillRootSpec,
  consent: ExternalTargetConsent,
  tree: FdTree | undefined,
  signal?: AbortSignal,
): Promise<{ candidates: Candidate[]; refusals: SkillRefusal[] }> {
  const candidates: Candidate[] = []
  const refusals: SkillRefusal[] = []
  throwIfSkillOperationAborted(signal)
  if (!tree) return { candidates, refusals }
  let directory: FdDirectory
  try {
    throwIfSkillOperationAborted(signal)
    directory = tree.openDirectoryRelative(spec.base)
  } catch (error) {
    if (error instanceof SkillOperationAbortError || signal?.aborted) throw new SkillOperationAbortError()
    if (error instanceof FdTreeError && error.code === 2) return { candidates, refusals }
    const reason: SkillRefusal["reason"] = error instanceof FdTreeError && error.reason === "race"
      ? "raced"
      : error instanceof FdTreeError && error.reason === "unreadable" ? "unreadable" : "unsafe-path"
    refusals.push(frozenRefusal(spec.source, reason, `${spec.source}:${spec.base}`))
    return { candidates, refusals }
  }

  try {
    throwIfSkillOperationAborted(signal)
    for (const entry of tree.list(directory)) {
        throwIfSkillOperationAborted(signal)
        const { name, stat: entryStat } = entry
        const identity = `${spec.source}:${spec.base}/${name}`
        const kind = fdStatKind(entryStat)
        if (kind !== "directory" && kind !== "symlink") continue
        if (!validName(name)) {
          refusals.push(frozenRefusal(spec.source, "invalid-name", identity, name))
          continue
        }
        if (PROTECTED_NAMES.has(name as ProtectedWorkflowName)) {
          refusals.push(frozenRefusal(spec.source, "protected-name", identity, name))
          continue
        }

        const checkpoint = tree.checkpoint()
        let candidateTree: FdTree | undefined
        let candidateDirectory: FdDirectory
        try {
          throwIfSkillOperationAborted(signal)
          if (kind === "directory") candidateDirectory = tree.openDirectoryAt(directory, entry)
          else {
            const resolved = tree.resolveLinkAt(directory, entry)
            if (!resolved.internal) {
              if (!hasExternalTargetConsent(consent, resolved.canonicalTarget)) {
                const refusal = frozenRefusal(spec.source, "external-consent-required", identity, name, [resolved.canonicalTarget])
                refusals.push(refusal)
                candidates.push({ source: spec.source, base: spec.base, name, identity, refusal })
                continue
              }
              throwIfSkillOperationAborted(signal)
              candidateTree = FdTree.openRoot(resolved.canonicalTarget)
              candidateDirectory = candidateTree.root
            } else {
              candidateDirectory = tree.openDirectoryRelative(resolved.relativeTarget!)
            }
          }

          if (PROTECTED_NAMES.has(name as ProtectedWorkflowName)) {
            refusals.push(frozenRefusal(spec.source, "protected-name", identity, name))
            continue
          }
          let descriptorBytes: Buffer
          const descriptorStat = candidateTree
            ? candidateTree.statAt(candidateDirectory, "SKILL.md")
            : tree.statAt(candidateDirectory, "SKILL.md")
          if (fdStatKind(descriptorStat) === "file") {
            throwIfSkillOperationAborted(signal)
            if (descriptorStat.size > BigInt(MAX_DESCRIPTOR_BYTES)) throw new RangeError("descriptor exceeds size limit")
            descriptorBytes = (candidateTree ?? tree).readFileAt(candidateDirectory, "SKILL.md").bytes
          } else if (fdStatKind(descriptorStat) === "symlink") {
            throwIfSkillOperationAborted(signal)
            const resolution = (candidateTree ?? tree).resolveLinkAt(candidateDirectory, "SKILL.md")
            if (!resolution.internal && !hasExternalTargetConsent(consent, resolution.canonicalTarget)) {
              throw new ExternalDescriptorConsentRequired(resolution.canonicalTarget)
            }
            if (resolution.internal) {
              const descriptorScope = candidateTree ?? tree
              const targetStat = descriptorScope.statRelative(resolution.relativeTarget!)
              if (fdStatKind(targetStat) !== "file") throw new TypeError("SKILL.md symlink does not target a regular file")
              throwIfSkillOperationAborted(signal)
              if (targetStat.size > BigInt(MAX_DESCRIPTOR_BYTES)) throw new RangeError("descriptor exceeds size limit")
              descriptorBytes = descriptorScope.readFileRelative(resolution.relativeTarget!).bytes
            } else {
              throwIfSkillOperationAborted(signal)
              const externalTree = FdTree.openRoot("/")
              try {
                const externalRelative = relative("/", resolution.canonicalTarget).split(sep).join("/")
                const targetStat = externalTree.statRelative(externalRelative)
                if (fdStatKind(targetStat) !== "file") throw new TypeError("SKILL.md symlink does not target a regular file")
                throwIfSkillOperationAborted(signal)
                if (targetStat.size > BigInt(MAX_DESCRIPTOR_BYTES)) throw new RangeError("descriptor exceeds size limit")
                descriptorBytes = externalTree.readFileRelative(externalRelative).bytes
                externalTree.assertStable()
              } finally {
                externalTree.close()
              }
            }
          } else throw new TypeError("SKILL.md is not a regular file")
          throwIfSkillOperationAborted(signal)
          if (descriptorBytes.byteLength > MAX_DESCRIPTOR_BYTES) throw new RangeError("descriptor exceeds size limit")
          const frontmatter = parseSkillFrontmatter(descriptorBytes, name)
          const descriptor: LocalSkillDescriptor = Object.freeze({
            kind: "skill",
            source: spec.source,
            identity,
            name,
            description: frontmatter.description,
            ...(frontmatter.allowedTools === undefined ? {} : { allowedTools: frontmatter.allowedTools }),
          })
          candidates.push({ source: spec.source, base: spec.base, name, identity, descriptor })
        } catch (error) {
          if (error instanceof SkillOperationAbortError || signal?.aborted) throw new SkillOperationAbortError()
          const reason: SkillRefusal["reason"] = error instanceof ExternalDescriptorConsentRequired
            ? "external-consent-required"
            : error instanceof FdTreeError && error.code === 2 ? "invalid-metadata"
            : error instanceof FdTreeError && error.reason === "race" ? "raced"
            : error instanceof FdTreeError && error.reason === "unreadable" ? "unreadable"
            : error instanceof FdTreeError ? "unsafe-path" : "invalid-metadata"
          const refusal = frozenRefusal(
            spec.source,
            reason,
            identity,
            name,
            error instanceof ExternalDescriptorConsentRequired ? [error.target] : undefined,
          )
          refusals.push(refusal)
          candidates.push({ source: spec.source, base: spec.base, name, identity, refusal })
        } finally {
          try {
            if (!signal?.aborted) {
              tree.assertStableSince(checkpoint)
              candidateTree?.assertStable()
            }
          } finally {
            let closeError: unknown
            try { candidateTree?.close() } catch (error) { closeError = error }
            try { tree.releaseSince(checkpoint) } catch (error) { closeError ??= error }
            if (closeError !== undefined) throw closeError
          }
        }
      }
    tree.assertStable()
  } catch (error) {
    if (error instanceof SkillOperationAbortError || signal?.aborted) throw new SkillOperationAbortError()
    candidates.length = 0
    refusals.push(frozenRefusal(spec.source, error instanceof FdTreeError && error.reason === "race" ? "raced" : "unsafe-path", `${spec.source}:${spec.base}`))
  }
  return { candidates, refusals }
}

function combineRefusals(refusals: SkillRefusal[]): SkillRefusal[] {
  const grouped = new Map<string, SkillRefusal[]>()
  for (const refusal of refusals) {
    const key = `${refusal.source}\0${refusal.name ?? ""}\0${refusal.reason}`
    const group = grouped.get(key) ?? []
    group.push(refusal)
    grouped.set(key, group)
  }
  return [...grouped.values()].map((items) => {
    if (items.length === 1) return items[0]!
    const externalTargets = [...new Set(items.flatMap((item) => item.externalTargets ?? []))].sort()
    return Object.freeze({
      source: items[0]!.source,
      ...(items[0]!.name === undefined ? {} : { name: items[0]!.name }),
      identities: Object.freeze(items.flatMap((item) => item.identities).sort()),
      reason: items[0]!.reason,
      ...(externalTargets.length === 0 ? {} : { externalTargets: Object.freeze(externalTargets) }),
    })
  })
}

/** Discover every valid descriptor; ambiguity is returned explicitly rather than resolved by root order. */
export async function discoverSkills(
  roots: SkillRoots,
  options: Readonly<{ consentedExternalTargets?: readonly string[]; signal?: AbortSignal }> = {},
): Promise<SkillDiscovery> {
  throwIfSkillOperationAborted(options.signal)
  try { roots = await resolveSkillRoots(roots) } catch (error) {
    if (options.signal?.aborted) throw new SkillOperationAbortError()
    throw error
  }
  throwIfSkillOperationAborted(options.signal)
  const consent = await canonicalExternalTargetConsent(options.consentedExternalTargets, options.signal)
  throwIfSkillOperationAborted(options.signal)
  const specs = rootSpecs(roots)
  const trees = new Map<"project" | "home", FdTree>()
  const rootFailures = new Map<"project" | "home", unknown>()
  const sources: Array<"project" | "home"> = roots.homeDirectory === undefined ? ["project"] : ["project", "home"]
  let scanned: Array<{ candidates: Candidate[]; refusals: SkillRefusal[] }>
  try {
    for (const source of sources) {
      throwIfSkillOperationAborted(options.signal)
      try {
        const tree = openSkillRoot(roots, source)
        if (tree) trees.set(source, tree)
      } catch (error) {
        if (error instanceof SkillOperationAbortError || options.signal?.aborted) throw new SkillOperationAbortError()
        if (!(source === "home" && error instanceof FdTreeError && error.code === 2)) rootFailures.set(source, error)
      }
    }
    throwIfSkillOperationAborted(options.signal)
    scanned = await Promise.all(specs.map((spec) => {
      throwIfSkillOperationAborted(options.signal)
      const failure = rootFailures.get(spec.source)
      if (failure !== undefined) {
        const reason: SkillRefusal["reason"] = failure instanceof FdTreeError && failure.reason === "race"
          ? "raced"
          : failure instanceof FdTreeError && failure.reason === "unreadable" ? "unreadable" : "unsafe-path"
        return { candidates: [], refusals: [frozenRefusal(spec.source, reason, `${spec.source}:root`)] }
      }
      return scanRoot(spec, consent, trees.get(spec.source), options.signal)
    }))
    throwIfSkillOperationAborted(options.signal)
    for (const [source, tree] of trees) {
      throwIfSkillOperationAborted(options.signal)
      try {
        tree.assertStable()
      } catch (error) {
        if (error instanceof SkillOperationAbortError || options.signal?.aborted) throw new SkillOperationAbortError()
        for (const result of scanned) {
          result.candidates = result.candidates.filter((candidate) => candidate.source !== source)
          result.refusals = result.refusals.filter((refusal) => refusal.source !== source)
        }
        const reason: SkillRefusal["reason"] = error instanceof FdTreeError && error.reason === "race" ? "raced" : "unsafe-path"
        scanned.push({ candidates: [], refusals: [frozenRefusal(source, reason, `${source}:root`)] })
      }
    }
  } finally {
    let closeError: unknown
    for (const tree of trees.values()) {
      try { tree.close() } catch (error) { closeError ??= error }
    }
    if (options.signal?.aborted) throw new SkillOperationAbortError()
    if (closeError !== undefined) throw closeError
  }
  throwIfSkillOperationAborted(options.signal)
  const candidates = scanned.flatMap((result) => result.candidates)
  const refusals = scanned.flatMap((result) => result.refusals)
  const descriptors: SkillDescriptor[] = [...PROTECTED_WORKFLOWS]
  const project = candidates.filter((candidate) => candidate.source === "project")
  const home = candidates.filter((candidate) => candidate.source === "home")
  const projectNames = new Set(project.map((candidate) => candidate.name))
  const projectRootUnavailable = refusals.some((refusal) => refusal.source === "project" && refusal.name === undefined)
  const homeRootUnavailable = refusals.some((refusal) => refusal.source === "home" && refusal.name === undefined)

  const addTier = (tier: Candidate[], source: "project" | "home") => {
    const byName = new Map<string, Candidate[]>()
    for (const candidate of tier) {
      const group = byName.get(candidate.name) ?? []
      group.push(candidate)
      byName.set(candidate.name, group)
    }
    for (const [name, group] of byName) {
      if (!validName(name) || PROTECTED_NAMES.has(name as ProtectedWorkflowName)) continue
      if (group.length > 1) {
        refusals.push(Object.freeze({ source, name, identities: Object.freeze(group.map((item) => item.identity).sort()), reason: "ambiguous" }))
        continue
      }
      const candidate = group[0]!
      if (candidate.descriptor) descriptors.push(candidate.descriptor)
      else if (candidate.refusal && !refusals.includes(candidate.refusal)) refusals.push(candidate.refusal)
    }
  }

  if (!projectRootUnavailable) addTier(project, "project")
  if (!projectRootUnavailable && !homeRootUnavailable) addTier(home.filter((candidate) => !projectNames.has(candidate.name)), "home")
  descriptors.sort((a, b) => a.name.localeCompare(b.name, "en"))
  const finalRefusals = combineRefusals(refusals).sort((a, b) =>
    `${a.source}:${a.name ?? ""}:${a.reason}:${a.identities.join(",")}`.localeCompare(`${b.source}:${b.name ?? ""}:${b.reason}:${b.identities.join(",")}`, "en"),
  )
  return Object.freeze({ descriptors: Object.freeze(descriptors), refusals: Object.freeze(finalRefusals) })
}

/** Resolve only a descriptor's canonical identity; the returned path is for capture, never an authority token. */
export function skillDirectoryPath(roots: SkillRoots, descriptor: LocalSkillDescriptor): string {
  if (!validName(descriptor.name)) throw new TypeError("invalid skill name")
  const specs = rootSpecs(roots).filter((spec) => spec.source === descriptor.source)
  const spec = specs.find((candidate) => `${candidate.source}:${candidate.base}/${descriptor.name}` === descriptor.identity)
  if (!spec) throw new TypeError("skill descriptor identity does not match configured roots")
  return join(spec.root, spec.base, descriptor.name)
}

