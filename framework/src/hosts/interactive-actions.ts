export type InteractiveContext = "chat" | "busy" | "held" | "read-only" | "selection" | "choice" | "unselected"

export type InteractiveAction = Readonly<{
  id: string
  syntax: string
  summary: string
  contexts: readonly InteractiveContext[]
  local?: boolean
}>

const all: readonly InteractiveAction[] = [
  { id: "help", syntax: "/help", summary: "show contextual commands and keys", contexts: ["chat", "busy", "held", "read-only", "selection", "unselected"] },
  { id: "model", syntax: "/model [engine native-id | default ...]", summary: "pick a model; /model default shows, saves or clears the startup default", contexts: ["chat", "selection", "unselected"] },
  { id: "sessions", syntax: "/sessions", summary: "inspect or choose retained sessions", contexts: ["chat", "held", "read-only", "selection"] },
  { id: "resume", syntax: "/resume <sid>", summary: "open a retained session through existing checks", contexts: ["chat", "held", "read-only", "selection"] },
  { id: "new", syntax: "/new", summary: "start a new conversation after release checks", contexts: ["chat", "held", "read-only"] },
  { id: "status", syntax: "/status", summary: "show checked workflow and execution state", contexts: ["chat", "busy", "held", "read-only"] },
  { id: "continue", syntax: "/continue", summary: "request proof-checked work Resume", contexts: ["held"] },
  { id: "pause", syntax: "/pause", summary: "request pause; it is not proof of stopped work", contexts: ["chat", "busy", "held"] },
  { id: "cancel", syntax: "/cancel", summary: "request cancellation; proof may remain unconfirmed", contexts: ["chat", "busy", "held"] },
  { id: "skills", syntax: "/skills [grants|revoke <name>]", summary: "inspect skills and consent grants", contexts: ["chat", "held", "read-only"] },
  { id: "skill", syntax: "/skill:<name> [request]", summary: "invoke a discovered skill explicitly", contexts: ["chat"] },
  { id: "search", syntax: "/search <tool/status/task>", summary: "filter this session transcript", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "expand", syntax: "/expand <item number>", summary: "toggle evidence for a tool item or full output for $<shell number>", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "details", syntax: "/details", summary: "toggle the local task/evidence panel", contexts: ["chat", "busy", "held", "read-only"], local: true },
  { id: "theme", syntax: "/theme <neutral|light|dark>", summary: "set the process-local palette", contexts: ["chat", "busy", "held", "read-only", "unselected"], local: true },
  { id: "ascii", syntax: "/ascii", summary: "toggle ASCII chrome for this process", contexts: ["chat", "busy", "held", "read-only", "unselected"], local: true },
  { id: "finish", syntax: "/finish", summary: "finish an active interview prompt", contexts: ["chat"] },
  { id: "plan", syntax: "/plan", summary: "send a planning prompt; it grants no execution authority", contexts: ["chat"] },
  { id: "quit", syntax: "/quit", summary: "request exit", contexts: ["chat", "busy", "held", "read-only", "selection", "unselected"] },
]

export function interactiveActions(context?: InteractiveContext): readonly InteractiveAction[] {
  return context ? all.filter(action => action.contexts.includes(context)) : all
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
  return [`Commands (${context}):`, ...actions, "Keys: Enter send/select · Ctrl+R history · PageUp/PageDown transcript or active document · Escape cancel/dismiss · Ctrl+C clear then shutdown on second press · Ctrl+D quit · Ctrl+Z proof-guarded suspend."].join("\n") + "\n"
}
