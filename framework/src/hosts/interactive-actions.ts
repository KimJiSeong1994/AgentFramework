/** `observer`: chat is held only because another session owns the active workflow; held actions plus /model and SkillOpt commands. */
export type InteractiveContext = "chat" | "busy" | "held" | "observer" | "read-only" | "selection" | "choice" | "unselected"

export type InteractiveAction = Readonly<{
  id: string
  syntax: string
  summary: string
  contexts: readonly InteractiveContext[]
  local?: boolean
}>

const all: readonly InteractiveAction[] = [
  { id: "help", syntax: "/help", summary: "show contextual commands and keys", contexts: ["chat", "busy", "held", "read-only", "selection", "unselected"] },
  { id: "model", syntax: "/model [engine native-id | default ... | combo ...]", summary: "pick a model; /model default sets the startup default; /model combo offers recommended combos and custom role settings", contexts: ["chat", "selection", "unselected"] },
  { id: "memory", syntax: "/memory [show | test | auto | claude [model] | codex [model] | local <model> | jev | off]", summary: "show, measure (test) or pick the engine that links requests to wiki memory; applies to the next memory call", contexts: ["chat", "held", "read-only", "unselected"] },
  { id: "local", syntax: "/local [status | profile memory|balanced|speed|default | keepalive <duration> | unload [model]]", summary: "inspect Ollama memory and choose model/cache retention; unload releases a model when chat is idle", contexts: ["chat", "held", "unselected"] },
  { id: "context", syntax: "/context [status | optimize [speed|balanced|long|default] | budget <tokens>|default | pin <text> | unpin | compact [pairs]]", summary: "manage local conversation context: optimize input budget and trimming, pin notes; keeps the full transcript", contexts: ["chat", "held", "unselected"] },
  { id: "auth", syntax: "/login [codex|claude]", summary: "sign in to an engine with its own CLI (/auth shows status, /logout signs out); otter stores no credentials", contexts: ["chat", "held", "unselected"] },
  { id: "sessions", syntax: "/sessions", summary: "inspect or choose retained sessions", contexts: ["chat", "held", "read-only", "selection", "unselected"] },
  { id: "resume", syntax: "/resume [sid]", summary: "open a retained session through existing checks", contexts: ["chat", "held", "read-only", "selection", "unselected"] },
  { id: "new", syntax: "/new", summary: "start a new conversation after release checks", contexts: ["chat", "held", "read-only"] },
  { id: "status", syntax: "/status", summary: "show checked workflow and execution state", contexts: ["chat", "busy", "held", "read-only"] },
  { id: "skillopt", syntax: "/skillopt [status | prepare <input-path> | consent|arm|disarm|cancel|resume|run <run-id> [input-path] | apply|rollback|cleanup <run-id>]", summary: "inspect or manage a native SkillOpt run; cleanup requires explicit retirement approval", contexts: ["chat", "held", "observer"] },
  { id: "continue", syntax: "/continue", summary: "request proof-checked work Resume", contexts: ["held"] },
  { id: "pause", syntax: "/pause", summary: "request pause; it is not proof of stopped work", contexts: ["chat", "busy", "held"] },
  { id: "cancel", syntax: "/cancel", summary: "request cancellation; proof may remain unconfirmed", contexts: ["chat", "busy", "held"] },
  { id: "engines", syntax: "/engines [update [codex|claude]]", summary: "codex/claude CLI versions and install method; update runs the fitting command after you confirm it", contexts: ["chat", "held", "read-only", "unselected"] },
  { id: "history", syntax: "/history [<count> | <session-id>]", summary: "recent sessions of this worktree: model, turns, files, commands and their results", contexts: ["chat", "held", "read-only", "observer"] },
  { id: "facts", syntax: "/facts", summary: "what earlier sessions showed: commands that pass, commands that keep failing, files that keep changing", contexts: ["chat", "held", "read-only", "observer"] },
  { id: "wiki", syntax: "/wiki [ingest | lint]", summary: "wiki sources waiting for integration; ingest asks otter to integrate them (each edit approved), lint checks the wiki", contexts: ["chat", "held"] },
  { id: "undo", syntax: "/undo [list | <turn>]", summary: "put back the files otter changed in the last turn (or a listed one); later changes are kept", contexts: ["chat", "held"] },
  { id: "permissions", syntax: "/permissions [clear]", summary: "show the chat execution mode and your saved \"Always allow\" command rules; clear removes them", contexts: ["chat", "held", "read-only"] },
  { id: "skills", syntax: "/skills [grants|revoke <name>|auto [on|off]]", summary: "inspect skills, consent grants and automatic selection", contexts: ["chat", "held", "read-only"] },
  { id: "skill", syntax: "/skill:<name> [request]", summary: "invoke a discovered skill explicitly", contexts: ["chat"] },
  { id: "search", syntax: "/search <tool/status/task>", summary: "filter this session transcript", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "copy", syntax: "/copy", summary: "copy the latest assistant answer in this transcript page (Ctrl+Y in TUI)", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "expand", syntax: "/expand <item number>", summary: "toggle evidence for a tool item or full output for $<shell number>", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "details", syntax: "/details", summary: "toggle the local task/evidence panel", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "theme", syntax: "/theme <neutral|light|dark>", summary: "set the process-local palette", contexts: ["chat", "busy", "held", "read-only", "unselected"], local: true },
  { id: "ascii", syntax: "/ascii", summary: "toggle ASCII chrome for this process", contexts: ["chat", "busy", "held", "read-only", "unselected"], local: true },
  { id: "finish", syntax: "/finish", summary: "finish an active interview prompt", contexts: ["chat"] },
  { id: "plan", syntax: "/plan", summary: "send a planning prompt; it grants no execution authority", contexts: ["chat"] },
  { id: "shell", syntax: "!<command>", summary: "run one shell command in the worktree with your terminal (vim, ssh, sudo work); never sent to the model", contexts: ["chat", "held", "unselected"] },
  { id: "quit", syntax: "/quit", summary: "request exit", contexts: ["chat", "busy", "held", "read-only", "selection", "unselected"] },
]

export function interactiveActions(context?: InteractiveContext): readonly InteractiveAction[] {
  if (context === "observer") return all.filter(action => action.contexts.includes("observer") || action.contexts.includes("held") || action.id === "model")
  return context ? all.filter(action => action.contexts.includes(context)) : all
}

export type SkillOptCommand =
  | Readonly<{ operation: "status" }>
  | Readonly<{ operation: "prepare"; inputPath?: string }>
  | Readonly<{ operation: "consent" | "arm" | "disarm" | "cancel" | "resume" | "run"; runId: string; inputPath?: string }>
  | Readonly<{ operation: "apply" | "rollback"; runId: string }>
  | Readonly<{ operation: "cleanup"; runId: string }>
  | Readonly<{ operation: "invalid"; reason: "usage" | "operation" }>

const SKILLOPT_REENTRY_OPERATIONS = new Set(["consent", "arm", "disarm", "cancel", "resume", "run"])

/** Parse only the slash-command boundary; paths are the literal remainder, never shell-tokenized or expanded. */
export function parseSkillOptCommand(line: string): SkillOptCommand | undefined {
  if (typeof line !== "string") return undefined
  const match = /^\/skillopt(?:\s+([\s\S]*))?$/u.exec(line.trim())
  if (!match) return undefined
  const rest = match[1]?.trim() ?? ""
  if (!rest || rest === "status") return Object.freeze({ operation: "status" })
  const token = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(rest)
  if (!token) return Object.freeze({ operation: "invalid", reason: "usage" })
  const operation = token[1]!
  const tail = token[2]?.trim()
  if (operation === "prepare") return Object.freeze({ operation, ...(tail ? { inputPath: tail } : {}) })
  if (operation === "status") return Object.freeze({ operation: "invalid", reason: "usage" })
  if (operation === "apply" || operation === "rollback" || operation === "cleanup") {
    if (!tail || /\s/u.test(tail)) return Object.freeze({ operation: "invalid", reason: "usage" })
    return Object.freeze({ operation, runId: tail })
  }
  if (!SKILLOPT_REENTRY_OPERATIONS.has(operation)) return Object.freeze({ operation: "invalid", reason: "operation" })
  if (!tail) return Object.freeze({ operation: "invalid", reason: "usage" })
  const run = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(tail)
  if (!run) return Object.freeze({ operation: "invalid", reason: "usage" })
  return Object.freeze({ operation: operation as "consent" | "arm" | "disarm" | "cancel" | "resume" | "run", runId: run[1]!,
    ...(run[2]?.trim() ? { inputPath: run[2]!.trim() } : {}) })
}

export function commandInsertion(action: InteractiveAction): string | undefined {
  const insertion = action.syntax.split(/[ <[]/u)[0]!
  return insertion && !insertion.endsWith(":") ? insertion : undefined
}

export function commandInsertions(prefix: string, context: InteractiveContext = "chat"): string[] {
  if (!/^\/[a-z-]*$/u.test(prefix)) return []
  const seen = new Set<string>()
  return interactiveActions(context).flatMap(action => {
    const command = commandInsertion(action)
    if (!command) return []
    if (seen.has(command) || command === prefix || !command.startsWith(prefix)) return []
    seen.add(command)
    return [command]
  })
}

export function interactiveHelp(context: InteractiveContext = "chat"): string {
  const actions = interactiveActions(context).map(action => `${action.syntax} — ${action.summary}${action.local ? " (local)" : ""}`)
  return [`Commands (${context}):`, ...actions,
    "SkillOpt input paths are literal remainders of the line (spaces are allowed; no shell expansion). Reentry inputs default to the run's saved input. In the TUI, `/skillopt run` waits for separate `/skillopt apply`; `/skillopt rollback` is available only in the same live owner session after that session's publication. `/skillopt cleanup` requires explicit approval in the current TUI owner session. CLI cleanup is `bun scripts/otter-skillopt.ts cleanup --run <run-id>` and requires fresh approval under its newly attached owner, not run reentry. CLI `run` also requires real publication approval; standalone CLI apply/rollback is not available.",
    "SkillOpt source, fixture, model-response, and candidate text are not added to chat or saved session history; summaries expose allowlisted metadata only.",
    "Keys: Enter send/select · Ctrl+R history · PageUp/PageDown transcript or active document · Escape interrupts running work or dismisses (/cancel stops a workflow) · Ctrl+C clear then shutdown on second press · Ctrl+D quit · Ctrl+Z proof-guarded suspend.",
  ].join("\n") + "\n"
}
