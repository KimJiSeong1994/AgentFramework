#!/usr/bin/env bun
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { inspectPilotCapability } from "../framework/src/skillopt/host.ts"
import { canonicalJson, sha256, SkillOptError, snapshotSources } from "../framework/src/skillopt/pilot.ts"

const USAGE = "Usage: bun scripts/lca-skillopt.ts <snapshot|preflight> [--root DIR]"
const [command, ...args] = process.argv.slice(2)

function usageError(): never {
  console.error(USAGE)
  process.exit(2)
}

if (!command || !["snapshot", "preflight"].includes(command)) usageError()
let parsed: ReturnType<typeof parseArgs>
try {
  parsed = parseArgs({ args, allowPositionals: false, strict: true, options: { root: { type: "string" } } })
} catch {
  usageError()
}
const rootValue = parsed.values.root
if (rootValue !== undefined && typeof rootValue !== "string") usageError()
const root = resolve(rootValue ?? resolve(import.meta.dir, ".."))

try {
  const snapshot = snapshotSources(root)
  const snapshotSha256 = sha256(canonicalJson(snapshot))
  if (command === "snapshot") {
    console.log(JSON.stringify({ snapshotSha256, snapshot }, null, 2))
  } else {
    const capability = inspectPilotCapability()
    console.log(JSON.stringify({ snapshotSha256, originalSkillSha256: snapshot.originalSkillSha256, capability }, null, 2))
    process.exitCode = 1
  }
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", code: error instanceof SkillOptError ? error.code : "preflight_failed", experimentAdmitted: false, productionApplied: false }))
  process.exitCode = 1
}
