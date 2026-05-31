// turns.ts
// Turn-grouping primitives used by the pressure-gradient strategy.
//
// A "turn" is one user message (an `invocation.received` event) plus
// the agent's full response chain through to the next user message
// (model.completed + tool.* + task.* events). The preserve-recent
// budget is measured in turns; the summarization window is M turns
// long; the relevance overlay reads the most recent turn's user
// message. So turns are the unit the strategy reasons about even
// though events are the unit the loop records.

import type { Event } from "../events.js"
import { readToolCall } from "../tools.js"

export interface CompactionTurn {
  // First event in the turn — either an invocation.received or
  // (rarely) an invocation.auto when the loop self-triggered.
  starter: Event
  // All events that belong to this turn, in event-log order.
  events: Event[]
}

export interface EventTurnIndex {
  firstEventId: string
  lastEventId: string
}

export function groupEventsIntoTurns(events: Event[]): CompactionTurn[] {
  const turns: CompactionTurn[] = []
  let current: CompactionTurn | undefined
  for (const event of events) {
    if (event.type === "invocation.received" || event.type === "invocation.auto") {
      if (current !== undefined) turns.push(current)
      current = { starter: event, events: [event] }
      continue
    }
    if (current === undefined) {
      // Edge case: events before any invocation.received. Synthesize a
      // turn so we don't lose them. Should not happen in practice.
      current = { starter: event, events: [event] }
      continue
    }
    current.events.push(event)
  }
  if (current !== undefined) turns.push(current)
  return turns
}

function renderTurnForSummarizer(turn: CompactionTurn, chunkCap: number): string {
  const lines: string[] = []
  for (const event of turn.events) {
    const rendered = renderEventForSummarizer(event, chunkCap)
    if (rendered !== undefined) lines.push(rendered)
  }
  return lines.join("\n")
}

export function renderTurnsForSummarizer(turns: CompactionTurn[], chunkCap: number): string {
  return turns.map((turn) => renderTurnForSummarizer(turn, chunkCap)).join("\n\n---\n\n")
}

function renderEventForSummarizer(event: Event, chunkCap: number): string | undefined {
  switch (event.type) {
    case "invocation.received": {
      const text = readString(event, "text")
      return `User: ${truncate(text ?? "", chunkCap)}`
    }
    case "invocation.auto": {
      const reason = readString(event, "reason") ?? "auto"
      return `(auto-trigger: ${reason})`
    }
    case "model.completed":
    case "model.cancelled": {
      const text = readString(event, "text") ?? ""
      const toolCalls = readArray(event, "toolCalls")
      const parts: string[] = []
      if (text.length > 0) parts.push(`Assistant: ${truncate(text, chunkCap)}`)
      if (toolCalls.length > 0) {
        const summarized = toolCalls
          .map((call) => {
            const c = readToolCall(call)
            const name = c?.name ?? "?"
            const args = c?.args === undefined ? "" : truncate(JSON.stringify(c.args), 200)
            return `  → ${name}(${args})`
          })
          .join("\n")
        parts.push(summarized)
      }
      return parts.length > 0 ? parts.join("\n") : undefined
    }
    case "tool.completed": {
      const name = readToolCall(event.call)?.name ?? "?"
      const result = readString(event, "result") ?? ""
      const summary = readString(event, "summary")
      const body =
        summary !== undefined
          ? `[${summary}] ${truncate(result, chunkCap)}`
          : truncate(result, chunkCap)
      return `Tool ${name} → ${body}`
    }
    case "tool.failed": {
      const name = readToolCall(event.call)?.name ?? "?"
      const error = readString(event, "error") ?? ""
      return `Tool ${name} FAILED → ${truncate(error, chunkCap)}`
    }
    case "task.started": {
      const taskId = readString(event, "taskId") ?? "?"
      const summary = readString(event, "summary")
      return `Background task ${taskId} started${summary !== undefined ? ` (${summary})` : ""}`
    }
    case "task.completed": {
      const taskId = readString(event, "taskId") ?? "?"
      const summary = readString(event, "summary")
      const result = readString(event, "result") ?? ""
      const header = `Background task ${taskId} completed${summary !== undefined ? ` (${summary})` : ""}`
      return result.length > 0 ? `${header} → ${truncate(result, chunkCap)}` : header
    }
    case "task.failed": {
      const taskId = readString(event, "taskId") ?? "?"
      const error = readString(event, "error") ?? ""
      return `Background task ${taskId} failed → ${truncate(error, chunkCap)}`
    }
    case "task.cancelled": {
      const taskId = readString(event, "taskId") ?? "?"
      const reason = readString(event, "reason") ?? "?"
      return `Background task ${taskId} cancelled (${reason})`
    }
    default:
      return undefined
  }
}

function readString(event: Event, key: string): string | undefined {
  const value = event[key]
  return typeof value === "string" ? value : undefined
}

function readArray(event: Event, key: string): unknown[] {
  const value = event[key]
  return Array.isArray(value) ? value : []
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}…`
}
