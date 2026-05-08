import type { ToolDisplaySnapshot } from "@leharness/harness"

type CellKind = "system" | "user" | "assistant" | "tool" | "error"
export type ToolStatus = "pending" | "completed" | "failed"

export interface Cell {
  id: string
  kind: CellKind
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
  total: number
}

export interface QueuedMessage {
  id: string
  text: string
}
