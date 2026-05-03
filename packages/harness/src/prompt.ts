import { type ZodTypeAny, z } from "zod"
import type { Event } from "./events.js"
import type { HarnessMessage, HarnessTool, ProviderRequest } from "./provider/index.js"
import type { Tool, ToolCall } from "./tools.js"

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful coding assistant operating inside a harness. You have access to tools when provided. Call tools when you need information or actions; respond directly when you have what you need. Stop calling tools when the task is complete and reply with a short summary."

export interface BuildPromptOptions {
  model: string
  system?: string
  temperature?: number
  maxOutputTokens?: number
  onText?: (delta: string) => void
}

export function buildPrompt(
  events: Event[],
  tools: Tool[],
  options: BuildPromptOptions,
): ProviderRequest {
  const messages: HarnessMessage[] = []
  for (const event of events) {
    const message = eventToMessage(event)
    if (message !== null) messages.push(message)
  }

  return {
    model: options.model,
    system: options.system,
    messages,
    tools: tools.length > 0 ? tools.map(toHarnessTool) : undefined,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    onText: options.onText,
  }
}

function eventToMessage(event: Event): HarnessMessage | null {
  switch (event.type) {
    case "invocation.received":
      return { role: "user", content: event.text as string }
    case "model.completed":
      return {
        role: "assistant",
        content: event.text as string,
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
