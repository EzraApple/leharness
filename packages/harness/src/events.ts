import { promises as fs } from "node:fs"
import path from "node:path"
import { ulid } from "ulid"

export interface EventEnvelope {
  v: 1
  id: string
  ts: string
  type: string
}

export type Event = EventEnvelope & Record<string, unknown>

export type EventOf<T extends string, P> = EventEnvelope & { type: T } & P

export function resolveLeharnessHome(): string {
  const override = process.env.LEHARNESS_HOME
  if (override !== undefined && override.length > 0) return path.resolve(override)
  return path.resolve(process.cwd(), ".leharness")
}

export function resolveSessionPath(sessionId: string): string {
  return path.join(resolveLeharnessHome(), "sessions", sessionId, "events.jsonl")
}

export function newEventId(): string {
  return ulid()
}

export function nowIso(): string {
  return new Date().toISOString()
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
  const out: Event[] = []
  const lines = raw.split("\n")
  for (const [i, line] of lines.entries()) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as Event)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to parse event at line ${i + 1} (sessionId=${sessionId}): ${message}`)
    }
  }
  return out
}
