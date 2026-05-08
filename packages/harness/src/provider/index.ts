import type { ReasoningEffort } from "../models.js"
import type { ToolCall } from "../tools.js"

export type HarnessMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoningText?: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }

export interface HarnessTool {
  name: string
  description: string
  schemaJson: Record<string, unknown>
}

export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
  argumentsText?: string
}

export interface ProviderRequest {
  model: string
  system?: string
  messages: HarnessMessage[]
  tools?: HarnessTool[]
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  onText?: (delta: string) => void
  onReasoningText?: (delta: string) => void
  onToolCallDelta?: (delta: ToolCallDelta) => void
  signal?: AbortSignal
}

export interface ProviderResponse {
  text: string
  reasoningText?: string
  toolCalls: ToolCall[]
  usage?: { promptTokens: number; completionTokens: number }
  stopReason: "stop" | "tool_calls" | "length" | "error"
  raw?: unknown
}

export interface Provider {
  name: string
  call(req: ProviderRequest): Promise<ProviderResponse>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerName: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "ProviderError"
  }
}
