import { describe, expect, test } from "bun:test"
import { copyText } from "../src/tui/clipboard.ts"

describe("TUI clipboard", () => {
  test("pipes the exact reply to macOS clipboard without terminal output", async () => {
    const calls: unknown[] = []
    const writes: string[] = []
    const text = "답변 🌊\n`echo hello` $(exit)"
    expect(await copyText(text, (value) => writes.push(value), {
      platform: "darwin", env: {},
      run: async (command, args, input) => { calls.push([command, args, input.toString("utf8")]); return true },
    })).toBe("native")
    expect(calls).toEqual([["pbcopy", [], text]])
    expect(writes).toEqual([])
  })

  test("tries available Linux display clipboard programs in order", async () => {
    const commands: unknown[] = []
    expect(await copyText("reply", () => { throw new Error("unexpected fallback") }, {
      platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      run: async (command, args) => { commands.push([command, args]); return command === "xsel" },
    })).toBe("native")
    expect(commands).toEqual([["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]])
  })

  test("encodes Windows clipboard input as UTF-16LE", async () => {
    const calls: unknown[] = []
    await copyText("답변 🌊", () => {}, {
      platform: "win32", env: {},
      run: async (command, args, input) => { calls.push([command, args, input.toString("utf16le")]); return true },
    })
    expect(calls).toEqual([["clip.exe", [], "답변 🌊"]])
  })

  test("SSH uses OSC 52 instead of the remote system clipboard", async () => {
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
      let called = false
      const writes: string[] = []
      const text = "답변 🌊\nsecond line\x1b]52;c;hostile\x07"
      expect(await copyText(text, (value) => writes.push(value), {
        platform: "darwin", env: { [key]: "remote" },
        run: async () => { called = true; return true },
      })).toBe("terminal")
      expect(writes).toEqual([`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`])
      expect(called).toBe(false)
    }
  })

  test("missing native command and failed command fall back to OSC 52", async () => {
    for (const failsByThrowing of [false, true]) {
      const writes: string[] = []
      expect(await copyText("reply", (value) => writes.push(value), {
        platform: "darwin", env: {},
        run: async () => { if (failsByThrowing) throw new Error("ENOENT"); return false },
      })).toBe("terminal")
      expect(writes).toEqual(["\x1b]52;c;cmVwbHk=\x07"])
    }
  })

  test("Linux without a display does not run clipboard programs", async () => {
    let called = false
    expect(await copyText("reply", () => {}, {
      platform: "linux", env: {}, run: async () => { called = true; return true },
    })).toBe("terminal")
    expect(called).toBe(false)
  })
})
