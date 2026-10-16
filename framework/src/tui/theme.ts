export type ThemeName = "neutral" | "light" | "dark"
export type SemanticToken = "text" | "muted" | "notice" | "warning" | "error" | "success" | "code" | "diff-add" | "diff-remove" | "focus" | "user" | "border" | "accent"

export type Theme = Readonly<{
  name: ThemeName
  sgr: Readonly<Record<SemanticToken, string>>
  labels: Readonly<Record<Exclude<SemanticToken, "text">, string>>
}>

const labels = {
  muted: "info",
  notice: "notice",
  warning: "warning",
  error: "error",
  success: "success",
  code: "code",
  "diff-add": "+",
  "diff-remove": "-",
  focus: ">",
  user: "you",
  border: "border",
  accent: "accent",
} as const

const palettes: Record<ThemeName, Theme["sgr"]> = {
  neutral: { text: "\x1b[39m", muted: "\x1b[2m", notice: "\x1b[36m", warning: "\x1b[33m", error: "\x1b[31m", success: "\x1b[32m", code: "\x1b[35m", "diff-add": "\x1b[32m", "diff-remove": "\x1b[31m", focus: "\x1b[1m", user: "\x1b[1;48;5;236;97m", border: "\x1b[90m", accent: "\x1b[1;36m" },
  light: { text: "\x1b[30m", muted: "\x1b[90m", notice: "\x1b[34m", warning: "\x1b[33m", error: "\x1b[31m", success: "\x1b[32m", code: "\x1b[35m", "diff-add": "\x1b[32m", "diff-remove": "\x1b[31m", focus: "\x1b[1m", user: "\x1b[1;48;5;254;30m", border: "\x1b[37m", accent: "\x1b[1;34m" },
  dark: { text: "\x1b[97m", muted: "\x1b[90m", notice: "\x1b[96m", warning: "\x1b[93m", error: "\x1b[91m", success: "\x1b[92m", code: "\x1b[95m", "diff-add": "\x1b[92m", "diff-remove": "\x1b[91m", focus: "\x1b[1m", user: "\x1b[1;48;5;237;97m", border: "\x1b[90m", accent: "\x1b[1;96m" },
}

export function resolveTheme(name: ThemeName = "neutral"): Theme {
  return { name, sgr: palettes[name], labels }
}

export function semanticStyle(text: string, token: SemanticToken, theme: Theme, enabled: boolean): string {
  return enabled ? `${theme.sgr[token]}${text}\x1b[0m` : text
}

export function chrome(value: string, ascii: boolean): string {
  if (!ascii) return value
  return value.replaceAll("·", "|").replaceAll("─", "-").replaceAll("…", "...")
}
