import { promises as fs } from "node:fs"
import path from "node:path"
import { ulid } from "ulid"

// Note (Ezra, 2026-04-22): replaced by Provider package import after Phase 5a lands.
export type ProviderRequest = unknown

// Note (Ezra, 2026-04-22): replaced by Provider package import after Phase 5a lands.
export type ToolCall = { id: string; name: string; args: unknown }

export type EventEnvelope = {
  v: 1
  id: string
  ts: string
}

export type Event =
  | (EventEnvelope & { type: "invocation.received"; text: string })
  | (EventEnvelope & { type: "step.started"; stepNumber: number })
  | (EventEnvelope & { type: "model.requested"; request: ProviderRequest })
  | (EventEnvelope & {
      type: "model.completed"
      text: string
      toolCalls: ToolCall[]
      usage?: { promptTokens: number; completionTokens: number }
    })
  | (EventEnvelope & { type: "model.failed"; error: string })
  | (EventEnvelope & { type: "tool.started"; call: ToolCall })
  | (EventEnvelope & { type: "tool.completed"; call: ToolCall; result: string })
  | (EventEnvelope & { type: "tool.failed"; call: ToolCall; error: string })
  | (EventEnvelope & { type: "agent.finished"; reason: string })

export type EventOfType<T extends Event["type"]> = Extract<Event, { type: T }>

export function newEventId(): string {
  return ulid()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function resolveLeharnessHome(): string {
  const override = process.env.LEHARNESS_HOME
  if (override !== undefined && override.length > 0) {
    return path.resolve(override)
  }
  return path.resolve(process.cwd(), ".leharness")
}

export function resolveSessionPath(sessionId: string): string {
  return path.join(resolveLeharnessHome(), "sessions", sessionId, "events.jsonl")
}

export async function appendEvent(sessionId: string, event: Event): Promise<void> {
  const filePath = resolveSessionPath(sessionId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`)
}

export async function loadEvents(sessionId: string): Promise<Event[]> {
  const filePath = resolveSessionPath(sessionId)
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw err
  }

  const lines = raw.split("\n")
  const events: Event[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.length === 0) continue
    try {
      events.push(JSON.parse(line) as Event)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to parse event at line ${i + 1} (sessionId=${sessionId}): ${message}`)
    }
  }
  return events
}
