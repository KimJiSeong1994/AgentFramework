import { TextDecoder } from "node:util"
import type { ExecutionReference } from "./types.ts"

const MAX_FRAME_BYTES = 1024 * 1024
const FAILURE_MESSAGE = "invalid CLI reference stream"

export type CLIReferenceEngine = "claude-code" | "codex"

export type CLIReferenceStreamOptions = {
  engine: CLIReferenceEngine
  executionID: string
  onReference: (reference: ExecutionReference) => undefined
}

export type CLIReferenceStream = {
  /** Accepts process stdout bytes synchronously and never retains the supplied chunk. */
  onStdoutChunk(chunk: Uint8Array): undefined
  /** Requires a bound identity and refuses unterminated records or an invalid stream. */
  finish(): void
}

function invalidStream(): Error {
  return new Error(FAILURE_MESSAGE)
}

/** Decodes only documented top-level CLI identity events; it does not interpret transcript content. */
export function createCLIReferenceStream(options: CLIReferenceStreamOptions): CLIReferenceStream {
  if (!options || typeof options !== "object") {
    throw new TypeError("invalid CLI reference stream options")
  }
  const engine = options.engine
  const executionID = options.executionID
  const onReference = options.onReference
  if ((engine !== "claude-code" && engine !== "codex") ||
      typeof executionID !== "string" || executionID.length === 0 || executionID.length > 512 ||
      typeof onReference !== "function") throw new TypeError("invalid CLI reference stream options")

  let frame = Buffer.alloc(0)
  let frameBytes = 0
  let boundID: string | undefined
  let failure: Error | undefined
  let finished = false

  const fail = (): never => {
    failure ??= invalidStream()
    throw failure
  }

  const append = (chunk: Uint8Array, start: number, end: number): void => {
    const addedBytes = end - start
    if (frameBytes + addedBytes > MAX_FRAME_BYTES) fail()
    if (frameBytes + addedBytes > frame.byteLength) {
      const capacity = Math.min(MAX_FRAME_BYTES, Math.max(frameBytes + addedBytes, frame.byteLength === 0 ? 1024 : frame.byteLength * 2))
      const grown = Buffer.allocUnsafe(capacity)
      if (frameBytes > 0) frame.copy(grown, 0, 0, frameBytes)
      frame = grown
    }
    frame.set(chunk.subarray(start, end), frameBytes)
    frameBytes += addedBytes
  }

  const processFrame = (): void => {
    let length = frameBytes
    if (length > 0 && frame[length - 1] === 0x0d) length--
    let text: string
    let value: unknown
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, length))
      value = JSON.parse(text)
    } catch {
      return fail()
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail()

    const record = value as Record<string, unknown>
    const isInit = engine === "claude-code" && record.type === "system" && record.subtype === "init"
    const isIdentity = engine === "claude-code"
      ? Object.hasOwn(record, "session_id") || isInit
      : record.type === "thread.started"
    if (!isIdentity) return

    const identityValue = engine === "claude-code" ? record.session_id : record.thread_id
    if (typeof identityValue !== "string" || identityValue.length === 0 || identityValue.length > 512 || identityValue.trim().length === 0 || identityValue.includes("\0")) return fail()
    const identity = identityValue
    if (boundID !== undefined) {
      if (boundID !== identity) return fail()
      return
    }

    const reference: ExecutionReference = engine === "claude-code"
      ? { executionID, vendorSessionID: identity }
      : { executionID, vendorThreadID: identity }
    let result: unknown
    try {
      result = onReference(reference)
    } catch {
      return fail()
    }
    if (result !== undefined) {
      try { void Promise.resolve(result).catch(() => {}) } catch { /* Runtime misuse is refused below. */ }
      return fail()
    }
    boundID = identity
  }

  return {
    onStdoutChunk(chunk): undefined {
      if (failure) throw failure
      if (finished || !(chunk instanceof Uint8Array)) fail()
      try {
        let segmentStart = 0
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] !== 0x0a) continue
          append(chunk, segmentStart, index)
          processFrame()
          frameBytes = 0
          segmentStart = index + 1
        }
        append(chunk, segmentStart, chunk.byteLength)
      } catch {
        fail()
      }
      return undefined
    },
    finish(): void {
      if (failure) throw failure
      if (finished) fail()
      finished = true
      if (frameBytes !== 0 || boundID === undefined) fail()
    },
  }
}
