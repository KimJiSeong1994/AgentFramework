#!/usr/bin/env bun
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { captureWiki, lintWiki, registerWiki, statusWiki, unlockWiki } from "../framework/src/wiki/wiki.ts"

const DEFAULT_ROOT = resolve(import.meta.dir, "..")
const USAGE = [
  "Usage: bun scripts/otter-wiki.ts <capture|lint|status|unlock|register> [file] [--title TITLE] [--root DIR]",
  "capture is explicit, manual evidence collection; it never compiles or ingests sources.",
].join("\n")

function usageError(message: string): never {
  console.error(message)
  console.error(USAGE)
  process.exit(2)
}

const [command, ...rest] = process.argv.slice(2)
if (!command || !["capture", "lint", "status", "unlock", "register"].includes(command)) usageError(`Unknown command: ${command ?? "<none>"}`)

let parsed: ReturnType<typeof parseArgs>
try {
  parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: { title: { type: "string" }, root: { type: "string" } },
  })
} catch (error) {
  usageError((error as Error).message)
}
const { values, positionals } = parsed
if (values.title !== undefined && command !== "register") usageError("--title is only valid with register")
if (command === "register") {
  if (positionals.length !== 1) usageError("register requires exactly one <file> positional argument")
} else if (positionals.length !== 0) usageError(`${command} does not accept positional arguments other than --root`)

const root = resolve(values.root ?? DEFAULT_ROOT)

try {
  if (command === "capture") console.log(JSON.stringify(captureWiki(root), null, 2))
  else if (command === "unlock") console.log(JSON.stringify(unlockWiki(root), null, 2))
  else if (command === "register") console.log(JSON.stringify(registerWiki(root, resolve(positionals[0]!), { title: values.title }), null, 2))
  else if (command === "status") {
    // A lock means a writer may be mid-change: callers must not compile from this snapshot.
    const status = statusWiki(root)
    console.log(JSON.stringify(status, null, 2))
    if (status.locked) process.exitCode = 1
  }
  else {
    const problems = lintWiki(root)
    console.log(JSON.stringify({ status: problems.length ? "failed" : "passed", semanticReview: "Agent review required for contradictions and stale claims", problems }, null, 2))
    if (problems.length) process.exitCode = 1
  }
} catch (error) {
  console.error(`Wiki operation failed: ${(error as Error).message}`)
  process.exitCode = 1
}
