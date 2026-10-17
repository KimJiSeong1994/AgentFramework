// Configured chat default (`chat.default_model`) in ~/.config/otter/otter.jsonc or <worktree>/.otter/otter.jsonc.
// The default is the operator's explicit, persisted opt-in: it selects an engine/model at launch exactly like
// `--engine` + `--model`, without model discovery. It never substitutes a different model on failure.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { applyEdits, modify } from "jsonc-parser"
import { ConfigError, loadConfig, parseJsonc, projectConfigPath, userConfigPath, type OtterConfig } from "../config.ts"
import { createCodexProfile } from "./codex-profile.ts"
import { EXECUTION_ROLES, NATIVE_MODEL_ID_RE, type ComboEngine, type ComboRoute, type ComboRoutes, type ExecutionRole } from "./types.ts"

export type CliEngine = "local" | "codex" | "claude"

export type DefaultModel = { readonly engine: CliEngine; readonly model: string }

/** Native model IDs are passed as argv; reject empty, option-like, whitespace and control characters. */
export function validModelID(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.startsWith("-") && value.trim() === value &&
    !/[\\\s\u0000-\u001f\u007f]/u.test(value)
}

export type DefaultModelLookup =
  | { readonly state: "unset" }
  | { readonly state: "configured"; readonly value: DefaultModel; readonly source: "user" | "project" }
  | { readonly state: "invalid"; readonly reason: string }

export type DefaultModelStore = {
  read: (worktree: string) => DefaultModelLookup
  /** Persist the user-level default; returns the path written. */
  save: (value: DefaultModel) => string
  /** Remove the user-level default; returns whether one was present. */
  clear: () => boolean
}

const engines: readonly CliEngine[] = ["local", "codex", "claude"]

function rawDefault(path: string): unknown {
  try {
    const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"))
    const chat = parsed && typeof parsed === "object" ? parsed.chat : undefined
    return chat && typeof chat === "object" && !Array.isArray(chat) && Object.hasOwn(chat, "default_model")
      ? (chat as Record<string, unknown>).default_model
      : undefined
  } catch {
    return undefined
  }
}

export function validateDefaultModel(value: unknown): DefaultModel | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "chat.default_model must be an object with engine and model"
  const { engine, model } = value as Record<string, unknown>
  if (typeof engine !== "string" || !engines.includes(engine as CliEngine)) return "chat.default_model.engine must be local, codex, or claude"
  if (typeof model !== "string" || !validModelID(model)) return "chat.default_model.model must be a native model ID without whitespace"
  return { engine: engine as CliEngine, model }
}

export function readDefaultModel(worktree: string): DefaultModelLookup {
  let value: unknown
  try {
    value = loadConfig(worktree).chat.default_model
  } catch (error) {
    return { state: "invalid", reason: error instanceof ConfigError ? error.message : "otter config could not be read" }
  }
  if (value === undefined || value === null) return { state: "unset" }
  const validated = validateDefaultModel(value)
  if (typeof validated === "string") return { state: "invalid", reason: validated }
  return { state: "configured", value: validated, source: rawDefault(projectConfigPath(worktree)) !== undefined ? "project" : "user" }
}

function rewriteUserConfig(update: (text: string) => string): string {
  const path = userConfigPath()
  let text = "{}\n"
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new ConfigError(path, "unreadable")
  }
  try {
    const parsed = parseJsonc<unknown>(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
  } catch {
    // Never overwrite a file the operator must repair by hand.
    throw new ConfigError(path, "invalid-jsonc")
  }
  const next = update(text)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, next, { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return path
}

const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }

export function saveDefaultModel(value: DefaultModel): string {
  return rewriteUserConfig(text => applyEdits(text, modify(text, ["chat", "default_model"], { engine: value.engine, model: value.model }, formatting)))
}

export function clearDefaultModel(): boolean {
  let present = false
  rewriteUserConfig(text => {
    present = rawDefault(userConfigPath()) !== undefined
    return present ? applyEdits(text, modify(text, ["chat", "default_model"], undefined, formatting)) : text
  })
  return present
}

export const fileDefaultModelStore: DefaultModelStore = {
  read: readDefaultModel,
  save: saveDefaultModel,
  clear: clearDefaultModel,
}

const comboRoleKeys = EXECUTION_ROLES.filter(role => role !== "main")

function isComboRole(value: string): value is ExecutionRole {
  return value !== "main" && (EXECUTION_ROLES as readonly string[]).includes(value)
}

/** Validate a role -> route map. `main` is always the /model selection, so it cannot be routed. */
export function validateComboRoutes(value: unknown): ComboRoutes | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "chat.combo must be an object mapping roles to {engine, model}"
  const routes: Partial<Record<ExecutionRole, ComboRoute>> = {}
  for (const [role, route] of Object.entries(value)) {
    if (!isComboRole(role)) return `chat.combo.${role} is not a routable role (${comboRoleKeys.join(", ")})`
    if (!route || typeof route !== "object" || Array.isArray(route)) return `chat.combo.${role} must be an object with engine and model`
    const { engine, model } = route as Record<string, unknown>
    if (typeof engine !== "string" || !engines.includes(engine as CliEngine)) return `chat.combo.${role}.engine must be local, codex, or claude`
    if (typeof model !== "string" || !NATIVE_MODEL_ID_RE.test(model)) return `chat.combo.${role}.model must be a native model ID (letters, digits and . _ : / @ + -; at most 256 characters)`
    if (engine === "codex") {
      try { createCodexProfile(model) } catch { return `chat.combo.${role}.model is not a bundled Codex model slug: ${model}` }
    }
    routes[role] = Object.freeze({ engine: engine as ComboEngine, model })
  }
  return Object.freeze(routes)
}

export type ComboLookup =
  | { readonly state: "unset" }
  | { readonly state: "configured"; readonly routes: ComboRoutes; readonly sources: Readonly<Partial<Record<ExecutionRole, "user" | "project">>> }
  | { readonly state: "invalid"; readonly reason: string }

/** The raw `chat.combo` value of one config file; undefined when the file or key is absent or unreadable. */
function rawComboValue(path: string): unknown {
  try {
    const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"))
    const chat = parsed && typeof parsed === "object" ? parsed.chat : undefined
    return chat && typeof chat === "object" && !Array.isArray(chat) && Object.hasOwn(chat, "combo")
      ? (chat as Record<string, unknown>).combo
      : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const COMBO_SHAPE = "chat.combo must be an object mapping roles to {engine, model}"

/**
 * Effective combo after the user/project merge, with the winning file per role. A role route is replaced as a
 * whole object (never field-merged); a project `null` removes the user's route. An invalid combo is never partially applied.
 */
export function readCombo(worktree: string): ComboLookup {
  try {
    loadConfig(worktree)
  } catch (error) {
    return { state: "invalid", reason: error instanceof ConfigError ? error.message : "otter config could not be read" }
  }
  const merged: Record<string, unknown> = {}
  const sources: Partial<Record<ExecutionRole, "user" | "project">> = {}
  for (const [file, path] of [["user", userConfigPath()], ["project", projectConfigPath(worktree)]] as const) {
    const value = rawComboValue(path)
    if (value === undefined) continue
    if (value === null) {
      for (const role of Object.keys(merged)) delete merged[role]
      continue
    }
    if (!isRecord(value)) return { state: "invalid", reason: COMBO_SHAPE }
    for (const [role, route] of Object.entries(value)) {
      if (route === null || route === undefined) {
        delete merged[role]
        delete sources[role as ExecutionRole]
      } else {
        merged[role] = route
        sources[role as ExecutionRole] = file
      }
    }
  }
  if (Object.keys(merged).length === 0) return { state: "unset" }
  const routes = validateComboRoutes(merged)
  if (typeof routes === "string") {
    // Name the file that supplies the offending role so the operator edits the right one (`clear` only edits the user file).
    const role = /^chat\.combo\.([a-z-]+)/.exec(routes)?.[1] as ExecutionRole | undefined
    const source = role ? sources[role] : undefined
    const where = source === "project" ? " (from the project .otter/otter.jsonc)" : source === "user" ? " (from the user config)" : ""
    return { state: "invalid", reason: `${routes}${where}` }
  }
  return { state: "configured", routes, sources: Object.freeze(sources) }
}

function checkedRoute(role: string, route: ComboRoute): ComboRoute {
  const validated = validateComboRoutes({ [role]: route })
  if (typeof validated === "string") throw new TypeError(validated)
  return validated[role as ExecutionRole]!
}

/** Persist one role route in the user config; returns the path written. */
export function saveComboRole(role: ExecutionRole, route: ComboRoute): string {
  const checked = checkedRoute(role, route)
  return rewriteUserConfig(text => applyEdits(text, modify(text, ["chat", "combo", role], { engine: checked.engine, model: checked.model }, formatting)))
}

function userComboValue(): unknown {
  return rawComboValue(userConfigPath())
}

/** Remove one user-level role route; returns whether one was present. */
export function clearComboRole(role: ExecutionRole): boolean {
  if (!isComboRole(role)) throw new TypeError(`${String(role)} is not a routable role`)
  let present = false
  rewriteUserConfig(text => {
    const combo = userComboValue()
    present = isRecord(combo) && Object.hasOwn(combo, role)
    return present ? applyEdits(text, modify(text, ["chat", "combo", role], undefined, formatting)) : text
  })
  return present
}

/** Remove the whole user-level combo; returns whether one was present. */
export function clearCombo(): boolean {
  let present = false
  rewriteUserConfig(text => {
    present = userComboValue() !== undefined
    return present ? applyEdits(text, modify(text, ["chat", "combo"], undefined, formatting)) : text
  })
  return present
}

/** Persist the user-level memory engine (`/memory`); an explicit model is stored, otherwise the key is removed. */
export function saveMemoryEngine(engine: OtterConfig["memory"]["engine"], model?: string): string {
  return rewriteUserConfig(text => {
    let next = applyEdits(text, modify(text, ["memory", "engine"], engine, formatting))
    next = applyEdits(next, modify(next, ["memory", "model"], engine === "jev" || engine === "off" || engine === "auto" ? undefined : model, formatting))
    return next
  })
}

export type ComboStore = {
  read: (worktree: string) => ComboLookup
  /** Persist one user-level role route; returns the path written. */
  save: (role: ExecutionRole, route: ComboRoute) => string
  clearRole: (role: ExecutionRole) => boolean
  clear: () => boolean
}

export const fileComboStore: ComboStore = {
  read: readCombo,
  save: saveComboRole,
  clearRole: clearComboRole,
  clear: clearCombo,
}
