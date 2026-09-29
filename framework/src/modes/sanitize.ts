// Keyword-detection sanitizer (OMC idea): strip regions of a user message where a mode keyword
// is most likely quoted, pasted or referenced rather than requested. Applied only for detection;
// the user's message itself is never rewritten.

const FENCED_BLOCK = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g
const INLINE_CODE = /`[^`\n]+`/g
const URL = /\b(?:https?|ftp|file|ssh|git):\/\/[^\s<>"'`)\]]+|\bwww\.[^\s<>"'`)\]]+/gi
// A token containing "/" that ends in an extension, e.g. src/modes/detect.ts, ./a/b.json, ~/x/y.md
const FILE_PATH = /(?:^|(?<=\s|[("'`[]))[^\s"'`()[\]<>]*\/[^\s"'`()[\]<>]*\.[A-Za-z0-9]{1,8}(?=$|\s|[)"'`\],;:.!?])/g
const DOUBLE_QUOTED = /"[^"\n]*"/g
const CURLY_DOUBLE = /[“„][^”“„\n]*[”“]/g
const CURLY_SINGLE = /[‘‚][^’‘‚\n]*[’‘]/g
// Single quotes only when they wrap a whole token group (avoids apostrophes: don't, it's).
const SINGLE_QUOTED = /(?<=^|[\s(])'[^'\n]*'(?=$|[\s).,;:!?])/g
const XML_TAG_HEAD = /<(\/)?([A-Za-z_:][A-Za-z0-9_.:-]*)/y
// Whole lines that look quoted or pasted from a transcript / shell session.
const QUOTED_OR_TRANSCRIPT_LINE = /^[ \t]*(?:>|(?:user|assistant|system|human|ai)\s*:|\$\s)[^\n]*(?:\n|$)/gim

type XmlMarkup =
  | { kind: "tag"; end: number; name: string; closing: boolean; selfClosing: boolean }
  | { kind: "opaque"; end: number }
  | { kind: "unterminated" }

function findMarkupEnd(text: string, start: number, terminator: string, subset = false): number {
  let quote = ""
  let subsetDepth = 0
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]!
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (subset && char === "[") {
      subsetDepth++
      continue
    }
    if (subset && char === "]" && subsetDepth > 0) {
      subsetDepth--
      continue
    }
    if (subsetDepth === 0 && text.startsWith(terminator, i)) return i + terminator.length
  }
  return -1
}

function xmlMarkupAt(text: string, start: number): XmlMarkup | null {
  const opaque: Array<[string, string]> = [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<?", "?>"]]
  for (const [prefix, terminator] of opaque) {
    if (!text.startsWith(prefix, start)) continue
    const end = text.indexOf(terminator, start + prefix.length)
    return end < 0 ? { kind: "unterminated" } : { kind: "opaque", end: end + terminator.length }
  }
  if (text.startsWith("<!", start)) {
    const end = findMarkupEnd(text, start, ">", true)
    return end < 0 ? { kind: "unterminated" } : { kind: "opaque", end }
  }

  XML_TAG_HEAD.lastIndex = start
  const head = XML_TAG_HEAD.exec(text)
  if (!head) return null
  const afterName = start + head[0].length
  const boundary = text[afterName]
  if (boundary !== undefined && !/[\s/>]/.test(boundary)) return { kind: "unterminated" }
  const end = findMarkupEnd(text, start, ">")
  if (end < 0) return { kind: "unterminated" }
  let tail = end - 2
  while (tail > start && /\s/.test(text[tail]!)) tail--
  const closing = head[1] === "/"
  return {
    kind: "tag",
    end,
    name: head[2]!.toLowerCase(),
    closing,
    selfClosing: !closing && text[tail] === "/",
  }
}

/** Remove markup and all element bodies; malformed/unclosed elements hide the remainder conservatively. */
function stripXmlElements(text: string): string {
  let out = ""
  let outsideStart = 0
  let cursor = 0
  const openElements: string[] = []

  while (cursor < text.length) {
    const start = text.indexOf("<", cursor)
    if (start < 0) break
    const markup = xmlMarkupAt(text, start)
    if (!markup) {
      cursor = start + 1
      continue
    }
    if (markup.kind === "unterminated") {
      if (openElements.length === 0) out += text.slice(outsideStart, start)
      return `${out} `
    }

    if (openElements.length === 0) {
      out += text.slice(outsideStart, start)
      if (markup.kind === "opaque" || markup.closing || markup.selfClosing) {
        out += " "
        outsideStart = markup.end
      } else {
        out += " "
        openElements.push(markup.name)
        outsideStart = markup.end
      }
    } else if (markup.kind === "tag") {
      if (!markup.closing && !markup.selfClosing) openElements.push(markup.name)
      else if (markup.closing && openElements[openElements.length - 1] === markup.name) {
        openElements.pop()
        if (openElements.length === 0) outsideStart = markup.end
      }
    }
    cursor = markup.end
  }

  if (openElements.length === 0) out += text.slice(outsideStart)
  return out
}

export function sanitizeForDetection(text: string): string {
  if (!text) return ""
  let out = text.replace(/\r\n?/g, "\n")
  out = out.replace(FENCED_BLOCK, "$1")
  out = out.replace(QUOTED_OR_TRANSCRIPT_LINE, "\n")
  out = out.replace(INLINE_CODE, " ")
  out = out.replace(URL, " ")
  out = out.replace(FILE_PATH, " ")
  out = out.replace(DOUBLE_QUOTED, " ")
  out = out.replace(CURLY_DOUBLE, " ")
  out = out.replace(CURLY_SINGLE, " ")
  out = out.replace(SINGLE_QUOTED, " ")
  out = stripXmlElements(out)
  return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}
