import type { Event, ToolCall, ToolDisplaySnapshot } from "@leharness/harness"
import { collapseSkillLoadHints } from "../utils/display.js"
import { finishReason, summarize } from "../utils/format.js"
import type { Cell, ToolStatus, TranscriptState } from "./types.js"

type CellInput = Omit<Cell, "id">

export function initialTranscript(): TranscriptState {
  return {
    activeAssistantIndex: undefined,
    cells: [],
    nextCellId: 0,
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

function insertCellInline(state: TranscriptState, index: number, cell: CellInput): void {
  const id = `cell-${state.nextCellId}`
  state.nextCellId += 1
  state.cells.splice(index, 0, { id, ...cell })
  if (state.activeAssistantIndex !== undefined && state.activeAssistantIndex >= index) {
    state.activeAssistantIndex += 1
  }
  for (const [toolCallId, toolIndex] of state.toolCellById) {
    if (toolIndex >= index) state.toolCellById.set(toolCallId, toolIndex + 1)
  }
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
      appendReasoning(next, event)
      commitAssistant(next, event)
      if (event.type === "model.cancelled") break
      for (const call of readToolCalls(event.toolCalls)) next.toolCellById.delete(call.id)
      break
    }
    case "tool.started": {
      const call = readToolCall(event.call)
      if (call === undefined) break
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

function appendReasoning(state: TranscriptState, event: Event): void {
  const reasoningText = String(event.reasoningText ?? "").trim()
  if (reasoningText.length === 0) return
  const cell: CellInput = {
    kind: "system",
    text: summarize(reasoningText, 10, 1200),
    title: "reasoning",
  }
  if (state.activeAssistantIndex === undefined) {
    pushCell(state, cell)
    return
  }
  insertCellInline(state, state.activeAssistantIndex, cell)
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
