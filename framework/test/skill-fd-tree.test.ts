import { afterEach, describe, expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { captureSkill } from "../src/skills/capture.ts"
import { FdTree, FdTreeError } from "../src/skills/fd-tree.ts"
import { discoverSkills, resolveSkillRoots } from "../src/skills/roots.ts"

const sandboxes: string[] = []

function sandbox(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-fd-tree-")))
  sandboxes.push(path)
  return path
}

function addSkill(projectRoot: string, name: string, body: string): void {
  const directory = join(projectRoot, ".agents", "skills", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture.\n---\n`)
  writeFileSync(join(directory, "payload.txt"), body)
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("checked FD skill tree", () => {
  test("unrelated siblings do not invalidate the root anchor but root contents still do", () => {
    const parent = sandbox()
    const boundary = join(parent, "boundary")
    mkdirSync(boundary)
    writeFileSync(join(boundary, "payload.txt"), "stable bytes")
    const tree = FdTree.openRoot(boundary)
    try {
      expect(tree.readFileRelative("payload.txt").bytes.toString()).toBe("stable bytes")
      mkdirSync(join(parent, "unrelated-sibling"))
      writeFileSync(join(parent, "unrelated.txt"), "outside the capture boundary")
      expect(() => tree.assertStable()).not.toThrow()
      writeFileSync(join(boundary, "new-entry.txt"), "inside the capture boundary")
      expect(() => tree.assertStable()).toThrow(FdTreeError)
    } finally { tree.close() }
  })

  test("replacing the parent anchor still invalidates an otherwise unchanged held root", () => {
    const base = sandbox()
    const parent = join(base, "parent")
    const boundary = join(parent, "boundary")
    mkdirSync(boundary, { recursive: true })
    const tree = FdTree.openRoot(boundary)
    try {
      renameSync(parent, join(base, "retained-parent"))
      mkdirSync(boundary, { recursive: true })
      expect(() => tree.assertStable()).toThrow(FdTreeError)
    } finally { tree.close() }
  })

  test("refuses an external regular-file inode hard-linked into the source boundary", () => {
    const root = sandbox()
    const boundary = join(root, "boundary")
    mkdirSync(boundary)
    const outside = join(root, "external.txt")
    writeFileSync(outside, "outside bytes must not become a source snapshot")
    linkSync(outside, join(boundary, "reference.txt"))
    const tree = FdTree.openRoot(boundary)
    try {
      expect(() => tree.readFileRelative("reference.txt")).toThrow("hard-linked")
    } finally { tree.close() }
  })

  test("enumerates a retained directory after its pathname is replaced by an external symlink", () => {
    const root = sandbox()
    const original = join(root, "candidate")
    const renamed = join(root, "candidate-held")
    const external = join(root, "outside")
    mkdirSync(original)
    mkdirSync(external)
    writeFileSync(join(original, "inside.txt"), "inside")
    writeFileSync(join(original, "é.txt"), "unicode")
    writeFileSync(join(external, "secret-name.txt"), "external payload")

    const tree = FdTree.openRoot(root)
    try {
      const held = tree.openDirectoryRelative("candidate")
      renameSync(original, renamed)
      symlinkSync(external, original)

      const entries = tree.list(held)
      const names = entries.map((entry) => entry.name)
      expect(names).toEqual(["inside.txt", "é.txt"])
      expect(names).not.toContain("secret-name.txt")
      const unicodeEntry = entries.find((entry) => entry.name === "é.txt")!
      expect(unicodeEntry.rawName).toEqual(Buffer.from("é.txt"))
      expect(tree.readFileAt(held, unicodeEntry).bytes.toString("utf8")).toBe("unicode")
      expect(() => tree.assertStable()).toThrow(FdTreeError)
    } finally {
      tree.close()
    }
  })

  test("classifies an internal link from its held parent and identifies an external target without reading it", () => {
    const root = sandbox()
    const boundary = join(root, "boundary")
    const outside = join(root, "outside")
    mkdirSync(join(boundary, "inside"), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(boundary, "inside", "data.txt"), "internal payload")
    writeFileSync(join(outside, "secret.txt"), "external payload")
    symlinkSync("inside/data.txt", join(boundary, "internal-link"))
    symlinkSync(join(outside, "secret.txt"), join(boundary, "external-link"))

    const tree = FdTree.openRoot(boundary)
    try {
      const internal = tree.resolveLinkAt(tree.root, "internal-link")
      expect(internal.internal).toBe(true)
      expect(internal.relativeTarget).toBe("inside/data.txt")
      expect(tree.readFileRelative(internal.relativeTarget!).bytes.toString("utf8")).toBe("internal payload")

      const external = tree.resolveLinkAt(tree.root, "external-link")
      expect(external.internal).toBe(false)
      expect(external.canonicalTarget).toBe(realpathSync(join(outside, "secret.txt")))
      tree.assertStable()
    } finally {
      tree.close()
    }
  })

  test("fails closed on symlink cycles and closes the held tree after errors", () => {
    const root = sandbox()
    symlinkSync("cycle", join(root, "cycle"))
    const tree = FdTree.openRoot(root)
    try {
      expect(() => tree.resolveLinkAt(tree.root, "cycle")).toThrow(FdTreeError)
      expect(tree.list(tree.root).map((entry) => entry.name)).toEqual(["cycle"])
    } finally {
      tree.close()
    }
    expect(() => tree.list(tree.root)).toThrow(FdTreeError)
  })

  test("refuses a resolved project root replaced by a symlink before discovery or capture can consume external skills", async () => {
    const root = sandbox()
    const project = join(root, "project")
    const retained = join(root, "project-retained")
    const external = join(root, "external")
    mkdirSync(project)
    mkdirSync(external)
    addSkill(project, "root-escape", "authorized project payload")
    addSkill(external, "root-escape", "external payload must not be captured")

    const roots = await resolveSkillRoots({ projectRoot: project })
    const selected = (await discoverSkills(roots)).descriptors.find((descriptor) => descriptor.name === "root-escape")
    expect(selected?.kind).toBe("skill")

    renameSync(project, retained)
    symlinkSync(external, project)

    const discovery = await discoverSkills(roots)
    expect(discovery.descriptors.some((descriptor) => descriptor.name === "root-escape")).toBe(false)
    expect(discovery.refusals.some((refusal) => refusal.source === "project" && refusal.reason === "raced")).toBe(true)
    await expect(captureSkill(roots, selected!)).rejects.toMatchObject({ reason: "refused" })
  })

  test("refuses a different directory inode installed at the pinned project-root path", async () => {
    const root = sandbox()
    const project = join(root, "project")
    const retained = join(root, "project-retained")
    mkdirSync(project)
    addSkill(project, "authorized-root", "authorized payload")
    const roots = await resolveSkillRoots({ projectRoot: project })

    renameSync(project, retained)
    mkdirSync(project)
    addSkill(project, "replacement-root", "replacement payload must not be consumed")

    const discovery = await discoverSkills(roots)
    expect(discovery.descriptors.some((descriptor) => descriptor.name === "replacement-root")).toBe(false)
    expect(discovery.refusals.some((refusal) => refusal.source === "project" && refusal.reason === "raced")).toBe(true)
  })
})
