import { spawnSync } from "node:child_process"
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { SkillOptError } from "./pilot.ts"

export const SUPPORTED_HOST_VERSION = "1.18.33"
export const OBSERVED_OLLAMA_VERSION = "0.34.3"
export const RUNNER_ROUTE_EVIDENCE = Object.freeze([
  "https://github.com/ollama/ollama/blob/v0.34.3/llm/llama_server.go#L360-L505",
  "https://github.com/ollama/ollama/blob/v0.34.3/server/sched.go",
  "https://github.com/ollama/ollama/blob/v0.34.3/envconfig/config.go",
])

export type ExecutableIdentity = {
  launcherSha256: string
  observedVersion: string
  basis: "resolved-launcher-file-and-version-command"
}

export type CapabilityReceipt = {
  schema: "skillopt.capability.v1"
  status: "blocked"
  code: "isolation_unavailable" | "runtime_version_mismatch" | "sandbox_unavailable"
  host: ExecutableIdentity
  modelService: ExecutableIdentity
  sandboxPrimitive: "passed" | "failed"
  actualRoleContainment: "unverified"
  liveSkillWitness: "unverified"
  originalLoadedByteAttestation: false
  backendRequests: 0
  experimentAdmitted: false
  productionApplied: false
  reason: string
  evidence: readonly string[]
}

/** Hash the executable/launcher we actually invoke, without claiming its transitive binary identity. */
function executableDigest(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024) throw new SkillOptError("invalid_executable")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65536)
    let position = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - position), position)
      if (!count) break
      position += count
      if (position > before.size) throw new SkillOptError("executable_changed")
      hash.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd)
    if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new SkillOptError("executable_changed")
    return hash.digest("hex")
  } finally {
    closeSync(fd)
  }
}

function inspectExecutable(name: "opencode" | "ollama"): ExecutableIdentity {
  const located = Bun.which(name)
  if (!located) throw new SkillOptError("runtime_missing")
  const path = realpathSync.native(located)
  const before = executableDigest(path)
  const home = mkdtempSync(join(tmpdir(), "skillopt-version-"))
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), PATH: `${dirname(path)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`, OLLAMA_HOST: "127.0.0.1:11434", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.error || result.status !== 0 || result.signal || result.stderr.trim()) throw new SkillOptError("runtime_version_unverified")
    const text = result.stdout.trim()
    const match = name === "opencode" ? /^(\d+\.\d+\.\d+)$/.exec(text) : /^ollama version is (\d+\.\d+\.\d+)$/.exec(text)
    if (!match || executableDigest(path) !== before) throw new SkillOptError("runtime_version_unverified")
    return { launcherSha256: before, observedVersion: match[1]!, basis: "resolved-launcher-file-and-version-command" }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** A launcher smoke test only; this deliberately does not certify the real role profiles. */
function sandboxPrimitive(): boolean {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(deny default)(allow process-exec)(allow file-read*)", "/usr/bin/true"], {
    timeout: 5000,
    maxBuffer: 8192,
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return !result.error && result.status === 0 && !result.signal
}

export function classifyCapability(host: ExecutableIdentity, modelService: ExecutableIdentity, primitivePassed: boolean): CapabilityReceipt {
  const common = {
    schema: "skillopt.capability.v1" as const,
    status: "blocked" as const,
    host,
    modelService,
    sandboxPrimitive: primitivePassed ? "passed" as const : "failed" as const,
    actualRoleContainment: "unverified" as const,
    liveSkillWitness: "unverified" as const,
    originalLoadedByteAttestation: false as const,
    backendRequests: 0 as const,
    experimentAdmitted: false as const,
    productionApplied: false as const,
  }
  if (!primitivePassed) return { ...common, code: "sandbox_unavailable", reason: "The required launcher primitive is unavailable; no alternative launcher is admitted.", evidence: [] }
  if (host.observedVersion !== SUPPORTED_HOST_VERSION || modelService.observedVersion !== OBSERVED_OLLAMA_VERSION) {
    return { ...common, code: "runtime_version_mismatch", reason: "The installed runtime differs from the reviewed version; no upgrade or inferred compatibility is admitted.", evidence: [] }
  }
  return {
    ...common,
    code: "isolation_unavailable",
    reason: "Ollama 0.34.3 selects and releases an ephemeral internal runner port before spawning its child. No supported fixed/reserved runner route was verified. A fixed outer OLLAMA_HOST does not satisfy the approved internal-route boundary; broad loopback, a host patch and a different renderer are not admitted alternatives.",
    evidence: RUNNER_ROUTE_EVIDENCE,
  }
}

/** No model invocation, service start, shared-service takeover, source change or admission occurs here. */
export function inspectPilotCapability(): CapabilityReceipt {
  return classifyCapability(inspectExecutable("opencode"), inspectExecutable("ollama"), sandboxPrimitive())
}
