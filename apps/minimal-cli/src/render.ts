import type { Event, ToolCallRef } from "@leharness/harness"

export function renderEvent(event: Event): string | null {
  switch (event.type) {
    case "invocation.received":
      return `> ${event.text as string}`
    case "model.completed": {
      const text = event.text as string
      const toolCalls = (event.toolCalls as ToolCallRef[]) ?? []
      const toolLines = toolCalls.map((c) => `· ${c.name}(${JSON.stringify(c.args)})`)
      const parts = [text, ...toolLines].filter((s) => s.length > 0)
      return parts.length > 0 ? parts.join("\n") : null
    }
    case "tool.completed": {
      const call = event.call as ToolCallRef
      return `< ${call.id}: ${summarizeToolResult(event.result as string)}`
    }
    case "tool.failed": {
      const call = event.call as ToolCallRef
      return `! tool error (${call.name}): ${event.error as string}`
    }
    case "agent.finished":
      return `[done: ${event.reason as string}]`
    default:
      return null
  }
}

export function renderTranscript(events: Event[]): string {
  return events
    .map(renderEvent)
    .filter((line): line is string => line !== null)
    .join("\n")
}

function summarizeToolResult(result: string): string {
  if (result.includes("\n")) return `${result.split("\n").length} lines`
  if (result.length > 80) return `${result.slice(0, 80)}…`
  return result
}
