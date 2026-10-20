import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import process from "node:process"
import { isAbsolute } from "node:path"
import type { Readable } from "node:stream"
import type { ExecutionCancelResult, ExecutionReconciliation } from "./types.ts"

// Native keychain lookup needs the non-secret account names; authentication tokens are never forwarded.
// Location variables say where the vendor CLI keeps its own sign-in (CODEX_HOME, CLAUDE_CONFIG_DIR, XDG dirs) and how it
// reaches its service (proxy, CA bundle). They carry no model-provider credential; without them a model call reads a
// different sign-in than the one `otter auth` / `/login` saw, and a signed-in user is refused.
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const

/**
 * Credentials a vendor CLI would also accept from the environment. Otter never forwards them; a user who signed in only
 * this way is told to sign in with the CLI itself (stored in its own CODEX_HOME / CLAUDE_CONFIG_DIR / keychain).
 */
export const UNFORWARDED_CREDENTIAL_ENV = Object.freeze({
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
} as const)

/** The environment every vendor CLI process gets: the allowlist only. Sign-in status checks use exactly this too. */
export function vendorProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === "string" && !value.includes("\0")) env[key] = value
  }
  return env
}
const POSIX_PLATFORMS = new Set(["aix", "darwin", "dragonfly", "freebsd", "linux", "netbsd", "openbsd", "sunos"])
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_STDIN_BYTES = 1024 * 1024
const MAX_ARGUMENT_COUNT = 256
const MAX_ARGUMENT_BYTES = 128 * 1024
const MAX_SINGLE_ARGUMENT_BYTES = 8192
const MAX_EXECUTION_MS = 24 * 60 * 60 * 1000
const MAX_TERM_TO_KILL_MS = 30_000
const CAPTURE_BLOCK_BYTES = 16 * 1024
const POST_LEADER_GRACE_MS = 1000
// Deadline cleanup may observe SIGKILL exit through D+termToKillMs+250 ms, plus timer lateness.
const POST_KILL_GRACE_MS = 250
const GROUP_PROBE_INTERVAL_MS = 25

export type VendorProcessOptions = {
  executable: string
  argv: readonly string[]
  cwd: string
  stdin?: string | Uint8Array
  /** Absolute Unix-epoch deadline in milliseconds. */
  deadlineAt: number
  /** Combined stdout+stderr capture cap in bytes. */
  maxCombinedOutputBytes: number
  /** Maximum delay between an accepted SIGTERM and SIGKILL, in milliseconds. */
  termToKillMs: number
  /**
   * Called synchronously with each accepted stdout byte chunk, before the run result is published.
   * Persist the owned copy synchronously; returned thenables are unsupported and are not awaited.
   * A throw or any non-undefined return fails the run and starts bounded owned-handle termination.
   */
  onStdoutChunk?: (chunk: Uint8Array) => undefined
}

export type VendorProcessOutput = {
  text: string
  capturedBytes: number
  truncated: boolean
  complete: boolean
}

export type VendorProcessResult = {
  /** A completed leader with full capture and observed owned-group quiescence, not vendor/native safety evidence. */
  status: "completed" | "failed" | "cancelled" | "timed-out" | "incomplete" | "unresolved"
  launched: boolean
  code: number | null
  signal: NodeJS.Signals | null
  stdout: VendorProcessOutput
  stderr: VendorProcessOutput
  captureComplete: boolean
  timedOut: boolean
  cancellationRequested: boolean
  cancellationAcknowledged: boolean
  /** Observed process-group absence only; this does not prove escaped descendants are stopped. */
  quiescent: boolean
  evidence: string
}

export type VendorProcessHandle = {
  run(): Promise<VendorProcessResult>
  requestCancel(reason: string, deadlineAt: number): Promise<ExecutionCancelResult>
  reconcile(): Promise<ExecutionReconciliation>
}

type CaptureState = {
  chunks: Buffer[]
  blockUsed: number
  capturedBytes: number
  truncated: boolean
  complete: boolean
  ended: boolean
  forcedClosed: boolean
}

type ProbeState = "present" | "unknown" | "absent"

function invalidOptions(): TypeError {
  return new TypeError("invalid local process options")
}

function validateOptions(options: VendorProcessOptions): {
  executable: string
  argv: string[]
  cwd: string
  stdin: Buffer
  deadlineAt: number
  maxCombinedOutputBytes: number
  termToKillMs: number
  onStdoutChunk?: (chunk: Uint8Array) => undefined
  env: NodeJS.ProcessEnv
} {
  if (!options || typeof options !== "object") throw invalidOptions()
  const { executable, argv, cwd, deadlineAt, maxCombinedOutputBytes, termToKillMs, onStdoutChunk } = options
  if (typeof executable !== "string" || executable.length === 0 || executable.includes("\0") || Buffer.byteLength(executable) > MAX_SINGLE_ARGUMENT_BYTES) throw invalidOptions()
  if (onStdoutChunk !== undefined && typeof onStdoutChunk !== "function") throw invalidOptions()
  if (!Array.isArray(argv) || argv.length > MAX_ARGUMENT_COUNT) throw invalidOptions()
  let argumentBytes = 0
  const copiedArgv: string[] = []
  for (const argument of argv) {
    if (typeof argument !== "string" || argument.includes("\0")) throw invalidOptions()
    const bytes = Buffer.byteLength(argument)
    if (bytes > MAX_SINGLE_ARGUMENT_BYTES || argumentBytes + bytes > MAX_ARGUMENT_BYTES) throw invalidOptions()
    argumentBytes += bytes
    copiedArgv.push(argument)
  }
  if (typeof cwd !== "string" || cwd.includes("\0") || !isAbsolute(cwd) || Buffer.byteLength(cwd) > MAX_SINGLE_ARGUMENT_BYTES) throw invalidOptions()
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || deadlineAt - Date.now() > MAX_EXECUTION_MS) throw invalidOptions()
  if (!Number.isSafeInteger(maxCombinedOutputBytes) || maxCombinedOutputBytes < 0 || maxCombinedOutputBytes > MAX_OUTPUT_BYTES) throw invalidOptions()
  if (!Number.isSafeInteger(termToKillMs) || termToKillMs < 1 || termToKillMs > MAX_TERM_TO_KILL_MS) throw invalidOptions()

  let stdin: Buffer
  if (options.stdin === undefined) stdin = Buffer.alloc(0)
  else if (typeof options.stdin === "string") {
    if (Buffer.byteLength(options.stdin, "utf8") > MAX_STDIN_BYTES) throw invalidOptions()
    stdin = Buffer.from(options.stdin, "utf8")
  } else if (options.stdin instanceof Uint8Array) {
    if (options.stdin.byteLength > MAX_STDIN_BYTES) throw invalidOptions()
    stdin = Buffer.from(options.stdin)
  } else throw invalidOptions()

  const env = vendorProcessEnvironment()
  if (!isAbsolute(executable) && !env.PATH) throw invalidOptions()

  return { executable, argv: copiedArgv, cwd, stdin, deadlineAt, maxCombinedOutputBytes, termToKillMs, onStdoutChunk, env }
}

function fixedErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" ? code : undefined
}

function outputResult(state: CaptureState): VendorProcessOutput {
  return {
    text: Buffer.concat(state.chunks, state.capturedBytes).toString("utf8"),
    capturedBytes: state.capturedBytes,
    truncated: state.truncated,
    complete: state.complete,
  }
}

/** Creates an inert, current-process-owned POSIX subprocess handle. It never reads vendor credentials. */
export function createVendorProcess(options: VendorProcessOptions): VendorProcessHandle {
  if (!POSIX_PLATFORMS.has(process.platform)) throw new Error("local process groups require a supported POSIX platform")
  const config = validateOptions(options)
  const stdoutCapture: CaptureState = { chunks: [], blockUsed: 0, capturedBytes: 0, truncated: false, complete: false, ended: false, forcedClosed: false }
  const stderrCapture: CaptureState = { chunks: [], blockUsed: 0, capturedBytes: 0, truncated: false, complete: false, ended: false, forcedClosed: false }
  let capturedCombinedBytes = 0
  let runCalled = false
  let launchAttempted = false
  let launchPending = false
  let launched = false
  let spawnFailed = false
  let stdoutObserverFailed = false
  let leaderLive = false
  let leaderExited = false
  let code: number | null = null
  let signal: NodeJS.Signals | null = null
  let timedOut = false
  let cancellationRequested = false
  let cancellationAcknowledged = false
  let cancellationBeforeStart = false
  let terminationStarted = false
  let termSignalAccepted = false
  let killSignalAttempted = false
  let terminationCause: "cancel" | "deadline" | "stdout-observer" | undefined
  let groupID: number | undefined
  // ESRCH permanently revokes identifier use; observed absence is not quiescence until leader exit.
  let groupSignalAuthority = false
  let groupAbsentObserved = false
  let lastProbe: ProbeState = "unknown"
  let groupEvidence = "process-group state has not been observed"
  let lastSignalEvidence = "no termination signal has been sent"
  let leaderExitedAt: number | undefined
  let postKillGraceUntil: number | undefined
  let finalizerCutoffAt: number | undefined
  let resolveRun: ((result: VendorProcessResult) => void) | undefined
  let publishedResult: VendorProcessResult | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let escalationTimer: ReturnType<typeof setTimeout> | undefined
  let groupProbeTimer: ReturnType<typeof setTimeout> | undefined
  let finalizerTimer: ReturnType<typeof setTimeout> | undefined
  let cancelDeadlineAt: number | undefined

  const isTerminal = (): boolean => !launchAttempted || cancellationBeforeStart || spawnFailed || leaderExited || (!launched && !launchPending)

  const isQuiescent = (): boolean =>
    !launchAttempted || cancellationBeforeStart || spawnFailed || (!launched && !launchPending) || (isTerminal() && groupAbsentObserved)

  const evidence = (): string => {
    if (cancellationBeforeStart) return "cancelled before process launch"
    if (spawnFailed) return "local process could not be started"
    if (!launchAttempted) return "process has not been started"
    if (!launched && !launchPending) return timedOut ? "deadline elapsed before process launch" : "process did not launch"
    if (!leaderExited) {
      if (groupAbsentObserved) return "process group absence observed; leader terminal state is unobserved"
      return timedOut ? "execution deadline elapsed; process terminal state is unobserved" : "owned process leader is running"
    }
    if (groupAbsentObserved) return "leader exited and process group is absent"
    if (lastProbe === "present") return "leader exited; process group remains observed"
    if (lastProbe === "absent") return "leader exited; process group is absent"
    return groupEvidence
  }

  const makeResult = (): VendorProcessResult => {
    const stdout = outputResult(stdoutCapture)
    const stderr = outputResult(stderrCapture)
    const captureComplete = stdout.complete && stderr.complete
    const quiescent = isQuiescent()
    let status: VendorProcessResult["status"]
    if (!isTerminal() || !quiescent) status = "unresolved"
    else if (stdoutObserverFailed) status = "failed"
    else if (timedOut) status = "timed-out"
    else if (cancellationRequested && cancellationAcknowledged) status = "cancelled"
    else if (code !== 0 || signal !== null || spawnFailed) status = "failed"
    else if (!captureComplete) status = "incomplete"
    else status = "completed"
    return {
      status,
      launched,
      code,
      signal,
      stdout,
      stderr,
      captureComplete,
      timedOut,
      cancellationRequested,
      cancellationAcknowledged,
      quiescent,
      evidence: stdoutObserverFailed ? `stdout observer failed; ${evidence()}` : evidence(),
    }
  }

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): undefined => {
    if (timer) clearTimeout(timer)
    return undefined
  }

  const markGroupAbsent = (evidence: string): void => {
    lastProbe = "absent"
    groupAbsentObserved = true
    groupSignalAuthority = false
    groupID = undefined
    groupEvidence = evidence
  }

  const forceCloseCapture = (stream: Readable, state: CaptureState): void => {
    if (state.ended) return
    state.ended = true
    state.forcedClosed = true
    state.truncated = true
    state.complete = false
    stream.destroy()
  }

  const maybeFinish = (): void => {
    if (!resolveRun) return
    if (!publishedResult && spawnFailed) {
      publishedResult = makeResult()
    } else if (!publishedResult && leaderExited && isQuiescent() && stdoutCapture.ended && stderrCapture.ended) {
      publishedResult = makeResult()
    }
    if (!publishedResult) return
    deadlineTimer = clearTimer(deadlineTimer)
    escalationTimer = clearTimer(escalationTimer)
    groupProbeTimer = clearTimer(groupProbeTimer)
    finalizerTimer = clearTimer(finalizerTimer)
    finalizerCutoffAt = undefined
    const finish = resolveRun
    resolveRun = undefined
    finish(publishedResult)
  }

  const observeGroup = (): ProbeState => {
    if (groupAbsentObserved) return "absent"
    if (groupID === undefined) return lastProbe
    try {
      process.kill(-groupID, 0)
      lastProbe = "present"
      groupEvidence = "leader exited; process group remains observed"
    } catch (error) {
      const errorCode = fixedErrorCode(error)
      if (errorCode === "ESRCH") {
        markGroupAbsent("process group absent by ESRCH observation")
      } else {
        lastProbe = "unknown"
        groupEvidence = errorCode === "EPERM"
          ? "process-group probe was denied; quiescence is unknown"
          : "process-group probe failed; quiescence is unknown"
      }
    }
    return lastProbe
  }

  const scheduleGroupProbe = (): void => {
    if (groupProbeTimer || groupAbsentObserved || !leaderExited || !resolveRun) return
    const exitedAt = leaderExitedAt ?? Date.now()
    const cutoffAt = Math.min(Math.max(config.deadlineAt + config.termToKillMs, postKillGraceUntil ?? 0), exitedAt + POST_LEADER_GRACE_MS)
    if (Date.now() >= cutoffAt) return
    groupProbeTimer = setTimeout(() => {
      groupProbeTimer = undefined
      if (!resolveRun || groupAbsentObserved) return
      observeGroup()
      maybeFinish()
      scheduleGroupProbe()
    }, Math.min(GROUP_PROBE_INTERVAL_MS, Math.max(1, cutoffAt - Date.now())))
  }

  const trySignalGroup = (which: NodeJS.Signals): boolean => {
    if (!leaderLive || leaderExited || !groupSignalAuthority || groupID === undefined) return false
    try {
      process.kill(-groupID, which)
      lastSignalEvidence = which === "SIGTERM" ? "SIGTERM accepted for owned process group" : "SIGKILL accepted for owned process group"
      return true
    } catch (error) {
      const code = fixedErrorCode(error)
      if (code === "ESRCH") {
        markGroupAbsent("process group absent by ESRCH signal result")
        lastSignalEvidence = "termination signal found no process group; ownership revoked"
      } else {
        lastSignalEvidence = code === "EPERM"
          ? "termination signal was denied; process state remains unresolved"
          : "termination signal failed; process state remains unresolved"
      }
      return false
    }
  }

  const finalizeUnresolved = (): void => {
    if (!resolveRun || publishedResult) return
    if (leaderExited) observeGroup()
    if (!stdoutCapture.ended) forceCloseCapture(child!.stdout, stdoutCapture)
    if (!stderrCapture.ended) forceCloseCapture(child!.stderr, stderrCapture)
    child?.stdin.destroy()
    if (child && !leaderExited) child.unref()
    publishedResult = makeResult()
    maybeFinish()
  }

  const scheduleFinalizer = (cutoffAt: number): void => {
    finalizerTimer = clearTimer(finalizerTimer)
    const scheduledCutoffAt = Math.max(cutoffAt, postKillGraceUntil ?? 0)
    finalizerCutoffAt = scheduledCutoffAt
    const delay = Math.max(0, scheduledCutoffAt - Date.now())
    finalizerTimer = setTimeout(() => {
      finalizerTimer = undefined
      finalizerCutoffAt = undefined
      if (leaderLive && terminationStarted && groupSignalAuthority && groupID !== undefined && !killSignalAttempted) {
        killSignalAttempted = true
        trySignalGroup("SIGKILL")
        postKillGraceUntil = Date.now() + POST_KILL_GRACE_MS
        scheduleFinalizer(postKillGraceUntil)
        return
      }
      finalizeUnresolved()
    }, delay)
  }

  const scheduleFinalizerAtLeast = (cutoffAt: number): void => {
    if (finalizerTimer && finalizerCutoffAt !== undefined && finalizerCutoffAt >= cutoffAt) return
    scheduleFinalizer(cutoffAt)
  }

  const schedulePostLeaderFinalizer = (): void => {
    if (!leaderExited || !resolveRun) return
    const cutoffAt = Math.min(Math.max(config.deadlineAt + config.termToKillMs, postKillGraceUntil ?? 0), (leaderExitedAt ?? Date.now()) + POST_LEADER_GRACE_MS)
    scheduleFinalizer(cutoffAt)
    scheduleGroupProbe()
  }

  const observerCleanupCutoff = (startedAt: number): number =>
    Math.min(startedAt + config.termToKillMs, config.deadlineAt + config.termToKillMs)

  const beginTermination = (cause: "cancel" | "deadline" | "stdout-observer"): void => {
    if (terminationStarted || !leaderLive) return
    terminationStarted = true
    terminationCause = cause
    termSignalAccepted = trySignalGroup("SIGTERM")
    if (cause === "cancel") cancellationAcknowledged = termSignalAccepted
    const now = Date.now()
    if (groupID === undefined) {
      if (cause === "stdout-observer") scheduleFinalizer(observerCleanupCutoff(now))
      return
    }
    let escalationAt = now + config.termToKillMs
    if (cause === "cancel" && cancelDeadlineAt !== undefined) escalationAt = Math.min(escalationAt, cancelDeadlineAt)
    else if (cause === "stdout-observer") escalationAt = observerCleanupCutoff(now)
    escalationTimer = setTimeout(() => {
      escalationTimer = undefined
      if (!leaderLive || leaderExited || killSignalAttempted) return
      killSignalAttempted = true
      if (trySignalGroup("SIGKILL") && terminationCause === "cancel") cancellationAcknowledged = true
      // All termination causes get the same bounded observation grace after SIGKILL.
      postKillGraceUntil = Date.now() + POST_KILL_GRACE_MS
      scheduleFinalizerAtLeast(postKillGraceUntil)
    }, Math.max(0, escalationAt - now))
  }

  const onDeadline = (): void => {
    deadlineTimer = undefined
    timedOut = true
    if (leaderLive) beginTermination("deadline")
    if (leaderExited) schedulePostLeaderFinalizer()
    else scheduleFinalizer(config.deadlineAt + config.termToKillMs)
  }

  const failStdoutObserver = (): void => {
    if (stdoutObserverFailed) return
    stdoutObserverFailed = true
    if (leaderLive) beginTermination("stdout-observer")
    else if (leaderExited) schedulePostLeaderFinalizer()
    else if (launched) scheduleFinalizer(observerCleanupCutoff(Date.now()))
  }

  const attachCapture = (stream: Readable, state: CaptureState, onChunk?: (chunk: Uint8Array) => undefined): void => {
    stream.on("data", (chunk: Buffer | string) => {
      if (state.forcedClosed) return
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      const available = Math.max(0, config.maxCombinedOutputBytes - capturedCombinedBytes)
      const accepted = Math.min(available, bytes.byteLength)
      if (accepted > 0) {
        let sourceOffset = 0
        while (sourceOffset < accepted) {
          let block = state.chunks[state.chunks.length - 1]
          if (!block || state.blockUsed === block.length) {
            const capacity = Math.min(CAPTURE_BLOCK_BYTES, config.maxCombinedOutputBytes - capturedCombinedBytes)
            block = Buffer.allocUnsafe(capacity)
            state.chunks.push(block)
            state.blockUsed = 0
          }
          const copied = Math.min(accepted - sourceOffset, block.length - state.blockUsed)
          bytes.copy(block, state.blockUsed, sourceOffset, sourceOffset + copied)
          state.blockUsed += copied
          state.capturedBytes += copied
          capturedCombinedBytes += copied
          sourceOffset += copied
        }
        if (onChunk && !stdoutObserverFailed) {
          try {
            const observerResult: unknown = onChunk(Buffer.from(bytes.subarray(0, accepted)))
            if (observerResult !== undefined) {
              void Promise.resolve(observerResult).catch(() => {})
              failStdoutObserver()
            }
          } catch {
            failStdoutObserver()
          }
        }
      }
      if (accepted < bytes.byteLength) {
        state.truncated = true
        state.complete = false
      }
    })
    stream.once("end", () => {
      state.ended = true
      state.complete = !state.truncated && !state.forcedClosed
      maybeFinish()
    })
    stream.once("close", () => {
      if (state.ended) return
      state.ended = true
      state.truncated = true
      state.complete = false
      maybeFinish()
    })
    stream.once("error", () => {
      if (state.ended) return
      state.ended = true
      state.truncated = true
      state.complete = false
      stream.destroy()
      maybeFinish()
    })
  }

  const onLeaderExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
    if (leaderExited) return
    leaderExited = true
    leaderLive = false
    groupSignalAuthority = false
    launchPending = false
    code = exitCode
    signal = exitSignal
    leaderExitedAt = Date.now()
    escalationTimer = clearTimer(escalationTimer)
    if (groupID !== undefined) observeGroup()
    schedulePostLeaderFinalizer()
    maybeFinish()
  }

  const handle: VendorProcessHandle = {
    run(): Promise<VendorProcessResult> {
      if (runCalled) return Promise.reject(new TypeError("local process handle is one-shot"))
      runCalled = true
      launchAttempted = true
      if (cancellationBeforeStart) {
        stdoutCapture.complete = true
        stderrCapture.complete = true
        publishedResult = makeResult()
        return Promise.resolve(publishedResult)
      }
      if (Date.now() >= config.deadlineAt) {
        timedOut = true
        stdoutCapture.complete = true
        stderrCapture.complete = true
        publishedResult = makeResult()
        return Promise.resolve(publishedResult)
      }

      const pendingRun = new Promise<VendorProcessResult>((resolve) => { resolveRun = resolve })
      launchPending = true
      try {
        child = spawn(config.executable, config.argv, {
          cwd: config.cwd,
          env: config.env,
          detached: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams
      } catch {
        launchPending = false
        spawnFailed = true
        stdoutCapture.complete = true
        stderrCapture.complete = true
        maybeFinish()
        return pendingRun
      }

      child.on("error", () => {
        if (launched) return
        launchPending = false
        spawnFailed = true
        stdoutCapture.complete = true
        stderrCapture.complete = true
        if (!stdoutCapture.ended) { stdoutCapture.ended = true; child!.stdout.destroy() }
        if (!stderrCapture.ended) { stderrCapture.ended = true; child!.stderr.destroy() }
        child!.stdin.destroy()
        maybeFinish()
      })
      child.once("spawn", () => {
        launchPending = false
        launched = true
        const pid = child!.pid
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
          groupEvidence = "spawn identity unavailable; process state is unresolved"
          scheduleFinalizer(config.deadlineAt + config.termToKillMs)
          return
        }
        groupID = pid
        groupSignalAuthority = true
        leaderLive = true
        if (stdoutObserverFailed) beginTermination("stdout-observer")
        else if (timedOut) beginTermination("deadline")
        else if (cancellationRequested) beginTermination("cancel")
      })
      child.once("exit", onLeaderExit)
      attachCapture(child.stdout, stdoutCapture, config.onStdoutChunk)
      attachCapture(child.stderr, stderrCapture)
      child.stdin.on("error", () => { /* A child may close stdin before consuming the bounded input. */ })
      try {
        child.stdin.end(config.stdin)
      } catch {
        child.stdin.destroy()
      }
      deadlineTimer = setTimeout(onDeadline, Math.max(0, config.deadlineAt - Date.now()))
      return pendingRun
    },

    async requestCancel(reason: string, deadlineAt: number): Promise<ExecutionCancelResult> {
      if (typeof reason !== "string" || reason.length > 512 || !Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || deadlineAt - Date.now() > MAX_EXECUTION_MS) {
        throw new TypeError("invalid local process cancellation request")
      }
      if (deadlineAt <= Date.now()) {
        return { requested: false, acknowledged: false, terminal: isTerminal(), quiescent: isQuiescent(), evidence: "cancellation deadline elapsed before request" }
      }
      if (!runCalled) {
        cancellationBeforeStart = true
        cancellationRequested = true
        cancellationAcknowledged = true
        stdoutCapture.complete = true
        stderrCapture.complete = true
        return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "cancellation prevented process launch" }
      }
      if (leaderExited) {
        observeGroup()
        return { requested: false, acknowledged: false, terminal: isTerminal(), quiescent: isQuiescent(), evidence: evidence() }
      }
      if (spawnFailed) return { requested: false, acknowledged: false, terminal: isTerminal(), quiescent: isQuiescent(), evidence: "local process could not be started" }
      if (publishedResult) return { requested: false, acknowledged: false, terminal: isTerminal(), quiescent: isQuiescent(), evidence: publishedResult.evidence }
      cancellationRequested = true
      cancelDeadlineAt = deadlineAt
      if (leaderLive) beginTermination("cancel")
      return {
        requested: true,
        acknowledged: cancellationAcknowledged,
        terminal: isTerminal(),
        quiescent: isQuiescent(),
        evidence: cancellationAcknowledged ? lastSignalEvidence : launchPending ? "cancellation queued for process startup" : lastSignalEvidence,
      }
    },

    async reconcile(): Promise<ExecutionReconciliation> {
      if (cancellationBeforeStart) return { outcome: "terminal", quiescent: true, evidence: "cancellation prevented process launch" }
      if (!launchAttempted) return { outcome: "terminal", quiescent: true, evidence: "process has not been started" }
      if (spawnFailed) return { outcome: "terminal", quiescent: true, evidence: "local process could not be started" }
      if (!launched && !launchPending) return { outcome: "terminal", quiescent: true, evidence: timedOut ? "deadline elapsed before process launch" : "process did not launch" }
      if (!leaderExited) return { outcome: "running", quiescent: isQuiescent(), evidence: evidence() }
      if (isQuiescent()) return { outcome: "terminal", quiescent: true, evidence: "leader exited and process group is absent" }
      const state = observeGroup()
      return state === "absent"
        ? { outcome: "terminal", quiescent: true, evidence: "leader exited and process group is absent" }
        : { outcome: "unknown", quiescent: false, evidence: groupEvidence }
    },
  }

  return handle
}
