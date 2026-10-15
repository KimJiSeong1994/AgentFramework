import type { EXECUTION_TOOL_NAMES } from "../hosts/types.ts"

export type SkillSource = "builtin" | "project" | "home"
export type SkillClassification = "common" | "custom"
export type ProtectedWorkflowName = "deep-interview" | "ralplan" | "ultragoal" | "autoresearch"
export type SkillToolName = (typeof EXECUTION_TOOL_NAMES)[number]

export type SkillRoots = Readonly<{
  projectRoot: string
  homeDirectory?: string
}>

export type LocalSkillDescriptor = Readonly<{
  kind: "skill"
  source: "project" | "home"
  identity: string
  name: string
  description: string
  allowedTools?: readonly SkillToolName[]
}>

export type ProtectedWorkflowDescriptor = Readonly<{
  kind: "protected-workflow"
  source: "builtin"
  identity: `builtin:${ProtectedWorkflowName}`
  name: ProtectedWorkflowName
  description: string
  workflow: ProtectedWorkflowName
}>

export type SkillDescriptor = LocalSkillDescriptor | ProtectedWorkflowDescriptor

export type SkillRefusalReason =
  | "ambiguous"
  | "external-consent-required"
  | "invalid-name"
  | "invalid-metadata"
  | "protected-name"
  | "raced"
  | "unreadable"
  | "unsafe-path"

export type SkillRefusal = Readonly<{
  source: "project" | "home"
  name?: string
  identities: readonly string[]
  reason: SkillRefusalReason
  externalTargets?: readonly string[]
}>

export type SkillDiscovery = Readonly<{
  descriptors: readonly SkillDescriptor[]
  refusals: readonly SkillRefusal[]
}>

export type SkillSnapshotEntry = Readonly<{
  path: string
  type: "file" | "directory" | "symlink"
  mode: number
  size?: number
  /** Exact UTF-8 link text; descriptive only and never a filesystem capability. */
  linkTarget?: string
  /** Canonical source-relative referent identity for a link captured inside its source boundary. */
  linkIdentity?: string
}>

declare const skillCaptureBrand: unique symbol

/**
 * An immutable capture minted by captureSkill. The runtime authenticity check is
 * intentionally stronger than this compile-time brand.
 */
export type SkillCapture = Readonly<{
  kind: "skill-capture"
  descriptor: SkillDescriptor
  identity: string
  source: SkillSource
  name: string
  classification: SkillClassification
  contentHash: string
  entries: readonly SkillSnapshotEntry[]
  files: readonly Readonly<{ path: string; mode: number; size: number; sha256: string }>[]
}> & { readonly [skillCaptureBrand]: never }

