import { compact } from "../compaction/index.js"
import type { Event } from "../events.js"
import { buildInput, buildRequest, type CompactionOptions } from "../prompt.js"
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/index.js"
import type { SkillOptions } from "../skills.js"
import {
  executeToolCall,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "../tools.js"
import { abortable, errorMessage, isAbort, isCancelled } from "./abort.js"
import { buildPromptSurface } from "./prompt-surface.js"
import { endInvocation, loadInvocationState } from "./state.js"

export const DEFAULT_MAX_STEPS = 25

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

type PromptResult =
  | { kind: "completed"; response: ProviderResponse }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string }

type ToolRun =
  | { kind: "completed"; results: ToolResult[] }
  | { kind: "cancelled"; results: ToolResult[] }

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
  const signal = options.signal
  const invocation = await loadInvocationState(sessionId, options)

  await invocation.recordEvent("invocation.received", { text: userText })

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    await invocation.recordEvent("step.started", { stepNumber })

    const promptSurface = await buildPromptSurface({
      events: invocation.events,
      skills,
      systemPrompt,
      tools,
      userText,
    })
    const input = await compact(
      buildInput(invocation.events, promptSurface.tools, {
        sessionId,
        provider,
        model,
        system: promptSurface.system,
        temperature,
        maxOutputTokens,
        onText: options.onText,
        signal,
        compaction,
        recordEvent: invocation.recordEvent,
      }),
    )

    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    const promptResult = await sendPrompt(provider, buildRequest(input), signal)
    if (promptResult.kind === "cancelled") return endInvocation(invocation, "cancelled")
    if (promptResult.kind === "failed") {
      await invocation.recordEvent("model.failed", { error: promptResult.error })
      return endInvocation(invocation, "model_failed")
    }
    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    await invocation.recordEvent("model.completed", {
      text: promptResult.response.text,
      toolCalls: promptResult.response.toolCalls,
      usage: promptResult.response.usage,
    })
    if (promptResult.response.toolCalls.length === 0) {
      return endInvocation(invocation, "no_tool_calls")
    }

    const ctx: ToolContext = { sessionId, recordEvent: invocation.recordEvent, signal }
    const toolRun = await executeTools(promptResult.response.toolCalls, promptSurface.tools, ctx)
    for (const result of toolRun.results) {
      if (result.ok) {
        await invocation.recordEvent("tool.completed", { call: result.call, result: result.value })
      } else {
        await invocation.recordEvent("tool.failed", { call: result.call, error: result.error })
      }
    }

    if (toolRun.kind === "cancelled") return endInvocation(invocation, "cancelled")
  }

  return endInvocation(invocation, "max_steps", { maxSteps })
}

async function sendPrompt(
  provider: Provider,
  request: ProviderRequest,
  signal: AbortSignal | undefined,
): Promise<PromptResult> {
  try {
    return { kind: "completed", response: await abortable(provider.call(request), signal) }
  } catch (err) {
    if (isAbort(err, signal)) return { kind: "cancelled" }
    return { kind: "failed", error: errorMessage(err) }
  }
}

async function executeTools(calls: ToolCall[], tools: Tool[], ctx: ToolContext): Promise<ToolRun> {
  const results: ToolResult[] = []

  for (const call of calls) {
    if (isCancelled(ctx.signal)) return { kind: "cancelled", results }
    results.push(await executeToolCall(call, tools, ctx))
  }

  return isCancelled(ctx.signal) ? { kind: "cancelled", results } : { kind: "completed", results }
}
