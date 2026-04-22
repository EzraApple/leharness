import { type ZodTypeAny, z } from "zod"
import { appendEvent, type Event, loadEvents, newEvent } from "./events.js"
import { type BuildPromptOptions, buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompt.js"
import {
  callModel,
  type HarnessTool,
  type Provider,
  type ProviderResponse,
} from "./provider/index.js"
import { projectSession, type SessionState } from "./session.js"
import {
  allowAllPermissions,
  executeToolCalls,
  type Tool,
  type ToolContext,
  type ToolRegistry,
} from "./tools.js"

export interface HarnessDeps {
  provider: Provider
  tools: ToolRegistry
  model: string
  systemPrompt?: string
  temperature?: number
  maxOutputTokens?: number
  maxSteps?: number
}

const DEFAULT_MAX_STEPS = 20

export async function runInvocation(
  sessionId: string,
  userText: string,
  deps: HarnessDeps,
): Promise<SessionState> {
  await appendEvent(sessionId, newEvent("invocation.received", { text: userText }))
  return runSession(sessionId, deps)
}

export async function runSession(sessionId: string, deps: HarnessDeps): Promise<SessionState> {
  const events: Event[] = await loadEvents(sessionId)
  const append = async (event: Event): Promise<void> => {
    events.push(event)
    await appendEvent(sessionId, event)
  }
  const finish = async (reason: string): Promise<SessionState> => {
    await append(newEvent("agent.finished", { reason }))
    return projectSession(events)
  }

  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const ctx: ToolContext = { sessionId, permission: allowAllPermissions }
  const harnessTools: HarnessTool[] = deps.tools.list().map(toHarnessTool)
  const promptOptions: BuildPromptOptions = {
    model: deps.model,
    system: deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    temperature: deps.temperature,
    maxOutputTokens: deps.maxOutputTokens,
  }

  let stepNumber = 0
  while (true) {
    const session = projectSession(events)
    if (shouldCompact(session)) {
      await compact(session, append)
      continue
    }

    stepNumber++
    await append(newEvent("step.started", { stepNumber }))
    const request = buildPrompt(session, harnessTools, promptOptions)
    await append(newEvent("model.requested", { request }))

    let modelOutput: ProviderResponse
    try {
      modelOutput = await callModel(deps.provider, request)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await append(newEvent("model.failed", { error: errorMessage }))
      return finish("model_error")
    }

    await append(
      newEvent("model.completed", {
        text: modelOutput.text,
        toolCalls: modelOutput.toolCalls,
        usage: modelOutput.usage,
      }),
    )

    if (modelOutput.toolCalls.length > 0) {
      await executeToolCalls(modelOutput.toolCalls, deps.tools, ctx, append)
    }

    if (!shouldContinue(modelOutput, stepNumber, maxSteps)) {
      return finish(stepNumber >= maxSteps ? "max_steps" : "no_tool_calls")
    }
  }
}

export function shouldContinue(
  modelOutput: ProviderResponse,
  stepNumber: number,
  maxSteps: number,
): boolean {
  if (stepNumber >= maxSteps) return false
  return modelOutput.toolCalls.length > 0
}

export function shouldCompact(_session: SessionState): boolean {
  return false
}

export async function compact(
  _session: SessionState,
  _append: (event: Event) => Promise<void>,
): Promise<void> {
  // Note (Ezra, 2026-04-22): MVP no-op. Real compaction lives behind shouldCompact + a
  // future `compaction.started` / `compaction.completed` event pair so the loop stays
  // a single writer.
}

function toHarnessTool(tool: Tool): HarnessTool {
  return {
    name: tool.name,
    description: tool.description,
    schemaJson: zodSchemaToJsonSchema(tool.schema),
  }
}

function zodSchemaToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  // Note (Ezra, 2026-04-22): zod v4 ships z.toJSONSchema; if a tool's schema isn't
  // representable we fall back to { type: "object" } so the loop never crashes on
  // a misconfigured tool.
  try {
    return z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    return { type: "object" }
  }
}
