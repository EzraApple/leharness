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

assert.equal(state.cells.length, 1)
assert.equal(state.cells[0]?.kind, "assistant")
assert.equal(state.cells[0]?.text, "final")

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

state = initialTranscript()
state = reduceEvent(state, {
  call: {
    args: { path: "README.md", content: "large file" },
    id: "call_stream",
    name: "create_file",
  },
  display: {
    completed: "created",
    failed: "could not create",
    pending: "creating",
    target: "README.md",
  },
  id: "event-6",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
assert.equal(state.cells.filter((cell) => cell.kind === "tool").length, 1)
assert.equal(state.cells[0]?.display?.target, "README.md")

state = initialTranscript()
state = reduceEvent(state, {
  id: "event-7",
  text: "Reading files.",
  toolCalls: [
    { args: { path: "README.md" }, id: "read_1", name: "read_file" },
    { args: { path: "rain.md" }, id: "read_2", name: "read_file" },
    { args: { path: "the-ocean.md" }, id: "read_3", name: "read_file" },
  ],
  ts: "2026-05-07T00:00:00.000Z",
  type: "model.completed",
  v: 1,
})
state = reduceEvent(state, {
  call: { args: { path: "README.md" }, id: "read_1", name: "read_file" },
  display: {
    completed: "read",
    failed: "could not read",
    pending: "reading",
    target: "README.md",
  },
  id: "event-8",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
assert.equal(state.cells.filter((cell) => cell.kind === "tool").length, 1)
assert.equal(state.cells.find((cell) => cell.title === "read_file_batch")?.display?.target, "files")
state = reduceEvent(state, {
  call: { args: { path: "README.md" }, id: "read_1", name: "read_file" },
  display: {
    completed: "read",
    failed: "could not read",
    pending: "reading",
    target: "README.md",
  },
  id: "event-9",
  result: "readme",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.completed",
  v: 1,
})
assert.equal(state.cells.find((cell) => cell.title === "read_file_batch")?.display?.target, "files")
for (const [index, path] of ["rain.md", "the-ocean.md"].entries()) {
  const id = `read_${index + 2}`
  state = reduceEvent(state, {
    call: { args: { path }, id, name: "read_file" },
    display: {
      completed: "read",
      failed: "could not read",
      pending: "reading",
      target: path,
    },
    id: `event-${index + 10}`,
    ts: "2026-05-07T00:00:00.000Z",
    type: "tool.started",
    v: 1,
  })
  state = reduceEvent(state, {
    call: { args: { path }, id, name: "read_file" },
    display: {
      completed: "read",
      failed: "could not read",
      pending: "reading",
      target: path,
    },
    id: `event-${index + 12}`,
    result: path,
    ts: "2026-05-07T00:00:00.000Z",
    type: "tool.completed",
    v: 1,
  })
}
const readBatchCell = state.cells.find((cell) => cell.title === "read_file_batch")
assert.equal(state.cells.filter((cell) => cell.title === "read_file_batch").length, 1)
assert.equal(readBatchCell?.status, "completed")
assert.equal(readBatchCell?.display?.target, "3 files")
assert.equal(readBatchCell?.text, "")

console.log("smoke-transcript: transient thinking, tool display, preparation, and read grouping ok")
