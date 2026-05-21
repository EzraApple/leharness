import type { ToolDisplaySnapshot } from "@leharness/harness"

type CellKind = "system" | "user" | "assistant" | "tool" | "error"
export type ToolStatus = "pending" | "completed" | "failed"

export interface Cell {
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

export interface TranscriptState {
  nextCellId: number
  cells: Cell[]
  nextReadBatchId: number
  toolCellById: Map<string, number>
  activeAssistantIndex?: number
  readBatchByCallId: Map<string, string>
  readBatches: Map<string, ReadBatch>
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
