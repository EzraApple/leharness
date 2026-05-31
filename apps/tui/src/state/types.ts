import type { TaskKind } from "@leharness/harness"
import type { ToolDisplaySnapshot } from "../display/tools.js"

type CellKind = "system" | "user" | "assistant" | "tool" | "error"
export type ToolStatus = "pending" | "completed" | "failed"

type BackgroundPhase = "started" | "completed" | "failed" | "cancelled"

interface BackgroundMarker {
  phase: BackgroundPhase
  taskId: string
  reason?: "parent" | "user" | "process_exited"
}

export interface Cell {
  background?: BackgroundMarker
  detail?: string
  id: string
  expanded?: boolean
  kind: CellKind
  outcome?: "cancelled" | "failed" | "ok"
  title?: string
  text: string
  status?: ToolStatus
  display?: ToolDisplaySnapshot
}

export interface ActiveTask {
  id: string
  kind: TaskKind
  command: string
  startedAt: string
  display: ToolDisplaySnapshot
}

export interface TranscriptState {
  nextCellId: number
  cells: Cell[]
  nextReadBatchId: number
  toolCellById: Map<string, number>
  activeAssistantIndex?: number
  readBatchByCallId: Map<string, string>
  readBatches: Map<string, ReadBatch>
  activeTasks: Map<string, ActiveTask>
  // Smart-compaction surface (plan 007).
  // `compactionInProgress` toggles the "compacting…" footer note. Set
  // true at compaction.summary (start) and back to false on
  // compaction.completed / compaction.summary.failed.
  compactionInProgress: boolean
  // Real-token context indicator, hydrated from model.completed.usage.
  // Undefined until the first model.completed arrives — footer hides
  // the indicator in that case.
  contextUsage?: ContextUsage
  // When the most recent compaction.completed lands, we know what we
  // dropped/promoted/summarized but NOT how many tokens we actually
  // saved (that only becomes visible from the next model.completed's
  // usage.promptTokens). The transient transcript cell is appended
  // immediately with the structural counts; its index is remembered
  // here so the next model.completed can patch in the savedTokens.
  pendingCompactionCellIndex?: number
  // Pre-compaction token count, captured when compaction.completed
  // lands; subtracted from the next model.completed.usage.promptTokens
  // to compute savedTokens.
  pendingCompactionBaselineTokens?: number
}

interface ContextUsage {
  tokens: number
  budget: number
}

export interface ReadBatch {
  cellIndex?: number
  completed: number
  failed: boolean
  targets: string[]
  total: number
}

export interface QueuedMessage {
  id: string
  text: string
}
