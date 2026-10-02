// lca control markers (<lca-mode>, <lca-flow>, <lca-resume>, <lca-skill-advice>) are written only by code. A user
// message that contains one — however obfuscated — must not carry it to the model, because the main prompt tells the
// model to follow <lca-flow> blocks. Matching runs on a "skeleton" of the text (TR39-style): compatibility forms
// folded (NFKC, e.g. fullwidth ＜), combining marks and invisible/format characters dropped, Cyrillic/Greek letters
// that look Latin mapped to Latin, lowercased. Ranges matched on the skeleton are removed from the ORIGINAL text, so
// legitimate text elsewhere in the message is never rewritten.

const NAMES = "lca-mode|lca-flow|lca-resume|lca-skill-advice"
const BLOCK_RE = new RegExp(`<(${NAMES})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "g")
const TAG_RE = new RegExp(`<\\/?(${NAMES})\\b[^>]*>`, "g")
const ANY_RE = new RegExp(`<\\/?(${NAMES})\\b`)

/** Letters from other scripts that render like the Latin letters used in marker names. */
const CONFUSABLES: Record<string, string> = {
  а: "a", А: "a", с: "c", С: "c", е: "e", Е: "e", о: "o", О: "o", р: "p", Р: "p", х: "x", Х: "x",
  у: "y", ѕ: "s", Ѕ: "s", і: "i", І: "i", ј: "j", ԁ: "d", ӏ: "l", Ӏ: "l", ɩ: "l", ʟ: "l", ⅼ: "l", ı: "i",
  α: "a", ο: "o", Ο: "o", ε: "e", ν: "v", κ: "k", Κ: "k", ϲ: "c", Ϲ: "c", ρ: "p", ѵ: "v", ꟾ: "l",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "﹣": "-", "－": "-", "˗": "-",
}
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|\uDB40[\uDC00-\uDDEF]/

type Skeleton = { text: string; index: number[] }

/** Skeleton of `text` plus, for every skeleton char, the index of the original code unit it came from. */
function skeleton(text: string): Skeleton {
  let out = ""
  const index: number[] = []
  let i = 0
  for (const ch of text) {
    const at = i
    i += ch.length
    if (INVISIBLE.test(ch)) continue
    const folded = (CONFUSABLES[ch] ?? ch).normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC")
    for (const c of folded) {
      const m = (CONFUSABLES[c] ?? c).toLowerCase()
      out += m
      for (let k = 0; k < m.length; k++) index.push(at)
    }
  }
  return { text: out, index }
}

export function hasLcaMarker(text: string): boolean {
  if (!text.includes("<") && !text.includes("＜") && !text.includes("﹤")) return false
  return ANY_RE.test(skeleton(text).text)
}

/** Remove lca marker blocks, then any leftover marker tags, from user text. Other text is kept byte-for-byte. */
export function stripForgedMarkers(text: string): string {
  let cur = text
  for (const re of [BLOCK_RE, TAG_RE]) {
    const sk = skeleton(cur)
    const cuts: Array<[number, number]> = []
    re.lastIndex = 0
    for (let m = re.exec(sk.text); m; m = re.exec(sk.text)) {
      const start = sk.index[m.index]!
      const lastSk = m.index + m[0].length - 1
      // end = after the original character that produced the last skeleton char
      const lastOrig = sk.index[lastSk]!
      const end = lastOrig + (cur.codePointAt(lastOrig)! > 0xffff ? 2 : 1)
      // also swallow the blank-line separator before a block, as the old suffix regex did
      const sep = cur.slice(Math.max(0, start - 2), start) === "\n\n" ? 2 : 0
      cuts.push([start - sep, end])
    }
    for (let k = cuts.length - 1; k >= 0; k--) cur = cur.slice(0, cuts[k]![0]) + cur.slice(cuts[k]![1])
  }
  return cur
}
