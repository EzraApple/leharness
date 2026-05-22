import type { ToolDisplaySnapshot } from "../display/tools.js"

type CellKind = "system" | "user" | "assistant" | "tool" | "error"
export type ToolStatus = "pending" | "completed" | "failed"

type BackgroundPhase = "started" | "completed" | "failed" | "cancelled"

interface BackgroundMarker {
  phase: BackgroundPhase
  taskId: string
  reason?: "user" | "process_exited"
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
  kind: string
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
