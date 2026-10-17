import { createHash } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { parseJsonc } from "../config.ts"
import { containsSecret } from "../security/secrets.ts"
import { stateRoot } from "../state/store.ts"
import { estimateTokens } from "../tokens.ts"

export const UPSTREAM_COMMIT = "fa4ca184573e42ec11472959dd57422381418096"
export const PILOT_SKILL = ".agents/skills/llm-wiki/SKILL.md"
export const RESEARCH_SOURCE = "42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8"
export const COMPILE_ANCHOR = "2. Read its source page, the raw file in chunks, and related existing pages.\n"
export const PILOT_LIMITS = Object.freeze({
  sourceFiles: 64,
  sourceBytes: 2 * 1024 * 1024,
  sourceFileBytes: 128 * 1024,
  skillBytes: 16384,
  skillEstimatedTokens: 2000,
  fragmentBytes: 1200,
  fragmentEstimatedTokens: 200,
  targetRequests: 8000,
  optimizerRequests: 40,
  activeMilliseconds: 21600000,
  artifactBytes: 256 * 1024 * 1024,
  candidateSteps: 3,
})

export class SkillOptError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "SkillOptError"
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Canonical JSON for persisted, finite JSON data; no undefined/NaN coercion. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  throw new SkillOptError("invalid_json_value")
}

export function pilotRoot(worktree: string): string {
  return join(stateRoot(realpathSync.native(worktree)), "skillopt")
}

export function experimentDirectory(worktree: string, experimentId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(experimentId)) throw new SkillOptError("invalid_experiment_id")
  return join(pilotRoot(worktree), "experiments", experimentId)
}

/** Reject aliases at every component, then pin a bounded regular inode while reading. */
export function readBoundedSource(root: string, path: string, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > PILOT_LIMITS.sourceBytes) {
    throw new SkillOptError("invalid_read_bound")
  }
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new SkillOptError("unsafe_source_path")
  }
  const canonicalRoot = realpathSync.native(root)
  let current = canonicalRoot
  for (const component of path.split("/")) {
    current = join(current, component)
    if (lstatSync(current).isSymbolicLink()) throw new SkillOptError("source_alias")
  }
  const rel = relative(canonicalRoot, current)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SkillOptError("unsafe_source_path")
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) {
      throw new SkillOptError("source_type_or_size")
    }
    const bytes = Buffer.alloc(Math.min(maximum + 1, before.size + 1))
    let count = 0
    for (;;) {
      const n = readSync(fd, bytes, count, bytes.length - count, count)
      if (n === 0) break
      count += n
      if (count === bytes.length) throw new SkillOptError("source_changed")
    }
    const after = fstatSync(fd)
    const named = lstatSync(current)
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino || named.nlink !== 1) {
      throw new SkillOptError("source_changed")
    }
    const result = bytes.subarray(0, count)
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result)
    } catch {
      throw new SkillOptError("source_encoding")
    }
    if (text.includes("\0") || containsSecret(text)) throw new SkillOptError("source_sensitive_or_invalid")
    return result
  } finally {
    closeSync(fd)
  }
}

export function assembleSkill(original: string, fragment: string): string {
  if (original.indexOf(COMPILE_ANCHOR) < 0 || original.indexOf(COMPILE_ANCHOR) !== original.lastIndexOf(COMPILE_ANCHOR)) {
    throw new SkillOptError("skill_anchor_mismatch")
  }
  if (Buffer.byteLength(fragment, "utf8") > PILOT_LIMITS.fragmentBytes || estimateTokens(fragment) > PILOT_LIMITS.fragmentEstimatedTokens) {
    throw new SkillOptError("fragment_limit")
  }
  if (fragment && (fragment !== fragment.trim() || Buffer.from(fragment, "utf8").toString("utf8") !== fragment || /[\r\n\x00-\x1f\x7f]/.test(fragment) || /(?:^|\s)#{1,6}\s|`|~~~|https?:\/\/|\b(?:bash|sudo|curl|wget|bun|python|npm|pip)\s+/i.test(fragment) || /\b(?:OpenAI|Anthropic|Claude|Gemma|Ollama|Sonnet|Opus|GPT|Qwen|DeepSeek)\b/i.test(fragment) || containsSecret(fragment))) {
    throw new SkillOptError("fragment_structure")
  }
  const end = original.indexOf(COMPILE_ANCHOR) + COMPILE_ANCHOR.length
  const candidate = fragment ? `${original.slice(0, end)}\n${fragment}\n\n${original.slice(end)}` : original
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(candidate)
  if (!frontmatter) throw new SkillOptError("skill_frontmatter")
  if (Buffer.byteLength(candidate, "utf8") > PILOT_LIMITS.skillBytes || estimateTokens(candidate.slice(frontmatter[0].length).trim()) > PILOT_LIMITS.skillEstimatedTokens) {
    throw new SkillOptError("skill_limit")
  }
  return candidate
}

export function extractFragment(original: string, candidate: string): string {
  assembleSkill(original, "")
  if (candidate === original) return ""
  const end = original.indexOf(COMPILE_ANCHOR) + COMPILE_ANCHOR.length
  if (end < COMPILE_ANCHOR.length || !candidate.startsWith(original.slice(0, end)) || !candidate.endsWith(original.slice(end))) {
    throw new SkillOptError("protected_skill_changed")
  }
  const insertion = candidate.slice(end, candidate.length - original.slice(end).length)
  if (!insertion.startsWith("\n") || !insertion.endsWith("\n\n")) throw new SkillOptError("fragment_structure")
  const fragment = insertion.slice(1, -2)
  if (assembleSkill(original, fragment) !== candidate) throw new SkillOptError("protected_skill_changed")
  return fragment
}

export const EVIDENCE_FILES = [
  "knowledge/AGENTS.md",
  "knowledge/wiki/index.md",
  "knowledge/wiki/log.md",
  `knowledge/raw/documents/${RESEARCH_SOURCE}.md`,
  `knowledge/wiki/sources/documents-${RESEARCH_SOURCE}.md`,
  "knowledge/wiki/entities/claude-dev.md",
  "knowledge/wiki/concepts/local-first-contract.md",
  "knowledge/wiki/concepts/agent-harness-design.md",
  "knowledge/wiki/concepts/agent-context-and-cache.md",
  "knowledge/wiki/concepts/agent-skills-and-extensions.md",
  "knowledge/wiki/concepts/agent-evaluation-and-hillclimbing.md",
  "knowledge/wiki/concepts/agent-operations-and-economics.md",
  "knowledge/wiki/concepts/agent-human-review-artifacts.md",
  PILOT_SKILL,
  ".otter/otter.jsonc",
] as const

export type SourceEntry = { path: string; sha256: string; bytes: number; kind: "raw" | "annotation" | "synthesis" | "contract" }
export type SourceSnapshot = {
  schema: "skillopt.source-snapshot.v1"
  rootBinding: string
  entries: SourceEntry[]
  originalSkillSha256: string
  correction: { sourceId: string; rawClaim: "Bash"; correctedClaim: "ExitPlanTool"; basis: "source-page-erratum" }
}

export function snapshotSources(worktree: string): SourceSnapshot {
  const root = realpathSync.native(worktree)
  const lock = join(root, "knowledge", ".wiki.lock")
  if (existsSync(lock)) throw new SkillOptError("wiki_locked")
  const contents = new Map<string, Buffer>()
  let total = 0
  for (const path of EVIDENCE_FILES) {
    const bytes = readBoundedSource(root, path, path === PILOT_SKILL ? PILOT_LIMITS.skillBytes : PILOT_LIMITS.sourceFileBytes)
    contents.set(path, bytes)
    total += bytes.length
    if (total > PILOT_LIMITS.sourceBytes || contents.size > PILOT_LIMITS.sourceFiles) throw new SkillOptError("snapshot_limit")
  }
  const raw = contents.get(`knowledge/raw/documents/${RESEARCH_SOURCE}.md`)!
  const annotation = contents.get(`knowledge/wiki/sources/documents-${RESEARCH_SOURCE}.md`)!.toString("utf8")
  if (sha256(raw) !== RESEARCH_SOURCE || !annotation.includes("A13 정정") || !annotation.includes("ExitPlanTool")) {
    throw new SkillOptError("missing_source_correction")
  }
  const config = parseJsonc<Record<string, unknown>>(contents.get(".otter/otter.jsonc")!.toString("utf8"))
  const observation = config.skill_observation as Record<string, unknown> | undefined
  const router = config.skill_router as Record<string, unknown> | undefined
  const skills = config.skills as { allow?: unknown } | undefined
  if (observation?.enabled !== false || observation.campaign_id !== "skill-evaluation-p1-20261002" || observation.owner_binding !== "cd4d9d661baf48eb48fd0a20c6bdd015daba10b9389e6ed2d25c6ea8ef08948f" || router?.mode !== "suggest" || !Array.isArray(skills?.allow) || canonicalJson(skills.allow) !== canonicalJson(["ulw", "plan", "llm-wiki"])) {
    throw new SkillOptError("protected_configuration_changed")
  }
  const original = contents.get(PILOT_SKILL)!.toString("utf8")
  assembleSkill(original, "")
  for (const [path, bytes] of contents) {
    if (!bytes.equals(readBoundedSource(root, path, path === PILOT_SKILL ? PILOT_LIMITS.skillBytes : PILOT_LIMITS.sourceFileBytes))) {
      throw new SkillOptError("source_changed")
    }
  }
  if (existsSync(lock)) throw new SkillOptError("wiki_locked")
  const entries: SourceEntry[] = [...contents].map(([path, bytes]) => ({
    path,
    sha256: sha256(bytes),
    bytes: bytes.length,
    kind: path.startsWith("knowledge/raw/") ? "raw" : path.startsWith("knowledge/wiki/sources/") ? "annotation" : path.includes("/concepts/") || path.includes("/entities/") ? "synthesis" : "contract",
  }))
  return {
    schema: "skillopt.source-snapshot.v1",
    rootBinding: sha256(root),
    entries,
    originalSkillSha256: sha256(contents.get(PILOT_SKILL)!),
    correction: { sourceId: RESEARCH_SOURCE, rawClaim: "Bash", correctedClaim: "ExitPlanTool", basis: "source-page-erratum" },
  }
}
