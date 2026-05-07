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
  toolCellById: Map<string, number>
  activeAssistantIndex?: number
}

export interface QueuedMessage {
  id: string
  text: string
}
