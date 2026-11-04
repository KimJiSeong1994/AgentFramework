// Otter-owned CODEX_HOME for Codex inference.
//
// Codex reads more than config.toml from its home on every turn: `$CODEX_HOME/AGENTS.md` becomes a user message
// (oh-my-codex installs a 25 KB "autonomous agent, never ask permission" file there), `$CODEX_HOME/skills` is listed to
// the model, and hooks/config live beside them. `--ignore-user-config` skips only config.toml. Otter's inference process
// therefore runs with a home it owns that holds nothing but an `auth.json` symlink to the user's real sign-in file: the
// vendor CLI keeps the credential (Codex writes refreshed tokens through the link; verified with `codex login` on
// 0.165.0), otter never reads it, and `otter auth` / `/login` keep using the real home, so one sign-in serves both.
// Files Codex itself creates in the owned home (installation_id, skills/.system, sqlite state) are tolerated.
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { stateBase } from "../state/store.ts"

export const OWNED_CODEX_HOME_DIRECTORY = "codex-home"
/** Files that would re-inject instructions if a user (or a tool) placed them in the owned home; otter refuses to run then. */
const FORBIDDEN_ENTRIES = ["AGENTS.md", "config.toml", "hooks.json", "rules"] as const

/** The user's real Codex home, where `codex login` stores auth.json: $CODEX_HOME when absolute, else ~/.codex. */
export function realCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME
  return typeof configured === "string" && configured.length > 0 && isAbsolute(configured) && !configured.includes("\0") ? configured : join(homedir(), ".codex")
}

/** Where the owned home lives: `<state base>/codex-home` (`$XDG_STATE_HOME/otter` or `$OTTER_STATE_HOME`). */
export function ownedCodexHomePath(): string {
  return join(stateBase(), OWNED_CODEX_HOME_DIRECTORY)
}

export type OwnedCodexHome = Readonly<{ path: string; authLink: string; authTarget: string }>

export class OwnedCodexHomeError extends Error {}

/**
 * Ensures the owned home exists (mode 0700, not a symlink) and that `auth.json` inside it is a symlink to the real
 * home's auth.json; a link to a previous real home is re-pointed. Throws OwnedCodexHomeError when auth.json is a regular
 * file (a Codex release replaced the link instead of writing through it: otter refuses to run on a credential copy that
 * could diverge from the user's sign-in) or when an instruction file was placed in the owned home.
 */
export function ensureOwnedCodexHome(env: NodeJS.ProcessEnv = process.env): OwnedCodexHome {
  const requested = ownedCodexHomePath()
  mkdirSync(requested, { recursive: true, mode: 0o700 })
  const created = lstatSync(requested)
  if (!created.isDirectory() || created.isSymbolicLink()) throw new OwnedCodexHomeError(`owned Codex home ${requested} is not a directory`)
  if ((created.mode & 0o077) !== 0) chmodSync(requested, 0o700)
  const path = realpathSync(requested)
  for (const entry of FORBIDDEN_ENTRIES) {
    if (existsSync(join(path, entry))) throw new OwnedCodexHomeError(`owned Codex home ${path} contains ${entry}; remove it (otter must not feed instruction files to the model)`)
  }
  const authTarget = join(realCodexHome(env), "auth.json")
  const authLink = join(path, "auth.json")
  let existing: ReturnType<typeof lstatSync> | undefined
  try { existing = lstatSync(authLink) } catch (error) {
    if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new OwnedCodexHomeError(`${authLink} is not a symlink to the Codex sign-in file; delete it and retry (otter recreates the link)`)
  }
  if (existing && readlinkSync(authLink) !== authTarget) {
    unlinkSync(authLink)
    existing = undefined
  }
  if (!existing) symlinkSync(authTarget, authLink)
  return Object.freeze({ path, authLink, authTarget })
}
