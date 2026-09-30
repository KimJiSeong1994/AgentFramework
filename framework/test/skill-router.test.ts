import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TextPart, UserMessage } from "@opencode-ai/sdk"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createSkillRouter } from "../src/routing/router.ts"
import { createCommandHook } from "../src/hooks/command.ts"
import { EMPTY_MODE, readModeState, writeModeState } from "../src/state/store.ts"

let root: string
let deps: HookDeps
let server: ReturnType<typeof Bun.serve>
let requests: unknown[]
let logs: unknown[]
let rules: Array<{ permission: string; pattern: string; action: string }>
let handler: (request: Request) => Response | Promise<Response>
let agentLookup: () => Promise<unknown>

function answer(choice = "plan", probabilities = { plan: 0.99, none: 0.01 }) {
  return { answers: { route: { type: "choice", choice, probabilities, confidence: 0.9 } } }
}
function skill(name: string, description = "Read-only investigation and numbered implementation plan.", base: ".opencode" | ".agents" = ".opencode") {
  const dir = join(root, base, "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nPrivate skill instructions must not be sent.\n`)
}
function part(text: string, id = "msg1", synthetic = false): TextPart {
  return { type: "text", text, id: `part-${id}`, messageID: id, sessionID: "s1", synthetic }
}
async function turn(hook: ReturnType<typeof createChatMessageHook>, p: TextPart, agent = "main") {
  await hook({ sessionID: p.sessionID, agent }, { parts: [p], message: { id: p.messageID } as UserMessage })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lca-router-"))
  requests = []; logs = []
  rules = [{ permission: "skill", pattern: "*", action: "deny" }, { permission: "skill", pattern: "plan", action: "allow" }]
  agentLookup = async () => ({ data: [{ name: "main", permission: rules }] })
  handler = () => Response.json(answer())
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    requests.push(await request.clone().json())
    return handler(request)
  } })
  deps = {
    worktree: root, directory: root,
    config: { ...structuredClone(DEFAULT_CONFIG), disabled_hooks: ["tool.delegate"], skills: { allow: ["plan"] },
      skill_router: { ...DEFAULT_CONFIG.skill_router, mode: "shadow", endpoint: `http://127.0.0.1:${server.port}` } },
    client: { app: { agents: () => agentLookup() } } as unknown as HookDeps["client"],
    log: (message, extra) => logs.push({ message, extra }),
  }
  skill("plan")
})
afterEach(() => { server.stop(true); rmSync(root, { recursive: true, force: true }) })

describe("OpenJev skill router package", () => {
  test("shadow sends only bounded metadata and never changes text or mode", async () => {
    const p = part("Investigate authentication and provide numbered implementation steps, without edits.")
    const original = p.text
    await turn(createChatMessageHook(deps), p)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ model: "jev-latest", samples: 1, steps: 1, state: original })
    expect(JSON.stringify(requests)).not.toContain("Private skill instructions")
    expect(p.text).toBe(original)
    expect(readModeState(root, "s1")).toEqual(EMPTY_MODE)
    expect(JSON.stringify(logs)).toContain('"reason":"recommended"')
    expect(JSON.stringify(logs)).not.toContain(original)
  })

  test("suggest is optional advice only, idempotent per message", async () => {
    deps.config.skill_router.mode = "suggest"
    const hook = createChatMessageHook(deps)
    const p = part("Investigate architecture and give numbered implementation steps.")
    await turn(hook, p)
    expect(p.text).toContain("<lca-skill-advice>")
    expect(p.text).not.toContain("<lca-mode")
    expect(readModeState(root, "s1")).toEqual(EMPTY_MODE)
    await turn(hook, p)
    expect(p.text.split("<lca-skill-advice>")).toHaveLength(2)
    expect(requests).toHaveLength(1)
  })

  test("off, explicit commands, child agents, synthetic turns and active modes bypass inference", async () => {
    const hook = createChatMessageHook(deps)
    await turn(hook, part("/stop"))
    await turn(hook, part("/skill:plan", "m2"))
    await turn(hook, part("Investigate", "m3"), "worker")
    await turn(hook, part("Investigate", "m4", true))
    await turn(hook, part("ulw fix it", "m5"))
    await turn(hook, part("continue", "m6"))
    writeModeState(root, "s1", EMPTY_MODE)
    deps.config.skill_router.mode = "off"
    await turn(hook, part("Investigate", "m7"))
    expect(requests).toHaveLength(0)
  })

  test("an expanded command template (no literal slash) is not routed; the next plain turn is", async () => {
    const hook = createChatMessageHook(deps)
    const command = createCommandHook(deps, { stop: false })
    await command({ command: "review", sessionID: "s1", arguments: "" } as any, { parts: [] } as any)
    await turn(hook, part("Investigate the auth module and give numbered implementation steps.", "c1"))
    expect(requests).toHaveLength(0)
    await turn(hook, part("Investigate the auth module and give numbered implementation steps.", "c2"))
    expect(requests).toHaveLength(1)
  })

  test("back-to-back commands each keep their bypass; a worker turn consumes nothing extra", async () => {
    const hook = createChatMessageHook(deps)
    const command = createCommandHook(deps, { stop: false })
    await command({ command: "a", sessionID: "s1", arguments: "" } as any, { parts: [] } as any)
    await command({ command: "b", sessionID: "s1", arguments: "" } as any, { parts: [] } as any)
    await turn(hook, part("Investigate the auth module and give numbered implementation steps.", "d1"))
    await turn(hook, part("Investigate the auth module and give numbered implementation steps.", "d2"))
    expect(requests).toHaveLength(0)
    await command({ command: "c", sessionID: "s1", arguments: "" } as any, { parts: [] } as any)
    await turn(hook, part("Investigate", "d3"), "worker")
    await turn(hook, part("Investigate the auth module and give numbered implementation steps.", "d4"))
    expect(requests).toHaveLength(1)
  })

  test("invalid router config is reported as invalid_config, never a silent off", async () => {
    deps.config.skill_router.timeout_ms = 5000
    expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("invalid_config")
    expect(JSON.stringify(logs)).toContain("timeout_ms")
    expect(requests).toHaveLength(0)
  })

  test("secrets and oversized input are not transmitted", async () => {
    const router = createSkillRouter(deps)
    for (const [i, text] of ["apikey_abcdefghijklmnopqrstuvwxyz", "Bearer privatecredential", "password=secretpassword", "x".repeat(2001)].entries()) {
      expect((await router.recommend("s1", String(i), text)).skill).toBeNull()
    }
    expect(requests).toHaveLength(0)
  })

  test("network endpoints and redirects are refused", async () => {
    deps.config.skill_router.endpoint = "http://user:pw@192.168.0.51:8080"
    expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("invalid_endpoint")
    expect(JSON.stringify(logs)).toContain('"reason":"invalid_endpoint"')
    expect(JSON.stringify(logs)).not.toContain("192.168.0.51")
    expect(JSON.stringify(logs)).not.toContain("pw@")
    expect(requests).toHaveLength(0)
    deps.config.skill_router.endpoint = `http://127.0.0.1:${server.port}`
    handler = () => Response.redirect("http://example.com")
    expect((await createSkillRouter(deps).recommend("s", "m2", "Investigate")).skill).toBeNull()
    expect(requests).toHaveLength(1)
  })

  test("latest permissions deny, ask and unsupported rules cannot widen access", async () => {
    for (const action of ["deny", "ask"]) {
      rules.push({ permission: "skill", pattern: "plan", action })
      expect((await createSkillRouter(deps).recommend("s", action, "Investigate")).reason).toBe("no_candidates")
    }
    expect(requests).toHaveLength(0)
  })

  test("global permission revocation wins while unrelated bash patterns do not hide skills", async () => {
    rules.unshift({ permission: "bash", pattern: "git *", action: "ask" })
    expect((await createSkillRouter(deps).recommend("s", "first", "Investigate")).skill).toBe("plan")
    rules.push({ permission: "*", pattern: "*", action: "deny" })
    expect((await createSkillRouter(deps).recommend("s", "second", "Investigate")).reason).toBe("no_candidates")
  })

  test("missing, mismatched and escaping skill files are excluded", async () => {
    rmSync(join(root, ".opencode", "skills", "plan"), { recursive: true })
    expect((await createSkillRouter(deps).recommend("s", "a", "Investigate")).reason).toBe("no_candidates")
    const external = mkdtempSync(join(tmpdir(), "lca-external-"))
    try {
      writeFileSync(join(external, "SKILL.md"), "---\nname: plan\ndescription: External\n---\n")
      symlinkSync(external, join(root, ".opencode", "skills", "plan"))
      expect((await createSkillRouter(deps).recommend("s", "b", "Investigate")).reason).toBe("no_candidates")
    } finally { rmSync(external, { recursive: true, force: true }) }
    expect(requests).toHaveLength(0)
  })

  test("invalid labels, numbers, distributions and winners abstain", async () => {
    const bad = [
      answer("ulw"), answer("plan", { plan: 0.2, none: 0.8 }), answer("plan", { plan: 0.9, none: 0.9 }),
      answer("plan", { plan: -1, none: 2 }), answer("plan", { plan: NaN, none: 0 }),
      { answers: {} }, answer("plan", { plan: 0.99, none: 0.01, malicious: 0 } as any),
    ]
    for (const [i, value] of bad.entries()) {
      handler = () => Response.json(value)
      expect((await createSkillRouter(deps).recommend("s", String(i), "Investigate")).skill).toBeNull()
    }
  })

  test("none and low margins are abstentions, not forced winners", async () => {
    for (const value of [answer("none", { plan: 0.01, none: 0.99 }), answer("plan", { plan: 0.51, none: 0.49 })]) {
      handler = () => Response.json(value)
      expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("abstained")
    }
  })

  test("permission changes during inference suppress a previously allowed winner", async () => {
    handler = () => { rules.push({ permission: "skill", pattern: "plan", action: "deny" }); return Response.json(answer()) }
    expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("candidate_changed")
  })

  test("503, 529, invalid JSON and oversized responses do not retry", async () => {
    for (const response of [new Response("down", { status: 503 }), new Response("busy", { status: 529 }), new Response("not-json"), new Response("x".repeat(65537))]) {
      handler = () => response
      expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).skill).toBeNull()
    }
    expect(requests).toHaveLength(4)
  })

  test("deadline covers stalled host discovery, not only HTTP inference", async () => {
    deps.config.skill_router.timeout_ms = 50
    agentLookup = () => new Promise(() => {})
    const start = performance.now()
    expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("aborted")
    expect(performance.now() - start).toBeLessThan(500)
    expect(requests).toHaveLength(0)
  })

  test("deadline covers an incomplete HTTP body", async () => {
    deps.config.skill_router.timeout_ms = 50
    handler = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')) },
    }))
    const start = performance.now()
    expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("aborted")
    expect(performance.now() - start).toBeLessThan(500)
    expect(requests).toHaveLength(1)
  })

  test("unknown host permission schema and disabled skill tools abstain", async () => {
    for (const data of [
      [{ name: "main", permission: { skill: "allow" } }],
      [{ name: "main", permission: rules, tools: { skill: false } }],
      [{ name: "worker", permission: rules }],
    ]) {
      agentLookup = async () => ({ data })
      expect((await createSkillRouter(deps).recommend("s", "m", "Investigate")).reason).toBe("no_candidates")
    }
    expect(requests).toHaveLength(0)
  })

  test("unsupported skill patterns, oversized catalogs and mismatched metadata abstain", async () => {
    rules.push({ permission: "skill", pattern: "[p]*", action: "allow" })
    expect((await createSkillRouter(deps).recommend("s", "a", "Investigate")).reason).toBe("no_candidates")
    rules.pop()
    deps.config.skills.allow = Array.from({ length: 17 }, (_, i) => `skill${i}`)
    expect((await createSkillRouter(deps).recommend("s", "b", "Investigate")).reason).toBe("no_candidates")
    deps.config.skills.allow = ["plan"]
    writeFileSync(join(root, ".opencode", "skills", "plan", "SKILL.md"), "---\nname: ulw\ndescription: Do work\n---\n")
    expect((await createSkillRouter(deps).recommend("s", "c", "Investigate")).reason).toBe("no_candidates")
    expect(requests).toHaveLength(0)
  })

  test("one in-flight call, no queue, stale advice discarded on /stop", async () => {
    deps.config.skill_router.mode = "suggest"
    let arrived!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => { arrived = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    handler = async () => { arrived(); await held; return Response.json(answer()) }
    const hook = createChatMessageHook(deps)
    const p = part("Investigate architecture and give implementation steps.")
    const pending = turn(hook, p)
    await ready
    const other = part("Investigate another module", "other")
    other.sessionID = "s2"
    await turn(hook, other)
    expect(requests).toHaveLength(1)
    await turn(hook, part("/stop", "stop"))
    release()
    await pending
    expect(p.text).not.toContain("lca-skill-advice")
    expect(other.text).not.toContain("lca-skill-advice")
    expect(readModeState(root, "s1").stopReason).toBe("user_cancel")
  })

  test("a skill defined only under .agents/skills is found", async () => {
    rmSync(join(root, ".opencode", "skills", "plan"), { recursive: true })
    skill("plan", "Read-only investigation and numbered implementation plan.", ".agents")
    expect((await createSkillRouter(deps).recommend("s", "a", "Investigate")).skill).toBe("plan")
  })

  test("a name defined in both .opencode/skills and .agents/skills is excluded as ambiguous", async () => {
    skill("plan", "Read-only investigation and numbered implementation plan.", ".agents")
    expect((await createSkillRouter(deps).recommend("s", "a", "Investigate")).reason).toBe("no_candidates")
  })

  test("an escaping symlink under .agents/skills is excluded like under .opencode/skills", async () => {
    rmSync(join(root, ".opencode", "skills", "plan"), { recursive: true })
    const external = mkdtempSync(join(tmpdir(), "lca-external-agents-"))
    try {
      writeFileSync(join(external, "SKILL.md"), "---\nname: plan\ndescription: External\n---\n")
      mkdirSync(join(root, ".agents", "skills"), { recursive: true })
      symlinkSync(external, join(root, ".agents", "skills", "plan"))
      expect((await createSkillRouter(deps).recommend("s", "b", "Investigate")).reason).toBe("no_candidates")
    } finally { rmSync(external, { recursive: true, force: true }) }
    expect(requests).toHaveLength(0)
  })
})
