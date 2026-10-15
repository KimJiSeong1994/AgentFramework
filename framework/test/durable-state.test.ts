import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { join } from "node:path"
import { durableWriteJson, ensureDurableDirectory } from "../src/state/durable.ts"
import { tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

describe("durable JSON state", () => {
  test("creates a private directory chain and refuses symlink path components", () => {
    const nested = join(wt.stateHome, "private", "nested")
    ensureDurableDirectory(nested)
    expect(fs.statSync(nested).isDirectory()).toBe(true)
    expect(fs.statSync(join(wt.stateHome, "private")).mode & 0o077).toBe(0)

    const target = join(wt.stateHome, "symlink-target")
    fs.mkdirSync(target)
    const link = join(wt.stateHome, "symlink")
    fs.symlinkSync(target, link)
    expect(() => ensureDurableDirectory(join(link, "child"))).toThrow(/symlink/)
    expect(() => durableWriteJson(join(link, "data.json"), { value: 1 })).toThrow(/symlink/)
  })

  test("uses exclusive private temporaries and preserves existing originals on fsync and rename failure", () => {
    const path = join(wt.stateHome, "manifest.json")
    durableWriteJson(path, { version: 1, lastSeq: 3 })
    const original = fs.readFileSync(path, "utf8")

    const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("injected fsync failure") })
    try {
      expect(() => durableWriteJson(path, { version: 1, lastSeq: 4 })).toThrow("injected fsync failure")
      expect(fs.readFileSync(path, "utf8")).toBe(original)
    } finally {
      fsync.mockRestore()
    }

    const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("injected rename failure") })
    try {
      expect(() => durableWriteJson(path, { version: 1, lastSeq: 5 })).toThrow("injected rename failure")
      expect(fs.readFileSync(path, "utf8")).toBe(original)
      expect(fs.readdirSync(wt.stateHome).some(name => name.endsWith(".tmp"))).toBe(false)
    } finally {
      rename.mockRestore()
    }
  })

  test("rejects symlink files and non-JSON top-level values without changing the original", () => {
    const path = join(wt.stateHome, "state.json")
    durableWriteJson(path, { safe: true })
    const original = fs.readFileSync(path, "utf8")
    expect(() => durableWriteJson(path, undefined)).toThrow(/JSON serializable/)
    expect(fs.readFileSync(path, "utf8")).toBe(original)

    const link = join(wt.stateHome, "state-link.json")
    fs.symlinkSync(path, link)
    expect(() => durableWriteJson(link, { safe: false })).toThrow(/symlink/)
    expect(fs.readFileSync(path, "utf8")).toBe(original)
  })
})
