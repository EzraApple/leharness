import { compact } from "../compaction/index.js"
import type { Event } from "../events.js"
import {
  buildInput,
  buildRequest,
  type CompactionOptions,
  DEFAULT_SYSTEM_PROMPT,
  type PromptInput,
} from "../prompt.js"
import type { Provider, ProviderResponse } from "../provider/index.js"
import {
  createLoadSkillTool,
  discoverSkills,
  recentLoadedSkillNames,
  renderSkillCatalog,
  type SkillOptions,
  skillOptionsEnabled,
  withSkillCatalog,
} from "../skills.js"
import {
  executeToolCall,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "../tools.js"
import { endInvocation, type InvocationState, loadInvocationState } from "./state.js"

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

interface PreparedPrompt {
  input: PromptInput
  tools: Tool[]
}

export async function runInvocation(
  sessionId: string,
  userText: string,
  deps: HarnessDeps,
  options: RunOptions = {},
): Promise<Event[]> {
  const { provider, maxSteps = DEFAULT_MAX_STEPS } = deps
  const signal = options.signal
  const invocation = await loadInvocationState(sessionId, options)

  await invocation.recordEvent("invocation.received", { text: userText })

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    await invocation.recordEvent("step.started", { stepNumber })

    const preparedPrompt = await preparePrompt(invocation, userText, deps, options)
    const prompt = await compact(preparedPrompt.input)

    if (isCancelled(signal)) return endInvocation(invocation, "cancelled")

    const promptResult = await sendPrompt(provider, prompt, signal)
    if (promptResult.kind === "cancelled") return endInvocation(invocation, "cancelled")
    if (promptResult.kind === "failed") {
      await invocation.recordEvent("model.failed", { error: promptResult.error })
      return endInvocation(invocation, "model_failed")
    }

    await invocation.recordEvent("model.completed", {
      text: promptResult.response.text,
      toolCalls: promptResult.response.toolCalls,
      usage: promptResult.response.usage,
    })
    if (promptResult.response.toolCalls.length === 0) {
      return endInvocation(invocation, "no_tool_calls")
    }

    const ctx: ToolContext = { sessionId, recordEvent: invocation.recordEvent, signal }
    const toolRun = await executeTools(promptResult.response.toolCalls, preparedPrompt.tools, ctx)
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

async function preparePrompt(
  invocation: InvocationState,
  userText: string,
  deps: HarnessDeps,
  options: RunOptions,
): Promise<PreparedPrompt> {
  const baseSystem = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const skillConfig = deps.skills === false ? undefined : deps.skills
  let system = baseSystem
  let tools = deps.tools

  if (skillOptionsEnabled(deps.skills)) {
    const discoveredSkills = await discoverSkills(skillConfig?.root)
    if (discoveredSkills.length > 0) {
      const catalog = renderSkillCatalog(discoveredSkills, {
        budgetChars: skillConfig?.catalogBudgetChars,
        includePaths: skillConfig?.includePaths,
        queryText: userText,
        recentSkillNames: recentLoadedSkillNames(invocation.events),
      })
      system = withSkillCatalog(baseSystem, catalog)
      tools = [
        createLoadSkillTool({
          root: skillConfig?.root,
          maxSkillBytes: skillConfig?.maxSkillBytes,
        }),
        ...deps.tools.filter((tool) => tool.name !== "load_skill"),
      ]
    }
  }

  return {
    input: buildInput(invocation.events, tools, {
      sessionId: invocation.sessionId,
      provider: deps.provider,
      model: deps.model,
      system,
      temperature: deps.temperature,
      maxOutputTokens: deps.maxOutputTokens,
      onText: options.onText,
      signal: options.signal,
      compaction: deps.compaction,
      recordEvent: invocation.recordEvent,
    }),
    tools,
  }
}

async function sendPrompt(
  provider: Provider,
  prompt: PromptInput,
  signal: AbortSignal | undefined,
): Promise<PromptResult> {
  try {
    const request = buildRequest(prompt)
    const response = await waitForProvider(() => provider.call(request), signal)
    return isCancelled(signal) ? { kind: "cancelled" } : { kind: "completed", response }
  } catch (err) {
    if (isProviderCancelled(err, signal)) return { kind: "cancelled" }
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

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function waitForProvider<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return call()
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    call().then(
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

function isProviderCancelled(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === "AbortError")
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
