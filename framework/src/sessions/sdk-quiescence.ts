import type { OpencodeClient } from "@opencode-ai/sdk"
import { realpathSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

export type SDKResumeContext = {
  client: OpencodeClient
  sessionID: string
  directory: string
  worktree: string
  revalidate: () => void
}
export type SDKResumeIdentity = { sessionID: string; directory: string; createdAt: number; updatedAt: number }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Authenticate the original root session; neither lookup nor failure creates a vendor session. */
export async function readSDKResumeIdentity(context: SDKResumeContext): Promise<SDKResumeIdentity> {
  context.revalidate()
  const result = await context.client.session.get({ path: { id: context.sessionID }, query: { directory: context.directory } })
  context.revalidate()
  const info: unknown = result.data
  if (result.error || !object(info) || info.id !== context.sessionID || info.parentID !== undefined || typeof info.directory !== "string" || !object(info.time)) {
    throw new Error("the original OpenCode root session is unavailable or mismatched")
  }
  const directory = realpathSync.native(info.directory)
  const root = realpathSync.native(context.worktree)
  const within = relative(root, directory)
  if (directory !== realpathSync.native(context.directory) || within === ".." || within.startsWith("../") || isAbsolute(within)) {
    throw new Error("OpenCode session directory does not match this owner worktree")
  }
  const { created, updated } = info.time
  if (typeof created !== "number" || !Number.isFinite(created) || created < 0 ||
      typeof updated !== "number" || !Number.isFinite(updated) || updated < created) {
    throw new Error("OpenCode session lifetime evidence is unavailable")
  }
  return { sessionID: context.sessionID, directory, createdAt: created, updatedAt: updated }
}

/** Vendor idleness and canonical terminal tool parts supplement, never replace, LCA execution-store proof. */
export async function assertSDKSessionQuiescent(context: SDKResumeContext, initial: SDKResumeIdentity): Promise<void> {
  const idle = async () => {
    context.revalidate()
    const result = await context.client.session.status({ query: { directory: context.directory } })
    context.revalidate()
    if (result.error || !object(result.data)) throw new Error("OpenCode session status is unavailable")
    // OpenCode's status registry removes idle entries (v1.18.35 session/status.ts).
    // Only a successfully read map plus an authenticated, still-existing SID permits this interpretation.
    const status: unknown = Object.hasOwn(result.data, context.sessionID) ? result.data[context.sessionID] : undefined
    if (status !== undefined && (!object(status) || status.type !== "idle")) throw new Error("OpenCode session is not idle")
  }
  await idle()
  const messages = await context.client.session.messages({ path: { id: context.sessionID }, query: { directory: context.directory } })
  context.revalidate()
  if (messages.error || !Array.isArray(messages.data)) throw new Error("OpenCode canonical message history is unavailable")
  const ids = new Set<string>()
  for (const message of messages.data) {
    if (!object(message) || !object(message.info) || message.info.sessionID !== context.sessionID ||
        typeof message.info.id !== "string" || !message.info.id || ids.has(message.info.id) || !Array.isArray(message.parts)) {
      throw new Error("OpenCode canonical message identity is invalid")
    }
    ids.add(message.info.id)
    for (const part of message.parts) {
      if (!object(part) || part.sessionID !== context.sessionID || part.messageID !== message.info.id) {
        throw new Error("OpenCode canonical part identity is invalid")
      }
      if (part.type === "tool" && (!object(part.state) || (part.state.status !== "completed" && part.state.status !== "error"))) {
        throw new Error("OpenCode tool execution is not terminal")
      }
    }
  }
  await idle()
  const final = await readSDKResumeIdentity(context)
  if (final.sessionID !== initial.sessionID || final.directory !== initial.directory ||
      final.createdAt !== initial.createdAt || final.updatedAt !== initial.updatedAt) {
    throw new Error("OpenCode session changed during explicit Resume")
  }
  context.revalidate()
}
