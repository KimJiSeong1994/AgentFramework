import { describe, expect, test } from "bun:test"
import { sameViewIdentity, type InteractiveViewFacts } from "../src/hosts/interactive-view.ts"
import { statusLines } from "../src/tui/status-view.ts"
import { TuiApp } from "../src/tui/app.ts"

describe("interactive view facts", () => {
  test("identity equality includes writable attachment epoch", () => {
    expect(sameViewIdentity(undefined, { mode: "writable", sessionID: "s", epoch: "e1" })).toBe(false)
    expect(sameViewIdentity({ mode: "writable", sessionID: "s", epoch: "e1" }, { mode: "writable", sessionID: "s", epoch: "e1" })).toBe(true)
    expect(sameViewIdentity({ mode: "writable", sessionID: "s", epoch: "e1" }, { mode: "writable", sessionID: "s", epoch: "e2" })).toBe(false)
    expect(sameViewIdentity({ mode: "retained-read-only", sessionID: "s" }, { mode: "retained-read-only", sessionID: "s" })).toBe(true)
  })

  test("safety status survives compaction before ordinary activity", () => {
    const facts: InteractiveViewFacts = {
      identity: { mode: "retained-read-only", sessionID: "s" },
      selection: { engine: "codex", model: "매우-긴-모델-이름" },
      hold: { state: "known", value: { held: true, reason: "ownership unresolved" } },
      workflow: { state: "unknown" }, owner: "unknown",
      claim: { state: "unknown" }, fence: { state: "unknown" }, termination: "unconfirmed",
      discovery: "completed", request: { state: "cancellation-unconfirmed", operationID: "op" },
    }
    const rows = statusLines({ facts, workflow: "workflow detail", activity: "ordinary activity", queued: 2, columns: 80 })
    expect(rows.length).toBeLessThanOrEqual(2)
    expect(rows.join(" ")).toContain("termination:?")
    expect(rows.join(" ")).toContain("read-only")
    expect(rows.every(row => row.length <= 80)).toBe(true)
  })

  test("stale same-session epochs cannot overwrite a rebound view", () => {
    const tui = new TuiApp()
    const internal = tui as unknown as { viewFacts?: InteractiveViewFacts }
    const base = {
      selection: { engine: "local", model: "model" }, hold: { state: "known", value: { held: false } } as const,
      workflow: { state: "known", value: null } as const, owner: "none" as const,
      claim: { state: "known", value: false } as const, fence: { state: "known", value: false } as const,
      termination: "not-observed" as const, discovery: "not-observed" as const, request: { state: "not-observed" } as const,
    }
    tui.bindView({ mode: "writable", sessionID: "s", epoch: "new" })
    tui.viewSnapshot({ ...base, identity: { mode: "writable", sessionID: "s", epoch: "new" }, selection: { engine: "local", model: "new" } })
    tui.viewSnapshot({ ...base, identity: { mode: "writable", sessionID: "s", epoch: "old" }, selection: { engine: "local", model: "stale" } })
    expect(internal.viewFacts?.selection.model).toBe("new")
    tui.close()
  })
})
