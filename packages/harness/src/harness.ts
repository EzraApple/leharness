import { appendEvent, type Event, loadEvents, newEventId, nowIso } from "./events.js"
import { buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompt.js"
import type { Provider } from "./provider/index.js"
import { executeToolCalls, type Tool, type ToolContext } from "./tools.js"

export interface HarnessDeps {
  provider: Provider
  tools: Tool[]
  model: string
  systemPrompt?: string
  temperature?: number
  maxOutputTokens?: number
}

export interface RunOptions {
  onText?: (delta: string) => void
  onEvent?: (event: Event) => void
}

// TODO (2026-05-02): no max-step cap and no in-turn interrupt. For now Ctrl-C
// kills the process; resume picks up from the last persisted event. Add a step
// budget and an Escape-to-abort path once we feel them missing.

export async function runInvocation(
  sessionId: string,
  userText: string,
  deps: HarnessDeps,
  options: RunOptions = {},
): Promise<Event[]> {
  const { provider, tools, model, systemPrompt, temperature, maxOutputTokens } = deps
  const events: Event[] = await loadEvents(sessionId)

  const recordEvent = async (type: string, payload: Record<string, unknown>) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    options.onEvent?.(event)
  }

  await recordEvent("invocation.received", { text: userText })

  const ctx: ToolContext = { sessionId }

  let stepNumber = 0
  while (true) {
    stepNumber++
    await recordEvent("step.started", { stepNumber })
    const request = buildPrompt(events, tools, {
      model,
      system: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature,
      maxOutputTokens,
      onText: options.onText,
    })
    const response = await provider.call(request)
    await recordEvent("model.completed", {
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
    })
    if (response.toolCalls.length === 0) {
      await recordEvent("agent.finished", { reason: "no_tool_calls" })
      return events
    }
    const toolResults = await executeToolCalls(response.toolCalls, tools, ctx)
    for (const result of toolResults) {
      if (result.ok) {
        await recordEvent("tool.completed", { call: result.call, result: result.value })
      } else {
        await recordEvent("tool.failed", { call: result.call, error: result.error })
      }
    }
  }
}
