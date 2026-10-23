import { expect, test } from "bun:test"
import { renderFrame, TranscriptLayoutCache } from "../src/tui/render.ts"
import { TranscriptModel } from "../src/tui/transcript-model.ts"

test("cached searched frames match fresh replay across alternating sessions and live completion", () => {
  let now = 0
  const models = [new TranscriptModel("a", () => now), new TranscriptModel("b", () => now)]
  const histories: Array<Array<{ at: number; apply: (model: TranscriptModel) => void }>> = [[], []]
  const cache = new TranscriptLayoutCache()
  for (let step = 0; step < 48; step++) {
    now = step * 1000
    const session = Math.floor(step / 6) % 2
    const round = Math.floor(step / 12)
    const id = `shell-${round}`
    const mutations: Array<(m: TranscriptModel) => void> = [
      m => m.append({ provenance: "assistant", text: `## 한글 ${round}\n\n**answer** é 👩‍💻` }),
      m => { m.shellStarted(id, "echo 한글") },
      () => {},
      m => m.shellFinished(id, { status: "complete", exitCode: 0, signal: null, durationMs: 2000,
        lines: Array.from({ length: 25 }, (_, i) => `output ${i}`), totalLines: 25 }),
      m => { m.toggle(id) },
      m => m.append("done"),
    ]
    const apply = mutations[step % 6]!
    histories[session]!.push({ at: now, apply })
    const model = models[session]!
    apply(model)
    for (const query of [undefined, "", "missing", "한글", "output", "done"]) {
      const replay = new TranscriptModel(session === 0 ? "a" : "b", () => now)
      for (const entry of histories[session]!) { now = entry.at; entry.apply(replay) }
      now = step * 1000 + 500
      const expected = replay.lines(query)
      const actual = model.lines(query)
      expect(actual, `step ${step}, query ${query}`).toEqual(expected)
      const options = { columns: [60, 81, 120][step % 3]!, rows: 24, status: "ready", draft: `draft ${step}`,
        cursor: 3, transcriptOffset: step % 7, ascii: step % 2 === 0, spinner: step % 2 ? "⠋" : "⠙" }
      expect(renderFrame({ ...options, transcript: actual, transcriptLayout: cache }))
        .toBe(renderFrame({ ...options, transcript: expected }))
    }
  }
})
