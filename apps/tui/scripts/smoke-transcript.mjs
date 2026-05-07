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

state = initialTranscript()
state = reduceEvent(state, {
  id: "event-2",
  text: "I will edit.",
  toolCalls: [{ args: { path: "a.ts" }, id: "call_1", name: "edit_file" }],
  ts: "2026-05-07T00:00:00.000Z",
  type: "model.completed",
  v: 1,
})
state = reduceEvent(state, {
  call: { args: { path: "a.ts" }, id: "call_1", name: "edit_file" },
  display: {
    completed: "edited",
    failed: "could not edit",
    pending: "editing",
    target: "a.ts",
  },
  id: "event-3",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
assert.equal(state.cells.find((cell) => cell.kind === "tool")?.status, "pending")
state = reduceEvent(state, {
  call: { args: { path: "a.ts" }, id: "call_1", name: "edit_file" },
  display: {
    completed: "edited",
    failed: "could not edit",
    pending: "editing",
    summary: "1 replacement · +1 -1 · 12 -> 13 bytes",
    target: "a.ts",
  },
  id: "event-4",
  result: "Edited a.ts",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.completed",
  v: 1,
})

const toolCell = state.cells.find((cell) => cell.kind === "tool")
assert.equal(toolCell?.display?.completed, "edited")
assert.equal(toolCell?.display?.target, "a.ts")
assert.equal(toolCell?.text, "1 replacement · +1 -1 · 12 -> 13 bytes")

console.log("smoke-transcript: reasoning and tool display ok")
