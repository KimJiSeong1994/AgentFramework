#!/usr/bin/env bun
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  activateSkillCampaign, getSkillCampaignStatus, SkillObservationError, stopSkillCampaign,
} from "../framework/src/telemetry/skills.ts"

const DEFAULT_ROOT = resolve(import.meta.dir, "..")
const USAGE = "Usage: bun scripts/lca-skill-observation.ts <activate|status|stop> [--root DIR] [--campaign-id ID]"
const [command, ...args] = process.argv.slice(2)

function usageError(): never {
  console.error(USAGE)
  process.exit(2)
}

if (!command || !["activate", "status", "stop"].includes(command)) usageError()

let parsed: ReturnType<typeof parseArgs>
try {
  parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: { root: { type: "string" }, "campaign-id": { type: "string" } },
  })
} catch {
  usageError()
}

const rootValue = parsed.values.root
const campaignID = parsed.values["campaign-id"]
if (rootValue !== undefined && typeof rootValue !== "string") usageError()
if (campaignID !== undefined && typeof campaignID !== "string") usageError()
if (command === "activate" && (!rootValue || !campaignID)) usageError()
const root = resolve(rootValue ?? DEFAULT_ROOT)

try {
  if (command === "activate") {
    const status = activateSkillCampaign(root, campaignID!)
    console.log(JSON.stringify(status, null, 2))
    if (!status.available) process.exitCode = 1
  } else if (command === "status") {
    const status = getSkillCampaignStatus(root)
    if (campaignID !== undefined && status.campaignID !== campaignID) {
      console.error(JSON.stringify({ available: false, health: status.available ? "campaign_mismatch" : status.health }))
      process.exitCode = 1
    } else {
      console.log(JSON.stringify(status, null, 2))
      if (!status.available) process.exitCode = 1
    }
  } else {
    const status = stopSkillCampaign(root, campaignID)
    console.log(JSON.stringify(status, null, 2))
    if (!status.available) process.exitCode = 1
  }
} catch (error) {
  const health = error instanceof SkillObservationError ? error.code : "storage_error"
  console.error(JSON.stringify({ available: false, health }))
  process.exitCode = 1
}
