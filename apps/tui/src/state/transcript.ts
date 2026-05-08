import type { Event, ToolCall, ToolDisplaySnapshot } from "@leharness/harness"
import { collapseSkillLoadHints } from "../utils/display.js"
import { finishReason, summarize } from "../utils/format.js"
import type { Cell, ReadBatch, ToolStatus, TranscriptState } from "./types.js"

type CellInput = Omit<Cell, "id">

export function initialTranscript(): TranscriptState {
  return {
    activeAssistantIndex: undefined,
    cells: [],
    nextCellId: 0,
    nextReadBatchId: 0,
    readBatchByCallId: new Map(),
    readBatches: new Map(),
    toolCellById: new Map(),
  }
}

export function appendCell(state: TranscriptState, cell: CellInput): TranscriptState {
  const next = cloneTranscript(state)
  pushCell(next, cell)
  return next
}

function pushCell(state: TranscriptState, cell: CellInput): void {
  const id = `cell-${state.nextCellId}`
  state.nextCellId += 1
  state.cells.push({ id, ...cell })
}

function appendCellInline(state: TranscriptState, cell: CellInput): number {
  const index = state.cells.length
  pushCell(state, cell)
  return index
}

function updateCellInline(state: TranscriptState, index: number, update: Partial<CellInput>): void {
  const cell = state.cells[index]
  if (cell === undefined) return
  state.cells[index] = { ...cell, ...update }
}

function replaceCellTextInline(state: TranscriptState, index: number, text: string): void {
  updateCellInline(state, index, { text })
}

function appendCellTextInline(state: TranscriptState, index: number, delta: string): void {
  const cell = state.cells[index]
  if (cell === undefined) return
  replaceCellTextInline(state, index, `${cell.text}${delta}`)
}

function updateToolInline(state: TranscriptState, index: number, update: Partial<CellInput>): void {
  updateCellInline(state, index, update)
}

function cloneTranscript(state: TranscriptState): TranscriptState {
  return {
    activeAssistantIndex: state.activeAssistantIndex,
    cells: state.cells.map((cell) => ({ ...cell })),
    nextCellId: state.nextCellId,
    nextReadBatchId: state.nextReadBatchId,
    readBatchByCallId: new Map(state.readBatchByCallId),
    readBatches: new Map([...state.readBatches].map(([key, batch]) => [key, { ...batch }])),
    toolCellById: new Map(state.toolCellById),
  }
}

export function reduceText(state: TranscriptState, delta: string): TranscriptState {
  if (delta.length === 0) return state
  const next = cloneTranscript(state)
  let index = next.activeAssistantIndex
  if (index === undefined) {
    index = next.cells.length
    next.activeAssistantIndex = index
    appendCellInline(next, { kind: "assistant", text: "" })
  }
  appendCellTextInline(next, index, delta)
  return next
}

export function reduceEvent(state: TranscriptState, event: Event): TranscriptState {
  const next = cloneTranscript(state)
  switch (event.type) {
    case "invocation.received":
      next.activeAssistantIndex = undefined
      pushCell(next, { kind: "user", text: collapseSkillLoadHints(String(event.text ?? "")) })
      break
    case "model.completed":
    case "model.cancelled": {
      commitAssistant(next, event)
      if (event.type === "model.completed") prepareReadBatches(next, readToolCalls(event.toolCalls))
      break
    }
    case "tool.started": {
      const call = readToolCall(event.call)
      if (call === undefined) break
      if (startReadBatchTool(next, call)) break
      const existingIndex = next.toolCellById.get(call.id)
      if (existingIndex !== undefined && next.cells[existingIndex] !== undefined) {
        updateToolInline(next, existingIndex, {
          display: readDisplay(event.display),
          kind: "tool",
          status: "pending",
          text: "",
          title: call.name,
        })
        break
      }
      const index = appendCellInline(next, {
        display: readDisplay(event.display),
        kind: "tool",
        status: "pending",
        text: "",
        title: call.name,
      })
      next.toolCellById.set(call.id, index)
      break
    }
    case "tool.completed":
      completeTool(next, event, "completed")
      break
    case "tool.failed":
      completeTool(next, event, "failed")
      break
    case "model.failed":
      pushCell(next, {
        kind: "error",
        text: String(event.error ?? "model failed"),
        title: "model",
      })
      break
    case "agent.finished":
      next.activeAssistantIndex = undefined
      if (event.reason !== "no_tool_calls") {
        pushCell(next, {
          kind: "system",
          text: finishReason(String(event.reason ?? "unknown")),
          title: "status",
        })
      }
      break
  }
  return next
}

function commitAssistant(state: TranscriptState, event: Event): void {
  const text = String(event.text ?? "")
  if (state.activeAssistantIndex === undefined) {
    if (text.length > 0) pushCell(state, { kind: "assistant", text })
    return
  }
  if (text.length > 0) replaceCellTextInline(state, state.activeAssistantIndex, text)
  state.activeAssistantIndex = undefined
}

function completeTool(state: TranscriptState, event: Event, status: ToolStatus): void {
  const call = readToolCall(event.call)
  const output = status === "completed" ? String(event.result ?? "") : String(event.error ?? "")
  const display = readDisplay(event.display)
  if (call !== undefined && completeReadBatchTool(state, call, display, output, status)) return
  const text = display?.summary ?? summarize(output, 8, 900)
  if (call?.id !== undefined) {
    const index = state.toolCellById.get(call.id)
    const cell = index === undefined ? undefined : state.cells[index]
    if (index !== undefined && cell !== undefined) {
      updateToolInline(state, index, {
        display: display ?? cell.display,
        status,
        text,
      })
      return
    }
  }
  pushCell(state, {
    display,
    kind: status === "failed" ? "error" : "tool",
    status,
    text,
    title: call?.name ?? "tool",
  })
}

function prepareReadBatches(state: TranscriptState, calls: ToolCall[]): void {
  let run: ToolCall[] = []
  for (const call of calls) {
    if (call.name === "read_file") {
      run.push(call)
      continue
    }
    registerReadBatch(state, run)
    run = []
  }
  registerReadBatch(state, run)
}

function registerReadBatch(state: TranscriptState, calls: ToolCall[]): void {
  if (calls.length < 2) return
  const key = `read-batch-${state.nextReadBatchId}`
  state.nextReadBatchId += 1
  state.readBatches.set(key, {
    completed: 0,
    failed: false,
    total: calls.length,
  })
  for (const call of calls) state.readBatchByCallId.set(call.id, key)
}

function startReadBatchTool(state: TranscriptState, call: ToolCall): boolean {
  const batch = readBatchForCall(state, call)
  if (batch === undefined) return false
  if (batch.cellIndex !== undefined && state.cells[batch.cellIndex] !== undefined) return true
  batch.cellIndex = appendCellInline(state, {
    display: readBatchDisplay(batch),
    kind: "tool",
    status: "pending",
    text: "",
    title: "read_file_batch",
  })
  return true
}

function completeReadBatchTool(
  state: TranscriptState,
  call: ToolCall,
  display: ToolDisplaySnapshot | undefined,
  output: string,
  status: ToolStatus,
): boolean {
  const batch = readBatchForCall(state, call)
  if (batch === undefined) return false
  if (batch.cellIndex === undefined || state.cells[batch.cellIndex] === undefined) {
    startReadBatchTool(state, call)
  }
  if (status === "completed") batch.completed += 1
  if (status === "failed") batch.failed = true
  const done = batch.failed || batch.completed >= batch.total
  const text = status === "failed" ? (display?.summary ?? summarize(output, 4, 400)) : ""
  const index = batch.cellIndex
  if (index !== undefined) {
    updateToolInline(state, index, {
      display: readBatchDisplay(batch),
      status: batch.failed ? "failed" : done ? "completed" : "pending",
      text,
    })
  }
  return true
}

function readBatchForCall(state: TranscriptState, call: ToolCall): ReadBatch | undefined {
  const key = state.readBatchByCallId.get(call.id)
  return key === undefined ? undefined : state.readBatches.get(key)
}

function readBatchDisplay(batch: ReadBatch): ToolDisplaySnapshot {
  return {
    completed: "read",
    failed: "could not read",
    pending: "reading",
    target: readBatchTarget(batch),
  }
}

function readBatchTarget(batch: ReadBatch): string {
  if (batch.completed >= batch.total) return plural(batch.total, "file")
  return "files"
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function readToolCalls(value: unknown): ToolCall[] {
  return Array.isArray(value) ? value.filter(isToolCall) : []
}

function readToolCall(value: unknown): ToolCall | undefined {
  return isToolCall(value) ? value : undefined
}

function readDisplay(value: unknown): ToolDisplaySnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.pending !== "string" ||
    typeof candidate.completed !== "string" ||
    typeof candidate.failed !== "string"
  ) {
    return undefined
  }
  return {
    completed: candidate.completed,
    failed: candidate.failed,
    pending: candidate.pending,
    summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
    target: typeof candidate.target === "string" ? candidate.target : undefined,
  }
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    Object.hasOwn(candidate, "args")
  )
}
