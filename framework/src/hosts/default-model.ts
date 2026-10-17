// Configured chat default (`chat.default_model`) in ~/.config/lca/lca.jsonc or <worktree>/.lca/lca.jsonc.
// The default is the operator's explicit, persisted opt-in: it selects an engine/model at launch exactly like
// `--engine` + `--model`, without model discovery. It never substitutes a different model on failure.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { applyEdits, modify } from "jsonc-parser"
import { ConfigError, loadConfig, parseJsonc, projectConfigPath, userConfigPath } from "../config.ts"
import { EXECUTION_ROLES, type ComboEngine, type ComboRoute, type ComboRoutes, type ExecutionRole } from "./types.ts"

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
    return { state: "invalid", reason: error instanceof ConfigError ? error.message : "lca config could not be read" }
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
    if (typeof model !== "string" || !validModelID(model)) return `chat.combo.${role}.model must be a native model ID without whitespace`
    routes[role] = Object.freeze({ engine: engine as ComboEngine, model })
  }
  return Object.freeze(routes)
}

export type ComboLookup =
  | { readonly state: "unset" }
  | { readonly state: "configured"; readonly routes: ComboRoutes; readonly sources: Readonly<Partial<Record<ExecutionRole, "user" | "project">>> }
  | { readonly state: "invalid"; readonly reason: string }

function rawCombo(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"))
    const chat = parsed && typeof parsed === "object" ? parsed.chat : undefined
    if (!chat || typeof chat !== "object" || Array.isArray(chat)) return undefined
    const combo = (chat as Record<string, unknown>).combo
    return combo && typeof combo === "object" && !Array.isArray(combo) ? combo as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Effective combo after the user/project merge, with the winning file per role. An invalid combo is never partially applied. */
export function readCombo(worktree: string): ComboLookup {
  let value: unknown
  try {
    value = loadConfig(worktree).chat.combo
  } catch (error) {
    return { state: "invalid", reason: error instanceof ConfigError ? error.message : "lca config could not be read" }
  }
  if (value === undefined || value === null) return { state: "unset" }
  if (typeof value !== "object" || Array.isArray(value)) return { state: "invalid", reason: "chat.combo must be an object mapping roles to {engine, model}" }
  // A null role (project removing a user route) means "not routed".
  const present = Object.fromEntries(Object.entries(value).filter(([, route]) => route !== null && route !== undefined))
  const routes = validateComboRoutes(present)
  if (typeof routes === "string") return { state: "invalid", reason: routes }
  if (Object.keys(routes).length === 0) return { state: "unset" }
  const project = rawCombo(projectConfigPath(worktree))
  const sources: Partial<Record<ExecutionRole, "user" | "project">> = {}
  for (const role of Object.keys(routes) as ExecutionRole[]) {
    sources[role] = project !== undefined && project[role] !== undefined && project[role] !== null ? "project" : "user"
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

function userCombo(): Record<string, unknown> | undefined {
  return rawCombo(userConfigPath())
}

/** Remove one user-level role route; returns whether one was present. */
export function clearComboRole(role: ExecutionRole): boolean {
  if (!isComboRole(role)) throw new TypeError(`${String(role)} is not a routable role`)
  let present = false
  rewriteUserConfig(text => {
    present = userCombo()?.[role] !== undefined
    return present ? applyEdits(text, modify(text, ["chat", "combo", role], undefined, formatting)) : text
  })
  return present
}

/** Remove the whole user-level combo; returns whether one was present. */
export function clearCombo(): boolean {
  let present = false
  rewriteUserConfig(text => {
    present = userCombo() !== undefined
    return present ? applyEdits(text, modify(text, ["chat", "combo"], undefined, formatting)) : text
  })
  return present
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
