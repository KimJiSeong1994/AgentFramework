import { spyOn } from "bun:test"
import * as readline from "node:readline/promises"
import { PassThrough } from "node:stream"
import type { DecisionBinding } from "../src/hosts/operator.ts"

/** Plan-subject binding for an operator receipt, bound to the workflow revision the operator inspected. */
export function planBinding(sessionID: string, wf: { id: string; lastSeq: number }, planSha: string): DecisionBinding {
  return { sessionID, workflowID: wf.id, expectedRevision: wf.lastSeq, subject: { kind: "plan", id: wf.id, sha256: planSha } }
}

let active = false

/** Exercise the real terminal reader and receipt issuer; never replace receipt validation. */
export async function withTerminalLine<T>(line: string, read: () => Promise<T>): Promise<T> {
  if (active) throw new Error("terminal input fixtures must not overlap")
  const input = new PassThrough()
  const output = new PassThrough()
  const terminal = readline.createInterface({ input, output, terminal: false })
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
  let changedStdin = false
  let changedStderr = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const intercepted = spyOn(readline, "createInterface").mockReturnValue(terminal)
  active = true
  try {
    if (process.stdin.isTTY !== true) {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      changedStdin = true
    }
    if (process.stderr.isTTY !== true) {
      Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true })
      changedStderr = true
    }
    // The terminal reader must register its question before its first await.
    const pending = read()
    input.write(`${line}\n`)
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("terminal input fixture did not finish")), 1000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    intercepted.mockRestore()
    terminal.close()
    input.destroy()
    output.destroy()
    if (changedStdin) {
      if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY)
      else Reflect.deleteProperty(process.stdin, "isTTY")
    }
    if (changedStderr) {
      if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY)
      else Reflect.deleteProperty(process.stderr, "isTTY")
    }
    active = false
  }
}
