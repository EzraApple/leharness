import { compact } from "./compaction/index.js"
import {
  appendEvent,
  type Event,
  loadEvents,
  newEventId,
  nowIso,
  type RecordEvent,
} from "./events.js"
import {
  buildInput,
  buildRequest,
  type CompactionOptions,
  DEFAULT_SYSTEM_PROMPT,
} from "./prompt.js"
import type { Provider, ProviderRequest, ProviderResponse } from "./provider/index.js"
import {
  createLoadSkillTool,
  discoverSkills,
  recentLoadedSkillNames,
  renderSkillCatalog,
  type SkillOptions,
  skillOptionsEnabled,
  withSkillCatalog,
} from "./skills.js"
import { executeToolCalls, type Tool, type ToolContext } from "./tools.js"

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

const DEFAULT_MAX_STEPS = 25

interface PromptSurface {
  system: string
  tools: Tool[]
}

type ModelCallResult = { status: "completed"; response: ProviderResponse } | { status: "finished" }

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

  await recordEvent("invocation.received", { text: userText })

  const ctx: ToolContext = { sessionId, recordEvent, signal }

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
      baseSystem: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      events,
      skills,
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

function createEventRecorder(sessionId: string, events: Event[], options: RunOptions): RecordEvent {
  return async (type: string, payload: Record<string, unknown>) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    options.onEvent?.(event)
    return event
  }
}

async function preparePromptSurface(options: {
  baseSystem: string
  events: Event[]
  skills: SkillOptions | false | undefined
  tools: Tool[]
  userText: string
}): Promise<PromptSurface> {
  const skillConfig = options.skills === false ? undefined : options.skills
  if (!skillOptionsEnabled(options.skills)) {
    return { system: options.baseSystem, tools: options.tools }
  }

  const discoveredSkills = await discoverSkills(skillConfig?.root)
  if (discoveredSkills.length === 0) return { system: options.baseSystem, tools: options.tools }

  const catalog = renderSkillCatalog(discoveredSkills, {
    budgetChars: skillConfig?.catalogBudgetChars,
    includePaths: skillConfig?.includePaths,
    queryText: options.userText,
    recentSkillNames: recentLoadedSkillNames(options.events),
  })
  return {
    system: withSkillCatalog(options.baseSystem, catalog),
    tools: [
      createLoadSkillTool({
        root: skillConfig?.root,
        maxSkillBytes: skillConfig?.maxSkillBytes,
      }),
      ...options.tools.filter((tool) => tool.name !== "load_skill"),
    ],
  }
}

async function callModel(
  provider: Provider,
  request: ProviderRequest,
  recordEvent: RecordEvent,
  signal: AbortSignal | undefined,
): Promise<ModelCallResult> {
  if (await finishIfCancelled(recordEvent, signal)) return { status: "finished" }

  try {
    const response = await abortable(provider.call(request), signal)
    return { status: "completed", response }
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      await recordEvent("agent.finished", { reason: "cancelled" })
      return { status: "finished" }
    }

    await recordEvent("model.failed", { error: errorMessage(err) })
    await recordEvent("agent.finished", { reason: "model_failed" })
    return { status: "finished" }
  }
}

async function recordModelCompleted(
  response: ProviderResponse,
  recordEvent: RecordEvent,
): Promise<void> {
  await recordEvent("model.completed", {
    text: response.text,
    toolCalls: response.toolCalls,
    usage: response.usage,
  })
}

async function recordToolResults(
  calls: ProviderResponse["toolCalls"],
  tools: Tool[],
  ctx: ToolContext,
  recordEvent: RecordEvent,
): Promise<void> {
  const toolResults = await executeToolCalls(calls, tools, ctx)
  for (const result of toolResults) {
    if (result.ok) {
      await recordEvent("tool.completed", { call: result.call, result: result.value })
    } else {
      await recordEvent("tool.failed", { call: result.call, error: result.error })
    }
  }
}

async function finishIfCancelled(
  recordEvent: RecordEvent,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted !== true) return false
  await recordEvent("agent.finished", { reason: "cancelled" })
  return true
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
