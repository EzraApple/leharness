import {
  appendEvent,
  type Event,
  loadEvents,
  newEventId,
  nowIso,
  type RecordEvent,
} from "../events.js"

interface InvocationOptions {
  onEvent?: (event: Event) => void
}

type FinishReason = "no_tool_calls" | "max_steps" | "cancelled" | "model_failed"

export interface InvocationState {
  sessionId: string
  events: Event[]
  recordEvent: RecordEvent
}

export async function loadInvocationState(
  sessionId: string,
  options: InvocationOptions,
): Promise<InvocationState> {
  const events: Event[] = await loadEvents(sessionId)
  const recordEvent: RecordEvent = async (type, payload) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    options.onEvent?.(event)
    return event
  }

  return { sessionId, events, recordEvent }
}

export async function endInvocation(
  invocation: InvocationState,
  reason: FinishReason,
  payload: Record<string, unknown> = {},
): Promise<Event[]> {
  await invocation.recordEvent("agent.finished", { reason, ...payload })
  return invocation.events
}
