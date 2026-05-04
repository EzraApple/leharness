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
  compaction?: CompactionOptions
  skills?: SkillOptions | false
}

export interface RunOptions {
  onText?: (delta: string) => void
  onEvent?: (event: Event) => void
}

// TODO (2026-05-02): no max-step cap and no in-turn interrupt. For now Ctrl-C
// kills the process; resume picks up from the last persisted event. Add a step
// budget and an Escape-to-abort path once we feel them missing.

export async function runInvocation(
  sessionId: string,
  userText: string,
  deps: HarnessDeps,
  options: RunOptions = {},
): Promise<Event[]> {
  const { provider, tools, model, systemPrompt, temperature, maxOutputTokens, compaction, skills } =
    deps
  const events: Event[] = await loadEvents(sessionId)

  const recordEvent = async (type: string, payload: Record<string, unknown>) => {
    const event: Event = { v: 1, id: newEventId(), ts: nowIso(), type, ...payload }
    events.push(event)
    await appendEvent(sessionId, event)
    options.onEvent?.(event)
    return event
  }

  await recordEvent("invocation.received", { text: userText })

  const ctx: ToolContext = { sessionId, recordEvent }

  let stepNumber = 0
  while (true) {
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
        compaction,
        recordEvent,
      }),
    )
    const request = buildRequest(input)
    const response = await provider.call(request)
    await recordEvent("model.completed", {
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
    })
    if (response.toolCalls.length === 0) {
      await recordEvent("agent.finished", { reason: "no_tool_calls" })
      return events
    }
    const toolResults = await executeToolCalls(response.toolCalls, promptTools, ctx)
    for (const result of toolResults) {
      if (result.ok) {
        await recordEvent("tool.completed", { call: result.call, result: result.value })
      } else {
        await recordEvent("tool.failed", { call: result.call, error: result.error })
      }
    }
  }
}
