// Test helpers for the guards/loop suites (kept separate from test/helpers.ts, which other suites own): temp worktree, fake SDK client, deps bag.
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { executionRunDirectory } from "../src/state/store.ts"

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
    status: (o?: any) => Promise<{ data: Record<string, { type: "busy" | "idle" }> }>
  }
}

export function fakeClient(opts: { todoEndpoint?: boolean; promptAsync?: boolean } = {}): FakeClient {
  let seq = 0
  const nth: Record<string, number> = {}
  const pendingMessageIDs = new Map<string, string>()
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
          const info: any = { id: `msg_${seq}_${nth[agent!]}`, role: "assistant", sessionID: sid, parentID: o.body.messageID }
          if (aborted) info.error = { name: "MessageAbortedError", data: {} }
          else if (reply.error) info.error = reply.error
          const texts = reply.texts ?? (reply.text !== undefined ? [reply.text] : [])
          const parts = [{ type: "step-start" }, ...texts.map((text) => ({ type: "text", text, sessionID: sid })), { type: "step-finish" }]
          return { data: { info, parts } }
        }
        // in flight until delay/run finish; session.abort resolves it early with MessageAbortedError (real behaviour)
        return await new Promise<{ data: unknown }>(async (resolve) => {
          let settled = false
          pendingMessageIDs.set(sid, o.body.messageID)
          c.inflight.set(sid, (r) => {
            if (settled) return
            settled = true
            resolve(r)
          })
          try {
            if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
            if (reply.run) await reply.run()
          } finally {
            pendingMessageIDs.delete(sid)
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
          pending({ data: { info: { id: "aborted", role: "assistant", sessionID: o.path.id, parentID: pendingMessageIDs.get(o.path.id), error: { name: "MessageAbortedError", data: {} } }, parts: [] } })
        }
        return { data: true }
      },
      status: async () => ({ data: Object.fromEntries(c.created.map(({ id }) => [id, { type: c.inflight.has(id) ? "busy" as const : "idle" as const }])) }),
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

export type TempExecutionAuthorityRelease = Readonly<{ removed: boolean; path: string; reason?: string }>

export type TempExecutionAuthority = Readonly<{
  directory: string
  keyDirectory: string
  release: (options: { preserve: boolean }) => TempExecutionAuthorityRelease
}>

export type TempWorktree = {
  worktree: string
  stateHome: string
  executionAuthority: TempExecutionAuthority
  releaseEnvironment: () => void
  cleanup: () => void
}

type FixtureIdentity = { uid: bigint; dev: bigint; ino: bigint }

function fixtureIdentity(path: string, kind: "directory" | "file", uid: number): FixtureIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`expected fixture ${kind} at ${path}`)
  }
  if (stat.uid !== BigInt(uid)) throw new Error(`fixture ${kind} at ${path} is not owned by the operating-system user`)
  return { uid: stat.uid, dev: stat.dev, ino: stat.ino }
}

function fixtureIdentityMatches(path: string, kind: "directory" | "file", expected: FixtureIdentity): string | undefined {
  let stat
  try {
    stat = lstatSync(path, { bigint: true })
  } catch (error) {
    return `cannot inspect captured ${kind} at ${path}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return `captured ${kind} at ${path} is no longer a ${kind}`
  if (stat.uid !== expected.uid || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    return `captured ${kind} identity changed at ${path}`
  }
  return undefined
}

/**
 * Exclusively allocate a test-owned namespace at the production execution-authority path.
 * This helper never adopts an existing worktree-key directory; release validates captured
 * filesystem identities before removing only that key directory.
 */
export function tempExecutionAuthority(worktree: string): TempExecutionAuthority {
  const directory = executionRunDirectory(worktree)
  const keyDirectory = dirname(directory)
  const base = dirname(keyDirectory)

  let uidValue: unknown
  try {
    uidValue = process.geteuid?.()
  } catch (error) {
    throw new Error(`cannot capture the operating-system identity for execution-authority fixture: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof uidValue !== "number" || !Number.isSafeInteger(uidValue) || uidValue < 0) {
    throw new Error("cannot capture a valid effective operating-system UID for execution-authority fixture")
  }
  const uid = uidValue

  try {
    try {
      const stat = lstatSync(base)
      if (!stat.isDirectory()) throw new Error(`execution-authority fixture base is not a directory: ${base}`)
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      mkdirSync(base, { recursive: true, mode: 0o700 })
    }
  } catch (error) {
    throw new Error(`cannot prepare execution-authority fixture base; any newly created ancestors were retained at ${base}: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    mkdirSync(keyDirectory, { mode: 0o700 })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`execution-authority fixture namespace already exists and was not adopted or changed: ${keyDirectory}`)
    }
    throw new Error(`cannot exclusively create execution-authority fixture namespace at ${keyDirectory}; the base was retained: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const keyIdentity = fixtureIdentity(keyDirectory, "directory", uid)
    mkdirSync(directory, { mode: 0o700 })
    const directoryIdentity = fixtureIdentity(directory, "directory", uid)

    const markerName = `.execution-authority-fixture-${randomBytes(32).toString("hex")}`
    const markerPath = join(directory, markerName)
    const markerToken = randomBytes(32)
    let markerFD: number | undefined
    try {
      markerFD = openSync(markerPath, "wx", 0o600)
      writeFileSync(markerFD, markerToken)
    } finally {
      if (markerFD !== undefined) closeSync(markerFD)
    }
    const markerIdentity = fixtureIdentity(markerPath, "file", uid)

    const result = (removed: boolean, reason?: string): TempExecutionAuthorityRelease => Object.freeze({
      removed,
      path: keyDirectory,
      ...(reason === undefined ? {} : { reason }),
    })

    let removed = false
    const release = ({ preserve }: { preserve: boolean }): TempExecutionAuthorityRelease => {
      if (removed) return result(true)
      if (preserve) return result(false, "preserved by request")

      for (const [path, kind, identity] of [
        [keyDirectory, "directory", keyIdentity],
        [directory, "directory", directoryIdentity],
        [markerPath, "file", markerIdentity],
      ] as const) {
        const mismatch = fixtureIdentityMatches(path, kind, identity)
        if (mismatch) return result(false, mismatch)
      }

      let currentToken: Buffer
      try {
        currentToken = readFileSync(markerPath)
      } catch (error) {
        return result(false, `cannot read captured marker at ${markerPath}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!currentToken.equals(markerToken)) return result(false, `captured marker content changed at ${markerPath}`)

      try {
        rmSync(keyDirectory, { recursive: true })
      } catch (error) {
        return result(false, `cannot remove captured namespace at ${keyDirectory}: ${error instanceof Error ? error.message : String(error)}`)
      }
      removed = true
      return result(true)
    }

    return Object.freeze({ directory, keyDirectory, release })
  } catch (error) {
    throw new Error(`execution-authority fixture setup failed; retained partial namespace at ${keyDirectory}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type StateHomeSelection = {
  selected: string
  rootValue: string | undefined
  previous?: StateHomeSelection
  closed: boolean
}

const stateHomeSelections: StateHomeSelection[] = []

function selectStateHome(selected: string): StateHomeSelection {
  let previous: StateHomeSelection | undefined
  for (let i = stateHomeSelections.length - 1; i >= 0; i--) {
    const candidate = stateHomeSelections[i]!
    if (!candidate.closed && candidate.selected === process.env.LCA_STATE_HOME) {
      previous = candidate
      break
    }
  }
  const selection: StateHomeSelection = {
    selected,
    rootValue: previous ? previous.rootValue : process.env.LCA_STATE_HOME,
    previous,
    closed: false,
  }
  stateHomeSelections.push(selection)
  process.env.LCA_STATE_HOME = selected
  return selection
}

function releaseStateHome(selection: StateHomeSelection): void {
  if (selection.closed) return
  selection.closed = true
  if (process.env.LCA_STATE_HOME === selection.selected) {
    let previous = selection.previous
    while (previous?.closed) previous = previous.previous
    const restore = previous?.selected ?? selection.rootValue
    if (restore === undefined) delete process.env.LCA_STATE_HOME
    else process.env.LCA_STATE_HOME = restore
  }
  while (stateHomeSelections.at(-1)?.closed) stateHomeSelections.pop()
}

/** Temp worktree and separate control-state home, with an exclusively owned fixed execution authority. */
export function tempWorktree(): TempWorktree {
  let worktree: string | undefined
  let stateHome: string | undefined
  let stateHomeSelection: StateHomeSelection | undefined
  try {
    const worktreePath = mkdtempSync(join(tmpdir(), "lca-test-"))
    worktree = worktreePath
    const stateHomePath = mkdtempSync(join(tmpdir(), "lca-state-"))
    stateHome = stateHomePath
    stateHomeSelection = selectStateHome(stateHomePath)
    const executionAuthority = tempExecutionAuthority(worktreePath)

    return {
      worktree: worktreePath,
      stateHome: stateHomePath,
      executionAuthority,
      releaseEnvironment: () => releaseStateHome(stateHomeSelection!),
      cleanup: () => {
        releaseStateHome(stateHomeSelection!)
        const released = executionAuthority.release({ preserve: false })
        if (!released.removed) {
          throw new Error(`cannot clean temp worktree fixture; execution authority retained at ${released.path}${released.reason ? ` (${released.reason})` : ""}; worktree retained at ${worktreePath}; stateHome retained at ${stateHomePath}`)
        }
        rmSync(worktreePath, { recursive: true, force: true })
        rmSync(stateHomePath, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (stateHomeSelection) releaseStateHome(stateHomeSelection)
    const ownedPaths = [
      worktree ? `worktree retained at ${worktree}` : undefined,
      stateHome ? `stateHome retained at ${stateHome}` : undefined,
    ].filter((path): path is string => path !== undefined)
    throw new Error(`tempWorktree setup failed${ownedPaths.length ? `; ${ownedPaths.join("; ")}` : ""}: ${error instanceof Error ? error.message : String(error)}`)
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

export function tempGitWorktree(files: Record<string, string> = { "README.md": "fixture\n" }): TempWorktree {
  const wt = tempWorktree()
  try {
    const g = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: wt.worktree, stdio: "pipe", env: GIT_TEST_ENV })
    g("init", "-q")
    g("config", "user.email", "lca-test@localhost")
    g("config", "user.name", "lca-test")
    for (const [name, content] of Object.entries(files)) writeFileSync(join(wt.worktree, name), content)
    g("add", "-A")
    g("commit", "-q", "-m", "fixture")
    return wt
  } catch (error) {
    wt.releaseEnvironment()
    throw new Error(`tempGitWorktree setup failed; worktree retained at ${wt.worktree}; stateHome retained at ${wt.stateHome}; execution-authority namespace retained at ${wt.executionAuthority.keyDirectory}: ${error instanceof Error ? error.message : String(error)}`)
  }
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
