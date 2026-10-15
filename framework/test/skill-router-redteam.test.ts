import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TextPart, UserMessage } from "@opencode-ai/sdk"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { createOpenCodeSystemTransformHook, UnsafeOpenCodeSystemChannel, type UnsafeOpenCodeSystemReason } from "../src/hosts/opencode-system.ts"
import { createOpenCodeSkillPermissionSource } from "../src/hosts/opencode-skill-source.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createSkillRouter } from "../src/routing/router.ts"
import { effectiveHold, holdAdmission } from "../src/sessions/admission.ts"
import { EMPTY_MODE, modeStatePath, readModeState, sessionInfoPath } from "../src/state/store.ts"
import { activateSkillCampaign, listSkillObservations, skillObservationBindingHash } from "../src/telemetry/skills.ts"
import { admitFixtureSession, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"
import { routingLogPath } from "../src/telemetry/routing.ts"

type RequestBody = Record<string, unknown>
type Handler = (request: Request) => Response | Promise<Response>

let root: string
let wt: ReturnType<typeof tempWorktree>
let deps: HookDeps
let server: ReturnType<typeof Bun.serve>
let servers: Array<ReturnType<typeof Bun.serve>>
let requests: RequestBody[]
let logs: unknown[]
let rules: Array<{ permission: string; pattern: string; action: string }>
let handler: Handler
let agentLookup: () => Promise<unknown>
let fixtureSessions: Array<ReturnType<typeof admitFixtureSession>>

function admitSession(sessionID: string) {
  const store = admitFixtureSession(deps, sessionID)
  fixtureSessions.push(store)
  return store
}

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

async function turn(
  hook: ReturnType<typeof createChatMessageHook>,
  p: TextPart,
  agent = "main",
  messageAgent: string | null = agent,
  system?: string,
) {
  const message: UserMessage = {
    id: p.messageID,
    sessionID: p.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: messageAgent ?? agent,
    model: { providerID: "fixture", modelID: "skill-router-redteam-test" },
    ...(system === undefined ? {} : { system }),
  }
  if (messageAgent === null) delete (message as Partial<UserMessage>).agent
  await hook({ sessionID: p.sessionID, agent, model: message.model }, { parts: [p], message })
}

async function createNativeChatHook() {
  await createConfigHook(deps)({})
  if (!fixtureSessions.some((store) => store.sessionID === "s1")) admitSession("s1")
  return createChatMessageHook(deps)
}

async function expectUnsafeTurn(promise: Promise<unknown>, reason: UnsafeOpenCodeSystemReason) {
  const error = await promise.then(
    () => { throw new Error(`Expected OpenCode system-channel refusal: ${reason}`) },
    (rejection: unknown) => rejection,
  )
  expect(error).toBeInstanceOf(UnsafeOpenCodeSystemChannel)
  expect(error).toMatchObject({
    code: "LCA_UNSAFE_OPENCODE_SYSTEM_CHANNEL",
    reason,
  })
}

function expectNoChatEffects(sessionID = "s1") {
  expect(requests).toHaveLength(0)
  expect(existsSync(routingLogPath(root, sessionID))).toBe(false)
  expect(existsSync(sessionInfoPath(root, sessionID))).toBe(false)
  expect(existsSync(modeStatePath(root, sessionID))).toBe(false)
  expect(readModeState(root, sessionID)).toEqual(EMPTY_MODE)
}

function registerLiveWorker(childSessionID: string) {
  const runtime = getOpenCodeRuntime(deps)
  const policy = runtime.policy.resolve("worker")
  const claim = runtime.runs.claim("s1", runtime.instance, process.pid)
  const executionID = "skill-router-redteam-worker-execution"
  runtime.runs.registerIntent(claim, {
    executionId: executionID,
    ownerSession: "s1",
    taskId: "skill-router-redteam-worker-task",
    attemptId: "skill-router-redteam-worker-attempt",
    generation: claim.generation,
    role: "worker",
    cwd: root,
    policyID: policy.id,
    kind: "host",
    engine: runtime.host.identity.engine,
    profile: "legacy-unowned",
  })
  runtime.runs.markHostDispatched(claim, executionID)
  runtime.runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: childSessionID }))
  return { runtime, policy, executionID }
}

function createRouter() {
  return createSkillRouter(deps, createOpenCodeSkillPermissionSource(deps))
}

function hostClient(app: unknown = { agents: () => agentLookup() }): HookDeps["client"] {
  return {
    app,
    session: {
      get: async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: root, time: { created: 1 } },
      }),
    },
  } as unknown as HookDeps["client"]
}

beforeEach(() => {
  wt = tempWorktree()
  root = realpathSync.native(wt.worktree)
  fixtureSessions = []
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
    client: hostClient(),
    log: (message, extra) => logs.push({ message, extra }),
  }
  skill("plan")
})

afterEach(() => {
  for (const instance of servers) instance.stop(true)
  for (const store of fixtureSessions) releaseFixtureSession(root, store)
  wt.cleanup()
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
    deps.client = hostClient(app)

    const p = part("Explain the architecture; do not modify files or run tools.")
    const original = p.text
    await turn(await createNativeChatHook(), p)

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
    deps.client = hostClient(app)
    deps.config.skill_router.mode = "suggest"

    const p = part("Please inspect the code without changes; no execution is authorized.")
    await turn(await createNativeChatHook(), p)

    expect(p.text).toContain("optional advice, not a request to load a skill, change mode, or execute work")
    expect(p.text).not.toContain("<lca-mode")
    expect(readModeState(root, "s1")).toEqual(EMPTY_MODE)
    expect(capabilityReads).toEqual([])
  })

  test("child-agent role and latest skill deny override an otherwise winning route", async () => {
    deps.config.skill_router.mode = "suggest"
    const hook = await createNativeChatHook()
    const child = part("Investigate using the plan skill.", "child")
    const childText = child.text
    await expectUnsafeTurn(turn(hook, child, "reviewer"), "unknown-role")
    expect(child.text).toBe(childText)
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
    admitSession("s2")
    const revoked = await createRouter().recommend("s2", "revoked-in-flight", "Investigate")
    expect(revoked.skill).toBeNull()
    expect(revoked.reason).toBe("candidate_changed")
    expect(requests).toHaveLength(1)
  })

  test("a live bound worker receives only its exact code-owned worker system and never invokes skill routing", async () => {
    deps.config.skill_router.mode = "suggest"
    const childSessionID = "bound-worker-child"
    const hook = await createNativeChatHook()
    const { runtime, policy, executionID } = registerLiveWorker(childSessionID)
    const p = part("Investigate this worker task and report findings.", "bound-worker-turn")
    p.sessionID = childSessionID
    const workerSystem = policy.system.join("\n\n")
    await turn(hook, p, "worker", "worker", workerSystem)

    const system = ["Unchecked vendor prompt and metadata"]
    await createOpenCodeSystemTransformHook(deps)({ sessionID: childSessionID, model: {} as never }, { system })

    expect(system).toEqual([...policy.system])
    expect(runtime.policy.snapshotForSession(childSessionID)).toBe(policy)
    expect(runtime.runs.status().executions).toMatchObject([{
      executionId: executionID,
      ownerSession: "s1",
      role: "worker",
      policyID: policy.id,
      hostDispatch: "started",
      vendorRef: JSON.stringify({ executionID, vendorSessionID: childSessionID }),
    }])
    expect(requests).toHaveLength(0)
    expect(p.text).toBe("Investigate this worker task and report findings.")
    expect(existsSync(routingLogPath(root, childSessionID))).toBe(false)
    expect(existsSync(modeStatePath(root, childSessionID))).toBe(false)
    expect(readModeState(root, childSessionID)).toEqual(EMPTY_MODE)
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

  test("explicit slash commands bypass routing", async () => {
    deps.config.skill_router.mode = "suggest"
    const hook = await createNativeChatHook()
    await turn(hook, part("/skill:plan", "explicit"))
    expect(requests).toHaveLength(0)
  })

  test("unbound child, unknown-role and synthetic-only turns refuse before routing or state writes", async () => {
    deps.config.skill_router.mode = "suggest"
    const hook = await createNativeChatHook()
    await expectUnsafeTurn(turn(hook, part("Investigate this module.", "unbound-worker"), "worker"), "unknown-role")
    await expectUnsafeTurn(turn(hook, part("Investigate this module.", "unknown-role"), "main", "unknown"), "unknown-role")
    await expectUnsafeTurn(turn(hook, part("Investigate this module.", "missing-agent"), "main", null), "unknown-role")
    await expectUnsafeTurn(turn(hook, part("Investigate this module.", "synthetic-only", true)), "invalid-turn")
    expectNoChatEffects()
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

    const hook = await createNativeChatHook()
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

  test("a hold during recommendation prevents advice and exposure mutation", async () => {
    deps.config.skill_router.mode = "suggest"
    const campaignID = "router-held-flight"
    activateSkillCampaign(root, campaignID)
    deps.config.skill_observation = {
      ...deps.config.skill_observation,
      enabled: true,
      campaign_id: campaignID,
      owner_binding: skillObservationBindingHash(root),
    }

    let arrived!: () => void
    let release!: () => void
    const requestStarted = new Promise<void>((resolve) => { arrived = resolve })
    const heldResponse = new Promise<void>((resolve) => { release = resolve })
    handler = async () => {
      arrived()
      await heldResponse
      return answer()
    }

    const p = part("Investigate the routing guard and give implementation steps.")
    const original = p.text
    const pending = turn(await createNativeChatHook(), p)
    await requestStarted
    const exposureBeforeHold = listSkillObservations(root).facts

    holdAdmission(root, "s1", "fixture-held-during-router")
    const heldDuringResponse = effectiveHold(root, "s1")
    release()
    await pending

    expect(heldDuringResponse).toBe(true)
    expect(exposureBeforeHold).toHaveLength(1)
    expect(exposureBeforeHold[0]).toMatchObject({
      kind: "turn_context",
      payload: { routerExposure: "unknown", routeDecisionID: null, routeSkillName: null, adviceInserted: null },
    })
    expect(requests).toHaveLength(1)
    expect(p.text).toBe(original)
    const events = readFileSync(routingLogPath(root, "s1"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string })
    expect(events.map(event => event.event)).toEqual(["decision"])
    expect(listSkillObservations(root).facts).toEqual(exposureBeforeHold)
  })

  test("private skill frontmatter and file contents never enter the inference body", async () => {
    const privateOwner = "INTERNAL_OWNER_SENTINEL_7f91"
    const privateInstructions = "PRIVATE_SKILL_BODY_SENTINEL_52ad"
    writeFileSync(join(root, ".opencode", "skills", "plan", "SKILL.md"),
      `---\nname: plan\ndescription: Public routing summary.\ninternal_owner: ${privateOwner}\n---\n${privateInstructions}\n`)

    await turn(await createNativeChatHook(), part("Give a short architecture summary."))

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
