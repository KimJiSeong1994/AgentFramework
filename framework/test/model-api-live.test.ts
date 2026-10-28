import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareModelApiAction, runModelApi } from "../src/hosts/model-api.ts"

// Opt-in real local inference only. Gate approval/denial is covered separately by cli-host/interactive tests.
test.skipIf(process.env.OTTER_MODEL_API_LIVE_TEST !== "1")("model_api real Ollama inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "otter-model-api-live-"))
  try {
    // Missing isolated user config selects the literal loopback default, never a user's remote target.
    const action = prepareModelApiAction({ target: "local", model: "llama3.2:3b", prompt: "Reply with exactly OTTER_API_OK and nothing else.",
      maxOutputTokens: 32, timeoutSeconds: 60 }, join(root, "absent.jsonc"))
    const result = await runModelApi(action, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.text).toContain("OTTER_API_OK")
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 65_000)
