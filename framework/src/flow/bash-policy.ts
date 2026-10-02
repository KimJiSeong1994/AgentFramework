// Read-only bash policy for the planning boundary (ralplan §5.4). Pure. Fail-closed: anything not explicitly
// allowed is refused. Deliberately stricter than VERIFY_DENY_RE (no `&&`, no quoting tricks, no find).

const METACHAR = /[;|&$`<>(){}\n\r\t\\]/

export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "stat", "file", "git"])
const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse"])

/** Quote-aware split without expansion. Returns null on unbalanced quotes. */
export function tokenize(command: string): string[] | null {
  const out: string[] = []
  let cur = ""
  let quote: "'" | '"' | null = null
  let started = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === " ") {
      if (started) out.push(cur)
      cur = ""
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (quote) return null
  if (started) out.push(cur)
  return out
}

function denied(arg: string, names: string[]): boolean {
  return names.some((n) => arg === n || (n.startsWith("--") && arg.startsWith(`${n}=`)) || (n.endsWith("*") && arg.startsWith(n.slice(0, -1))))
}

/** Returns a one-line reason when the command is not allowed, else null. */
export function bashPolicyProblem(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return "empty command"
  if (METACHAR.test(cmd)) return "shell operators, substitution and redirection are not allowed"
  const argv = tokenize(cmd)
  if (!argv || argv.length === 0) return "unbalanced quotes"
  const [bin, ...args] = argv as [string, ...string[]]
  if (!READ_ONLY_COMMANDS.has(bin)) return `${bin} is not a read-only command (allowed: ${[...READ_ONLY_COMMANDS].join(", ")})`
  if (bin === "rg" && args.some((a) => denied(a, ["--pre*", "--hostname-bin*", "--search-zip", "-z"]))) return "rg preprocessors and decompression are not allowed"
  // BSD/GNU tail accept follow inside a short-option cluster (-10f, -nf) and in the historical +N form (+5f):
  // refuse any -/+ cluster containing f/F.
  if (bin === "tail" && args.some((a) => denied(a, ["--follow*", "--retry"]) || /^[-+][^-+]*[fF]/.test(a))) return "tail -f is not allowed"
  // `file -C` compiles a magic file, i.e. writes; refuse it in a read-only boundary.
  if (bin === "file" && args.some((a) => denied(a, ["--compile"]) || /^-[^-]*C/.test(a))) return "file -C is not allowed"
  if (bin === "git") {
    const sub = args[0]
    if (!sub || sub.startsWith("-")) return "git global options are not allowed"
    if (!GIT_SUBCOMMANDS.has(sub)) return `git ${sub} is not allowed (allowed: ${[...GIT_SUBCOMMANDS].join(", ")})`
    if (args.slice(1).some((a) => denied(a, ["--output*", "-o", "--ext-diff", "--textconv", "--exec*", "--upload-pack*"]))) return "git output, external diff and exec options are not allowed"
  }
  return null
}
