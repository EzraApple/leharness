import type { Event } from "./events.js"

export interface AssistantToolCall {
  id: string
  name: string
  args: unknown
}

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; toolCalls: AssistantToolCall[] }
  | { kind: "tool_result"; callId: string; toolName: string; content: string }
  | { kind: "tool_error"; callId: string; toolName: string; error: string }

export interface SessionState {
  transcript: TranscriptEntry[]
  // Note (Ezra, 2026-04-22): no metadata field for MVP. provider/model live in
  // deps and are not in the event log yet. session.started event + metadata are
  // additive and arrive when the TUI needs them for display.
}

export function initialSessionState(): SessionState {
  return { transcript: [] }
}

export function reduce(state: SessionState, event: Event): SessionState {
  switch (event.type) {
    case "invocation.received":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "user", text: event.text }],
      }
    case "step.started":
      return state
    case "model.requested":
      return state
    case "model.completed":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: "assistant",
            text: event.text,
            toolCalls: event.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              args: call.args,
            })),
          },
        ],
      }
    case "model.failed":
      return state
    case "tool.started":
      return state
    case "tool.completed":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: "tool_result",
            callId: event.call.id,
            toolName: event.call.name,
            content: event.result,
          },
        ],
      }
    case "tool.failed":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: "tool_error",
            callId: event.call.id,
            toolName: event.call.name,
            error: event.error,
          },
        ],
      }
    case "agent.finished":
      return state
    default:
      return unreachable(event)
  }
}

export function projectSession(events: Event[]): SessionState {
  return events.reduce(reduce, initialSessionState())
}

function unreachable(value: never): never {
  throw new Error(`unreachable event type: ${JSON.stringify(value)}`)
}
