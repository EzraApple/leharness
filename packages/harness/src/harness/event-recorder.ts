import { appendEvent, type Event, newEventId, nowIso, type RecordEvent } from "../events.js"

interface EventRecorderOptions {
  onEvent?: (event: Event) => void
}

export function createEventRecorder(
  sessionId: string,
  events: Event[],
  options: EventRecorderOptions,
): RecordEvent {
  return async (type: string, payload: Record<string, unknown>) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    options.onEvent?.(event)
    return event
  }
}
