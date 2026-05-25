// prompt.ts
// Event-log → provider-message projection plus the request shape every
// Provider implementation consumes. eventToMessage is the per-event mapping
// (user / assistant / tool / synthetic-user injection for task.* completions
// the model needs to react to). buildInput / buildRequest assemble the
// PromptInput the model call layer hands to the provider.

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
  // Budget in real tokens. Default is contextWindowTokensForModel × 0.85
  // computed in core/prepare-prompt.ts when the app doesn't supply one.
  // Reactive: pressure is measured against the last model.completed's
  // usage.promptTokens, so this is the threshold that triggers tiered
  // transformations on the *next* step's prompt.
  maxInputTokens?: number
  // T6's char-based safety net (see plan 007). Only the truncate-front
  // tier reads this; T1-5 reason in tokens. Default is contextWindowTokens
  // × 4 chars/token × 0.90 when unset.
  maxInputChars?: number
  // How many recent turns are exempt from T1-T5 (only T6 may touch them).
  // A turn = one user message + the agent's response chain through to
  // the next user message. Default 2.
  preserveRecentTurns?: number
  // Optional override for the summarizer model. Defaults to the main
  // session's model (deps.model).
  summarizerModel?: string
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

export function eventToMessage(event: Event): HarnessMessage | null {
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
    case "task.started": {
      const callId = typeof event.callId === "string" ? event.callId : undefined
      if (callId === undefined) return null
      const taskId = readTaskIdField(event)
      const payload = JSON.stringify({
        task_id: taskId,
        status: "started",
        note: "background task is running; call read_task or wait_task to follow up",
      })
      return { role: "tool", toolCallId: callId, content: payload }
    }
    case "task.completed":
      return { role: "user", content: backgroundUpdateMessage(event, "completed") }
    case "task.failed":
      return { role: "user", content: backgroundUpdateMessage(event, "failed") }
    case "task.cancelled":
      return { role: "user", content: backgroundUpdateMessage(event, "cancelled") }
    default:
      return null
  }
}

function readTaskIdField(event: Event): string {
  if (typeof event.taskId === "string") return event.taskId
  const task = event.task as { id?: unknown } | undefined
  return typeof task?.id === "string" ? task.id : "unknown"
}

function backgroundUpdateMessage(
  event: Event,
  phase: "completed" | "failed" | "cancelled",
): string {
  const taskId = readTaskIdField(event)
  const summary = typeof event.summary === "string" ? ` · ${event.summary}` : ""
  const body =
    phase === "failed"
      ? typeof event.error === "string"
        ? event.error
        : ""
      : phase === "completed"
        ? typeof event.result === "string"
          ? event.result
          : ""
        : `reason: ${typeof event.reason === "string" ? event.reason : "user"}`
  const header = `[background task ${taskId}] ${phase}${summary}`
  return body.length > 0 ? `${header}\n${body}` : header
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
