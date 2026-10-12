import { describe, expect, test } from "bun:test"
import { inputColorSupported, inputLine, renderInput } from "../src/hosts/cli-input.ts"

describe("CLI input presentation", () => {
  test("color requires a capable TTY and respects even empty NO_COLOR", () => {
    expect(inputColorSupported(true, { TERM: "xterm-256color" })).toBe(true)
    for (const env of [{ TERM: "dumb" }, {}, { TERM: "xterm", NO_COLOR: "" }, { TERM: "xterm", NO_COLOR: "1" }]) {
      expect(inputColorSupported(true, env)).toBe(false)
    }
    expect(inputColorSupported(false, { TERM: "xterm" })).toBe(false)
    const plain = renderInput("codex · model", "Enter send", "You> ")
    expect(plain.chrome).toContain("── codex · model\nEnter send\n")
    expect(plain.prompt).toBe("You> ")
    expect(plain.chrome).not.toContain("\x1b")
    const color = renderInput("codex · model", "Enter send", "You> ", { color: true })
    expect(color.chrome).toContain("\x1b[36m── codex · model\x1b[0m")
    expect(color.chrome).toContain("\x1b[2mEnter send\x1b[0m")
    expect(color.prompt).toBe("\x1b[36mYou> \x1b[0m")
  })

  test("clips display columns without splitting CJK, combining or Hangul clusters", () => {
    expect(inputLine("界界界", { columns: 5 })).toBe("界界…")
    expect(inputLine("éééé", { columns: 3 })).toBe("éé…")
    expect(inputLine("가abcdef", { columns: 3 })).toBe("가…")
    expect(inputLine("界", { columns: 2 })).toBe("界")
    expect(inputLine("界", { columns: 1 })).toBe("…")
    for (const columns of [1, 4, 12, 40, 160]) {
      const rendered = renderInput("local · 界".repeat(20), "Enter send · /help commands".repeat(10), "You> ", { columns })
      for (const line of rendered.chrome.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns)
      expect(rendered.prompt).toBe("You> ")
    }
    expect(renderInput("Model selection", "Select", "Model [1-10 or native ID]: ", { columns: 12 }).prompt).toBe("Model> ")
  })

  test("escapes hostile labels before measuring and never emits control sequences", () => {
    const hostile = "model\x1b[2J\x1b]0;title\x07\r\n\t\u009b31m\u202e\u2066path"
    const line = inputLine(hostile, { columns: 200 })
    expect(line).toContain("\\u001b[2J")
    expect(line).toContain("\\u000d\\u000a\\u0009")
    expect(line).toContain("\\u202e\\u2066path")
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e\u2066]/u)
    expect(Bun.stringWidth(inputLine(hostile, { columns: 10 }))).toBeLessThanOrEqual(10)
    expect(inputLine(hostile, { columns: 10 })).toEndWith("…")
  })
})
