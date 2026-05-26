// prepare-prompt.ts
// Produces the PromptInput the model call will consume. Two responsibilities:
//   1. Compose the tool list — auto-injecting the built-in task tools when
//      tasks are enabled and load_skill when a skill catalog will be rendered.
//   2. Compose the system prompt — appending a compact skill catalog only
//      when skills are enabled and at least one was discovered.
// Returns both the projected PromptInput and the final tool list so the loop
// can pass the same list to executeTools.

import { readArtifactTool } from "../artifacts.js"
import type { Event } from "../events.js"
import { contextWindowTokensForModel, type ReasoningEffort } from "../models.js"
import type { CompactionOptions, PromptInput } from "../prompt.js"
import { buildInput } from "../prompt.js"
import type { Provider, ToolCallDelta } from "../provider/index.js"
import {
  createLoadSkillTool,
  discoverSkills,
  recentLoadedSkillNames,
  renderSkillCatalog,
  type SkillOptions,
  skillOptionsEnabled,
  withSkillCatalog,
} from "../skills.js"
import { createSpawnSubagentTool } from "../subagents.js"
import { builtInTaskTools, type SessionTaskServices } from "../tasks.js"
import type { Tool } from "../tools.js"
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
  skills?: SkillOptions | false
  tasks?: boolean
  subagents?: boolean
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
  taskServices?: SessionTaskServices,
): Promise<PreparedPrompt> {
  const baseSystem = deps.systemPrompt
  const skillConfig = deps.skills === false ? undefined : deps.skills
  const tasksEnabled = deps.tasks !== false
  const subagentsEnabled =
    deps.subagents !== false && taskServices?.executors.has("delegated") === true
  let system = baseSystem
  let tools = applyBuiltIns(deps.tools, { tasksEnabled, subagentsEnabled, taskServices })

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
      tools = applyBuiltIns(skillTools, { tasksEnabled, subagentsEnabled, taskServices })
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
      compaction: applyCompactionDefaults(deps.compaction, deps),
      recordEvent: invocation.recordEvent,
    }),
    tools,
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

function applyBuiltIns(
  tools: Tool[],
  flags: {
    tasksEnabled: boolean
    subagentsEnabled: boolean
    taskServices?: SessionTaskServices
  },
): Tool[] {
  const overrides = new Set(tools.map((tool) => tool.name))
  let next = tools
  if (flags.tasksEnabled) {
    next = [...next, ...builtInTaskTools.filter((tool) => !overrides.has(tool.name))]
  }
  if (!overrides.has("read_artifact")) {
    next = [...next, readArtifactTool]
  }
  if (
    flags.subagentsEnabled &&
    flags.taskServices !== undefined &&
    !overrides.has("spawn_subagent")
  ) {
    next = [...next, createSpawnSubagentTool(flags.taskServices)]
  }
  return next
}
