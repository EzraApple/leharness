type CellKind = "system" | "user" | "assistant" | "tool" | "error"
export type ToolStatus = "pending" | "completed" | "failed"

export interface Cell {
  id: string
  kind: CellKind
  title?: string
  text: string
  status?: ToolStatus
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
