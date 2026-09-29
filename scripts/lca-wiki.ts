#!/usr/bin/env bun
import { resolve } from "node:path"
import { captureWiki, lintWiki } from "../framework/src/telemetry/wiki.ts"

const [command, ...rest] = process.argv.slice(2)
if (!["capture", "lint"].includes(command ?? "") || rest.length > 1) {
  console.error("Usage: bun scripts/lca-wiki.ts <capture|lint> [worktree-root]")
  process.exit(2)
}
const root = resolve(rest[0] ?? resolve(import.meta.dir, ".."))
try {
  if (command === "capture") console.log(JSON.stringify(captureWiki(root), null, 2))
  else {
    const problems = lintWiki(root)
    console.log(JSON.stringify({ status: problems.length ? "failed" : "passed", semanticReview: "Agent review required for contradictions and stale claims", problems }, null, 2))
    if (problems.length) process.exitCode = 1
  }
} catch (error) {
  console.error(`Wiki operation failed: ${(error as Error).message}`)
  process.exitCode = 1
}
