import type { Event } from "@leharness/harness"

export function renderEvent(event: Event): string | null {
  switch (event.type) {
    case "invocation.received":
      return `> ${event.text}`
    case "step.started":
    case "model.requested":
    case "tool.started":
      return null
    case "model.completed": {
      const toolLines = event.toolCalls.map((c) => `· ${c.name}(${JSON.stringify(c.args)})`)
      const parts = [event.text, ...toolLines].filter((s) => s.length > 0)
      return parts.length > 0 ? parts.join("\n") : null
    }
    case "model.failed":
      return `! model error: ${event.error}`
    case "tool.completed":
      return `< ${event.call.id}: ${summarizeToolResult(event.result)}`
    case "tool.failed":
      return `! tool error (${event.call.name}): ${event.error}`
    case "agent.finished":
      return `[done: ${event.reason}]`
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
