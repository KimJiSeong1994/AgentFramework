import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { join } from "node:path"

const required = process.env.LCA_TUI_LIVE_REQUIRED === "1"
const model = process.env.LCA_TUI_LIVE_MODEL ?? ""
const modelID = process.env.LCA_TUI_LIVE_MODEL_ID ?? ""
const output = process.env.LCA_TUI_LIVE_OUT ?? ""
const sourceHash = process.env.LCA_TUI_LIVE_SOURCE_HASH ?? ""

test.skipIf(!required)("production TUI completes a genuine macOS native-model turn", () => {
  expect(process.platform).toBe("darwin")
  expect(model).not.toBe("")
  expect(modelID).toMatch(/^[0-9a-f]{12}$/u)
  expect(output).not.toBe("")
  expect(sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
  const framework = realpathSync(join(import.meta.dir, ".."))
  const result = spawnSync("python3", [join(import.meta.dir, "pty", "live-ux.py"), "--framework", framework, "--model", model, "--model-id", modelID, "--out", output, "--source-hash", sourceHash], {
    cwd: framework,
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const diagnostic = `${result.stdout}\n${result.stderr}`
  expect(result.error, diagnostic).toBeUndefined()
  expect(result.status, diagnostic).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ status: "passed", classification: "macOS native", model, modelID })
}, 20 * 60_000)
