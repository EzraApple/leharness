import assert from "node:assert/strict"
import { transcriptTestInternals } from "../src/components/transcript.js"
import {
  appendCell,
  initialTranscript,
  reduceEvent,
  reduceText,
  setLatestToolDetailExpanded,
} from "../src/state/transcript.js"

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
assert.ok(toolCell)
assert.equal(toolCell.display?.completed, "edited")
assert.equal(toolCell.display?.target, "a.ts")
assert.equal(toolCell.text, "Changed +1 -1 lines")
const editRows = transcriptTestInternals.buildRows([toolCell], { running: false, width: 80 })
assert.equal(
  editRows.some((row) => row.text.includes("edited a.ts · changed +1 -1 lines")),
  true,
)

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
assert.equal(
  state.cells.find((cell) => cell.title === "read_file_batch")?.display?.target,
  "3 files",
)
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
assert.equal(
  state.cells.find((cell) => cell.title === "read_file_batch")?.display?.target,
  "3 files",
)
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
assert.equal(readBatchCell?.detail, "README.md\nrain.md\nthe-ocean.md")
let expanded = setLatestToolDetailExpanded(state, true)
assert.equal(expanded.changed, true)
assert.equal(expanded.state.cells.find((cell) => cell.title === "read_file_batch")?.expanded, true)
expanded = setLatestToolDetailExpanded(expanded.state, false)
assert.equal(expanded.changed, true)
assert.equal(expanded.state.cells.find((cell) => cell.title === "read_file_batch")?.expanded, false)
expanded = setLatestToolDetailExpanded(state, true, "read")
assert.equal(expanded.changed, true)
assert.equal(expanded.state.cells.find((cell) => cell.title === "read_file_batch")?.expanded, true)

const poemFiles = [
  "poems/after-rain.md",
  "poems/city-window.md",
  "poems/low-tide.md",
  "poems/morning-train.md",
  "poems/night-garden.md",
  "poems/snow-light.md",
  "poems/western-sky.md",
]

state = initialTranscript()
state = reduceEvent(state, {
  id: "event-poetry-model",
  text: "I'll review the poems and update the set.",
  toolCalls: [
    ...poemFiles.map((path, index) => ({
      args: { path },
      id: `poem_read_${index}`,
      name: "read_file",
    })),
    ...poemFiles.slice(0, 6).map((path, index) => ({
      args: { path, old_string: "old", new_string: "new" },
      id: `poem_edit_${index}`,
      name: "edit_file",
    })),
    {
      args: { path: "README.md", old_string: "old list", new_string: "new list" },
      id: "poem_readme",
      name: "edit_file",
    },
  ],
  ts: "2026-05-07T00:00:00.000Z",
  type: "model.completed",
  v: 1,
})

for (const [index, path] of poemFiles.entries()) {
  const id = `poem_read_${index}`
  state = reduceEvent(state, {
    call: { args: { path }, id, name: "read_file" },
    display: {
      completed: "read",
      failed: "could not read",
      pending: "reading",
      target: path,
    },
    id: `event-poem-read-start-${index}`,
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
    id: `event-poem-read-done-${index}`,
    result: "line one\nline two\n",
    ts: "2026-05-07T00:00:00.000Z",
    type: "tool.completed",
    v: 1,
  })
}

for (const [index, path] of poemFiles.slice(0, 6).entries()) {
  const id = `poem_edit_${index}`
  state = reduceEvent(state, {
    call: { args: { path, old_string: "old", new_string: "new" }, id, name: "edit_file" },
    display: {
      completed: "edited",
      failed: "could not edit",
      pending: "editing",
      target: path,
    },
    id: `event-poem-edit-start-${index}`,
    ts: "2026-05-07T00:00:00.000Z",
    type: "tool.started",
    v: 1,
  })
  state = reduceEvent(state, {
    call: { args: { path, old_string: "old", new_string: "new" }, id, name: "edit_file" },
    display: {
      completed: "edited",
      failed: "could not edit",
      pending: "editing",
      summary: "Changed +4 -1 lines",
      target: path,
    },
    id: `event-poem-edit-done-${index}`,
    result: "Edited poem",
    ts: "2026-05-07T00:00:00.000Z",
    type: "tool.completed",
    v: 1,
  })
}

state = reduceEvent(state, {
  call: {
    args: { path: "README.md", old_string: "old list", new_string: "new list" },
    id: "poem_readme",
    name: "edit_file",
  },
  display: {
    completed: "edited",
    failed: "could not edit",
    pending: "editing",
    target: "README.md",
  },
  id: "event-poem-readme-start",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
state = reduceEvent(state, {
  call: {
    args: { path: "README.md", old_string: "old list", new_string: "new list" },
    id: "poem_readme",
    name: "edit_file",
  },
  display: {
    completed: "edited",
    failed: "could not edit",
    pending: "editing",
    summary: "Added 7 lines",
    target: "README.md",
  },
  id: "event-poem-readme-done",
  result: "Edited README",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.completed",
  v: 1,
})

const poetryBatch = state.cells.find((cell) => cell.title === "read_file_batch")
const poetryEdits = state.cells.filter((cell) => cell.title === "edit_file")
assert.equal(state.cells.filter((cell) => cell.title === "read_file_batch").length, 1)
assert.equal(poetryBatch?.display?.target, "7 files")
assert.equal(poetryBatch?.text, "")
assert.equal(poetryBatch?.detail, poemFiles.join("\n"))
assert.equal(poetryEdits.length, 7)
assert.equal(
  poetryEdits.every((cell) => !cell.text.includes("bytes")),
  true,
)
assert.equal(poetryEdits.at(-1)?.display?.target, "README.md")
assert.equal(poetryEdits.at(-1)?.text, "Added 7 lines")

state = initialTranscript()
state = reduceEvent(state, {
  id: "event-bash-model",
  text: "I'll run the tests.",
  toolCalls: [{ args: { command: "pnpm test" }, id: "bash_1", name: "bash" }],
  ts: "2026-05-07T00:00:00.000Z",
  type: "model.completed",
  v: 1,
})
state = reduceEvent(state, {
  call: { args: { command: "pnpm test" }, id: "bash_1", name: "bash" },
  display: {
    completed: "ran",
    failed: "command failed",
    pending: "running",
    target: "pnpm test",
  },
  id: "event-bash-start",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
state = reduceEvent(state, {
  call: { args: { command: "pnpm test" }, id: "bash_1", name: "bash" },
  display: {
    completed: "ran",
    failed: "command failed",
    pending: "running",
    summary: "exit 1 · 42 lines",
    target: "pnpm test",
  },
  id: "event-bash-done",
  result: "$ pnpm test\nok 1\nError: snapshot mismatch\n\n[exit: 1]",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.completed",
  v: 1,
})
const bashCell = state.cells.find((cell) => cell.title === "bash")
assert.equal(bashCell?.outcome, "failed")
assert.equal(bashCell?.text, "exit 1 · 42 lines\nError: snapshot mismatch")
assert.equal(bashCell?.detail, "ok 1\nError: snapshot mismatch")
expanded = setLatestToolDetailExpanded(state, true, "bash")
assert.equal(expanded.changed, true)
assert.equal(expanded.state.cells.find((cell) => cell.title === "bash")?.expanded, true)

state = initialTranscript()
state = reduceEvent(state, {
  call: {
    args: { path: "poems/missing.md", old_string: "x", new_string: "y" },
    id: "edit_fail",
    name: "edit_file",
  },
  display: {
    completed: "edited",
    failed: "could not edit",
    pending: "editing",
    target: "poems/missing.md",
  },
  id: "event-edit-fail-start",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
state = reduceEvent(state, {
  call: {
    args: { path: "poems/missing.md", old_string: "x", new_string: "y" },
    id: "edit_fail",
    name: "edit_file",
  },
  display: {
    completed: "edited",
    failed: "could not edit",
    pending: "editing",
    summary: "old_string matched 0 times",
    target: "poems/missing.md",
  },
  error: "edit_file failed: old_string matched 0 times",
  id: "event-edit-fail-done",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.failed",
  v: 1,
})
const editFailureCell = state.cells.find((cell) => cell.title === "edit_file")
assert.equal(editFailureCell?.status, "failed")
assert.equal(editFailureCell?.outcome, "failed")
assert.equal(editFailureCell?.text, "old_string matched 0 times")
assert.equal(editFailureCell?.detail, "edit_file failed: old_string matched 0 times")

state = initialTranscript()
state = reduceText(state, "partial")
state = reduceEvent(state, {
  id: "event-cancelled-model",
  text: "partial",
  ts: "2026-05-07T00:00:00.000Z",
  type: "model.cancelled",
  v: 1,
})
state = reduceEvent(state, {
  id: "event-cancelled-finished",
  reason: "cancelled",
  ts: "2026-05-07T00:00:00.000Z",
  type: "agent.finished",
  v: 1,
})
const cancelledCell = state.cells.at(-1)
assert.equal(cancelledCell?.kind, "system")
assert.equal(cancelledCell?.outcome, "cancelled")
assert.equal(cancelledCell?.text, "cancelled")

state = appendCell(initialTranscript(), {
  kind: "system",
  title: "model",
  text: "Switched to openai/gpt-5.4 (effort high).",
})
assert.equal(state.cells[0]?.kind, "system")
assert.equal(state.cells[0]?.title, "model")

console.log("smoke-transcript: transient thinking, tool display, preparation, and read grouping ok")
