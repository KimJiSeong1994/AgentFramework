import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileLocalModelStore, localModelCommand, runLocalModelCommand, type LocalModelStore } from "../src/hosts/local-model-command.ts"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture(keepAlive?: string | null) {
  const writes: Array<string | null> = []
  const calls: readonly string[][] = []
  const store: LocalModelStore = {
    read: () => keepAlive,
    save: value => { writes.push(value); keepAlive = value; return "/user/otter.jsonc" },
    run: async argv => { (calls as string[][]).push([...argv]); return "NAME SIZE PROCESSOR CONTEXT UNTIL\nmodel:tag 8 GB 100% GPU 8192 5 minutes" },
  }
  return { store, calls, writes }
}

describe("local model command", () => {
  test("status inspects loaded models without changing configuration or generating text", async () => {
    const f = fixture()
    const output = await localModelCommand([], "/project", { allowUnload: false }, f.store)
    expect(output).toContain("server default")
    expect(output).toContain("model:tag 8 GB")
    expect(f.calls).toEqual([["ps"]])
    expect(f.writes).toEqual([])
  })

  test("profiles persist retention with tradeoffs; custom durations and reset work", async () => {
    const f = fixture()
    for (const profile of ["memory", "balanced", "speed", "default"]) {
      expect(await localModelCommand(["profile", profile], "/project", { allowUnload: false }, f.store)).toContain("Applies to subsequent")
    }
    await localModelCommand(["keepalive", "20m"], "/project", { allowUnload: false }, f.store)
    await localModelCommand(["keepalive", "default"], "/project", { allowUnload: false }, f.store)
    expect(f.writes).toEqual(["0", "5m", "-1", null, "20m", null])
    expect(f.calls).toEqual([])
  })

  test("invalid syntax never writes or runs a process", async () => {
    const f = fixture()
    for (const args of [["keepalive", "25h"], ["keepalive", "1m;rm"], ["keepalive", "NaN"], ["profile", "toString"], ["profile", "speed", "extra"], ["status", "extra"], ["unload", "--all"]]) {
      expect(await localModelCommand(args, "/project", { allowUnload: true }, f.store)).toContain("Usage:")
    }
    expect(f.writes).toEqual([])
    expect(f.calls).toEqual([])
  })

  test("project override is reported rather than claiming the user choice is effective", async () => {
    const f = fixture()
    f.store.read = () => "10m"
    const output = await localModelCommand(["profile", "speed"], "/project", { allowUnload: true }, f.store)
    expect(output).toContain("overrides this user setting")
    expect(output).toContain("Effective keepalive: 10m")
  })

  test("unload targets only the selected or named model and refuses held work", async () => {
    const f = fixture()
    expect(await localModelCommand(["unload"], "/project", { model: "native", allowUnload: false }, f.store)).toContain("unavailable")
    expect(await localModelCommand(["unload"], "/project", { allowUnload: true }, f.store)).toContain("Select a local model")
    expect(f.calls).toEqual([])
    expect(await localModelCommand(["unload"], "/project", { model: "native", allowUnload: true }, f.store)).toContain("installed model files and conversation history are kept")
    await localModelCommand(["unload", "other:tag"], "/project", { model: "native", allowUnload: true }, f.store)
    expect(f.calls).toEqual([["stop", "native"], ["stop", "other:tag"]])
  })

  test("service errors remain visible while retention can still be read", async () => {
    const f = fixture("5m")
    f.store.run = async () => { throw new Error("service unavailable") }
    expect(await localModelCommand([], "/project", { allowUnload: true }, f.store)).toContain("Status unavailable: service unavailable")
    const output = await localModelCommand(["unload", "native"], "/project", { allowUnload: true }, f.store)
    expect(output).toContain("command failed")
    expect(output).not.toContain("Unloaded")
    f.store.read = () => { throw new Error("invalid config") }
    expect(await localModelCommand(["profile", "speed"], "/project", { allowUnload: true }, f.store)).toContain("invalid config")
    expect(f.writes).toEqual([])
  })

  test("file persistence preserves JSONC and reports effective project overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "otter-local-config-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const old = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(root, "config")
    cleanups.push(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old })
    mkdirSync(join(root, "config", "otter"), { recursive: true })
    const path = join(root, "config", "otter", "otter.jsonc")
    writeFileSync(path, '{\n // retain this comment\n "chat": {"intent": "off"}\n}\n')
    fileLocalModelStore.save("-1")
    expect(readFileSync(path, "utf8")).toContain("// retain this comment")
    expect(fileLocalModelStore.read(root)).toBe("-1")
    mkdirSync(join(root, ".otter"))
    writeFileSync(join(root, ".otter", "otter.jsonc"), '{"local_model":{"keep_alive":null}}')
    expect(await localModelCommand(["profile", "speed"], root, { allowUnload: true })).toContain("overrides this user setting")
    expect(fileLocalModelStore.read(root)).toBeNull()
    writeFileSync(path, "broken json")
    expect(() => fileLocalModelStore.save("5m")).toThrow()
    expect(readFileSync(path, "utf8")).toBe("broken json")
  })

  test("bounded native operation uses literal argv, reports process failure and honors cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "otter-local-cli-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const old = process.env.PATH
    process.env.PATH = root
    cleanups.push(() => { if (old === undefined) delete process.env.PATH; else process.env.PATH = old })
    writeFileSync(join(root, "ollama"), `#!${process.execPath}\nconst args = process.argv.slice(2); if (args[1] === "bad") process.exit(1); console.log(JSON.stringify(args))\n`, { mode: 0o700 })
    expect(await runLocalModelCommand(["ps"], root)).toBe('["ps"]')
    expect(await runLocalModelCommand(["stop", "model:tag"], root)).toBe('["stop","model:tag"]')
    await expect(runLocalModelCommand(["stop", "bad"], root)).rejects.toThrow("incomplete")
    await expect(runLocalModelCommand(["rm", "model:tag"], root)).rejects.toThrow("Unsupported")
    await expect(runLocalModelCommand(["ps"], root, AbortSignal.abort())).rejects.toThrow("cancelled")
  })
})
