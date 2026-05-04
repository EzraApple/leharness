import { compact } from "./compaction/index.js"
import { appendEvent, type Event, loadEvents, newEventId, nowIso } from "./events.js"
import {
  buildInput,
  buildRequest,
  type CompactionOptions,
  DEFAULT_SYSTEM_PROMPT,
} from "./prompt.js"
import type { Provider } from "./provider/index.js"
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

  const recordEvent = async (type: string, payload: Record<string, unknown>) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    options.onEvent?.(event)
    return event
  }

  await recordEvent("invocation.received", { text: userText })

  const ctx: ToolContext = { sessionId, recordEvent, signal: options.signal }

  let stepNumber = 0
  while (true) {
    if (await finishIfCancelled(recordEvent, options.signal)) return events
    if (stepNumber >= maxSteps) {
      await recordEvent("agent.finished", { reason: "max_steps", maxSteps })
      return events
    }

    stepNumber++
    await recordEvent("step.started", { stepNumber })
    const skillConfig = skills === false ? undefined : skills
    let promptTools = tools
    let system = systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    if (skillOptionsEnabled(skills)) {
      const discoveredSkills = await discoverSkills(skillConfig?.root)
      if (discoveredSkills.length > 0) {
        const catalog = renderSkillCatalog(discoveredSkills, {
          budgetChars: skillConfig?.catalogBudgetChars,
          includePaths: skillConfig?.includePaths,
          queryText: userText,
          recentSkillNames: recentLoadedSkillNames(events),
        })
        system = withSkillCatalog(system, catalog)
        promptTools = [
          createLoadSkillTool({
            root: skillConfig?.root,
            maxSkillBytes: skillConfig?.maxSkillBytes,
          }),
          ...tools.filter((tool) => tool.name !== "load_skill"),
        ]
      }
    }
    const input = await compact(
      buildInput(events, promptTools, {
        sessionId,
        provider,
        model,
        system,
        temperature,
        maxOutputTokens,
        onText: options.onText,
        signal: options.signal,
        compaction,
        recordEvent,
      }),
    )
    const request = buildRequest(input)
    if (await finishIfCancelled(recordEvent, options.signal)) return events

    let response: Awaited<ReturnType<Provider["call"]>>
    try {
      response = await abortable(provider.call(request), options.signal)
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) {
        await recordEvent("agent.finished", { reason: "cancelled" })
        return events
      }
      await recordEvent("model.failed", { error: errorMessage(err) })
      await recordEvent("agent.finished", { reason: "model_failed" })
      return events
    }

    if (await finishIfCancelled(recordEvent, options.signal)) return events
    await recordEvent("model.completed", {
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
    })
    if (response.toolCalls.length === 0) {
      await recordEvent("agent.finished", { reason: "no_tool_calls" })
      return events
    }
    if (await finishIfCancelled(recordEvent, options.signal)) return events
    const toolResults = await executeToolCalls(response.toolCalls, promptTools, ctx)
    for (const result of toolResults) {
      if (result.ok) {
        await recordEvent("tool.completed", { call: result.call, result: result.value })
      } else {
        await recordEvent("tool.failed", { call: result.call, error: result.error })
      }
    }
    if (await finishIfCancelled(recordEvent, options.signal)) return events
  }
}

async function finishIfCancelled(
  recordEvent: (type: string, payload: Record<string, unknown>) => Promise<Event>,
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
