/**
 * Pure terminal input decoding for the framework TUI.
 *
 * Behavior was independently implemented against the pinned GJC reference
 * fixtures at 8cd17c0f636d3c541c0c2af184e01709b0e6f2c1; this is not a runtime
 * dependency or a copied GJC module. Provenance: framework/src/tui/ATTRIBUTION.
 */

export type InputEvent = { type: "key"; key: string } | { type: "text"; text: string } | { type: "paste"; text: string } |
  { type: "mouse"; action: "down" | "move" | "up"; x: number; y: number }

const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"
const LOCK_MASK = 64 | 128
const MODIFIERS = [
  { bit: 4, name: "ctrl" },
  { bit: 2, name: "alt" },
  { bit: 1, name: "shift" },
  { bit: 8, name: "super" },
] as const

const KITTY_FUNCTIONAL_KEYS = new Map<number, string>([
  [57344, "escape"],
  [57345, "enter"],
  [57346, "tab"],
  [57347, "backspace"],
  [57348, "insert"],
  [57349, "delete"],
  [57350, "left"],
  [57351, "right"],
  [57352, "up"],
  [57353, "down"],
  [57354, "pageUp"],
  [57355, "pageDown"],
  [57356, "home"],
  [57357, "end"],
  [57364, "f1"],
  [57365, "f2"],
  [57366, "f3"],
  [57367, "f4"],
  [57368, "f5"],
  [57369, "f6"],
  [57370, "f7"],
  [57371, "f8"],
  [57372, "f9"],
  [57373, "f10"],
  [57374, "f11"],
  [57375, "f12"],
])

const KEYPAD_KEYS = new Map<number, string>([
  [57400, "end"],
  [57401, "down"],
  [57402, "pageDown"],
  [57403, "left"],
  [57404, "clear"],
  [57405, "right"],
  [57406, "home"],
  [57407, "up"],
  [57408, "pageUp"],
  [57409, "delete"],
  [57410, "/"],
  [57411, "*"],
  [57412, "-"],
  [57413, "+"],
  [57414, "enter"],
  [57415, "="],
])

const KEYPAD_PRINTABLE = new Map<number, string>([
  [57410, "/"],
  [57411, "*"],
  [57412, "-"],
  [57413, "+"],
  [57415, "="],
])

function key(key: string): InputEvent {
  return { type: "key", key }
}

function text(value: string): InputEvent {
  return { type: "text", text: value }
}

function modifiedKey(baseKey: string, modifiers: number): string {
  let prefix = ""
  for (const modifier of MODIFIERS) {
    if ((modifiers & modifier.bit) !== 0) prefix += `${modifier.name}+`
  }
  return prefix + baseKey
}

function printableCodepoint(codepoint: number): boolean {
  return Number.isSafeInteger(codepoint) && codepoint >= 32 && codepoint <= 0x10ffff &&
    !(codepoint >= 0xd800 && codepoint <= 0xdfff) && codepoint !== 0x7f &&
    !(codepoint >= 0x80 && codepoint <= 0x9f)
}

function baseKeyForCodepoint(codepoint: number): string | undefined {
  const functionalKey = KITTY_FUNCTIONAL_KEYS.get(codepoint)
  if (functionalKey) return functionalKey
  const keypadKey = KEYPAD_KEYS.get(codepoint)
  if (keypadKey) return keypadKey
  if (codepoint === 13 || codepoint === 10) return "enter"
  if (codepoint === 9) return "tab"
  if (codepoint === 27) return "escape"
  if (codepoint === 8 || codepoint === 127) return "backspace"
  if (codepoint === 32) return "space"
  if (codepoint >= 65 && codepoint <= 90) return String.fromCharCode(codepoint + 32)
  if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint)
  if (codepoint >= 48 && codepoint <= 57) return String.fromCharCode(codepoint)
  if (codepoint <= 0x7f && printableCodepoint(codepoint)) return String.fromCodePoint(codepoint)
  return undefined
}

function eventForCodepoint(
  codepoint: number,
  rawModifiers: number,
  shiftedKey?: number,
  textCodepoints?: string,
): InputEvent | undefined {
  const modifiers = rawModifiers & ~LOCK_MASK
  if ((modifiers & ~(1 | 2 | 4 | 8)) !== 0) return undefined

  const hasNonShiftModifier = (modifiers & (2 | 4 | 8)) !== 0
  if (!hasNonShiftModifier) {
    if (textCodepoints) {
      const textValue = [...textCodepoints]
        .map(char => char.codePointAt(0)!)
        .filter(printableCodepoint)
        .map(value => String.fromCodePoint(value))
        .join("")
      if (textValue) return text(textValue)
    }
    const keypadOperator = KEYPAD_PRINTABLE.get(codepoint)
    if (keypadOperator) return text(keypadOperator)
    if (modifiers === 0 && (rawModifiers & 128) !== 0 && codepoint >= 57399 && codepoint <= 57409) {
      return text(codepoint === 57409 ? "." : String((codepoint - 57399) % 10))
    }
    if (printableCodepoint(codepoint)) {
      const printable = (modifiers & 1) !== 0 && shiftedKey !== undefined ? shiftedKey : codepoint
      if (printableCodepoint(printable)) return text(String.fromCodePoint(printable))
    }
  }

  const baseKey = baseKeyForCodepoint(codepoint)
  if (!baseKey) return undefined
  return key(modifiedKey(baseKey, modifiers))
}

function parseWireModifiers(value: string | undefined): { modifiers: number; eventType?: number } | undefined {
  if (value === undefined || value === "") return { modifiers: 0 }
  const [wireText, eventText] = value.split(":", 2)
  const wire = Number(wireText)
  if (!Number.isSafeInteger(wire) || wire < 1 || wire > 0xffffffff) return undefined
  const eventType = eventText === undefined || eventText === "" ? undefined : Number(eventText)
  if (eventType !== undefined && (!Number.isSafeInteger(eventType) || eventType < 1 || eventType > 3)) return undefined
  return { modifiers: wire - 1, eventType }
}

function parseKittyCsiU(body: string): InputEvent | undefined {
  const match = body.match(/^(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+(?::\d+)?))?(?:;([\d:]*))?$/)
  if (!match) return undefined
  const codepoint = Number(match[1])
  if (!Number.isSafeInteger(codepoint) || codepoint < 0 || codepoint > 0xffffffff) return undefined
  const modifierData = parseWireModifiers(match[4])
  if (!modifierData || modifierData.eventType === 3) return undefined
  const shiftedText = match[2] ? Number(match[2]) : undefined
  const textCodepoints = match[5]
  return eventForCodepoint(
    codepoint,
    modifierData.modifiers,
    shiftedText,
    textCodepoints,
  )
}

function parseCsiKey(body: string, final: string): InputEvent | undefined {
  if (body.startsWith("<")) return parseSgrMouse(body, final)
  if (final === "u") return parseKittyCsiU(body)
  if (final === "Z") return key("shift+tab")

  const parts = body.split(";")
  const modifierData = parseWireModifiers(parts[1])
  if (!modifierData || modifierData.eventType === 3) return undefined
  const modifiers = modifierData.modifiers & ~LOCK_MASK

  const arrowKeys: Record<string, string> = {
    A: "up",
    B: "down",
    C: "right",
    D: "left",
    E: "clear",
    F: "end",
    H: "home",
    P: "f1",
    Q: "f2",
    R: "f3",
    S: "f4",
  }
  const arrow = arrowKeys[final]
  if (arrow && (parts[0] === "" || parts[0] === "1")) return key(modifiedKey(arrow, modifiers))

  if (final !== "~") return undefined
  const numbers = parts.map(part => Number(part))
  if (numbers.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined

  if (numbers[0] === 27 && numbers.length === 3) {
    const modified = parseWireModifiers(parts[1])
    const codepoint = numbers[2]
    if (!modified || modified.eventType === 3) return undefined
    return eventForCodepoint(codepoint, modified.modifiers)
  }

  const codepoint = numbers[0]
  if (codepoint === 13) return eventForCodepoint(codepoint, modifierData.modifiers)

  const functionKeys: Record<number, string> = {
    1: "home",
    2: "insert",
    3: "delete",
    4: "end",
    5: "pageUp",
    6: "pageDown",
    11: "f1",
    12: "f2",
    13: "f3",
    14: "f4",
    15: "f5",
    17: "f6",
    18: "f7",
    19: "f8",
    20: "f9",
    21: "f10",
    23: "f11",
    24: "f12",
  }
  const functionKey = functionKeys[codepoint]
  return functionKey ? key(modifiedKey(functionKey, modifiers)) : undefined
}

function controlKey(code: number): string | undefined {
  if (code === 0) return "ctrl+space"
  if (code === 8 || code === 127) return "backspace"
  if (code === 9) return "tab"
  if (code === 10) return "ctrl+j"
  if (code === 13) return "enter"
  if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`
  if (code === 28) return "ctrl+\\"
  if (code === 29) return "ctrl+]"
  if (code === 30) return "ctrl+^"
  if (code === 31) return "ctrl+_"
  return undefined
}

function codepointWidthAt(value: string, offset: number): number {
  const codepoint = value.codePointAt(offset)
  return codepoint !== undefined && codepoint > 0xffff ? 2 : 1
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function partialSuffixLength(value: string, marker: string): number {
  const maxLength = Math.min(value.length, marker.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

/** SGR mouse reports retain 1-based terminal coordinates for left-button selection. */
function parseSgrMouse(body: string, final: string): InputEvent | undefined {
  if (final !== "M" && final !== "m") return undefined
  const match = /^<(\d+);(\d+);(\d+)$/.exec(body)
  if (!match) return undefined
  const button = Number(match[1])
  const x = Number(match[2])
  const y = Number(match[3])
  if (![button, x, y].every(Number.isSafeInteger) || button > 255 || x < 1 || y < 1) return undefined
  if (button === 0) return { type: "mouse", action: final === "M" ? "down" : "up", x, y }
  if (button === 32 && final === "M") return { type: "mouse", action: "move", x, y }
  if (final !== "M") return undefined
  const wheel = button & ~(4 | 8 | 16)
  return wheel === 64 ? key("wheelUp") : wheel === 65 ? key("wheelDown") : undefined
}

function findCsiFinal(value: string): number {
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index
  }
  return -1
}

function decodeAltKey(character: string): InputEvent | undefined {
  const codepoint = character.codePointAt(0)
  if (codepoint === undefined) return undefined
  if (codepoint === 13 || codepoint === 10) return key("alt+enter")
  if (codepoint < 32 || codepoint === 127) {
    const base = controlKey(codepoint)
    return base ? key(`alt+${base}`) : undefined
  }
  const baseKey = baseKeyForCodepoint(codepoint)
  if (!baseKey) return undefined
  return key(modifiedKey(baseKey, 2))
}

/**
 * Incremental decoder for terminal key, text, and bracketed-paste packets.
 * UTF-8 byte decoding belongs to the caller (for example, StringDecoder).
 */
export class KeyDecoder {
  #pending = ""
  #pasteText = ""
  #inPaste = false

  feed(chunk: string): InputEvent[] {
    this.#pending += chunk
    return this.#drain()
  }

  /** True for an active paste or any buffered prefix that may start one. */
  isPastePending(): boolean {
    return this.#inPaste || (this.#pending.length > 0 && PASTE_START.startsWith(this.#pending))
  }

  /** Emit Escape only when the pending packet is exactly a standalone ESC. */
  flushEscape(): InputEvent[] {
    if (!this.#inPaste && this.#pending === "\x1b") {
      this.#pending = ""
      return [key("escape")]
    }
    return []
  }

  reset(): void {
    this.#pending = ""
    this.#pasteText = ""
    this.#inPaste = false
  }

  #drain(): InputEvent[] {
    const events: InputEvent[] = []
    while (this.#pending.length > 0) {
      if (this.#inPaste) {
        const end = this.#pending.indexOf(PASTE_END)
        if (end >= 0) {
          this.#pasteText += this.#pending.slice(0, end)
          events.push({ type: "paste", text: this.#pasteText })
          this.#pasteText = ""
          this.#inPaste = false
          this.#pending = this.#pending.slice(end + PASTE_END.length)
          continue
        }
        const partial = partialSuffixLength(this.#pending, PASTE_END)
        this.#pasteText += this.#pending.slice(0, this.#pending.length - partial)
        this.#pending = this.#pending.slice(this.#pending.length - partial)
        break
      }

      if (this.#pending[0] === "\x1b") {
        if (this.#pending.length === 1) break
        const second = this.#pending[1]!
        if (second === "[") {
          const finalIndex = findCsiFinal(this.#pending)
          if (finalIndex < 0) break
          const body = this.#pending.slice(2, finalIndex)
          const final = this.#pending[finalIndex]!
          this.#pending = this.#pending.slice(finalIndex + 1)
          if (body === "200" && final === "~") {
            this.#inPaste = true
            continue
          }
          if (body === "201" && final === "~") continue
          const decoded = parseCsiKey(body, final)
          if (decoded) events.push(decoded)
          continue
        }
        if (second === "O") {
          if (this.#pending.length < 3) break
          const final = this.#pending[2]!
          const keys: Record<string, string> = {
            A: "up",
            B: "down",
            C: "right",
            D: "left",
            H: "home",
            F: "end",
            P: "f1",
            Q: "f2",
            R: "f3",
            S: "f4",
          }
          this.#pending = this.#pending.slice(3)
          if (keys[final]) events.push(key(keys[final]!))
          continue
        }
        if (second === "\x1b") {
          events.push(key("escape"))
          this.#pending = this.#pending.slice(1)
          continue
        }
        if (["]", "P", "X", "^", "_"].includes(second)) {
          const terminator = second === "]" ? "\x07" : "\x1b\\"
          const end = this.#pending.indexOf(terminator, 2)
          if (end < 0) break
          this.#pending = this.#pending.slice(end + terminator.length)
          continue
        }
        const width = codepointWidthAt(this.#pending, 1)
        if (width === 1 && isHighSurrogate(this.#pending.charCodeAt(1)) && this.#pending.length === 2) break
        const char = this.#pending.slice(1, 1 + width)
        this.#pending = this.#pending.slice(1 + width)
        const decoded = decodeAltKey(char)
        if (decoded) events.push(decoded)
        continue
      }

      const firstCode = this.#pending.charCodeAt(0)
      if (firstCode < 0x20 || firstCode === 0x7f) {
        const control = controlKey(firstCode)
        this.#pending = this.#pending.slice(1)
        if (control) events.push(key(control))
        continue
      }
      if (firstCode >= 0x80 && firstCode <= 0x9f) {
        this.#pending = this.#pending.slice(1)
        continue
      }

      let end = 0
      while (end < this.#pending.length) {
        const codepoint = this.#pending.codePointAt(end)!
        if (codepoint === 0x1b || codepoint < 0x20 || codepoint === 0x7f || (codepoint >= 0x80 && codepoint <= 0x9f)) break
        if (isHighSurrogate(this.#pending.charCodeAt(end)) && end + 1 === this.#pending.length) break
        end += codepoint > 0xffff ? 2 : 1
      }
      if (end === 0) break
      events.push(text(this.#pending.slice(0, end)))
      this.#pending = this.#pending.slice(end)
    }
    return events
  }
}
