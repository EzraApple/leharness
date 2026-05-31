// events.ts
// The session log primitives. Events are the source of truth — every session
// is a JSONL file under .leharness/sessions/<id>/events.jsonl, appended one
// line at a time, never edited. Everything else in the kernel is a projection
// of this log. Single-writer discipline: the invocation loop is the only
// thing that should call appendEvent.

import { promises as fs } from "node:fs"
import path from "node:path"
import { ulid } from "ulid"
import { isRecord, readErrorCode, readErrorMessage } from "./readers.js"

export interface EventEnvelope {
  v: 1
  id: string
  ts: string
  type: string
}

export type Event = EventEnvelope & Record<string, unknown>

export type RecordEvent = (type: string, payload: Record<string, unknown>) => Promise<Event>

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

export async function appendEvent(sessionId: string, event: Event) {
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
    if (readErrorCode(err) === "ENOENT") return []
    throw err
  }
  const out: Event[] = []
  const lines = raw.split("\n")
  for (const [i, line] of lines.entries()) {
    if (line.length === 0) continue
    try {
      out.push(parseEvent(JSON.parse(line)))
    } catch (err) {
      const message = readErrorMessage(err)
      throw new Error(`Failed to parse event at line ${i + 1} (sessionId=${sessionId}): ${message}`)
    }
  }
  return out
}

function parseEvent(value: unknown): Event {
  if (!isRecord(value)) {
    throw new Error("event is not an object")
  }
  if (value.v !== 1) {
    throw new Error("event has unsupported version")
  }
  if (typeof value.id !== "string") {
    throw new Error("event is missing id")
  }
  if (typeof value.ts !== "string") {
    throw new Error("event is missing ts")
  }
  if (typeof value.type !== "string") {
    throw new Error("event is missing type")
  }
  return { ...value, v: 1, id: value.id, ts: value.ts, type: value.type }
}
