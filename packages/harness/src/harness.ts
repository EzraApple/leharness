import { type ZodTypeAny, z } from "zod"
import { appendEvent, type Event, loadEvents, newEventId, nowIso } from "./events.js"
import { type BuildPromptOptions, buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompt.js"
import type { HarnessTool, Provider } from "./provider/index.js"
import { type Emit, executeToolCalls, type Tool, type ToolContext } from "./tools.js"
import { eventsToTranscript, eventToTranscriptEntry, type TranscriptEntry } from "./transcript.js"

export interface HarnessDeps {
  provider: Provider
  tools: Tool[]
  model: string
  systemPrompt?: string
  temperature?: number
  maxOutputTokens?: number
}

export interface RunOptions {
  signal?: AbortSignal
  onText?: (delta: string) => void
  onEvent?: (event: Event) => void
}

export async function runInvocation(
  sessionId: string,
  userText: string,
  deps: HarnessDeps,
  options: RunOptions = {},
): Promise<TranscriptEntry[]> {
  const events: Event[] = await loadEvents(sessionId)
  const transcript: TranscriptEntry[] = eventsToTranscript(events)

  const emit: Emit = async (type, payload) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    const entry = eventToTranscriptEntry(event)
    if (entry !== null) transcript.push(entry)
    options.onEvent?.(event)
  }

  await emit("invocation.received", { text: userText })

  const ctx: ToolContext = { sessionId, signal: options.signal }
  const harnessTools = deps.tools.map(toHarnessTool)
  const promptOptions: BuildPromptOptions = {
    model: deps.model,
    system: deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    temperature: deps.temperature,
    maxOutputTokens: deps.maxOutputTokens,
  }

  let stepNumber = 0
  while (true) {
    if (options.signal?.aborted) {
      await emit("agent.interrupted", { reason: "user_interrupt" })
      return transcript
    }
    stepNumber++
    await emit("step.started", { stepNumber })
    const request = buildPrompt(transcript, harnessTools, promptOptions)
    request.signal = options.signal
    request.onText = options.onText
    let response: Awaited<ReturnType<typeof deps.provider.call>>
    try {
      response = await deps.provider.call(request)
    } catch (err) {
      if (options.signal?.aborted) {
        await emit("agent.interrupted", { reason: "user_interrupt" })
        return transcript
      }
      throw err
    }
    await emit("model.completed", {
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
    })
    if (response.toolCalls.length === 0) {
      await emit("agent.finished", { reason: "no_tool_calls" })
      return transcript
    }
    await executeToolCalls(response.toolCalls, deps.tools, ctx, emit)
    // TODO (2026-05-02): no max-step cap. Add a budget once we observe runaway loops.
  }
}

function toHarnessTool(tool: Tool): HarnessTool {
  return {
    name: tool.name,
    description: tool.description,
    schemaJson: zodSchemaToJsonSchema(tool.schema),
  }
}

function zodSchemaToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    return { type: "object" }
  }
}
