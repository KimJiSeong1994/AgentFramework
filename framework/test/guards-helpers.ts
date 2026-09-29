// Test helpers for the guards/loop suites (kept separate from test/helpers.ts, which other suites own): temp worktree, fake SDK client, deps bag.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"

export type Call = { method: string; args: unknown }

export type PromptReply = {
  text?: string
  /** several text parts (the real SDK returns step/tool/text parts mixed; extractText joins text parts) */
  texts?: string[]
  error?: { name: string; data?: any }
  delayMs?: number
  run?: () => void | Promise<void>
}

export type FakeClient = {
  calls: Call[]
  todos: unknown[] | undefined
  messages: unknown[]
  /** child sessions created via session.create (stage 2), in order */
  created: Array<{ id: string; parentID?: string; title?: string; directory?: string }>
  /** stage 2: reply for prompts sent to child sessions, keyed by agent ("worker" | "reviewer"); may be a function */
  replies: Record<string, PromptReply | ((o: any, nth: number) => PromptReply)>
  /** stage 2: make session.create fail like the real SDK ({data: undefined, error}) */
  createError?: { name: string; data?: any }
  /** prompts currently in flight per session (resolved with MessageAbortedError by session.abort, like OpenCode) */
  inflight: Map<string, (r: { data: unknown }) => void>
  session: {
    todo?: (o: any) => Promise<{ data?: unknown; error?: unknown }>
    messages: (o: any) => Promise<{ data: unknown }>
    prompt: (o: any) => Promise<{ data: unknown }>
    promptAsync?: (o: any) => Promise<{ data: unknown }>
    abort: (o: any) => Promise<{ data: boolean }>
    create: (o: any) => Promise<{ data: unknown }>
  }
}

export function fakeClient(opts: { todoEndpoint?: boolean; promptAsync?: boolean } = {}): FakeClient {
  let seq = 0
  const nth: Record<string, number> = {}
  const c: FakeClient = {
    calls: [],
    todos: [],
    messages: [],
    created: [],
    replies: {},
    inflight: new Map(),
    session: {
      messages: async (o) => {
        c.calls.push({ method: "messages", args: o })
        return { data: c.messages }
      },
      create: async (o) => {
        c.calls.push({ method: "create", args: o })
        if (c.createError) return { data: undefined, error: c.createError } as any
        const id = `child_${++seq}`
        c.created.push({ id, parentID: o?.body?.parentID, title: o?.body?.title, directory: o?.query?.directory })
        return { data: { id, parentID: o?.body?.parentID, title: o?.body?.title } }
      },
      prompt: async (o) => {
        c.calls.push({ method: "prompt", args: o })
        const agent = o?.body?.agent as string | undefined
        const entry = agent ? c.replies[agent] : undefined
        if (!entry) return { data: {} }
        nth[agent!] = (nth[agent!] ?? 0) + 1
        const reply = typeof entry === "function" ? entry(o, nth[agent!]!) : entry
        const sid = o.path.id as string
        const build = (aborted: boolean) => {
          const info: any = { id: `msg_${seq}_${nth[agent!]}`, role: "assistant", sessionID: sid }
          if (aborted) info.error = { name: "MessageAbortedError", data: {} }
          else if (reply.error) info.error = reply.error
          const texts = reply.texts ?? (reply.text !== undefined ? [reply.text] : [])
          const parts = [{ type: "step-start" }, ...texts.map((text) => ({ type: "text", text, sessionID: sid })), { type: "step-finish" }]
          return { data: { info, parts } }
        }
        // in flight until delay/run finish; session.abort resolves it early with MessageAbortedError (real behaviour)
        return await new Promise<{ data: unknown }>(async (resolve) => {
          let settled = false
          c.inflight.set(sid, (r) => {
            if (settled) return
            settled = true
            resolve(r)
          })
          try {
            if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
            if (reply.run) await reply.run()
          } finally {
            if (!settled) {
              settled = true
              c.inflight.delete(sid)
              resolve(build(false))
            }
          }
        })
      },
      abort: async (o) => {
        c.calls.push({ method: "abort", args: o })
        const pending = c.inflight.get(o.path.id)
        if (pending) {
          c.inflight.delete(o.path.id)
          pending({ data: { info: { id: "aborted", role: "assistant", sessionID: o.path.id, error: { name: "MessageAbortedError", data: {} } }, parts: [] } })
        }
        return { data: true }
      },
    },
  }
  if (opts.todoEndpoint !== false) {
    c.session.todo = async (o) => {
      c.calls.push({ method: "todo", args: o })
      return c.todos === undefined ? { error: { name: "NotFoundError" } } : { data: c.todos }
    }
  }
  if (opts.promptAsync) {
    c.session.promptAsync = async (o) => {
      c.calls.push({ method: "promptAsync", args: o })
      return { data: {} }
    }
  }
  return c
}

/** Temp worktree; plugin state (outside the worktree by design) is redirected to a sibling temp dir via LCA_STATE_HOME. */
export function tempWorktree(): { worktree: string; stateHome: string; cleanup: () => void } {
  const worktree = mkdtempSync(join(tmpdir(), "lca-test-"))
  const stateHome = mkdtempSync(join(tmpdir(), "lca-state-"))
  process.env.LCA_STATE_HOME = stateHome
  return {
    worktree,
    stateHome,
    cleanup: () => {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(stateHome, { recursive: true, force: true })
    },
  }
}

export function makeDeps(client: FakeClient, worktree: string, patch: Partial<LcaConfig> = {}): HookDeps & { logs: string[] } {
  const logs: string[] = []
  const config: LcaConfig = {
    ...DEFAULT_CONFIG,
    ...patch,
    guards: { ...DEFAULT_CONFIG.guards, ...(patch.guards ?? {}) },
    loop: { ...DEFAULT_CONFIG.loop, ...(patch.loop ?? {}) },
    delegate: { ...DEFAULT_CONFIG.delegate, ...(patch.delegate ?? {}) },
    models: { ...DEFAULT_CONFIG.models, ...(patch.models ?? {}) },
    data: { ...DEFAULT_CONFIG.data, ...(patch.data ?? {}), evo: { ...DEFAULT_CONFIG.data.evo, ...((patch.data as any)?.evo ?? {}) } },
  }
  return {
    client: client as unknown as HookDeps["client"],
    directory: worktree,
    worktree,
    config,
    log: (msg) => logs.push(msg),
    logs,
  }
}

export function todo(id: string, status: string, content = `task ${id}`) {
  return { id, status, content, priority: "medium" }
}

/** Temp worktree that is also a git repo with one commit (for snapshot/diff tests). */
export const GIT_TEST_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" }

export function tempGitWorktree(files: Record<string, string> = { "README.md": "fixture\n" }): { worktree: string; stateHome: string; cleanup: () => void } {
  const wt = tempWorktree()
  const g = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: wt.worktree, stdio: "pipe", env: GIT_TEST_ENV })
  g("init", "-q")
  g("config", "user.email", "lca-test@localhost")
  g("config", "user.name", "lca-test")
  for (const [name, content] of Object.entries(files)) writeFileSync(join(wt.worktree, name), content)
  g("add", "-A")
  g("commit", "-q", "-m", "fixture")
  return wt
}

/** Poll until fn() is truthy; fails fast instead of hanging until bun's test timeout. */
export async function waitFor(fn: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: condition not met in time")
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Write an allow-listed verify script (sh <name>.sh) into the worktree; `body` is the script content. */
export function verifyScript(worktree: string, name: string, body: string): string {
  writeFileSync(join(worktree, name), body + "\n")
  return `sh ${name}`
}
