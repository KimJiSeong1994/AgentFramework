import { isAbsolute, relative, resolve, sep } from "node:path"
import { isAuthenticSkillCapture, readCapturedFile, SkillCaptureError } from "./capture.ts"
import { skillDirectoryPath } from "./roots.ts"
import type { SkillCapture, SkillRoots } from "./types.ts"

export type CapturedSkillResource =
  | Readonly<{ kind: "file"; bytes: Uint8Array }>
  | Readonly<{ kind: "directory"; entries: readonly Readonly<{ name: string; type: "file" | "directory" | "symlink" }>[] }>

function below(root: string, path: string): string | undefined {
  const local = relative(root, path)
  return isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) ? undefined : local.split(sep).join("/")
}

/** Pure snapshot lookup, not path permission. The caller must already admit the real tool path and role. */
export function readCapturedSkillResource(roots: SkillRoots, capture: SkillCapture, absolutePath: string): CapturedSkillResource | undefined {
  if (!isAuthenticSkillCapture(capture) || capture.descriptor.kind !== "skill" || !isAbsolute(absolutePath)) {
    throw new SkillCaptureError("refused", "captured source resource identity is invalid")
  }
  const sourceRoot = capture.source === "project" ? roots.projectRoot : roots.homeDirectory
  if (!sourceRoot) throw new SkillCaptureError("refused", "captured source root is unavailable")
  const filePaths = new Set(capture.files.map(file => file.path))
  const areas = [{ disk: skillDirectoryPath(roots, capture.descriptor), logical: "", file: false }]
  for (const entry of capture.entries) {
    const prefix = `${capture.source}:`
    if (entry.type !== "symlink" || !entry.linkIdentity?.startsWith(prefix)) continue
    const disk = resolve(sourceRoot, entry.linkIdentity.slice(prefix.length))
    if (below(sourceRoot, disk) === undefined) throw new SkillCaptureError("refused", "captured link identity escaped its source root")
    areas.push({ disk, logical: entry.path === "." ? "" : entry.path, file: filePaths.has(entry.path) })
  }
  for (const area of areas.sort((left, right) => right.disk.length - left.disk.length)) {
    const suffix = below(area.disk, absolutePath)
    if (suffix === undefined || area.file && suffix !== "") continue
    const path = [area.logical, suffix].filter(Boolean).join("/") || "."
    const bytes = readCapturedFile(capture, path)
    if (bytes !== undefined) return Object.freeze({ kind: "file", bytes })
    if (!capture.entries.some(entry => entry.path === path && entry.type === "directory")) {
      throw new SkillCaptureError("refused", "source resource is absent from the captured snapshot")
    }
    const prefix = path === "." ? "" : `${path}/`
    const entries = new Map<string, { name: string; type: "file" | "directory" | "symlink" }>()
    for (const entry of capture.entries) {
      if (!entry.path.startsWith(prefix)) continue
      const name = entry.path.slice(prefix.length)
      if (!name || name === "." || name.includes("/")) continue
      if (!entries.has(name) || entry.type === "symlink") entries.set(name, Object.freeze({ name, type: entry.type }))
    }
    return Object.freeze({ kind: "directory", entries: Object.freeze([...entries.values()]) })
  }
  return undefined
}
