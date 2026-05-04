import { compact } from "../compaction/index.js"
import { type Event, loadEvents } from "../events.js"
import { buildInput, buildRequest, type CompactionOptions } from "../prompt.js"
import type { Provider } from "../provider/index.js"
import type { SkillOptions } from "../skills.js"
import type { Tool, ToolContext } from "../tools.js"
import { DEFAULT_MAX_STEPS, finishIfCancelled } from "./control.js"
import { createEventRecorder } from "./event-recorder.js"
import { callModel, recordModelCompleted } from "./model-call.js"
import { preparePromptSurface } from "./prompt-surface.js"
import { recordToolResults } from "./tool-results.js"

export interface HarnessDeps {
  provider: Provider
  tools: Tool[]
  model: string
  systemPrompt?: string
  temperature?: number
  maxOutputTokens?: number
  maxSteps?: number
  compaction?: CompactionOptions
  skills?: SkillOptions | false
}

export interface RunOptions {
  onText?: (delta: string) => void
  onEvent?: (event: Event) => void
  signal?: AbortSignal
}

export async function runInvocation(
  sessionId: string,
  userText: string,
  deps: HarnessDeps,
  options: RunOptions = {},
): Promise<Event[]> {
  const {
    provider,
    tools,
    model,
    systemPrompt,
    temperature,
    maxOutputTokens,
    maxSteps = DEFAULT_MAX_STEPS,
    compaction,
    skills,
  } = deps
  const events: Event[] = await loadEvents(sessionId)
  const recordEvent = createEventRecorder(sessionId, events, options)
  const signal = options.signal
  const ctx: ToolContext = { sessionId, recordEvent, signal }

  await recordEvent("invocation.received", { text: userText })

  let stepNumber = 0
  while (true) {
    if (await finishIfCancelled(recordEvent, signal)) return events
    if (stepNumber >= maxSteps) {
      await recordEvent("agent.finished", { reason: "max_steps", maxSteps })
      return events
    }

    stepNumber++
    await recordEvent("step.started", { stepNumber })

    const promptSurface = await preparePromptSurface({
      events,
      skills,
      systemPrompt,
      tools,
      userText,
    })
    const input = await compact(
      buildInput(events, promptSurface.tools, {
        sessionId,
        provider,
        model,
        system: promptSurface.system,
        temperature,
        maxOutputTokens,
        onText: options.onText,
        signal,
        compaction,
        recordEvent,
      }),
    )

    const modelCall = await callModel(provider, buildRequest(input), recordEvent, signal)
    if (modelCall.status === "finished") return events

    const { response } = modelCall
    if (await finishIfCancelled(recordEvent, signal)) return events
    await recordModelCompleted(response, recordEvent)
    if (response.toolCalls.length === 0) {
      await recordEvent("agent.finished", { reason: "no_tool_calls" })
      return events
    }

    if (await finishIfCancelled(recordEvent, signal)) return events
    await recordToolResults(response.toolCalls, promptSurface.tools, ctx, recordEvent)
    if (await finishIfCancelled(recordEvent, signal)) return events
  }
}
