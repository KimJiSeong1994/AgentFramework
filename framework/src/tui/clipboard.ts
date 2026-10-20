import { spawn } from "node:child_process"

type ClipboardRuntime = {
  platform: string
  env: NodeJS.ProcessEnv
  run: (command: string, args: string[], input: Buffer) => Promise<boolean>
}

function run(command: string, args: string[], input: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] })
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      finish(false)
    }, 750)
    function finish(success: boolean) {
      clearTimeout(timeout)
      resolve(success)
    }
    child.on("error", () => finish(false))
    child.on("close", (code) => finish(code === 0))
    child.stdin.on("error", () => {
      child.kill("SIGKILL")
      finish(false)
    })
    child.stdin.end(input)
  })
}

/** Native clipboard where available; otherwise ask the user's terminal via OSC 52. */
export async function copyText(
  text: string,
  write: (sequence: string) => void,
  runtime: ClipboardRuntime = { platform: process.platform, env: process.env, run },
): Promise<"native" | "terminal"> {
  const { platform, env } = runtime
  const commands: Array<[string, string[]]> = []
  if (!env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY) {
    if (platform === "darwin") commands.push(["pbcopy", []])
    if (platform === "win32") commands.push(["clip.exe", []])
    if (platform === "linux") {
      if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []])
      if (env.DISPLAY) commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]])
    }
  }
  for (const [command, args] of commands) {
    try {
      const input = Buffer.from(text, platform === "win32" ? "utf16le" : "utf8")
      if (await runtime.run(command, args, input)) return "native"
    } catch {
      // Missing programs and unavailable desktop sessions fall back to the terminal.
    }
  }
  write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`)
  return "terminal"
}
