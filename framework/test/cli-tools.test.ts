import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCliTools } from "../src/hosts/cli-tools.ts"
import { WORKFLOW_READ_ONLY_ROLES } from "../src/hosts/types.ts"
import { FdTree } from "../src/skills/fd-tree.ts"

let root: string
let outside: string
let tools: ReturnType<typeof createCliTools>

function text(result: ReturnType<typeof tools.execute>): string {
  return result.ok ? result.text : result.error
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-cli-tools-"))
  outside = mkdtempSync(join(tmpdir(), "otter-cli-tools-outside-"))
  tools = createCliTools({
    root,
    role: "worker",
    allowed: ["read", "list", "glob", "grep", "write", "edit"],
    denied: [],
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe("scoped CLI file tools", () => {
  test("multiread batches bounded read-only file ranges without partial disclosure", () => {
    writeFileSync(join(root, "a.txt"), "first\nsecond\n")
    writeFileSync(join(root, "b.txt"), "third")
    const input = { reads: [{ path: "a.txt", startLine: 2, maxLines: 1 }, { path: "b.txt" }] }
    expect(tools.validate("multiread", input)).toBe(true)
    const output = tools.execute("multiread", input)
    expect(output.ok).toBe(true)
    expect(JSON.parse(text(output))).toEqual({ results: [{ path: "a.txt", text: "second" }, { path: "b.txt", text: "third" }] })
    const denied = tools.execute("multiread", { reads: [{ path: "a.txt" }, { path: "../outside.txt" }] })
    expect(denied.ok).toBe(false)
    expect(text(denied)).not.toContain("first")
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("first\nsecond\n")
  })

  test("multiread rejects oversized batches and aggregate results", () => {
    writeFileSync(join(root, "large.txt"), "x".repeat(20_000))
    expect(() => tools.execute("multiread", { reads: Array.from({ length: 9 }, () => ({ path: "large.txt" })) })).toThrow()
    const result = tools.execute("multiread", { reads: [{ path: "large.txt" }, { path: "large.txt" }] })
    expect(result.ok).toBe(false)
    expect(text(result)).toContain("combined read output")
    expect(text(result)).not.toContain("x".repeat(50))
  })

  test("multiread checks cancellation between members", () => {
    writeFileSync(join(root, "a.txt"), "private-first")
    writeFileSync(join(root, "b.txt"), "private-second")
    let checks = 0
    const scoped = createCliTools({ root, role: "planner", allowed: ["read"], denied: [], beforeEffect() {
      if (++checks === 2) throw new Error("cancelled")
    } })
    const result = scoped.execute("multiread", { reads: [{ path: "a.txt" }, { path: "b.txt" }] })
    expect(checks).toBe(2)
    expect(result.ok).toBe(false)
    expect(text(result)).not.toContain("private-")
  })

  test("multiread refuses protected paths, symlinks, hardlinks and changed roots without partial output", () => {
    writeFileSync(join(root, "a.txt"), "private-first")
    writeFileSync(join(outside, "secret.txt"), "outside-secret")
    symlinkSync(join(outside, "secret.txt"), join(root, "symlink.txt"))
    linkSync(join(outside, "secret.txt"), join(root, "hardlink.txt"))
    mkdirSync(join(root, ".otter"))
    writeFileSync(join(root, ".otter/secret.txt"), "protected-secret")
    for (const path of ["symlink.txt", "hardlink.txt", ".otter/secret.txt"]) {
      const input = { reads: [{ path: "a.txt" }, { path }] }
      expect(tools.validate("multiread", input)).toBe(false)
      const output = tools.execute("multiread", input)
      expect(output.ok).toBe(false)
      expect(text(output)).not.toContain("private-first")
      expect(text(output)).not.toContain("secret")
    }
    let checks = 0
    const held = `${root}-held`
    const scoped = createCliTools({ root, role: "planner", allowed: ["read"], denied: [], beforeEffect() {
      if (++checks !== 2) return
      renameSync(root, held)
      mkdirSync(root)
      writeFileSync(join(root, "a.txt"), "replacement-secret")
    } })
    try {
      const output = scoped.execute("multiread", { reads: [{ path: "a.txt" }, { path: "a.txt" }] })
      expect(output.ok).toBe(false)
      expect(text(output)).toContain("root changed")
      expect(text(output)).not.toContain("private-first")
      expect(text(output)).not.toContain("replacement-secret")
    } finally {
      if (existsSync(held)) { rmSync(root, { recursive: true }); renameSync(held, root) }
    }
  })

  test("multiread requires read permission and can be withheld from skill-bound calls", () => {
    writeFileSync(join(root, "a.txt"), "a")
    for (const scope of [{ allowed: ["multiread"], denied: [] }, { allowed: ["read"], denied: ["read"] }, { allowed: ["read"], denied: [], multiRead: false }]) {
      const scoped = createCliTools({ root, role: "planner", ...scope })
      expect(scoped.available).not.toContain("multiread")
      expect(scoped.execute("multiread", { reads: [{ path: "a.txt" }] }).ok).toBe(false)
    }
  })

  test("workflow roles cannot gain writes from a broader caller-supplied allowlist", () => {
    writeFileSync(join(root, "existing.txt"), "original")
    for (const role of WORKFLOW_READ_ONLY_ROLES) {
      let effects = 0
      const scoped = createCliTools({
        root, role, allowed: ["read", "list", "glob", "grep", "write", "edit"], denied: [],
        beforeEffect() { effects++ },
      })
      expect(scoped.execute("write", { path: "new.txt", content: "forbidden" }).ok).toBe(false)
      expect(scoped.execute("edit", { path: "existing.txt", oldText: "original", newText: "forbidden" }).ok).toBe(false)
      expect(effects).toBe(0)
      expect(existsSync(join(root, "new.txt"))).toBe(false)
      expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("original")
      expect(scoped.execute("read", { path: "existing.txt" })).toEqual({ ok: true, text: "original" })
    }
    expect(() => createCliTools({ root, role: "unknown" as never, allowed: ["write"], denied: [] })).toThrow("invalid CLI tool scope")
  })

  test("root listing, read, glob, and grep work with bounded local results", () => {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src/example.ts"), "const marker = 'needle'\nsecond line\n")

    expect(text(tools.execute("list", {}))).toContain('"src"')
    expect(tools.execute("read", { path: "src/example.ts", startLine: 2, maxLines: 1 })).toEqual({ ok: true, text: "second line" })
    expect(text(tools.execute("glob", { pattern: "src/**/*.ts" }))).toContain("src/example.ts")
    expect(text(tools.execute("grep", { pattern: "needle", path: "src" }))).toContain('"line":1')
    expect(text(tools.execute("grep", { pattern: "needle", path: "src/example.ts" }))).toContain("needle")
  })

  test("directory names stay on the retained descriptor when a target is replaced immediately after open", () => {
    const target = join(root, "target")
    const renamed = join(root, "target-held")
    mkdirSync(target)
    writeFileSync(join(target, "authorized.txt"), "inside")
    writeFileSync(join(outside, "external-only.txt"), "must not enumerate")
    expect(tools.validate("list", { path: "target" })).toBe(true)

    const originalOpen = FdTree.prototype.openDirectoryRelative
    let replaced = false
    FdTree.prototype.openDirectoryRelative = function (this: FdTree, relativePath: string) {
      const directory = originalOpen.call(this, relativePath)
      if (!replaced && relativePath === "target") {
        renameSync(target, renamed)
        symlinkSync(outside, target)
        replaced = true
      }
      return directory
    }
    let result: ReturnType<typeof tools.execute>
    try {
      result = tools.execute("list", { path: "target" })
    } finally {
      FdTree.prototype.openDirectoryRelative = originalOpen
    }
    expect(replaced).toBe(true)
    expect(result!.ok).toBe(false)
    expect(text(result!)).not.toContain("external-only.txt")
  })

  test("validation is metadata-only for dynamic ignore rules but refuses statically ignored paths", () => {
    mkdirSync(join(root, "ignored-by-rule"))
    writeFileSync(join(root, "ignored-by-rule", "private.txt"), "private")
    writeFileSync(join(root, ".gitignore"), "ignored-by-rule/\n")

    expect(tools.validate("list", { path: "ignored-by-rule" })).toBe(true)
    expect(tools.validate("grep", { pattern: "private", path: "ignored-by-rule" })).toBe(true)
    expect(tools.validate("list", { path: "node_modules" })).toBe(false)
    expect(tools.validate("glob", { pattern: "**/.git/**" })).toBe(false)

    const result = tools.execute("list", { path: "ignored-by-rule" })
    expect(result.ok).toBe(false)
    expect(text(result)).not.toContain("private.txt")
  })

  test("list, glob, and grep mark result-capped output as partial", () => {
    for (let index = 0; index < 201; index++) {
      writeFileSync(join(root, `${String(index).padStart(3, "0")}.txt`), "needle")
    }

    for (const result of [
      tools.execute("list", {}),
      tools.execute("glob", { pattern: "**/*.txt" }),
      tools.execute("grep", { pattern: "needle" }),
    ]) {
      expect(result.ok).toBe(true)
      expect(text(result)).toContain("[partial results:")
    }
  })

  test("deep and entry-capped scans mark empty results as partial", () => {
    let nested = root
    for (let index = 0; index < 17; index++) {
      nested = join(nested, `depth-${index}`)
      mkdirSync(nested)
    }
    writeFileSync(join(nested, "too-deep.txt"), "needle")

    const deepGlob = tools.execute("glob", { pattern: "**/too-deep.txt" })
    const deepGrep = tools.execute("grep", { pattern: "needle" })
    expect(text(deepGlob)).toContain("[partial results:")
    expect(text(deepGrep)).toContain("[partial results:")
    expect(text(deepGlob)).not.toContain("too-deep.txt")
    expect(text(deepGrep)).not.toContain("needle")

    rmSync(join(root, "depth-0"), { recursive: true, force: true })
    writeFileSync(join(root, ".gitignore"), "hidden-*\n")
    for (let index = 0; index < 10_001; index++) {
      writeFileSync(join(root, `hidden-${String(index).padStart(5, "0")}.txt`), "")
    }
    const entryCappedList = tools.execute("list", {})
    const entryCappedGlob = tools.execute("glob", { pattern: "missing-*.txt" })
    expect(text(entryCappedList)).toContain("[partial results:")
    expect(text(entryCappedGlob)).toContain("[partial results:")
  })

  test("recursive grep enforces an aggregate byte budget and checks its lease between files", () => {
    let authorizations = 0
    const searching = createCliTools({
      root,
      role: "worker",
      allowed: ["grep"],
      denied: [],
      beforeEffect() { authorizations++ },
    })
    for (let index = 0; index < 33; index++) {
      writeFileSync(join(root, `${String(index).padStart(2, "0")}.txt`), Buffer.alloc(256 * 1024, 0x61))
    }

    const result = searching.execute("grep", { pattern: "not-present" })
    expect(result.ok).toBe(true)
    expect(text(result)).toContain("[partial results:")
    expect(authorizations).toBeGreaterThan(0)
    expect(authorizations).toBeLessThanOrEqual(32)
  })

  test("recursive grep stops before the next file when its lease check fails", () => {
    let authorizations = 0
    const guarded = createCliTools({
      root,
      role: "worker",
      allowed: ["grep"],
      denied: [],
      beforeEffect() {
        authorizations++
        if (authorizations === 2) throw new Error("lease changed")
      },
    })
    writeFileSync(join(root, "first.txt"), "needle")
    writeFileSync(join(root, "second.txt"), "needle")

    const result = guarded.execute("grep", { pattern: "needle" })
    expect(result.ok).toBe(false)
    expect(authorizations).toBe(2)
    expect(text(result)).not.toContain("needle")
  })

  test("writes create ordinary files and edit requires one exact occurrence", () => {
    mkdirSync(join(root, "src"))
    expect(tools.execute("write", { path: "src/new.ts", content: "before target after" })).toMatchObject({ ok: true })
    expect(readFileSync(join(root, "src/new.ts"), "utf8")).toBe("before target after")
    expect(tools.execute("edit", { path: "src/new.ts", oldText: "target", newText: "updated" })).toMatchObject({ ok: true })
    expect(readFileSync(join(root, "src/new.ts"), "utf8")).toBe("before updated after")
    expect(tools.execute("edit", { path: "src/new.ts", oldText: "before", newText: "x" })).toMatchObject({ ok: true })
    expect(tools.execute("edit", { path: "src/new.ts", oldText: "updated", newText: "x" })).toMatchObject({ ok: true })
    writeFileSync(join(root, "duplicate.txt"), "same same")
    expect(tools.execute("edit", { path: "duplicate.txt", oldText: "same", newText: "once" })).toMatchObject({ ok: false })
    expect(readFileSync(join(root, "duplicate.txt"), "utf8")).toBe("same same")
  })

  test("new-file writes authorize once before creation instead of failing on a second check", () => {
    let authorizations = 0
    const singleAuthorization = createCliTools({
      root,
      role: "worker",
      allowed: ["write"],
      denied: [],
      beforeEffect() {
        authorizations++
        if (authorizations === 2) throw new Error("lease changed")
      },
    })

    const result = singleAuthorization.execute("write", { path: "new-file.txt", content: "complete contents" })
    expect(result).toMatchObject({ ok: true })
    expect(authorizations).toBe(1)
    expect(readFileSync(join(root, "new-file.txt"), "utf8")).toBe("complete contents")
  })

  test("rejects traversal, protected/credential paths, and symlink escapes", () => {
    writeFileSync(join(outside, "outside.txt"), "outside sentinel")
    for (const directory of [".git", ".otter", ".gjc"]) {
      mkdirSync(join(root, directory))
      writeFileSync(join(root, directory, "private.txt"), "private")
      expect(tools.execute("read", { path: `${directory}/private.txt` })).toMatchObject({ ok: false })
    }
    writeFileSync(join(root, ".env.local"), "private")
    expect(tools.execute("read", { path: ".env.local" })).toMatchObject({ ok: false })
    expect(tools.execute("read", { path: "../outside.txt" })).toMatchObject({ ok: false })
    symlinkSync(join(outside, "outside.txt"), join(root, "escape.txt"))
    expect(tools.execute("read", { path: "escape.txt" })).toMatchObject({ ok: false })
    expect(tools.execute("write", { path: "escape.txt", content: "changed" })).toMatchObject({ ok: false })
    expect(readFileSync(join(outside, "outside.txt"), "utf8")).toBe("outside sentinel")
  })

  test("refuses intermediate symlink paths for file content operations", () => {
    mkdirSync(join(root, "actual"))
    writeFileSync(join(root, "actual", "data.txt"), "inside sentinel")
    writeFileSync(join(outside, "data.txt"), "outside sentinel")
    symlinkSync(join(root, "actual"), join(root, "inside-link"))
    symlinkSync(outside, join(root, "outside-link"))

    for (const link of ["inside-link", "outside-link"]) {
      const filePath = `${link}/data.txt`
      expect(tools.execute("read", { path: filePath })).toMatchObject({ ok: false })
      expect(tools.execute("grep", { pattern: "sentinel", path: filePath })).toMatchObject({ ok: false })
      expect(tools.execute("write", { path: filePath, content: "changed" })).toMatchObject({ ok: false })
      expect(tools.execute("edit", { path: filePath, oldText: "sentinel", newText: "changed" })).toMatchObject({ ok: false })
      expect(tools.execute("write", { path: `${link}/new.txt`, content: "created" })).toMatchObject({ ok: false })
      expect(tools.execute("list", { path: link })).toMatchObject({ ok: false })
      expect(tools.execute("grep", { pattern: "sentinel", path: link })).toMatchObject({ ok: false })
    }

    expect(readFileSync(join(root, "actual", "data.txt"), "utf8")).toBe("inside sentinel")
    expect(readFileSync(join(outside, "data.txt"), "utf8")).toBe("outside sentinel")
    expect(existsSync(join(root, "actual", "new.txt"))).toBe(false)
    expect(existsSync(join(outside, "new.txt"))).toBe(false)
  })

  test("refuses a renamed and replaced worktree root", () => {
    writeFileSync(join(root, "data.txt"), "original root")
    const displacedRoot = `${root}-displaced`
    try {
      renameSync(root, displacedRoot)
      mkdirSync(root)
      writeFileSync(join(root, "data.txt"), "replacement root")

      expect(tools.execute("read", { path: "data.txt" })).toMatchObject({ ok: false })
    } finally {
      rmSync(displacedRoot, { recursive: true, force: true })
    }
  })

  test("refuses unsupported platforms", () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "freebsd" })
      expect(() => createCliTools({ root, role: "worker", allowed: ["read"], denied: [] })).toThrow()
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor)
    }
  })

  test("rejects hard-linked credential contents through read and grep paths", () => {
    const sentinel = "hard-link-credential-sentinel"
    writeFileSync(join(root, ".env"), sentinel)
    linkSync(join(root, ".env"), join(root, "config.txt"))

    const directRead = tools.execute("read", { path: "config.txt" })
    const recursiveSearch = tools.execute("grep", { pattern: sentinel, path: "." })
    const aliasSearch = tools.execute("grep", { pattern: sentinel, path: "config.txt" })

    for (const result of [directRead, recursiveSearch, aliasSearch]) {
      expect(result.ok).toBe(false)
      expect(text(result)).not.toContain(sentinel)
    }
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(sentinel)
  })

  test("glob and grep skip protected and ignored directories", () => {
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, ".otter"))
    mkdirSync(join(root, "node_modules"))
    mkdirSync(join(root, "ignored"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, ".gitignore"), "ignored/\n")
    for (const path of [".git/private.txt", ".otter/private.txt", "node_modules/private.txt", "ignored/private.txt", "src/visible.txt"]) {
      writeFileSync(join(root, path), "needle")
    }
    const glob = text(tools.execute("glob", { pattern: "**/*.txt" }))
    const grep = text(tools.execute("grep", { pattern: "needle" }))
    expect(glob).toContain("src/visible.txt")
    expect(grep).toContain("src/visible.txt")
    for (const hidden of [".git/private.txt", ".otter/private.txt", "node_modules/private.txt", "ignored/private.txt"]) {
      expect(glob).not.toContain(hidden)
      expect(grep).not.toContain(hidden)
    }
  })

  test("large reads are refused and glob results are byte bounded", () => {
    writeFileSync(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61))
    for (let index = 0; index < 200; index++) {
      const name = `${String(index).padStart(3, "0")}-${"x".repeat(190)}.txt`
      writeFileSync(join(root, name), "x")
    }
    expect(tools.execute("read", { path: "large.txt" })).toMatchObject({ ok: false })
    expect(tools.execute("grep", { pattern: "a", path: "large.txt" })).toMatchObject({ ok: false })
    const result = text(tools.execute("glob", { pattern: "**/*" }))
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(32 * 1024)
    expect(result).toContain("tool output truncated")
  })

  test("main and reviewer roles are independently read-only", () => {
    for (const role of ["main", "reviewer"] as const) {
      const readonly = createCliTools({ root, role, allowed: ["read", "write", "edit"], denied: [] })
      expect(readonly.available).toContain("read")
      expect(readonly.available).not.toContain("write")
      expect(readonly.available).not.toContain("edit")
      expect(readonly.execute("write", { path: "new.txt", content: "blocked" })).toMatchObject({ ok: false })
      expect(existsSync(join(root, "new.txt"))).toBe(false)
    }
  })
})


test("model_api requires a gated main capability, validates input and never executes through file tools", () => {
  const input = { target: "local", model: "test:latest", prompt: "review this" }
  const api = createCliTools({ root, role: "main", allowed: ["model_api"], denied: [], actionGate: true, modelApi: true })
  expect(api.available).toContain("model_api")
  expect(api.validate("model_api", input)).toBe(true)
  expect(api.execute("model_api", input)).toEqual({ ok: false, error: "Tool refused: model API calls run through the host approval gate." })
  for (const bad of [ { ...input, url: "https://unapproved.example" }, { ...input, apiKeyEnv: "SECRET" },
    { ...input, prompt: "a".repeat(16385) }, { ...input, maxOutputTokens: 4097 }, { ...input, timeoutSeconds: 601 },
    { ...input, model: "bad\nmodel" }, { ...input, target: "../local" } ]) expect(api.validate("model_api", bad)).toBe(false)
  for (const options of [ { role: "main" as const, actionGate: false, modelApi: true, denied: [] },
    { role: "main" as const, actionGate: true, modelApi: false, denied: [] },
    { role: "worker" as const, actionGate: true, modelApi: true, denied: [] },
    { role: "main" as const, actionGate: true, modelApi: true, denied: ["model_api"] } ]) {
    const denied = createCliTools({ root, allowed: ["model_api"], ...options })
    expect(denied.available).not.toContain("model_api")
    expect(denied.validate("model_api", input)).toBe(false)
  }
})
