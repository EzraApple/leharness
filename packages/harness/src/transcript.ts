import type { Event } from "./events.js"

export interface ToolCallRef {
  id: string
  name: string
  args: unknown
}

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; toolCalls: ToolCallRef[] }
  | { kind: "tool_result"; callId: string; toolName: string; content: string }
  | { kind: "tool_error"; callId: string; toolName: string; error: string }

export function eventToTranscriptEntry(event: Event): TranscriptEntry | null {
  switch (event.type) {
    case "invocation.received":
      return { kind: "user", text: event.text as string }
    case "model.completed":
      return {
        kind: "assistant",
        text: event.text as string,
        toolCalls: (event.toolCalls as ToolCallRef[]) ?? [],
      }
    case "tool.completed": {
      const call = event.call as ToolCallRef
      return {
        kind: "tool_result",
        callId: call.id,
        toolName: call.name,
        content: event.result as string,
      }
    }
    case "tool.failed": {
      const call = event.call as ToolCallRef
      return {
        kind: "tool_error",
        callId: call.id,
        toolName: call.name,
        error: event.error as string,
      }
    }
    default:
      return null
  }
}

export function eventsToTranscript(events: Event[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const event of events) {
    const entry = eventToTranscriptEntry(event)
    if (entry !== null) out.push(entry)
  }
  return out
}
