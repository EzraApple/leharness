import type { ToolCall } from "../tools.js"

export type HarnessMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }

export interface HarnessTool {
  name: string
  description: string
  schemaJson: Record<string, unknown>
}

export interface ProviderRequest {
  model: string
  system?: string
  messages: HarnessMessage[]
  tools?: HarnessTool[]
  temperature?: number
  maxOutputTokens?: number
  onText?: (delta: string) => void
  signal?: AbortSignal
}

export interface ProviderResponse {
  text: string
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
