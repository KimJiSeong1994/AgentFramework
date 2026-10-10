import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TextPart, UserMessage } from "@opencode-ai/sdk"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { createOpenCodeSkillPermissionSource } from "../src/hosts/opencode-skill-source.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createSkillRouter } from "../src/routing/router.ts"
import { EMPTY_MODE, readModeState } from "../src/state/store.ts"

type RequestBody = Record<string, unknown>
type Handler = (request: Request) => Response | Promise<Response>

let root: string
let deps: HookDeps
let server: ReturnType<typeof Bun.serve>
let servers: Array<ReturnType<typeof Bun.serve>>
let requests: RequestBody[]
let logs: unknown[]
let rules: Array<{ permission: string; pattern: string; action: string }>
let handler: Handler
let agentLookup: () => Promise<unknown>

function answer(choice = "plan", probabilities: Record<string, number> = { plan: 0.99, none: 0.01 }) {
  return Response.json({ answers: { route: { type: "choice", choice, probabilities, confidence: 0.9 } } })
}

function skill(name: string, description = "Read-only investigation and numbered implementation plan.") {
  const dir = join(root, ".opencode", "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nPrivate skill instructions must never leave this machine.\n`)
}

function part(text: string, id = "m1", synthetic = false): TextPart {
  return { type: "text", text, id: `part-${id}`, messageID: id, sessionID: "s1", synthetic }
}

async function turn(hook: ReturnType<typeof createChatMessageHook>, p: TextPart, agent = "main") {
  await hook({ sessionID: p.sessionID, agent }, { parts: [p], message: { id: p.messageID } as UserMessage })
}

function createRouter() {
  return createSkillRouter(deps, createOpenCodeSkillPermissionSource(deps))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lca-router-redteam-"))
  requests = []
  logs = []
  servers = []
  rules = [
    { permission: "skill", pattern: "*", action: "deny" },
    { permission: "skill", pattern: "plan", action: "allow" },
  ]
  agentLookup = async () => ({ data: [{ name: "main", permission: rules }] })
  handler = () => answer()
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    requests.push(await request.clone().json() as RequestBody)
    return handler(request)
  } })
  servers.push(server)
  deps = {
    worktree: root,
    directory: root,
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      disabled_hooks: ["tool.delegate"],
      skills: { allow: ["plan"] },
      skill_router: { ...DEFAULT_CONFIG.skill_router, mode: "shadow", endpoint: `http://127.0.0.1:${server.port}` },
    },
    client: { app: { agents: () => agentLookup() } } as unknown as HookDeps["client"],
    log: (message, extra) => logs.push({ message, extra }),
  }
  skill("plan")
})

afterEach(() => {
  for (const instance of servers) instance.stop(true)
  rmSync(root, { recursive: true, force: true })
})

describe("skill router adversarial contract", () => {
  test("shadow is observational even when the router returns a confident winner", async () => {
    const capabilityReads: string[] = []
    const app = new Proxy({ agents: () => agentLookup() }, {
      get(target, property, receiver) {
        if (property === "agents") return Reflect.get(target, property, receiver)
        capabilityReads.push(String(property))
        return undefined
      },
    })
    deps.client = { app } as unknown as HookDeps["client"]

    const p = part("Explain the architecture; do not modify files or run tools.")
    const original = p.text
    await turn(createChatMessageHook(deps), p)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ state: original, samples: 1, steps: 1 })
    expect(p.text).toBe(original)
    expect(readModeState(root, "s1")).toEqual(EMPTY_MODE)
    expect(capabilityReads).toEqual([])
    expect(JSON.stringify(logs)).not.toContain(original)
  })

  test("a suggest result remains non-authoritative and invokes no execution capability", async () => {
    const capabilityReads: string[] = []
    const app = new Proxy({ agents: () => agentLookup() }, {
      get(target, property, receiver) {
        if (property === "agents") return Reflect.get(target, property, receiver)
        capabilityReads.push(String(property))
        return undefined
      },
    })
    deps.client = { app } as unknown as HookDeps["client"]
    deps.config.skill_router.mode = "suggest"

    const p = part("Please inspect the code without changes; no execution is authorized.")
    await turn(createChatMessageHook(deps), p)

    expect(p.text).toContain("optional advice, not a request to load a skill, change mode, or execute work")
    expect(p.text).not.toContain("<lca-mode")
    expect(readModeState(root, "s1")).toEqual(EMPTY_MODE)
    expect(capabilityReads).toEqual([])
  })

  test("child-agent role and latest skill deny override an otherwise winning route", async () => {
    deps.config.skill_router.mode = "suggest"
    const hook = createChatMessageHook(deps)
    const child = part("Investigate using the plan skill.", "child")
    await turn(hook, child, "reviewer")
    expect(child.text).not.toContain("lca-skill-advice")
    expect(requests).toHaveLength(0)

    rules.push({ permission: "skill", pattern: "plan", action: "deny" })
    const denied = part("Investigate using the plan skill.", "denied")
    await turn(hook, denied)
    expect(denied.text).not.toContain("lca-skill-advice")
    expect(requests).toHaveLength(0)

    rules.pop()
    handler = () => {
      rules.push({ permission: "skill", pattern: "plan", action: "deny" })
      return answer()
    }
    const revoked = await createRouter().recommend("s2", "revoked-in-flight", "Investigate")
    expect(revoked.skill).toBeNull()
    expect(revoked.reason).toBe("candidate_changed")
    expect(requests).toHaveLength(1)
  })

  test("unavailable, malformed and structurally inconsistent responses abstain without retry", async () => {
    const outcomes: Handler[] = [
      () => new Response("offline", { status: 503 }),
      () => new Response("busy", { status: 529 }),
      () => new Response("not-json"),
      () => Response.json({ answers: { route: { type: "choice", choice: "plan", probabilities: { plan: 1 }, confidence: 1 } } }),
      () => Response.json({ answers: { route: { type: "choice", choice: "plan", probabilities: { plan: 0.99, none: 0.01 }, confidence: 1.1 } } }),
    ]

    for (const [i, outcome] of outcomes.entries()) {
      handler = outcome
      const result = await createRouter().recommend("s1", `invalid-${i}`, "Investigate")
      expect(result.skill).toBeNull()
    }
    expect(requests).toHaveLength(outcomes.length)
  })

  test("explicit slash commands, synthetic messages and non-main turns bypass routing", async () => {
    deps.config.skill_router.mode = "suggest"
    const hook = createChatMessageHook(deps)
    await turn(hook, part("/skill:plan", "explicit"))
    await turn(hook, part("Investigate this module.", "synthetic", true))
    await turn(hook, part("Investigate this module.", "child"), "worker")
    expect(requests).toHaveLength(0)
  })

  test("a newer ordinary turn cancels prior advice before either message can receive it", async () => {
    deps.config.skill_router.mode = "suggest"
    let arrived!: () => void
    let release!: () => void
    const requestStarted = new Promise<void>((resolve) => { arrived = resolve })
    const heldResponse = new Promise<void>((resolve) => { release = resolve })
    handler = async () => {
      arrived()
      await heldResponse
      return answer()
    }

    const hook = createChatMessageHook(deps)
    const first = part("First request: investigate the parser.", "first")
    const firstText = first.text
    const pending = turn(hook, first)
    await requestStarted

    const newer = part("New request: investigate the renderer.", "newer")
    const newerText = newer.text
    await turn(hook, newer)
    release()
    await pending

    expect(requests).toHaveLength(1)
    expect(first.text).toBe(firstText)
    expect(newer.text).toBe(newerText)
    expect(first.text).not.toContain("lca-skill-advice")
    expect(newer.text).not.toContain("lca-skill-advice")
    expect(readModeState(root, "s1")).toEqual(EMPTY_MODE)
  })

  test("private skill frontmatter and file contents never enter the inference body", async () => {
    const privateOwner = "INTERNAL_OWNER_SENTINEL_7f91"
    const privateInstructions = "PRIVATE_SKILL_BODY_SENTINEL_52ad"
    writeFileSync(join(root, ".opencode", "skills", "plan", "SKILL.md"),
      `---\nname: plan\ndescription: Public routing summary.\ninternal_owner: ${privateOwner}\n---\n${privateInstructions}\n`)

    await turn(createChatMessageHook(deps), part("Give a short architecture summary."))

    const sent = JSON.stringify(requests)
    expect(requests).toHaveLength(1)
    expect(sent).not.toContain(privateOwner)
    expect(sent).not.toContain(privateInstructions)
    expect(sent).not.toContain(root)
    expect(sent).toContain("Public routing summary.")
  })

  test("common GitHub and cloud credentials in user text are withheld", async () => {
    const router = createRouter()
    const syntheticCredentials = [
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "AIzaSyD1234567890_abcdefghijklmnopqrstuvwxyz",
    ]
    for (const [i, credential] of syntheticCredentials.entries()) {
      const result = await router.recommend("s1", `credential-${i}`, `Investigate this issue; credential=${credential}`)
      expect(result.skill).toBeNull()
      expect(result.reason).toBe("sensitive_input")
    }
    expect(requests).toHaveLength(0)
  })

  test("a redirect to another loopback service is not followed", async () => {
    let destinationHits = 0
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      destinationHits++
      return answer()
    } })
    servers.push(destination)
    handler = () => Response.redirect(`http://127.0.0.1:${destination.port}/v1/systemone`)

    const result = await createRouter().recommend("s1", "redirect", "Investigate")

    expect(result.skill).toBeNull()
    expect(requests).toHaveLength(1)
    expect(destinationHits).toBe(0)
  })
})
