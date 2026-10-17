// P6a S5: the bundled-workflow boundary. Otter owns its workflows end to end: no GJC process, path, import or executable
// instruction at runtime; protected names resolve only to the builtin descriptors; small descriptors are discovery-only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, relative } from "node:path"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents } from "../src/flow/state.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { PROTECTED_WORKFLOWS } from "../src/skills/roots.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { handoffToRalplan, runRalplan, startRalplan } from "../src/workflows/ralplan-driver.ts"
import { runDeepInterview, startDeepInterview, type DiAnswer, type DiIo } from "../src/workflows/deep-interview-driver.ts"
import { startAutoresearch } from "../src/workflows/autoresearch-driver.ts"
import { startUltragoal } from "../src/workflows/ultragoal-driver.ts"
import * as prompts from "../src/workflows/prompts/index.ts"
import { kindAllowsRole, startRefusal } from "../src/workflows/registry.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { fullScript, scriptedRuntime } from "./workflow-fixture.ts"

const FRAMEWORK = realpathSync(join(import.meta.dir, ".."))
const FORBIDDEN = /\bgjc\b|\.gjc\/|\/skill:|--stage_n|GJC_RALPLAN_ARTIFACT|otter_flow/i

let wt: ReturnType<typeof tempGitWorktree>
let stores: SessionStore[] = []
let counter = 0
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree); stores = [] })
afterEach(() => {
  stopHeartbeat()
  for (const store of stores.splice(0)) {
    try { store.release({ workflowQuiescent: true, evidence: "fixture awaited all session work", workflowID: null, revision: null }) } catch { /* discarded worktree */ }
  }
  wt.cleanup()
})

const answer = (text: string): DiAnswer => ({ kind: "answer", text })
const io = (answers: DiAnswer[]): DiIo => {
  const queue = [...answers]
  return { async choose() { return 0 }, async readAnswer() { return queue.shift() }, async readNote() { return undefined } }
}
function setup(script = fullScript()) {
  const SID = `ses_bw${counter++}`
  const fixture = scriptedRuntime(wt.worktree, script)
  stores.push(attachAdmission(fixture.runtime, SID, { engine: "local", model: "fixture-model" }))
  return { SID, ...fixture }
}

function exportedPrompts() {
  const unique = new Map<string, prompts.StagePrompt>()
  for (const value of Object.values(prompts).flatMap(item => (Array.isArray(item) ? item : [item]))) {
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { sha256?: unknown }).sha256 === "string") {
      unique.set((value as prompts.StagePrompt).id, value as prompts.StagePrompt)
    }
  }
  return [...unique.values()]
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe("no GJC at runtime", () => {
  test("a full DI -> ralplan run starts no gjc process, creates no .gjc state and touches no home directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "otter-bw-home-"))
    const bin = mkdtempSync(join(tmpdir(), "otter-bw-bin-"))
    const marker = join(bin, "gjc-was-run")
    writeFileSync(join(bin, "gjc"), `#!/bin/sh\necho run >> '${marker}'\nexit 97\n`)
    chmodSync(join(bin, "gjc"), 0o755)
    const previous = { PATH: process.env.PATH, HOME: process.env.HOME }
    process.env.PATH = `${bin}${delimiter}${previous.PATH ?? ""}`
    process.env.HOME = home
    try {
      const h = setup()
      const started = startDeepInterview(h.runtime, h.SID, "build the widget")
      if (!started.ok) throw new Error(started.text)
      const result = await runDeepInterview(h.runtime, h.SID, started.wf.id, io([answer("a1"), answer("a2")]), {
        handoff: (done, events) => {
          const handed = handoffToRalplan(h.runtime, h.SID, done, "build the widget", events)
          return handed.ok ? { ok: true, successor: handed.wf } : { ok: false, text: handed.text }
        },
      })
      expect(result.status).toBe("handed_off")
      const read = readCommitted(wt.worktree)
      expect(read.state === "ok" && read.wf.kind).toBe("ralplan")
      if (read.state === "ok") expect((await runRalplan(h.runtime, h.SID, read.wf.id)).status).toBe("pending_execution")
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(wt.worktree, ".gjc"))).toBe(false)
      expect(existsSync(join(home, ".gjc"))).toBe(false)
      expect(readdirSync(home)).toEqual([])
      expect(readEvents(wt.worktree).length).toBeGreaterThan(0)
    } finally {
      process.env.PATH = previous.PATH
      if (previous.HOME === undefined) delete process.env.HOME
      else process.env.HOME = previous.HOME
      rmSync(home, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test("no runtime source imports or spawns anything from the GJC reference or artifacts", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(FRAMEWORK, "src"))) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const specifier = match[1]!
        if (/gjc-reference|\/artifacts\/|^@gjc|gajae/i.test(specifier)) offenders.push(`${relative(FRAMEWORK, file)} imports ${specifier}`)
      }
      if (/(?:spawn|spawnSync|exec|execFile|execFileSync|Bun\.spawn)\s*\(\s*\[?\s*["'`]gjc["'`]/.test(text)) offenders.push(`${relative(FRAMEWORK, file)} spawns gjc`)
    }
    expect(offenders).toEqual([])
    const manifest = JSON.parse(readFileSync(join(FRAMEWORK, "package.json"), "utf8")) as { dependencies?: Record<string, string> }
    expect(Object.keys(manifest.dependencies ?? {}).some(name => /gjc|gajae/i.test(name))).toBe(false)
  })
})

describe("prompts and descriptors carry no executable GJC instructions", () => {
  test("every exported stage prompt is frozen, hash-intact, role-legal and free of GJC command or path text", () => {
    const all = exportedPrompts()
    expect(all.length).toBeGreaterThanOrEqual(18)
    for (const prompt of all) {
      expect(Object.isFrozen(prompt), prompt.id).toBe(true)
      expect(prompts.promptIntact(prompt), prompt.id).toBe(true)
      expect(kindAllowsRole(prompt.kind, prompt.role), `${prompt.id} (${prompt.kind}/${prompt.role})`).toBe(true)
      expect(FORBIDDEN.test(prompt.text), `${prompt.id} contains a forbidden token`).toBe(false)
    }
  })

  test("the protected descriptors are small discovery metadata with no executable text", () => {
    expect(PROTECTED_WORKFLOWS.map(item => item.name)).toEqual(["deep-interview", "ralplan", "ultragoal", "autoresearch"])
    for (const descriptor of PROTECTED_WORKFLOWS) {
      expect(Object.isFrozen(descriptor)).toBe(true)
      expect(descriptor.source).toBe("builtin")
      expect(descriptor.kind).toBe("protected-workflow")
      expect(descriptor.identity).toBe(`builtin:${descriptor.name}`)
      expect(descriptor.description.length).toBeLessThan(200)
      expect(FORBIDDEN.test(JSON.stringify(descriptor))).toBe(false)
      expect(Object.keys(descriptor).sort()).toEqual(["description", "identity", "kind", "name", "source", "workflow"])
    }
  })

  test("ATTRIBUTION names every exported prompt id and states Otter authorship", () => {
    const attribution = readFileSync(join(FRAMEWORK, "src/workflows/ATTRIBUTION"), "utf8")
    for (const prompt of exportedPrompts()) expect(attribution, prompt.id).toContain(`\`${prompt.id}\``)
    expect(attribution).toContain("no GJC bytes")
    expect(attribution).toContain("discovery-only")
  })
})

describe("protected names cannot be redirected", () => {
  test("two sessions starting a deep-interview back to back (serialized by the flow lock) commit exactly one; the loser observes", () => {
    const h = setup()
    const other = `ses_bw${counter++}`
    stores.push(attachAdmission(h.runtime, other, { engine: "local", model: "fixture-model" }))
    const first = startDeepInterview(h.runtime, h.SID, "one")
    const second = startDeepInterview(h.runtime, other, "two")
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const loser = first.ok ? second : first
    if (!loser.ok) expect(loser.text).toContain("is active")
    expect(readEvents(wt.worktree).filter(event => event.type === "created")).toHaveLength(1)
  })

  test("a ralplan start while a deep-interview is live is refused and the committed workflow is unchanged", () => {
    const h = setup()
    const first = startDeepInterview(h.runtime, h.SID, "build")
    if (!first.ok) throw new Error(first.text)
    const before = readCommitted(wt.worktree)
    const refused = startRalplan(h.runtime, h.SID, "plan")
    expect(refused.ok).toBe(false)
    expect(readCommitted(wt.worktree)).toEqual(before)
  })

  test("ultragoal and autoresearch names start exactly one owner kind and still grant no execution", () => {
    const h = setup()
    expect(startRefusal("ultragoal")).toBeUndefined()
    expect(startRefusal("autoresearch")).toBeUndefined()
    const ug = startUltragoal(h.runtime, h.SID, "ship")
    expect(ug.ok).toBe(true)
    expect(readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)).toEqual(["ultragoal"])
    expect(startAutoresearch(h.runtime, h.SID, "research")).toMatchObject({ ok: false })
  })

  test("model output that mentions /skill:ralplan starts nothing: output is parsed as typed stage events only", async () => {
    const script = fullScript()
    script["di.interviewer.topology"] = ["/skill:ralplan start now", "/skill:ralplan start now"]
    const h = setup(script)
    const started = startDeepInterview(h.runtime, h.SID, "build")
    if (!started.ok) throw new Error(started.text)
    const result = await runDeepInterview(h.runtime, h.SID, started.wf.id, io([]), {})
    expect(result.status).toBe("stuck")
    expect(readEvents(wt.worktree).filter(event => event.type === "created")).toHaveLength(1)
    const committed = readCommitted(wt.worktree)
    expect(committed.state === "ok" && committed.wf.kind).toBe("deep-interview")
  })
})
