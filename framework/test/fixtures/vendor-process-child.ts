import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const [mode, ...args] = process.argv.slice(2)

switch (mode) {
  case "marker": {
    writeFileSync(args[0], "started", { flag: "wx" })
    break
  }
  case "report": {
    const input: Buffer[] = []
    process.stdin.on("data", (chunk) => input.push(Buffer.from(chunk)))
    process.stdin.on("end", () => {
      process.stdout.write(`${JSON.stringify({ args, envKeys: Object.keys(process.env).sort() })}\n`)
      process.stdout.write(Buffer.concat(input))
    })
    break
  }
  case "burst": {
    process.stdout.write("雪雪雪")
    process.stderr.write("ABCDEFGH")
    break
  }
  case "observe-before-exit": {
    const releasePath = args[0]
    process.stdout.write("first\n")
    const waitForRelease = setInterval(() => {
      if (!existsSync(releasePath)) return
      clearInterval(waitForRelease)
      process.stdout.write("second\n")
    }, 5)
    break
  }
  case "mixed-output": {
    process.stderr.write("ab")
    setTimeout(() => process.stdout.write(Buffer.from("雪")), 80)
    break
  }
  case "stdout-burst": {
    process.stdout.write("雪雪雪")
    break
  }
  case "reference-stream":
  case "reference-failure-wait": {
    const [engine, persistedPath] = args
    const startupFrame = engine === "claude-code"
      ? '{"type":"system","subtype":"plugin_install","status":"started","session_id":"claude-fixture-session"}\n'
      : '{"type":"thread.started","thread_id":"codex-fixture-thread"}\n'
    const laterFrames = engine === "claude-code"
      ? '{"type":"system","subtype":"init","session_id":"claude-fixture-session"}\n'
      : '{"type":"turn.started"}\n'
    const chunkSizes = [3, 7, 11, 5]
    let chunkIndex = 0
    if (mode === "reference-failure-wait") process.on("SIGTERM", () => {})
    const writeChunked = (value: string, onComplete: () => void) => {
      const bytes = Buffer.from(value)
      let offset = 0
      const writeNextChunk = () => {
        if (offset === bytes.length) {
          onComplete()
          return
        }
        const end = Math.min(bytes.length, offset + chunkSizes[chunkIndex++ % chunkSizes.length]!)
        process.stdout.write(bytes.subarray(offset, end))
        offset = end
        setTimeout(writeNextChunk, 5)
      }
      writeNextChunk()
    }
    const writeLaterFrames = () => writeChunked(laterFrames, () => {
      const waitForPersistence = setInterval(() => {
        if (!existsSync(persistedPath)) return
        clearInterval(waitForPersistence)
        if (mode === "reference-failure-wait") return
        process.exit(0)
      }, 5)
    })
    writeChunked(startupFrame, () => {
      const waitForStartupPersistence = setInterval(() => {
        if (!existsSync(persistedPath)) return
        clearInterval(waitForStartupPersistence)
        if (mode === "reference-failure-wait") return
        writeLaterFrames()
      }, 5)
    })
    break
  }
  case "sleep": {
    const duration = Math.min(5000, Math.max(0, Number(args[0]) || 0))
    setTimeout(() => process.stdout.write("finished\n"), duration)
    break
  }
  case "ignore-term": {
    process.on("SIGTERM", () => {})
    writeFileSync(args[0], "ready", { flag: "wx" })
    const duration = Math.min(5000, Math.max(1, Number(args[1]) || 2500))
    const stop = setTimeout(() => process.exit(0), duration)
    stop.unref()
    setInterval(() => process.stdout.write("waiting\n"), 100)
    break
  }
  case "leader-with-grandchild": {
    const duration = Math.min(1000, Math.max(0, Number(args[0]) || 0))
    const grandchildMode = args[1] === "silent" ? "grandchild-silent" : "grandchild"
    const fixturePath = process.argv[1]
    const runtimeArgs = process.versions.bun
      ? [fixturePath, grandchildMode, String(duration)]
      : ["--input-type=module", "--eval", readFileSync(fixturePath, "utf8"), fixturePath, grandchildMode, String(duration)]
    const grandchild = spawn(process.execPath, runtimeArgs, { stdio: ["ignore", "inherit", "inherit"] })
    grandchild.on("error", () => { process.exitCode = 1 })
    process.stdout.write("leader exiting\n", () => process.exit(process.exitCode ?? 0))
    break
  }
  case "grandchild": {
    const duration = Math.min(1000, Math.max(0, Number(args[0]) || 0))
    setTimeout(() => process.stdout.write("descendant finished\n"), duration)
    break
  }
  case "grandchild-silent": {
    const duration = Math.min(1000, Math.max(0, Number(args[0]) || 0))
    setTimeout(() => process.exit(0), duration)
    break
  }
  case "quick": {
    process.stdout.write("quick exit\n")
    break
  }
  default: {
    process.stderr.write("unknown fixture mode\n")
    process.exitCode = 2
  }
}
