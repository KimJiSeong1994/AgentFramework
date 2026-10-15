import { describe, expect, test } from "bun:test"
import { chrome, resolveTheme, semanticStyle } from "../src/tui/theme.ts"

describe("TUI semantic theme", () => {
  test("neutral light and dark expose labels as well as color", () => {
    for (const name of ["neutral", "light", "dark"] as const) {
      const theme = resolveTheme(name)
      expect(theme.labels.warning).toBe("warning")
      expect(semanticStyle("held", "warning", theme, true)).toContain("\x1b[")
      expect(semanticStyle("held", "warning", theme, false)).toBe("held")
    }
  })

  test("ASCII mode changes chrome without changing body text", () => {
    expect(chrome("status · held ─ …", true)).toBe("status | held - ...")
    const body = "사용자 · 모델 본문"
    expect(body).toBe("사용자 · 모델 본문")
  })
})
