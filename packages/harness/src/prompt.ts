import { type ZodTypeAny, z } from "zod"
import type { Event, RecordEvent } from "./events.js"
import type { ReasoningEffort } from "./models.js"
import type {
  HarnessMessage,
  HarnessTool,
  Provider,
  ProviderRequest,
  ToolCallDelta,
} from "./provider/index.js"
import type { Tool, ToolCall } from "./tools.js"

export type { RecordEvent } from "./events.js"

export interface BuildPromptOptions {
  model: string
  system?: string
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  onText?: (delta: string) => void
  onReasoningText?: (delta: string) => void
  onToolCallDelta?: (delta: ToolCallDelta) => void
  signal?: AbortSignal
}

export interface CompactionOptions {
  maxInputChars?: number
  preserveRecentMessages?: number
}

export interface PromptInput extends BuildPromptOptions {
  events: Event[]
  messages: HarnessMessage[]
  tools?: HarnessTool[]
  sessionId?: string
  provider?: Provider
  compaction?: CompactionOptions
  recordEvent?: RecordEvent
}

export function buildPrompt(
  events: Event[],
  tools: Tool[],
  options: BuildPromptOptions,
): ProviderRequest {
  return buildRequest(buildInput(events, tools, options))
}

export function buildInput(
  events: Event[],
  tools: Tool[],
  options: BuildPromptOptions & {
    sessionId?: string
    provider?: Provider
    compaction?: CompactionOptions
    recordEvent?: RecordEvent
  },
): PromptInput {
  const messages: HarnessMessage[] = []
  for (const event of events) {
    const message = eventToMessage(event)
    if (message !== null) messages.push(message)
  }

  return {
    events,
    messages,
    tools: tools.length > 0 ? tools.map(toHarnessTool) : undefined,
    model: options.model,
    system: options.system,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    reasoningEffort: options.reasoningEffort,
    onText: options.onText,
    onReasoningText: options.onReasoningText,
    onToolCallDelta: options.onToolCallDelta,
    signal: options.signal,
    sessionId: options.sessionId,
    provider: options.provider,
    compaction: options.compaction,
    recordEvent: options.recordEvent,
  }
}

export function buildRequest(input: PromptInput): ProviderRequest {
  return {
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
    onText: input.onText,
    onReasoningText: input.onReasoningText,
    onToolCallDelta: input.onToolCallDelta,
    signal: input.signal,
  }
}

function eventToMessage(event: Event): HarnessMessage | null {
  switch (event.type) {
    case "invocation.received":
      return { role: "user", content: event.text as string }
    case "model.completed":
    case "model.cancelled":
      return {
        role: "assistant",
        content: event.text as string,
        reasoningText:
          typeof event.reasoningText === "string" && event.reasoningText.length > 0
            ? event.reasoningText
            : undefined,
        toolCalls: (event.toolCalls as ToolCall[]) ?? [],
      }
    case "tool.completed": {
      const call = event.call as ToolCall
      return { role: "tool", toolCallId: call.id, content: event.result as string }
    }
    case "tool.failed": {
      const call = event.call as ToolCall
      return { role: "tool", toolCallId: call.id, content: `error: ${event.error as string}` }
    }
    default:
      return null
  }
}

function toHarnessTool(tool: Tool): HarnessTool {
  return {
    name: tool.name,
    description: tool.description,
    schemaJson: zodSchemaToJsonSchema(tool.schema),
  }
}

function zodSchemaToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    return { type: "object" }
  }
}
