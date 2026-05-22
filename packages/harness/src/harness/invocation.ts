import { compact } from "../compaction/index.js"
import type { Event } from "../events.js"
import type { ReasoningEffort } from "../models.js"
import { buildInput, buildRequest, type CompactionOptions, type PromptInput } from "../prompt.js"
import type { Provider, ProviderResponse, ToolCallDelta } from "../provider/index.js"
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
  builtInTaskTools,
  getOrCreateTaskServices,
  type Message,
  type SessionTaskServices,
} from "../tasks.js"
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

type PromptResult =
  | { kind: "completed"; response: ProviderResponse }
  | { kind: "cancelled"; text: string }
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

async function preparePrompt(
  invocation: InvocationState,
  userText: string | undefined,
  deps: HarnessDeps,
  options: RunOptions,
): Promise<PreparedPrompt> {
  const baseSystem = deps.systemPrompt
  const skillConfig = deps.skills === false ? undefined : deps.skills
  const tasksEnabled = deps.tasks !== false
  let system = baseSystem
  let tools = tasksEnabled ? withBuiltInTaskTools(deps.tools) : deps.tools

  if (skillOptionsEnabled(deps.skills)) {
    const discoveredSkills = await discoverSkills(skillConfig?.root)
    if (discoveredSkills.length > 0) {
      const catalog = renderSkillCatalog(discoveredSkills, {
        budgetChars: skillConfig?.catalogBudgetChars,
        includePaths: skillConfig?.includePaths,
        queryText: userText ?? "",
        recentSkillNames: recentLoadedSkillNames(invocation.events),
      })
      system = withSkillCatalog(baseSystem, catalog)
      const skillTools = [
        createLoadSkillTool({
          root: skillConfig?.root,
          maxSkillBytes: skillConfig?.maxSkillBytes,
        }),
        ...deps.tools.filter((tool) => tool.name !== "load_skill"),
      ]
      tools = tasksEnabled ? withBuiltInTaskTools(skillTools) : skillTools
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
      reasoningEffort: deps.reasoningEffort,
      onText: options.onText,
      onReasoningText: options.onReasoningText,
      onToolCallDelta: options.onToolCallDelta,
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
  let emittedText = ""
  try {
    const request = buildRequest(prompt)
    const forwardText = request.onText
    request.onText =
      forwardText === undefined
        ? undefined
        : (delta: string) => {
            if (isCancelled(signal)) return
            emittedText += delta
            forwardText(delta)
          }
    const forwardToolCallDelta = request.onToolCallDelta
    request.onToolCallDelta =
      forwardToolCallDelta === undefined
        ? undefined
        : (delta: ToolCallDelta) => {
            if (isCancelled(signal)) return
            forwardToolCallDelta(delta)
          }
    const response = await waitForProvider(() => provider.call(request), signal)
    return isCancelled(signal)
      ? { kind: "cancelled", text: emittedText }
      : { kind: "completed", response }
  } catch (err) {
    if (isProviderCancelled(err, signal)) return { kind: "cancelled", text: emittedText }
    return { kind: "failed", error: errorMessage(err) }
  }
}

async function executeTools(calls: ToolCall[], tools: Tool[], ctx: ToolContext): Promise<ToolRun> {
  const results: ToolResult[] = []

  for (const call of calls) {
    if (isCancelled(ctx.signal)) return { kind: "cancelled", results }
    await ctx.recordEvent?.("tool.started", { call })
    const result = await executeToolCall(call, tools, ctx)
    results.push(result)
    if (result.kind === "ok") {
      await ctx.recordEvent?.("tool.completed", {
        call: result.call,
        result: result.value,
        summary: result.summary,
      })
    } else if (result.kind === "started") {
      await ctx.recordEvent?.("task.started", {
        callId: result.call.id,
        task: result.task,
        summary: result.summary,
      })
    } else {
      await ctx.recordEvent?.("tool.failed", {
        call: result.call,
        error: result.error,
        summary: result.summary,
      })
    }
  }

  return isCancelled(ctx.signal) ? { kind: "cancelled", results } : { kind: "completed", results }
}

async function drainTaskQueue(
  invocation: InvocationState,
  services: SessionTaskServices,
): Promise<void> {
  for (const message of services.queue.drain()) {
    await invocation.recordEvent(message.kind, messagePayload(message))
  }
}

function messagePayload(message: Message): Record<string, unknown> {
  if (message.kind === "task.completed") {
    return {
      taskId: message.taskId,
      result: message.result,
      summary: message.summary,
      ts: message.occurredAt,
    }
  }
  if (message.kind === "task.failed") {
    return {
      taskId: message.taskId,
      error: message.error,
      summary: message.summary,
      ts: message.occurredAt,
    }
  }
  return {
    taskId: message.taskId,
    reason: message.reason,
    summary: message.summary,
    ts: message.occurredAt,
  }
}

async function reapOrphanTasks(
  invocation: InvocationState,
  services: SessionTaskServices,
): Promise<void> {
  const startedTaskIds = new Set<string>()
  const terminalTaskIds = new Set<string>()
  for (const event of invocation.events) {
    if (event.type === "task.started") {
      const taskId = readEventTaskId(event)
      if (taskId !== undefined) startedTaskIds.add(taskId)
      continue
    }
    if (
      event.type === "task.completed" ||
      event.type === "task.failed" ||
      event.type === "task.cancelled"
    ) {
      if (typeof event.taskId === "string") terminalTaskIds.add(event.taskId)
    }
  }
  for (const taskId of startedTaskIds) {
    if (terminalTaskIds.has(taskId)) continue
    const known = services.registry.get(taskId)
    if (known !== undefined && known.state === "running") continue
    await invocation.recordEvent("task.cancelled", {
      taskId,
      reason: "process_exited",
      summary: "process exited",
    })
  }
}

function readEventTaskId(event: Event): string | undefined {
  if (typeof event.taskId === "string") return event.taskId
  const task = event.task as { id?: unknown } | undefined
  return typeof task?.id === "string" ? task.id : undefined
}

function withBuiltInTaskTools(tools: Tool[]): Tool[] {
  const overrides = new Set(tools.map((tool) => tool.name))
  return [...tools, ...builtInTaskTools.filter((tool) => !overrides.has(tool.name))]
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
