import assert from "node:assert/strict"
import { transcriptTestInternals } from "../src/components/transcript.js"
import {
  appendCell,
  initialTranscript,
  reduceEvent,
  reduceText,
  setLatestToolDetailExpanded,
} from "../src/state/transcript.js"
import { color, glyph } from "../src/theme.js"

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
  id: "event-3",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
assert.equal(state.cells.find((cell) => cell.kind === "tool")?.status, "pending")
state = reduceEvent(state, {
  call: { args: { path: "a.ts" }, id: "call_1", name: "edit_file" },
  id: "event-4",
  result: "Edited a.ts",
  summary: "Changed +1 -1 lines",
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

state = initialTranscript()
state = reduceEvent(state, {
  callId: "call_subagent",
  id: "event-subagent-started",
  summary: "spawned explorer · task_01ABCDEFGHJKLMNPQRSTUV",
  task: {
    id: "task_01ABCDEFGHJKLMNPQRSTUV",
    kind: "delegated",
    payload: {
      childSessionId: "child_01ABCDEFGHJKLMNPQRSTUV",
      kind: "delegated",
      presetName: "explorer",
      prompt: "Map the artifact recovery path",
    },
    sessionId: "session",
    startedAt: "2026-05-07T00:00:00.000Z",
    state: "running",
  },
  taskId: "task_01ABCDEFGHJKLMNPQRSTUV",
  ts: "2026-05-07T00:00:00.000Z",
  type: "task.started",
  v: 1,
})
const runningSubagentRows = transcriptTestInternals.buildRows(state.cells, {
  running: false,
  width: 80,
})
assert.equal(
  runningSubagentRows.some(
    (row) => row.color === color.userChevron && row.text.startsWith("┌─ subagent"),
  ),
  true,
)
state = reduceEvent(state, {
  id: "event-subagent-completed",
  result: "Mapped the path.",
  summary: "Mapped the path.",
  taskId: "task_01ABCDEFGHJKLMNPQRSTUV",
  ts: "2026-05-07T00:00:01.000Z",
  type: "task.completed",
  v: 1,
})
const completedSubagentRows = transcriptTestInternals.buildRows(state.cells, {
  running: false,
  width: 80,
})
assert.equal(
  completedSubagentRows.some((row) => row.text.startsWith("┌─ subagent")),
  false,
)
assert.equal(
  completedSubagentRows.some((row) => row.text.includes("ran subagent")),
  true,
)

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
    id: `event-poem-edit-done-${index}`,
    result: "Edited poem",
    summary: "Changed +4 -1 lines",
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
  id: "event-poem-readme-done",
  result: "Edited README",
  summary: "Added 7 lines",
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
  id: "event-bash-start",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.started",
  v: 1,
})
state = reduceEvent(state, {
  call: { args: { command: "pnpm test" }, id: "bash_1", name: "bash" },
  id: "event-bash-done",
  result: "$ pnpm test\nok 1\nError: snapshot mismatch\n\n[exit: 1]",
  ts: "2026-05-07T00:00:00.000Z",
  type: "tool.completed",
  v: 1,
})
const bashCell = state.cells.find((cell) => cell.title === "bash")
assert.equal(bashCell?.outcome, "failed")
assert.equal(bashCell?.text, "exit 1 · 2 lines\nError: snapshot mismatch")
assert.equal(bashCell?.detail, "ok 1\nError: snapshot mismatch")

// Tree-connector layout: a tool renders as a `⏺` headline with its output
// hanging under it on a `⎿` connector (continuation lines align, unmarked).
assert.ok(bashCell)
const bashRows = transcriptTestInternals.buildRows([bashCell], { running: false, width: 80 })
assert.ok(
  bashRows.some((row) => row.marker === glyph.headline && row.text.includes("ran pnpm test")),
  "bash headline row should carry the ⏺ marker",
)
assert.ok(
  bashRows.some((row) => row.marker === glyph.connector && row.text.includes("exit 1")),
  "bash output row should carry the ⎿ connector marker",
)

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
  error: "edit_file failed: old_string matched 0 times",
  id: "event-edit-fail-done",
  summary: "old_string matched 0 times",
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

// Smart-compaction reducer cases (plan 007).

// model.completed with usage.promptTokens updates contextUsage.
state = initialTranscript()
state = reduceEvent(state, {
  id: "ev-usage",
  text: "answer",
  reasoningText: undefined,
  toolCalls: [],
  ts: "2026-05-23T00:00:00.000Z",
  type: "model.completed",
  usage: { promptTokens: 4200, completionTokens: 80 },
  v: 1,
})
assert.equal(state.contextUsage?.tokens, 4200, "contextUsage.tokens should mirror promptTokens")
assert.equal(state.contextUsage?.budget, 0, "budget defaults to 0 until compaction.completed runs")

// compaction.started flips compactionInProgress true.
state = reduceEvent(state, {
  id: "ev-cstart",
  type: "compaction.started",
  ts: "2026-05-23T00:01:00.000Z",
  v: 1,
  phase: "summarizing",
  windowCount: 1,
  budgetTokens: 8000,
  lastInputTokens: 7200,
  pressureRatio: 0.9,
})
assert.equal(state.compactionInProgress, true, "compaction.started should set compactionInProgress")

// compaction.completed flips it back, adds a transient cell, and seeds
// pending fields for the next model.completed to compute savings.
const beforeCellsLen = state.cells.length
state = reduceEvent(state, {
  id: "ev-ccomp",
  type: "compaction.completed",
  ts: "2026-05-23T00:01:01.000Z",
  v: 1,
  strategy: "pressure_gradient",
  reason: "input_too_large",
  budgetTokens: 8000,
  lastInputTokens: 7200,
  pressureRatio: 0.9,
  watermarksCrossed: ["summarize_one_window"],
  droppedReasoningCount: 0,
  promotedInlineCount: 0,
  droppedToolBodyCount: 0,
  summarizedWindowCount: 1,
  truncatedFromFrontCount: 0,
})
assert.equal(
  state.compactionInProgress,
  false,
  "compaction.completed should turn off compactionInProgress",
)
assert.equal(state.cells.length, beforeCellsLen + 1, "should append one transient compaction cell")
const compactionCellIndex = state.pendingCompactionCellIndex
assert.notEqual(compactionCellIndex, undefined, "pending cell index should be set")
const compactionCell = state.cells[compactionCellIndex]
assert.equal(compactionCell?.kind, "system")
assert.equal(compactionCell?.title, "compaction")
assert.ok(
  compactionCell?.text.includes("1 summarized"),
  `expected '1 summarized' in cell, got "${compactionCell?.text}"`,
)
assert.equal(
  state.contextUsage?.budget,
  8000,
  "compaction.completed should populate the budget half of contextUsage",
)
assert.equal(
  state.pendingCompactionBaselineTokens,
  7200,
  "pending baseline tokens should be the pre-compaction lastInputTokens",
)
assert.notEqual(state.pendingCompactionCellIndex, undefined, "pending cell index should be set")

// Next model.completed lands with lower promptTokens → cell is patched
// with the savings.
state = reduceEvent(state, {
  id: "ev-postcompact",
  text: "answered",
  reasoningText: undefined,
  toolCalls: [],
  ts: "2026-05-23T00:01:05.000Z",
  type: "model.completed",
  usage: { promptTokens: 3000, completionTokens: 50 },
  v: 1,
})
assert.equal(state.contextUsage?.tokens, 3000, "contextUsage updates with the new promptTokens")
assert.equal(state.pendingCompactionCellIndex, undefined, "pending should be cleared after patch")
assert.equal(state.pendingCompactionBaselineTokens, undefined, "pending baseline cleared")
const patchedCell = state.cells[compactionCellIndex]
assert.ok(
  patchedCell?.text.includes("saved"),
  `compaction cell should be patched with savings; got "${patchedCell?.text}"`,
)
assert.ok(
  patchedCell.text.includes("4.2k"),
  `expected savings of 4.2k tokens (7200 - 3000), got "${patchedCell.text}"`,
)

// compaction.summary.failed turns compactionInProgress off too.
state = reduceEvent(state, {
  id: "ev-fail-start",
  type: "compaction.started",
  ts: "2026-05-23T00:02:00.000Z",
  v: 1,
  phase: "summarizing",
  windowCount: 1,
})
assert.equal(state.compactionInProgress, true)
state = reduceEvent(state, {
  id: "ev-fail",
  type: "compaction.summary.failed",
  ts: "2026-05-23T00:02:01.000Z",
  v: 1,
  attemptedEventIds: ["ev-a", "ev-b"],
  error: "boom",
})
assert.equal(state.compactionInProgress, false, "summary.failed should clear in-progress")

// cloneTranscript (exercised via every reduceEvent) preserves the new fields.
state = reduceEvent(state, {
  id: "ev-final",
  type: "agent.finished",
  ts: "z",
  v: 1,
  reason: "no_tool_calls",
})
assert.equal(state.contextUsage?.tokens, 3000, "contextUsage should survive across clones")

console.log(
  "smoke-transcript: transient thinking, tool display, preparation, read grouping, and compaction ok",
)
