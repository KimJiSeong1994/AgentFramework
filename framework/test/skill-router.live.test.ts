import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { TextPart, UserMessage } from "@opencode-ai/sdk"
import { resolve } from "node:path"
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts"
import { createSkillRouter } from "../src/routing/router.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { EMPTY_MODE, readModeState } from "../src/state/store.ts"
import type { HookDeps } from "../src/hooks/types.ts"

// Opt-in: requires the actual OpenCode host and OpenJev, without starting or changing either.
const host = process.env.LCA_ROUTER_LIVE_HOST
const endpoint = process.env.LCA_ROUTER_LIVE_ENDPOINT

test.skipIf(!host || !endpoint)("real host catalog -> live OpenJev -> applied optional advice", async () => {
  const root = resolve(import.meta.dir, "../..")
  const logs: unknown[] = []
  const deps: HookDeps = {
    worktree: root, directory: root,
    client: createOpencodeClient({ baseUrl: host, directory: root }),
    config: { ...loadConfig(root), skill_router: { ...DEFAULT_CONFIG.skill_router, mode: "shadow", endpoint: endpoint!, timeout_ms: 3000 } },
    log: (message, extra) => logs.push({ message, extra }),
  }
  const text = "Before changing authentication, investigate the dependencies and provide a numbered implementation plan with files, risks and verification steps. Do not edit anything."
  const router = createSkillRouter(deps)
  const result = await router.recommend("router-live-smoke", "synthetic-1", text)
  console.log("LIVE_ROUTER", JSON.stringify({ result, logs }))
  expect(result).toEqual({ skill: "plan", reason: "recommended" })
  deps.config.skill_router.timeout_ms = DEFAULT_CONFIG.skill_router.timeout_ms
  const warm = await router.recommend("router-live-smoke", "synthetic-2", text)
  console.log("LIVE_ROUTER_DEFAULT_DEADLINE", JSON.stringify({ result: warm, log: logs.at(-1) }))
  expect(warm).toEqual({ skill: "plan", reason: "recommended" })
  deps.config.skill_router.mode = "suggest"
  const sessionID = `router-live-${crypto.randomUUID()}`
  const part: TextPart = { type: "text", id: "part-live", messageID: "message-live", sessionID, text }
  await createChatMessageHook(deps)({ sessionID, agent: "main" }, { parts: [part], message: { id: part.messageID } as UserMessage })
  console.log("LIVE_APPLIED_ADVICE", JSON.stringify({ applied: part.text.includes("<lca-skill-advice>"), log: logs.at(-1) }))
  expect(part.text).toContain("<lca-skill-advice>")
  expect(readModeState(root, sessionID)).toEqual(EMPTY_MODE)
}, 10000)
