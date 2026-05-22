// invocation.ts
// The harness's main loop. One call to runInvocation drives a session from
// the user's text (or an auto-trigger) through model steps + tool execution
// + background-task drains until the model finishes, max-steps is hit, or
// the AbortSignal fires. Everything else in this directory exists to keep
// this loop short enough to read top-to-bottom.

import { compact } from "../compaction/index.js"
import type { Event } from "../events.js"
import type { ReasoningEffort } from "../models.js"
import type { CompactionOptions } from "../prompt.js"
import type { Provider, ToolCallDelta } from "../provider/index.js"
import type { SkillOptions } from "../skills.js"
import { getOrCreateTaskServices } from "../tasks.js"
import type { Tool } from "../tools.js"
import { isCancelled } from "./cancellation.js"
import { executeTools } from "./execute-tools.js"
import { sendPrompt } from "./model-call.js"
import { preparePrompt } from "./prepare-prompt.js"
import { endInvocation, loadInvocationState } from "./state.js"
import { drainTaskQueue, reapOrphanTasks } from "./task-drain.js"

export const DEFAULT_MAX_STEPS = 25

export interface HarnessDeps {
  provider: Provider
  tools: Tool[]
  model: string
  systemPrompt: string
  temperature?: number
  maxOutputTokens?: number
  maxSteps?: number
  compaction?: CompactionOptions
  reasoningEffort?: ReasoningEffort
  skills?: SkillOptions | false
  tasks?: boolean
}

export interface RunOptions {
  onText?: (delta: string) => void
  onReasoningText?: (delta: string) => void
  onToolCallDelta?: (delta: ToolCallDelta) => void
  onEvent?: (event: Event) => void
  signal?: AbortSignal
}

export async function runInvocation(
  sessionId: string,
  userText: string | undefined,
  deps: HarnessDeps,
  options: RunOptions = {},
): Promise<Event[]> {
  const { provider, maxSteps = DEFAULT_MAX_STEPS } = deps
  const signal = options.signal
  const invocation = await loadInvocationState(sessionId, options)
  const tasksEnabled = deps.tasks !== false
  const taskServices = tasksEnabled ? getOrCreateTaskServices(sessionId) : undefined

  if (userText !== undefined && userText.length > 0) {
    await invocation.recordEvent("invocation.received", {
      text: userText,
      provider: deps.provider.name,
      model: deps.model,
      reasoningEffort: deps.reasoningEffort,
    })
  } else {
    await invocation.recordEvent("invocation.auto", {
      reason: "background_completion",
      provider: deps.provider.name,
      model: deps.model,
      reasoningEffort: deps.reasoningEffort,
    })
  }

  if (taskServices !== undefined) {
    await drainTaskQueue(invocation, taskServices)
    await reapOrphanTasks(invocation, taskServices)
  }

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    if (stepNumber > 1 && taskServices !== undefined) {
      await drainTaskQueue(invocation, taskServices)
    }

    await invocation.recordEvent("step.started", { stepNumber })

    const preparedPrompt = await preparePrompt(invocation, userText, deps, options)
    const prompt = await compact(preparedPrompt.input)

    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    const promptResult = await sendPrompt(provider, prompt, signal)
    if (promptResult.kind === "cancelled") {
      if (promptResult.text.length > 0) {
        await invocation.recordEvent("model.cancelled", { text: promptResult.text })
      }
      return endInvocation(invocation, "cancelled")
    }
    if (promptResult.kind === "failed") {
      await invocation.recordEvent("model.failed", { error: promptResult.error })
      return endInvocation(invocation, "model_failed")
    }

    await invocation.recordEvent("model.completed", {
      text: promptResult.response.text,
      reasoningText: promptResult.response.reasoningText,
      toolCalls: promptResult.response.toolCalls,
      usage: promptResult.response.usage,
    })
    if (promptResult.response.toolCalls.length === 0) {
      return endInvocation(invocation, "no_tool_calls")
    }

    const toolRun = await executeTools(promptResult.response.toolCalls, preparedPrompt.tools, {
      sessionId,
      recordEvent: invocation.recordEvent,
      signal,
      taskServices,
    })
    if (toolRun.kind === "cancelled") return endInvocation(invocation, "cancelled")
  }

  return endInvocation(invocation, "max_steps", { maxSteps })
}
