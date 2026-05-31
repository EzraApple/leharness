import {
  type Event,
  readRecordField,
  readStringField,
  readToolCall,
  readToolCalls,
  type TaskKind,
  type ToolCall,
} from "@leharness/harness"
import {
  completedSnapshotForCall,
  failedSnapshotForCall,
  pendingSnapshotForCall,
  snapshotForTaskKind,
  type ToolDisplaySnapshot,
} from "../display/tools.js"
import { collapseSkillLoadHints } from "../utils/display.js"
import { finishReason, summarize } from "../utils/format.js"
import type { ActiveTask, Cell, ReadBatch, ToolStatus, TranscriptState } from "./types.js"

type CellInput = Omit<Cell, "id">

export function initialTranscript(): TranscriptState {
  return {
    activeAssistantIndex: undefined,
    activeTasks: new Map(),
    cells: [],
    compactionInProgress: false,
    contextUsage: undefined,
    nextCellId: 0,
    nextReadBatchId: 0,
    pendingCompactionBaselineTokens: undefined,
    pendingCompactionCellIndex: undefined,
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

export function setLatestToolDetailExpanded(
  state: TranscriptState,
  expanded: boolean,
  target?: string,
): { changed: boolean; state: TranscriptState } {
  const next = cloneTranscript(state)
  const index = expanded
    ? findLatestExpandableCell(next, target)
    : findLatestExpandedCell(next, target)
  if (index === undefined) return { changed: false, state }
  const cell = next.cells[index]
  if (cell === undefined) return { changed: false, state }
  next.cells[index] = { ...cell, expanded }
  return { changed: true, state: next }
}

function pushCell(state: TranscriptState, cell: CellInput) {
  const id = `cell-${state.nextCellId}`
  state.nextCellId += 1
  state.cells.push({ id, ...cell })
}

function appendCellInline(state: TranscriptState, cell: CellInput): number {
  const index = state.cells.length
  pushCell(state, cell)
  return index
}

function updateCellInline(state: TranscriptState, index: number, update: Partial<CellInput>) {
  const cell = state.cells[index]
  if (cell === undefined) return
  state.cells[index] = { ...cell, ...update }
}

function replaceCellTextInline(state: TranscriptState, index: number, text: string) {
  updateCellInline(state, index, { text })
}

function appendCellTextInline(state: TranscriptState, index: number, delta: string) {
  const cell = state.cells[index]
  if (cell === undefined) return
  replaceCellTextInline(state, index, `${cell.text}${delta}`)
}

function updateToolInline(state: TranscriptState, index: number, update: Partial<CellInput>) {
  updateCellInline(state, index, update)
}

function cloneTranscript(state: TranscriptState): TranscriptState {
  return {
    activeAssistantIndex: state.activeAssistantIndex,
    activeTasks: new Map(state.activeTasks),
    cells: state.cells.map((cell) => ({ ...cell })),
    compactionInProgress: state.compactionInProgress,
    contextUsage: state.contextUsage === undefined ? undefined : { ...state.contextUsage },
    nextCellId: state.nextCellId,
    nextReadBatchId: state.nextReadBatchId,
    pendingCompactionBaselineTokens: state.pendingCompactionBaselineTokens,
    pendingCompactionCellIndex: state.pendingCompactionCellIndex,
    readBatchByCallId: new Map(state.readBatchByCallId),
    readBatches: new Map(
      [...state.readBatches].map(([key, batch]) => [
        key,
        { ...batch, targets: [...batch.targets] },
      ]),
    ),
    toolCellById: new Map(state.toolCellById),
  }
}

function findLatestExpandableCell(
  state: TranscriptState,
  target: string | undefined,
): number | undefined {
  for (let index = state.cells.length - 1; index >= 0; index--) {
    const cell = state.cells[index]
    if (
      cell?.detail !== undefined &&
      cell.detail.trim().length > 0 &&
      matchesDetailTarget(cell, target)
    ) {
      return index
    }
  }
  return undefined
}

function findLatestExpandedCell(
  state: TranscriptState,
  target: string | undefined,
): number | undefined {
  for (let index = state.cells.length - 1; index >= 0; index--) {
    const cell = state.cells[index]
    if (cell?.expanded === true && matchesDetailTarget(cell, target)) return index
  }
  return undefined
}

function matchesDetailTarget(cell: Cell, target: string | undefined): boolean {
  if (target === undefined || target.trim().length === 0) return true
  const normalized = target.toLowerCase().replace(/^\/+/, "")
  if (["read", "reads", "file", "files"].includes(normalized)) {
    return cell.title === "read_file_batch"
  }
  if (["sh", "shell", "command"].includes(normalized)) return cell.title === "bash"
  return (cell.title ?? "").toLowerCase().includes(normalized)
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
    case "invocation.auto":
      next.activeAssistantIndex = undefined
      break
    case "model.completed":
    case "model.cancelled": {
      commitAssistant(next, event)
      if (event.type === "model.completed") {
        prepareReadBatches(next, readToolCalls(event.toolCalls))
        applyModelUsage(next, event)
      }
      break
    }
    case "tool.started": {
      const call = readToolCall(event.call)
      if (call === undefined) break
      if (startReadBatchTool(next, call)) break
      const display = pendingSnapshotForCall(call)
      const existingIndex = next.toolCellById.get(call.id)
      if (existingIndex !== undefined && next.cells[existingIndex] !== undefined) {
        updateToolInline(next, existingIndex, {
          detail: undefined,
          display,
          expanded: false,
          kind: "tool",
          outcome: undefined,
          status: "pending",
          text: "",
          title: call.name,
        })
        break
      }
      const index = appendCellInline(next, {
        display,
        expanded: false,
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
        outcome: "failed",
        text: String(event.error ?? "model failed"),
        title: "model",
      })
      break
    case "agent.finished":
      next.activeAssistantIndex = undefined
      if (event.reason !== "no_tool_calls") {
        const reason = String(event.reason ?? "unknown")
        pushCell(next, {
          kind: "system",
          outcome:
            reason === "cancelled" ? "cancelled" : reason === "model_failed" ? "failed" : undefined,
          text: finishReason(reason),
          title: "status",
        })
      }
      break
    case "task.started":
      handleTaskStarted(next, event)
      break
    case "task.completed":
      handleTaskTerminal(next, event, "completed")
      break
    case "task.failed":
      handleTaskTerminal(next, event, "failed")
      break
    case "task.cancelled":
      handleTaskTerminal(next, event, "cancelled")
      break
    case "compaction.started":
      next.compactionInProgress = true
      break
    case "compaction.summary.failed":
      next.compactionInProgress = false
      break
    case "compaction.completed":
      handleCompactionCompleted(next, event)
      break
  }
  return next
}

function handleTaskStarted(state: TranscriptState, event: Event) {
  const task = readTaskRecord(event.task)
  if (task === undefined) return
  const summary = typeof event.summary === "string" ? event.summary : undefined
  const display = snapshotForTaskKind(task.kind, task.payload, summary)
  const command = task.payload?.command ?? ""
  const active: ActiveTask = {
    id: task.id,
    kind: task.kind,
    command,
    startedAt: task.startedAt ?? new Date().toISOString(),
    display,
  }
  state.activeTasks.set(task.id, active)

  // Prefer to upgrade the existing tool.started cell in place so the inline
  // pending spinner stops; only append a fresh cell when there's no matching
  // foreground cell (e.g. when replaying events on resume).
  const callId = typeof event.callId === "string" ? event.callId : undefined
  const existingIndex = callId === undefined ? undefined : state.toolCellById.get(callId)
  const update = {
    background: { phase: "started" as const, taskId: task.id },
    detail: undefined,
    display,
    expanded: false,
    kind: "tool" as const,
    outcome: undefined,
    status: undefined,
    text: "",
    title: task.kind,
  }
  if (existingIndex !== undefined && state.cells[existingIndex] !== undefined) {
    updateToolInline(state, existingIndex, update)
    if (callId !== undefined) state.toolCellById.delete(callId)
    return
  }
  pushCell(state, update)
}

function handleTaskTerminal(
  state: TranscriptState,
  event: Event,
  phase: "completed" | "failed" | "cancelled",
) {
  const taskId = typeof event.taskId === "string" ? event.taskId : undefined
  if (taskId === undefined) return
  const active = state.activeTasks.get(taskId)
  state.activeTasks.delete(taskId)
  const summary = typeof event.summary === "string" ? event.summary : undefined
  const display =
    active?.display ?? snapshotForTaskKind(active?.kind ?? "shell", undefined, summary)
  const text =
    phase === "cancelled"
      ? `cancelled (${typeof event.reason === "string" ? event.reason.replace("_", " ") : "user"})`
      : (summary ?? (phase === "completed" ? "completed" : "failed"))
  const detail = phase === "failed" || phase === "cancelled" ? readTerminalDetail(event) : undefined
  const outcome = phase === "completed" ? "ok" : phase === "failed" ? "failed" : "cancelled"
  const status: ToolStatus = phase === "failed" ? "failed" : "completed"
  pushCell(state, {
    background: {
      phase,
      taskId,
      reason:
        phase === "cancelled" && typeof event.reason === "string"
          ? event.reason === "process_exited"
            ? "process_exited"
            : event.reason === "parent"
              ? "parent"
              : "user"
          : undefined,
    },
    detail,
    display: summary === undefined ? display : { ...display, summary },
    kind: status === "failed" ? "error" : "tool",
    outcome,
    status,
    text,
    title: active?.kind ?? "task",
  })
}

function readTaskRecord(value: unknown):
  | {
      id: string
      kind: TaskKind
      payload: { command?: string } | undefined
      startedAt: string | undefined
    }
  | undefined {
  const record = readRecordField({ value }, "value")
  if (record === undefined) return undefined
  const id = readStringField(record, "id")
  const kind = readTaskKind(readStringField(record, "kind"))
  if (id === undefined || kind === undefined) return undefined
  const rawPayload = readRecordField(record, "payload")
  const command = readStringField(rawPayload, "command")
  const payload = command === undefined ? undefined : { command }
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : undefined
  return { id, kind, payload, startedAt }
}

function readTerminalDetail(event: Event): string | undefined {
  const error = typeof event.error === "string" ? event.error.trim() : ""
  if (error.length > 0) return error
  const result = typeof event.result === "string" ? event.result.trim() : ""
  return result.length > 0 ? result : undefined
}

// Track real-token usage from the model's response. This is the only
// signal the TUI has for the "32k / 850k (4%)" footer indicator — see
// plan 007. The budget piece is set by compaction.completed when it
// runs; until the first compaction.completed or a manual config, we
// don't know the budget, so we cache a default of "tokens, undefined
// budget" and let the footer hide the percentage in that case.
function applyModelUsage(state: TranscriptState, event: Event) {
  const usage = readRecordField(event, "usage")
  const tokens = typeof usage?.promptTokens === "number" ? usage.promptTokens : undefined
  if (tokens === undefined) return

  const existingBudget = state.contextUsage?.budget ?? 0
  state.contextUsage = { tokens, budget: existingBudget }

  // If a compaction.completed left us with a pending transient cell,
  // we now know what the post-compaction prompt actually cost in
  // tokens. Patch the cell with the savings.
  const pendingIndex = state.pendingCompactionCellIndex
  const baseline = state.pendingCompactionBaselineTokens
  if (pendingIndex !== undefined && baseline !== undefined) {
    const saved = baseline - tokens
    if (saved > 0) {
      const cell = state.cells[pendingIndex]
      if (cell !== undefined) {
        state.cells[pendingIndex] = {
          ...cell,
          text: `${cell.text} · saved ${formatTokens(saved)} tokens`,
        }
      }
    }
    state.pendingCompactionCellIndex = undefined
    state.pendingCompactionBaselineTokens = undefined
  }
}

function handleCompactionCompleted(state: TranscriptState, event: Event) {
  state.compactionInProgress = false
  const summarizedCount = readNumber(event, "summarizedWindowCount") ?? 0
  const droppedToolBodies = readNumber(event, "droppedToolBodyCount") ?? 0
  const promotedInline = readNumber(event, "promotedInlineCount") ?? 0
  const droppedReasoning = readNumber(event, "droppedReasoningCount") ?? 0
  const truncatedFromFront = readNumber(event, "truncatedFromFrontCount") ?? 0
  const budgetTokens = readNumber(event, "budgetTokens")
  const lastInputTokens = readNumber(event, "lastInputTokens")

  if (budgetTokens !== undefined) {
    const tokens = state.contextUsage?.tokens ?? lastInputTokens ?? 0
    state.contextUsage = { tokens, budget: budgetTokens }
  }

  const parts: string[] = []
  if (summarizedCount > 0) parts.push(`${summarizedCount} summarized`)
  if (promotedInline > 0) parts.push(`${promotedInline} promoted`)
  if (droppedToolBodies > 0) parts.push(`${droppedToolBodies} dropped`)
  if (droppedReasoning > 0) parts.push(`${droppedReasoning} reasoning trimmed`)
  if (truncatedFromFront > 0) parts.push(`${truncatedFromFront} truncated`)
  if (parts.length === 0) return

  const summaryText = `compacted: ${parts.join(" · ")}`
  const cellIndex = state.cells.length
  pushCell(state, {
    kind: "system",
    text: summaryText,
    title: "compaction",
  })
  if (lastInputTokens !== undefined) {
    state.pendingCompactionCellIndex = cellIndex
    state.pendingCompactionBaselineTokens = lastInputTokens
  }
}

function readNumber(event: Event, key: string): number | undefined {
  const value = event[key]
  return typeof value === "number" ? value : undefined
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`
  return String(tokens)
}

function commitAssistant(state: TranscriptState, event: Event) {
  const text = String(event.text ?? "")
  if (state.activeAssistantIndex === undefined) {
    if (text.length > 0) pushCell(state, { kind: "assistant", text })
    return
  }
  if (text.length > 0) replaceCellTextInline(state, state.activeAssistantIndex, text)
  state.activeAssistantIndex = undefined
}

function completeTool(state: TranscriptState, event: Event, status: ToolStatus) {
  const call = readToolCall(event.call)
  const output = status === "completed" ? String(event.result ?? "") : String(event.error ?? "")
  const summary = typeof event.summary === "string" ? event.summary : undefined
  const display =
    call === undefined
      ? undefined
      : status === "completed"
        ? completedSnapshotForCall(call, output, summary)
        : failedSnapshotForCall(call, output, summary)
  if (call !== undefined && completeReadBatchTool(state, call, display, output, status)) return
  const text = toolCellText(call, display, output, status)
  const detail = toolCellDetail(call, output, status)
  const outcome = toolOutcome(call, text, status)
  if (call?.id !== undefined) {
    const index = state.toolCellById.get(call.id)
    const cell = index === undefined ? undefined : state.cells[index]
    if (index !== undefined && cell !== undefined) {
      updateToolInline(state, index, {
        detail,
        display: display ?? cell.display,
        outcome,
        status,
        text,
      })
      return
    }
  }
  pushCell(state, {
    detail,
    display,
    kind: status === "failed" ? "error" : "tool",
    outcome,
    status,
    text,
    title: call?.name ?? "tool",
  })
}

function prepareReadBatches(state: TranscriptState, calls: ToolCall[]) {
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

function registerReadBatch(state: TranscriptState, calls: ToolCall[]) {
  if (calls.length < 2) return
  const key = `read-batch-${state.nextReadBatchId}`
  state.nextReadBatchId += 1
  state.readBatches.set(key, {
    completed: 0,
    failed: false,
    targets: calls.map(readToolCallTarget),
    total: calls.length,
  })
  for (const call of calls) state.readBatchByCallId.set(call.id, key)
}

function startReadBatchTool(state: TranscriptState, call: ToolCall): boolean {
  const batch = readBatchForCall(state, call)
  if (batch === undefined) return false
  if (batch.cellIndex !== undefined && state.cells[batch.cellIndex] !== undefined) return true
  batch.cellIndex = appendCellInline(state, {
    detail: readBatchText(batch),
    display: readBatchDisplay(batch),
    expanded: false,
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
  const detail = readBatchText(batch)
  const text =
    status === "failed"
      ? [compactToolSummary(display?.summary) ?? summarize(output, 4, 400)]
          .filter((part) => part.length > 0)
          .join("\n")
      : ""
  const index = batch.cellIndex
  if (index !== undefined) {
    updateToolInline(state, index, {
      detail,
      display: readBatchDisplay(batch),
      outcome: batch.failed ? "failed" : undefined,
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
  return plural(batch.total, "file")
}

function readBatchText(batch: ReadBatch): string {
  const visibleTargets = batch.targets.filter((target) => target.length > 0)
  if (visibleTargets.length === 0) return ""
  const maxTargets = 12
  const shown = visibleTargets.slice(0, maxTargets)
  const hidden = visibleTargets.length - shown.length
  return [...shown, hidden > 0 ? `... ${plural(hidden, "more file")}` : undefined]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function readToolCallTarget(call: ToolCall): string {
  return readStringField(call.args, "path") ?? ""
}

function compactToolSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined
  const byteStripped = summary
    .split(/\s+·\s+/g)
    .filter((part) => !/\bbytes?\b/i.test(part))
    .join(" · ")
    .trim()
  const lineChange = /(?:^|\s)([+-]\d+)\s+([+-]\d+)(?:\s+lines?)?/i.exec(byteStripped)
  if (lineChange !== null) {
    const added = Number.parseInt((lineChange[1] ?? "+0").replace("+", ""), 10)
    const removed = Math.abs(Number.parseInt(lineChange[2] ?? "-0", 10))
    if (added > 0 && removed === 0) return `Added ${plural(added, "line")}`
    if (removed > 0 && added === 0) return `Removed ${plural(removed, "line")}`
    return `Changed +${added} -${removed} lines`
  }
  return byteStripped.length > 0 ? byteStripped : undefined
}

function toolCellText(
  call: ToolCall | undefined,
  display: ToolDisplaySnapshot | undefined,
  output: string,
  status: ToolStatus,
): string {
  const summary = compactToolSummary(display?.summary) ?? summarize(output, 8, 900)
  if (call?.name !== "bash" || status === "failed") return summary
  const failureLine = bashExitCode(summary) > 0 ? firstUsefulOutputLine(output) : undefined
  return [summary, failureLine].filter((part): part is string => part !== undefined).join("\n")
}

function toolCellDetail(
  call: ToolCall | undefined,
  output: string,
  status: ToolStatus,
): string | undefined {
  if (call?.name === "bash") return commandBody(output)
  if (status !== "failed") return undefined
  const trimmed = output.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function toolOutcome(
  call: ToolCall | undefined,
  text: string,
  status: ToolStatus,
): CellInput["outcome"] {
  if (status === "failed") return "failed"
  if (call?.name === "bash" && bashExitCode(text) > 0) return "failed"
  return undefined
}

function bashExitCode(summary: string): number {
  const value = /\bexit\s+(\d+)\b/i.exec(summary)?.[1]
  return value === undefined ? 0 : Number.parseInt(value, 10)
}

function commandBody(output: string): string | undefined {
  const body = output
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("$ ") && !line.startsWith("[exit:") && !line.startsWith("[signal:"),
    )
    .join("\n")
    .trim()
  return body.length > 0 ? body : undefined
}

function firstUsefulOutputLine(output: string): string | undefined {
  const lines =
    commandBody(output)
      ?.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0) ?? []
  return (
    lines.find((line) =>
      /\b(error|failed|failure|exception|not found|no such|cannot|denied)\b|^ERR!/i.test(line),
    ) ?? lines[0]
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function readTaskKind(value: string | undefined): TaskKind | undefined {
  return value === "shell" || value === "delegated" ? value : undefined
}
