// Vendor CLI sign-in for the codex and claude engines. Otter never reads, stores, forwards or prints a credential:
// status runs the vendor's own read-only status command and keeps only "signed in / not / unknown" plus the sign-in
// method label, and login/logout hand the real terminal to the vendor's own interactive command.
import { spawn, spawnSync } from "node:child_process"
import { findExecutable, insideWsl, type CliEngine } from "./cli-transport.ts"
import { UNFORWARDED_CREDENTIAL_ENV, unforwardedEnvironmentNames, vendorProcessEnvironment } from "./vendor-process.ts"

export type AuthEngine = Extract<CliEngine, "codex" | "claude">
export const AUTH_ENGINES: readonly AuthEngine[] = ["codex", "claude"]

export type AuthState =
  | { engine: AuthEngine; state: "signed-in"; method?: string }
  /** `envOnly`: a credential variable is set in otter's environment, but model calls never receive it. */
  | { engine: AuthEngine; state: "signed-out"; envOnly?: string }
  | { engine: AuthEngine; state: "unknown"; reason: string }

export type LoginMethod = "browser" | "device" | "console" | "api-key"

export type AuthRun = { exitCode: number | null; signal: string | null }

const STATUS_TIMEOUT_MS = 15_000
const STATUS_OUTPUT_BYTES = 64 * 1024
const METHOD_LABEL = /^[A-Za-z0-9 ._()-]{1,40}$/u

/** The vendor's own sign-in commands. `api-key` reads the key from stdin inside the vendor CLI, never from otter. */
export function loginArgv(engine: AuthEngine, method: LoginMethod = "browser"): string[] {
  if (engine === "codex") {
    if (method === "device") return ["login", "--device-auth"]
    if (method === "api-key") return ["login", "--with-api-key"]
    if (method === "console") throw new TypeError("codex has no Anthropic Console sign-in")
    return ["login"]
  }
  if (method === "console") return ["auth", "login", "--console"]
  if (method === "device" || method === "api-key") throw new TypeError(`claude does not offer ${method} sign-in through auth login`)
  return ["auth", "login"]
}

/**
 * Shown before a browser sign-in under WSL (the Windows install): the vendor CLI opens the Windows browser through
 * BROWSER (set by scripts/otter-wsl), and its callback reaches WSL via localhost forwarding. When either fails, the
 * printed URL still works from Windows, and codex's device code needs neither.
 */
export function loginHint(engine: AuthEngine, method: LoginMethod, wsl = insideWsl()): string | undefined {
  if (!wsl || method !== "browser") return undefined
  return engine === "codex"
    ? "WSL: if no browser opens, open the printed URL in Windows. If the page cannot reach localhost, use: /login codex device"
    : "WSL: if no browser opens, open the printed URL in Windows and paste the code back here."
}

export function logoutArgv(engine: AuthEngine): string[] {
  return engine === "codex" ? ["logout"] : ["auth", "logout"]
}

function statusArgv(engine: AuthEngine): string[] {
  return engine === "codex" ? ["login", "status"] : ["auth", "status", "--json"]
}

type CodexStatusLine = "signed-out" | "chatgpt" | "api-key"

function codexStatusFromOutput(output: string): { hasStatus: boolean; status?: CodexStatusLine } {
  const statuses = new Set<CodexStatusLine>()
  for (const line of output.split(/\r?\n/u)) {
    if (line === "Not logged in") statuses.add("signed-out")
    else if (line === "Logged in using ChatGPT") statuses.add("chatgpt")
    else if (/^Logged in using an API key(?: - sk-[A-Za-z0-9._*-]+)?$/u.test(line)) statuses.add("api-key")
  }
  const status = statuses.values().next().value
  return statuses.size === 1 && status ? { hasStatus: true, status } : { hasStatus: statuses.size > 0 }
}

/** Read only the sign-in verdict (and the method label) from the vendor status output. */
export function parseAuthStatus(engine: AuthEngine, exitCode: number | null, output: string): AuthState {
  if (engine === "claude") {
    try {
      // The JSON object may follow a notice line (update or migration messages); parse from its first brace.
      const start = output.indexOf("{")
      const value: unknown = JSON.parse(start >= 0 ? output.slice(start) : output)
      if (value && typeof value === "object" && typeof (value as { loggedIn?: unknown }).loggedIn === "boolean") {
        const record = value as { loggedIn: boolean; authMethod?: unknown }
        if (!record.loggedIn) return { engine, state: "signed-out" }
        if (exitCode !== 0) return { engine, state: "unknown", reason: `claude auth status exited ${exitCode ?? "without a code"}` }
        const method = typeof record.authMethod === "string" && METHOD_LABEL.test(record.authMethod) ? record.authMethod : undefined
        return { engine, state: "signed-in", ...(method ? { method } : {}) }
      }
    } catch { /* fall through */ }
    return { engine, state: "unknown", reason: "claude auth status returned unrecognized output" }
  }
  const { status } = codexStatusFromOutput(output)
  if (status === "signed-out") return { engine, state: "signed-out" }
  if (exitCode === 0 && status === "chatgpt") return { engine, state: "signed-in", method: "ChatGPT" }
  // Codex may include a masked API-key hint after this status. Never retain or echo that suffix.
  if (exitCode === 0 && status === "api-key") {
    return { engine, state: "signed-in" }
  }
  return { engine, state: "unknown", reason: `codex login status exited ${exitCode ?? "without a code"}` }
}

/** The first credential variable set in otter's environment that model calls will not receive. */
function unforwardedCredential(engine: AuthEngine): string | undefined {
  return UNFORWARDED_CREDENTIAL_ENV[engine].find(name => typeof process.env[name] === "string" && process.env[name] !== "")
}

/**
 * Run the vendor status command without a terminal; bounded time and output. It runs with exactly the environment a model
 * call gets (vendorProcessEnvironment), so this reports the same CLI authentication view available to model calls; it
 * does not verify that a model request can successfully infer.
 */
export async function authStatus(engine: AuthEngine, cwd: string, env: NodeJS.ProcessEnv = vendorProcessEnvironment()): Promise<AuthState> {
  let executable: string
  try { executable = findExecutable(engine) } catch { return { engine, state: "unknown", reason: `${engine} CLI not found on PATH` } }
  const envOnly = env === process.env ? undefined : unforwardedCredential(engine)
  return await new Promise<AuthState>(settle => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let done = false
    const child = spawn(executable, statusArgv(engine), { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    const finish = (value: AuthState) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(value.state === "signed-out" && envOnly ? { ...value, envOnly } : value)
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} finish({ engine, state: "unknown", reason: "status check timed out" }) }, STATUS_TIMEOUT_MS)
    const take = (chunks: Buffer[], byteLength: number, chunk: Buffer) => {
      const remaining = STATUS_OUTPUT_BYTES - byteLength
      if (remaining <= 0) return byteLength
      const bounded = Buffer.from(chunk.subarray(0, remaining))
      chunks.push(bounded)
      return byteLength + bounded.length
    }
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = take(stdout, stdoutBytes, chunk) })
    // Capture stderr separately: Codex writes its status there, while Claude's JSON is on stdout.
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = take(stderr, stderrBytes, chunk) })
    child.on("error", () => finish({ engine, state: "unknown", reason: `${engine} status command could not start` }))
    child.on("close", code => {
      const stdoutText = Buffer.concat(stdout, stdoutBytes).toString("utf8")
      if (engine === "claude") {
        finish(parseAuthStatus(engine, code, stdoutText))
        return
      }
      const stderrText = Buffer.concat(stderr, stderrBytes).toString("utf8")
      const statusOutput = codexStatusFromOutput(stderrText).hasStatus ? stderrText : stdoutText
      finish(parseAuthStatus(engine, code, statusOutput))
    })
  })
}

export type AuthDiagnosis = Readonly<{
  engine: AuthEngine
  /** Resolved CLI and its `--version` line, when found. */
  cli?: string
  /** Sign-in as the user's own shell sees it (full environment). */
  shell: AuthState
  /** Sign-in as otter's model calls see it (the forwarded environment). */
  otter: AuthState
  /** Names of credential variables set in the shell that otter never forwards. */
  credentialEnv: readonly string[]
  /** Names of other possibly relevant variables set in the shell but not forwarded (keyring, cloud, vendor). */
  unforwarded: readonly string[]
}>

/** Compare the sign-in the user's shell sees with the one otter's model calls see, and name what differs. */
export async function diagnoseAuth(engine: AuthEngine, cwd: string): Promise<AuthDiagnosis> {
  let cli: string | undefined
  try {
    const executable = findExecutable(engine)
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
    cli = `${executable} ${(typeof version.stdout === "string" ? version.stdout.trim().split("\n")[0] ?? "" : "").slice(0, 80)}`.trim()
  } catch { cli = undefined }
  const [shell, otter] = await Promise.all([authStatus(engine, cwd, process.env), authStatus(engine, cwd)])
  const credentialEnv = UNFORWARDED_CREDENTIAL_ENV[engine].filter(name => typeof process.env[name] === "string" && process.env[name] !== "")
  return { engine, ...(cli ? { cli } : {}), shell, otter, credentialEnv, unforwarded: unforwardedEnvironmentNames() }
}

/** Human lines for a diagnosis: both views, and why they differ when they do. */
export function describeDiagnosis(d: AuthDiagnosis): string[] {
  const view = (state: AuthState) => describeAuth(state).replace(/^\w+: /u, "")
  const lines = [`${d.engine}${d.cli ? ` (${d.cli})` : ""}`, `  your shell:      ${view(d.shell)}`, `  otter (models):  ${view(d.otter)}`]
  if (d.shell.state === d.otter.state) {
    lines.push(d.otter.state === "signed-in" ? "  → the CLI reports the same signed-in status in both environments." : d.otter.state === "signed-out" ? `  → the CLI reports signed out in both environments; /login ${d.engine}.` : "  → status could not be read; see the reason above.")
    return lines
  }
  if (d.shell.state === "signed-in" && d.otter.state !== "signed-in") {
    if (d.credentialEnv.length) lines.push(`  → ${d.credentialEnv.join(", ")} is set in your shell but not passed to the CLI; this may explain the different status. Sign in with /login ${d.engine} so the CLI stores its own sign-in.`)
    else lines.push(`  → otter and your shell report different statuses.${d.unforwarded.length ? ` These shell variables are not passed to model calls and may explain the difference: ${d.unforwarded.join(", ")}.` : ""} Please report these lines.`)
  } else lines.push("  → otter and your shell report different statuses; please report these lines.")
  return lines
}

/**
 * Hand the real terminal to the vendor's interactive command (browser/device sign-in, or sign-out). The caller must
 * release raw input first. Output goes straight to the terminal; otter captures nothing.
 */
export async function runVendorAuth(engine: AuthEngine, argv: readonly string[], cwd: string): Promise<AuthRun> {
  const executable = findExecutable(engine)
  // The user's own session (browser, display, WSL interop), minus credential variables: the sign-in must land in the
  // CLI's own store, which model calls read, not be satisfied by an environment key they never receive.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of UNFORWARDED_CREDENTIAL_ENV[engine]) delete env[name]
  return await new Promise<AuthRun>((settle, fail) => {
    const child = spawn(executable, [...argv], { cwd, env, stdio: "inherit" })
    child.on("error", fail)
    child.on("close", (exitCode, signal) => settle({ exitCode, signal }))
  })
}

export function describeAuth(state: AuthState): string {
  if (state.state === "signed-in") return `${state.engine}: signed in${state.method ? ` (${state.method})` : ""}`
  if (state.state === "signed-out") {
    return state.envOnly
      ? `${state.engine}: not signed in · ${state.envOnly} is set, but otter never passes API keys to the CLI; sign in with /login ${state.engine}${state.engine === "codex" ? " (api-key stores a key in the CLI)" : " (console uses API billing)"}`
      : `${state.engine}: not signed in · /login ${state.engine}`
  }
  return `${state.engine}: unknown (${state.reason})`
}
