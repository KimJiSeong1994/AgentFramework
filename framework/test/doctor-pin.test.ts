// D12e opencode-pin: rows asserted from `otter-doctor.sh --json` over temp trees and a fake `opencode` on PATH.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DOCTOR = join(import.meta.dir, "..", "..", "scripts", "otter-doctor.sh")
const PIN = "1.18.32"
let root: string
let bin: string

function pkg(path: string, data: unknown) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}
function tree(opts: { framework?: string; installed?: string | null; opencodeBin?: string | null } = {}) {
  const fw = opts.framework ?? PIN
  pkg(join(root, "framework/package.json"), { dependencies: { "@opencode-ai/plugin": fw, "@opencode-ai/sdk": fw } })
  pkg(join(root, ".opencode/package.json"), { dependencies: { "@opencode-ai/plugin": PIN } })
  if (opts.installed !== null) {
    const v = opts.installed ?? PIN
    pkg(join(root, "framework/node_modules/@opencode-ai/plugin/package.json"), { version: v })
    pkg(join(root, "framework/node_modules/@opencode-ai/sdk/package.json"), { version: v })
  }
  pkg(join(root, ".opencode/node_modules/@opencode-ai/plugin/package.json"), { version: PIN })
  if (opts.opencodeBin !== null) {
    writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho ${opts.opencodeBin ?? PIN}\n`)
    chmodSync(join(bin, "opencode"), 0o755)
  }
}
function rows(only = "D12e") {
  const r = spawnSync("bash", [DOCTOR, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, OTTER_DOCTOR_ONLY: only, OTTER_DOCTOR_ROOT: root },
  })
  return (JSON.parse(r.stdout).checks as Array<{ status: string; id: string; observed: string }>)
}
/** No OTTER_DOCTOR_ONLY at all (unset, not empty-string): the fast-path filter must not short-circuit an unfiltered run. */
function rowsUnfiltered() {
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, OTTER_DOCTOR_ROOT: root }
  delete (env as Record<string, string | undefined>).OTTER_DOCTOR_ONLY
  const r = spawnSync("bash", [DOCTOR, "--json"], { encoding: "utf8", env })
  return (JSON.parse(r.stdout).checks as Array<{ status: string; id: string; observed: string }>)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-doctor-root-"))
  bin = mkdtempSync(join(tmpdir(), "otter-doctor-bin-"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }) })

test("PASS when all five sources are on the pin", () => {
  tree()
  expect(rows()).toEqual([expect.objectContaining({ id: "D12e", status: "PASS" })])
})

test("WARN names the opencode binary when it reports a newer version", () => {
  tree({ opencodeBin: "1.18.33" })
  const [row] = rows()
  expect(row).toMatchObject({ id: "D12e", status: "WARN" })
  expect(row!.observed).toContain("opencode:1.18.33")
})

test("WARN names framework/package.json when it still declares 1.18.31", () => {
  tree({ framework: "1.18.31" })
  const [row] = rows()
  expect(row!.status).toBe("WARN")
  expect(row!.observed).toContain("framework/package.json:plugin:1.18.31")
  expect(row!.observed).toContain("framework/package.json:sdk:1.18.31")
})

test("WARN reports a missing node_modules copy as not installed", () => {
  tree({ installed: null })
  const [row] = rows()
  expect(row!.status).toBe("WARN")
  expect(row!.observed).toContain("framework/node_modules:plugin:not-installed")
})

test("D01 below MIN stays WARN (unchanged semantics)", () => {
  tree({ opencodeBin: "1.18.30" })
  expect(rows("D01")).toEqual([expect.objectContaining({ id: "D01", status: "WARN" })])
})

test("an unfiltered run (no OTTER_DOCTOR_ONLY) does not short-circuit after D01/D12e", () => {
  tree()
  const ids = rowsUnfiltered().map((r) => r.id)
  expect(ids).toContain("D01")
  expect(ids).toContain("D12e")
  expect(ids).toContain("D02")
})
