// prepare-prompt.ts
// Produces the PromptInput the model call will consume. Two responsibilities:
//   1. Compose the tool list by folding caller-provided tools with any
//      capability contributions.
//   2. Compose the system prompt by letting capabilities append/wrap it.
// Returns both the projected PromptInput and the final tool list so the loop
// can pass the same list to executeTools.

import type { Event } from "../events.js"
import { contextWindowTokensForModel, type ReasoningEffort } from "../models.js"
import type { CompactionOptions, PromptInput } from "../prompt.js"
import { buildInput } from "../prompt.js"
import type { Provider, ToolCallDelta } from "../provider/index.js"
import type { SessionTaskServices } from "../tasks.js"
import type { Tool } from "../tools.js"
import type { Capability, CapabilityContext } from "./capability.js"
import type { InvocationState } from "./state.js"

interface PreparedPrompt {
  input: PromptInput
  tools: Tool[]
}

interface PrepareDeps {
  provider: Provider
  tools: Tool[]
  model: string
  systemPrompt: string
  temperature?: number
  maxOutputTokens?: number
  compaction?: CompactionOptions
  reasoningEffort?: ReasoningEffort
  capabilities?: Capability[]
}

interface PrepareOptions {
  onText?: (delta: string) => void
  onReasoningText?: (delta: string) => void
  onToolCallDelta?: (delta: ToolCallDelta) => void
  onEvent?: (event: Event) => void
  signal?: AbortSignal
}

export async function preparePrompt(
  invocation: InvocationState,
  userText: string | undefined,
  deps: PrepareDeps,
  options: PrepareOptions,
  taskServices: SessionTaskServices,
): Promise<PreparedPrompt> {
  const capabilityContext: CapabilityContext = {
    sessionId: invocation.sessionId,
    events: invocation.events,
    userText,
    taskServices,
  }
  const capabilities = deps.capabilities ?? []
  const { system, tools } = await foldCapabilities(
    deps.systemPrompt,
    deps.tools,
    capabilities,
    capabilityContext,
  )

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
      compaction: applyCompactionDefaults(deps.compaction, deps),
      recordEvent: invocation.recordEvent,
    }),
    tools,
  }
}

async function foldCapabilities(
  baseSystem: string,
  baseTools: Tool[],
  capabilities: Capability[],
  ctx: CapabilityContext,
): Promise<{ system: string; tools: Tool[] }> {
  let system = baseSystem
  const tools = [...baseTools]

  for (const capability of capabilities) {
    if (capability.tools !== undefined) {
      const contributed = await capability.tools(ctx)
      appendMissingTools(tools, contributed)
    }
    if (capability.augmentSystemPrompt !== undefined) {
      system = await capability.augmentSystemPrompt(system, ctx)
    }
  }

  return { system, tools }
}

function appendMissingTools(tools: Tool[], contributed: Tool[]) {
  const existingNames = new Set(tools.map((tool) => tool.name))
  for (const tool of contributed) {
    if (existingNames.has(tool.name)) continue
    tools.push(tool)
    existingNames.add(tool.name)
  }
}

// The kernel owns the default budget so apps don't have to think about
// model context windows. Pressure-gradient consumes maxInputTokens
// directly; the char ceiling is its T6 safety net only (see plan 007).
function applyCompactionDefaults(
  configured: CompactionOptions | undefined,
  deps: PrepareDeps,
): CompactionOptions {
  const contextWindowTokens = contextWindowTokensForModel(deps.model, deps.provider.name)
  const maxInputTokens = configured?.maxInputTokens ?? Math.floor(contextWindowTokens * 0.85)
  const maxInputChars = configured?.maxInputChars ?? Math.floor(contextWindowTokens * 4 * 0.9)
  return {
    ...configured,
    maxInputTokens,
    maxInputChars,
  }
}
