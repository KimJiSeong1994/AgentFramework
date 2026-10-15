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
  root = mkdtempSync(join(tmpdir(), "lca-cli-tools-"))
  outside = mkdtempSync(join(tmpdir(), "lca-cli-tools-outside-"))
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
    for (const directory of [".git", ".lca", ".gjc"]) {
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
    mkdirSync(join(root, ".lca"))
    mkdirSync(join(root, "node_modules"))
    mkdirSync(join(root, "ignored"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, ".gitignore"), "ignored/\n")
    for (const path of [".git/private.txt", ".lca/private.txt", "node_modules/private.txt", "ignored/private.txt", "src/visible.txt"]) {
      writeFileSync(join(root, path), "needle")
    }
    const glob = text(tools.execute("glob", { pattern: "**/*.txt" }))
    const grep = text(tools.execute("grep", { pattern: "needle" }))
    expect(glob).toContain("src/visible.txt")
    expect(grep).toContain("src/visible.txt")
    for (const hidden of [".git/private.txt", ".lca/private.txt", "node_modules/private.txt", "ignored/private.txt"]) {
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
