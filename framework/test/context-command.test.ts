import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contextCommand, fileContextBudgetStore, loadedContextSize, type ContextBudgetStore, type ContextController } from "../src/hosts/context-command.ts"
import { loadConfig } from "../src/config.ts"
import type { ConversationContextState } from "../src/hosts/plan-conversation.ts"

function fixture() {
  let tokens = 8192
  const writes: Array<number | null> = []
  let target = 70
  const store: ContextBudgetStore = {
    read: () => tokens, save: value => { writes.push(value); tokens = value ?? 8192; return "/user/config" },
    readTrimTarget: () => target,
    saveOptimization: (value, percent) => { writes.push(value); tokens = value ?? 8192; target = percent ?? 70; return "/user/config" },
  }
  let state: ConversationContextState = { messages: Array.from({ length: 6 }, (_, i) => [
    { role: "user" as const, text: `question ${i}` }, { role: "assistant" as const, text: `answer ${i}` },
  ]).flat(), pinnedNote: "Keep the API compatible" }
  const controller: ContextController = {
    state: () => structuredClone(state), apply: value => { state = structuredClone(value) },
    report: () => ({ inputTokens: tokens, conversationTokens: tokens - 3072, usedTokens: 1200, pairs: state.messages.length / 2, pinnedNote: state.pinnedNote, droppedPairs: 0 }),
  }
  return { store, writes, controller }
}

describe("context command", () => {
  test("file budget storage preserves notes, JSONC and retention, with project overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "otter-context-config-"))
    const old = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(root, "config")
    try {
      mkdirSync(join(root, "config", "otter"), { recursive: true })
      const path = join(root, "config", "otter", "otter.jsonc")
      writeFileSync(path, '{\n// keep this comment\n"local_model":{"keep_alive":"5m"}\n}\n')
      fileContextBudgetStore.save(16384)
      expect(loadConfig(root).local_model).toEqual({ keep_alive: "5m", context_input_tokens: 16384 })
      expect(readFileSync(path, "utf8")).toContain("// keep this comment")
      fileContextBudgetStore.saveOptimization!(32768, 85)
      expect(loadConfig(root).local_model).toEqual({ keep_alive: "5m", context_input_tokens: 32768, context_trim_target_percent: 85 })
      expect(readFileSync(path, "utf8")).toContain("// keep this comment")
      expect(() => fileContextBudgetStore.saveOptimization!(8192, 90)).toThrow()
      expect(fileContextBudgetStore.readTrimTarget!(root)).toBe(85)
      mkdirSync(join(root, ".otter"))
      writeFileSync(join(root, ".otter", "otter.jsonc"), '{"local_model":{"context_input_tokens":null}}')
      expect(await contextCommand(["budget", "32768"], root)).toContain("project config overrides")
      expect(fileContextBudgetStore.read(root)).toBe(8192)
      writeFileSync(path, "invalid JSONC")
      expect(() => fileContextBudgetStore.save(8192)).toThrow()
      expect(readFileSync(path, "utf8")).toBe("invalid JSONC")
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = old
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("status distinguishes input budget and retained context estimates", async () => {
    const f = fixture()
    const report = await contextCommand([], "/project", f.controller, f.store)
    expect(report).toContain("8192 estimated tokens")
    expect(report).toContain("~1200 / 5120")
    expect(report).toContain("6 complete pairs")
    expect(report).toContain("Keep the API compatible")
    expect(report).toContain("shared by all local models and local combo routes")
    expect(await contextCommand([], "/project", undefined, f.store)).toContain("Select a local model")
  })

  test("budget persists valid values, reports overrides and rejects invalid input", async () => {
    const f = fixture()
    for (const value of ["4096", "65536", "default"]) {
      expect(await contextCommand(["budget", value], "/project", undefined, f.store)).toContain("applies to the next turn")
    }
    expect(f.writes).toEqual([4096, 65536, null])
    for (const value of ["4095", "65537", "4k", "NaN", "4096.5", "-1"]) {
      expect(await contextCommand(["budget", value], "/project", f.controller, f.store)).toContain("Usage:")
    }
    expect(f.writes).toHaveLength(3)
    f.store.read = () => 8192
    expect(await contextCommand(["budget", "16384"], "/project", undefined, f.store)).toContain("project config overrides")
  })

  test("compact removes whole old pairs, keeps the pinned note and supports clearing active history", async () => {
    const f = fixture()
    expect(await contextCommand(["compact"], "/project", f.controller, f.store)).toContain("removed 2 older pairs; kept 4")
    expect(f.controller.state().messages[0]?.text).toBe("question 2")
    expect(f.controller.state().pinnedNote).toBe("Keep the API compatible")
    const before = f.controller.state()
    expect(await contextCommand(["compact", "-1"], "/project", f.controller, f.store)).toContain("Usage:")
    expect(f.controller.state()).toEqual(before)
    await contextCommand(["compact", "0"], "/project", f.controller, f.store)
    expect(f.controller.state()).toEqual({ messages: [], pinnedNote: before.pinnedNote })
  })

  test("pin keeps bounded exact text, unpin keeps history, and unsupported sessions cannot mutate", async () => {
    const f = fixture()
    const note = "요구사항:\n  API  유지"
    expect(await contextCommand(["pin", note], "/project", f.controller, f.store)).toContain("note saved")
    expect(f.controller.state().pinnedNote).toBe(note)
    expect(await contextCommand(["pin", "x".repeat(2001)], "/project", f.controller, f.store)).toContain("1–2000")
    expect(f.controller.state().pinnedNote).toBe(note)
    expect(await contextCommand(["compact"], "/project", undefined, f.store)).toContain("idle local-model")
    await contextCommand(["unpin"], "/project", f.controller, f.store)
    expect(f.controller.state().pinnedNote).toBe("")
    expect(f.controller.state().messages).toHaveLength(12)
  })

  test("failed checkpoint or configuration is never reported as applied", async () => {
    const f = fixture()
    f.controller.apply = () => { throw new Error("checkpoint unavailable") }
    expect(await contextCommand(["compact"], "/project", f.controller, f.store)).toBe("Context command failed: checkpoint unavailable")
    expect(f.controller.state().messages).toHaveLength(12)
    f.store.read = () => { throw new Error("invalid config") }
    expect(await contextCommand(["budget", "16384"], "/project", undefined, f.store)).toContain("invalid config")
    expect(f.writes).toEqual([])
  })

  test("optimization uses the selected loaded allocation, caps presets, and resets both settings", async () => {
    const f = fixture()
    let context = 65536
    const calls: readonly string[][] = []
    const local = { model: "native", run: async (argv: readonly string[]) => {
      (calls as string[][]).push([...argv])
      return `NAME    ID    SIZE    PROCESSOR    CONTEXT    RUNNER    UNTIL\nnative:latest    abc    18 GB    100% GPU    ${context}    llamacpp    Forever`
    } }
    for (const [profile, tokens, percent] of [["speed", 8192, 50], ["balanced", 16384, 70], ["long", 32768, 85]] as const) {
      const output = await contextCommand(["optimize", profile], "/project", undefined, f.store, local)
      expect(output).toContain(`Effective input budget: ${tokens}`)
      expect(output).toContain(`trim target: ${percent}%`)
      expect(output).toContain("Observed native: 65536")
      expect(output).toContain("shared by all local models and local combo routes")
    }
    context = 8192
    expect(await contextCommand(["optimize"], "/project", undefined, f.store, local)).toContain("Effective input budget: 6144")
    expect(calls).toEqual([["ps"], ["ps"], ["ps"], ["ps"]])
    expect(await contextCommand(["optimize", "default"], "/project", undefined, f.store)).toContain("trim target: 70%")
    expect(f.writes).toEqual([8192, 16384, 32768, 6144, null])
    expect(f.store.read("/project")).toBe(8192)
    f.store.readTrimTarget = () => 85
    expect(await contextCommand(["optimize"], "/project", undefined, f.store, local)).toContain("project config overrides")
  })

  test("missing, ambiguous, unsupported or small loaded context never changes settings", async () => {
    const f = fixture()
    expect(await contextCommand(["optimize"], "/project", undefined, f.store)).toContain("Select a local model")
    expect(await contextCommand(["optimize", "toString"], "/project", undefined, f.store)).toContain("Usage:")
    for (const output of [
      "NAME    ID    SIZE    PROCESSOR    UNTIL\nnative:latest    abc    18 GB    100% GPU    Forever",
      "NAME    CONTEXT\nother:latest    65536",
      "NAME    CONTEXT\nnative:latest    4096",
      "NAME    CONTEXT\nnative:latest    65536\nnative:latest    8192",
      "NAME    CONTEXT\nnative:latest    NaN",
    ]) expect(await contextCommand(["optimize"], "/project", undefined, f.store, { model: "native", run: async () => output })).toContain("failed")
    const abort = new AbortController()
    const output = await contextCommand(["optimize"], "/project", undefined, f.store, { model: "native", signal: abort.signal,
      run: async () => { abort.abort(); return "NAME    CONTEXT\nnative:latest    65536" } })
    expect(output).toContain("cancelled")
    expect(f.writes).toEqual([])
    expect(loadedContextSize("NAME    CONTEXT\norg/native:tag    8192", "org/native:tag")).toBe(8192)
  })
})
