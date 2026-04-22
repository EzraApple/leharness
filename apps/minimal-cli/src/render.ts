import type { Event } from "@leharness/harness"

export function renderEvent(event: Event): string | null {
  switch (event.type) {
    case "invocation.received":
      return `> ${event.text}`
    case "step.started":
      return null
    case "model.requested":
      return null
    case "model.completed": {
      const toolLines = event.toolCalls.map(
        (call) => `· ${call.name}(${JSON.stringify(call.args)})`,
      )
      const hasText = event.text.length > 0
      if (hasText && toolLines.length === 0) return event.text
      if (hasText && toolLines.length > 0) return `${event.text}\n${toolLines.join("\n")}`
      if (!hasText && toolLines.length > 0) return toolLines.join("\n")
      return null
    }
    case "model.failed":
      return `! model error: ${event.error}`
    case "tool.started":
      return null
    case "tool.completed":
      return `< ${event.call.id}: ${summarizeToolResult(event.result)}`
    case "tool.failed":
      return `! tool error (${event.call.name}): ${event.error}`
    case "agent.finished":
      return `[done: ${event.reason}]`
  }
}

export function renderTranscript(events: Event[]): string {
  const lines: string[] = []
  for (const event of events) {
    const line = renderEvent(event)
    if (line !== null) lines.push(line)
  }
  return lines.join("\n")
}

function summarizeToolResult(result: string): string {
  if (result.includes("\n")) {
    const lineCount = result.split("\n").length
    return `${lineCount} lines`
  }
  if (result.length > 80) return `${result.slice(0, 80)}…`
  return result
}
