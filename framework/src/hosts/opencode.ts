import type { PluginInput } from "@opencode-ai/plugin"
import type {
  ExecutionHandle,
  ExecutionHost,
  ExecutionOutcome,
  ExecutionPolicy,
  ExecutionReference,
  ExecutionRequest,
} from "./types.ts"

type Client = PluginInput["client"]
export type OpenCodeHostCapabilities = {
  /** Bound to the plugin hooks by the owning runtime, not synthesized by this adapter. */
  policy: Pick<ExecutionPolicy, "bindSession" | "unbindSession" | "handlersForSession" | "snapshotForSession">
  /** Apply controls in the plugin hook pipeline for this session; false means unenforceable. */
  applyOutputLimit(sessionID: string, maximum: number): boolean
  applyThinking(sessionID: string, mode: "inherit" | "enabled" | "disabled"): boolean
  /** Durable plugin-process evidence that a shell command may have surviving descendants. */
  processRisk(sessionID: string): boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createOpenCodeHost(client: Client, capabilities?: OpenCodeHostCapabilities): ExecutionHost {
  const policyBound = !!capabilities?.policy
  const controlsAvailable = !!capabilities?.applyOutputLimit && !!capabilities?.applyThinking && !!capabilities?.processRisk
  return {
    identity: { engine: "opencode", candidateVersion: "1.18.32", profile: "opencode-plugin" },

    async preflight(profile) {
      const compatible = policyBound && controlsAvailable
      return {
        compatible,
        controls: {
          session: "supported",
          model: "supported",
          system: "supported",
          tools: policyBound ? "supported" : "unsupported",
          outputLimit: controlsAvailable ? "supported" : "unsupported",
          thinking: controlsAvailable ? "supported" : "unsupported",
          toolPolicyHandlers: policyBound ? "supported" : "unsupported",
          assistantTextHandler: policyBound ? "supported" : "unsupported",
        },
        problems: compatible ? [] : [`OpenCode plugin does not provide all required execution controls for profile ${profile}`],
      }
    },

    async reconcile(reference) {
      if (!reference.vendorSessionID) {
        return { outcome: "unknown", quiescent: false, evidence: "persisted reference has no OpenCode session ID" }
      }
      try {
        const status = await client.session.status()
        if (status.error || !status.data) {
          return { outcome: "unknown", quiescent: false, evidence: status.error ? errorMessage(status.error) : "OpenCode returned no session status" }
        }
        if (status.data[reference.vendorSessionID]?.type === "busy") {
          return { outcome: "running", quiescent: false, evidence: "OpenCode reports session busy" }
        }
        return { outcome: "unknown", quiescent: false, evidence: "session is idle or absent; terminal completion and quiescence are unproven" }
      } catch (error) {
        return { outcome: "unknown", quiescent: false, evidence: errorMessage(error) }
      }
    },

    async prepare(request: ExecutionRequest): Promise<ExecutionHandle> {
      if (!capabilities || !policyBound || !controlsAvailable) {
        throw new Error("OpenCode execution controls are unavailable; refusing to create a child session")
      }
      const created = await client.session.create({
        body: { title: request.title, parentID: request.supervisorSessionID },
        query: { directory: request.cwd },
      })
      if (created.error || !created.data?.id) {
        throw new Error(`OpenCode session creation failed: ${errorMessage(created.error ?? "empty session response")}`)
      }

      const reference: ExecutionReference = {
        executionID: request.executionID,
        vendorSessionID: created.data.id,
      }
      request.onReference?.(reference)
      capabilities.policy.bindSession(created.data.id, request.handlers, request.policy)
      if (!capabilities.applyOutputLimit(created.data.id, request.policy.maxOutputTokens)
        || !capabilities.applyThinking(created.data.id, request.policy.thinking)) {
        throw new Error("OpenCode plugin hooks could not apply the requested output/thinking controls")
      }
      let outcome: ExecutionOutcome | undefined
      let terminalResponse = false
      let promptStarted = false
      const messageID = `msg_${request.executionID.replace(/[^A-Za-z0-9]/g, "")}`

      return {
        reference,
        async run() {
          if (promptStarted) return { status: "unresolved", error: "OpenCode prompt already dispatched" }
          promptStarted = true
          try {
            const result = await client.session.prompt({
              path: { id: created.data.id },
              query: { directory: request.cwd },
              body: {
                messageID,
                model: request.policy.model,
                agent: request.role,
                system: request.policy.system.join("\n\n"),
                tools: Object.fromEntries([
                  ...new Set([...request.policy.tools.allowed, ...request.policy.tools.denied]),
                ].map((name) => [name, !request.policy.tools.denied.includes(name)])),
                parts: [{ type: "text", text: request.text }],
              },
            })
            if (result.error) {
              outcome = { status: "failed", error: errorMessage(result.error) }
            } else {
              const response = result.data
              const parts: unknown = response?.parts
              const text = Array.isArray(parts)
                ? parts.filter((part): part is { type: "text"; text: string } =>
                  typeof part === "object" && part !== null && "type" in part && part.type === "text"
                  && "text" in part && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n")
                : ""
              const valid = response?.info?.sessionID === created.data.id
                && response.info.role === "assistant"
                && response.info.parentID === messageID
              if (!valid) {
                outcome = { status: "incomplete", error: "OpenCode returned an incomplete or uncorrelated assistant response" }
              } else if (response.info.error) {
                terminalResponse = true
                outcome = {
                  status: response.info.error.name === "MessageAbortedError" ? "cancelled" : "failed",
                  error: errorMessage(response.info.error),
                }
              } else if (text) {
                terminalResponse = true
                outcome = { status: "completed", text }
                outcome.childMessageID = response.info.id
              } else {
                outcome = { status: "incomplete", error: "OpenCode returned no final assistant text" }
              }
            }
          } catch (error) {
            outcome = { status: "failed", error: errorMessage(error) }
          }
          return outcome
        },
        async requestCancel(_reason: string, deadlineAt: number) {
          const remaining = Math.max(0, deadlineAt - Date.now())
          if (!remaining) {
            return { requested: false, acknowledged: false, terminal: false, quiescent: false, evidence: "cancellation deadline elapsed before abort request" }
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const abort = client.session.abort({ path: { id: created.data.id }, query: { directory: request.cwd } })
            const result = await Promise.race([
              abort,
              new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining) }),
            ])
            if (timer) clearTimeout(timer)
            if (result === null) {
              return { requested: true, acknowledged: false, terminal: false, quiescent: false, evidence: "abort request exceeded cancellation deadline" }
            }
            return { requested: true, acknowledged: !result.error && result.data === true, terminal: false, quiescent: false, evidence: result.error ? errorMessage(result.error) : "abort acknowledged; terminal state unproven" }
          } catch (error) {
            return { requested: true, acknowledged: false, terminal: false, quiescent: false, evidence: errorMessage(error) }
          }
        },
        async reconcile() {
          if (terminalResponse) return capabilities.processRisk(created.data.id)
            ? { outcome: "terminal", quiescent: false, evidence: "shell tool executed; descendant process quiescence is unproven" }
            : { outcome: "terminal", quiescent: true, evidence: "correlated final assistant response without shell process risk" }
          try {
            const status = await client.session.status({ query: { directory: request.cwd } })
            if (!status.error && status.data && status.data[created.data.id]?.type === "idle" && promptStarted) return { outcome: "unknown", quiescent: false, evidence: "session idle without a correlated final response" }
            if (!status.error && status.data?.[created.data.id]?.type === "busy") {
              return { outcome: "running", quiescent: false, evidence: "OpenCode reports session busy" }
            }
            return { outcome: "unknown", quiescent: false, evidence: status.error ? errorMessage(status.error) : "no terminal/quiescence proof" }
          } catch (error) {
            return { outcome: "unknown", quiescent: false, evidence: errorMessage(error) }
          }
        },
      }
    },
  }
}
