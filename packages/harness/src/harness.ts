import { type ZodTypeAny, z } from "zod"
import { appendEvent, type Event, loadEvents, newEventId, nowIso } from "./events.js"
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
  await appendEvent(sessionId, {
    type: "invocation.received",
    v: 1,
    id: newEventId(),
    ts: nowIso(),
    text: userText,
  })
  return runSession(sessionId, deps)
}

export async function runSession(sessionId: string, deps: HarnessDeps): Promise<SessionState> {
  const append = (event: Event): Promise<void> => appendEvent(sessionId, event)
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const ctx: ToolContext = { sessionId, permission: allowAllPermissions }
  let stepNumber = 0

  while (true) {
    const session = projectSession(await loadEvents(sessionId))

    if (shouldCompact(session)) {
      await compact(session, append)
      continue
    }

    stepNumber++
    await append({
      type: "step.started",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      stepNumber,
    })

    const promptOptions: BuildPromptOptions = {
      model: deps.model,
      system: deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
    }
    const harnessTools: HarnessTool[] = deps.tools.list().map(toHarnessTool)
    const request = buildPrompt(session, harnessTools, promptOptions)

    await append({
      type: "model.requested",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      request,
    })

    let modelOutput: ProviderResponse
    try {
      modelOutput = await callModel(deps.provider, request)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await append({
        type: "model.failed",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        error: errorMessage,
      })
      await append({
        type: "agent.finished",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        reason: "model_error",
      })
      return projectSession(await loadEvents(sessionId))
    }

    await append({
      type: "model.completed",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      text: modelOutput.text,
      toolCalls: modelOutput.toolCalls,
      ...(modelOutput.usage !== undefined ? { usage: modelOutput.usage } : {}),
    })

    if (modelOutput.toolCalls.length > 0) {
      await executeToolCalls(modelOutput.toolCalls, deps.tools, ctx, append)
    }

    if (!shouldContinue(modelOutput, stepNumber, maxSteps)) {
      const reason = stepNumber >= maxSteps ? "max_steps" : "no_tool_calls"
      await append({
        type: "agent.finished",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        reason,
      })
      return projectSession(await loadEvents(sessionId))
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
  // Note (Ezra, 2026-04-22): zod v4 ships z.toJSONSchema, so we delegate instead of
  // hand-rolling a converter. This keeps schemas faithful (descriptions, optionals,
  // nested objects, arrays) without adding a dependency. If a tool's schema isn't
  // representable as JSON Schema, fall back to { type: "object" } so the model still
  // sees a callable signature rather than crashing the loop.
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>
    return json
  } catch {
    return { type: "object" }
  }
}
