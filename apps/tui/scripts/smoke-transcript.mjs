import assert from "node:assert/strict"
import { initialTranscript, reduceEvent, reduceText } from "../dist/state/transcript.js"

let state = initialTranscript()
state = reduceText(state, "final")
state = reduceEvent(state, {
  id: "event-1",
  reasoningText: "thought",
  text: "final",
  toolCalls: [],
  ts: "2026-05-07T00:00:00.000Z",
  type: "model.completed",
  v: 1,
})

assert.equal(state.cells.length, 2)
assert.equal(state.cells[0]?.title, "reasoning")
assert.equal(state.cells[0]?.text, "thought")
assert.equal(state.cells[1]?.kind, "assistant")
assert.equal(state.cells[1]?.text, "final")

console.log("smoke-transcript: reasoning precedes assistant")
