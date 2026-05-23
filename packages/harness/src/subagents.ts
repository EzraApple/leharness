// subagents.ts
// Subagents shipped as TaskKind === "delegated". Mirrors the shell archetype:
// the harness owns the lifecycle (SubagentExecutor + the spawn_subagent tool),
// apps register typed presets (SubagentPreset) that say what tools / system
// prompt / model each subagent gets. Reuses the MessageQueue + TaskRegistry
// + wait_task / read_task / cancel_task from tasks.ts unchanged.
//
//   SubagentPreset          — apps register these via registerSubagentPreset
//   SubagentDefaults        — fallback config used when spawn_subagent is
//                             called without a `type` ("spawn a copy of me")
//   SubagentExecutor        — TaskExecutor impl; runs runInvocation on a
//                             child session, accumulates child events for
//                             snapshot, posts task.* to parent's queue
//   enableSubagentRuntime   — one-call setup paralleling enableShellRuntime
//   createSpawnSubagentTool — per-session built-in tool whose description
//                             dynamically lists registered presets

import { ulid } from "ulid"
import { z } from "zod"
import type { Event, RecordEvent } from "./events.js"
import { loadEvents } from "./events.js"
import type { ReasoningEffort } from "./models.js"
import type { Provider } from "./provider/index.js"
import { enableShellRuntime } from "./shell.js"
import {
  getOrCreateTaskServices,
  type MessageQueue,
  newTaskId,
  registerTaskExecutor,
  type SessionTaskServices,
  type Task,
  type TaskExecutor,
  type TaskRegistry,
  type TaskSnapshot,
} from "./tasks.js"
import type { Tool, ToolContext, ToolExecuteResult } from "./tools.js"

export interface SubagentPreset {
  name: string
  description: string
  systemPrompt: string
  tools: Tool[]
  model?: string
  reasoningEffort?: ReasoningEffort
  maxSteps?: number
}

export interface SubagentDefaults {
  provider: Provider
  model: string
  systemPrompt: string
  tools: Tool[]
  reasoningEffort?: ReasoningEffort
  maxSteps?: number
}

export interface SubagentExecutor extends TaskExecutor {
  readonly kind: "delegated"
  spawn(task: Task): void
}

interface SubagentTaskRecord {
  task: Task
  childSessionId: string
  presetName: string | undefined
  prompt: string
  abortController: AbortController
  childEvents: Event[]
}

const SNAPSHOT_MAX_BYTES = 16 * 1024
const SNAPSHOT_MAX_EVENTS = 40

const PRESETS_KEY = Symbol.for("leharness.subagentPresets")

interface ServicesWithPresets extends SessionTaskServices {
  [PRESETS_KEY]?: Map<string, SubagentPreset>
}

function presetMap(services: SessionTaskServices): Map<string, SubagentPreset> {
  const bag = services as ServicesWithPresets
  let map = bag[PRESETS_KEY]
  if (map === undefined) {
    map = new Map()
    bag[PRESETS_KEY] = map
  }
  return map
}

export function registerSubagentPreset(
  services: SessionTaskServices,
  preset: SubagentPreset,
): void {
  presetMap(services).set(preset.name, preset)
}

export function listSubagentPresets(services: SessionTaskServices): SubagentPreset[] {
  return Array.from(presetMap(services).values())
}

export function createSubagentExecutor(deps: {
  queue: MessageQueue
  registry: TaskRegistry
  defaults: SubagentDefaults
  runInvocation: typeof import("./core/invocation.js").runInvocation
  services: SessionTaskServices
}): SubagentExecutor {
  const records = new Map<string, SubagentTaskRecord>()

  function buildChildDeps(preset: SubagentPreset | undefined): {
    provider: Provider
    tools: Tool[]
    model: string
    systemPrompt: string
    reasoningEffort?: ReasoningEffort
    maxSteps?: number
    tasks: boolean
    subagents: boolean
  } {
    return {
      provider: deps.defaults.provider,
      tools: preset?.tools ?? deps.defaults.tools,
      model: preset?.model ?? deps.defaults.model,
      systemPrompt: preset?.systemPrompt ?? deps.defaults.systemPrompt,
      reasoningEffort: preset?.reasoningEffort ?? deps.defaults.reasoningEffort,
      maxSteps: preset?.maxSteps ?? deps.defaults.maxSteps,
      tasks: true,
      subagents: false, // no nested subagents in v1
    }
  }

  function postCompleted(record: SubagentTaskRecord, result: string, summary?: string): void {
    deps.registry.markTerminal(record.task.id, "completed")
    deps.queue.send({
      kind: "task.completed",
      taskId: record.task.id,
      occurredAt: new Date().toISOString(),
      result,
      summary: summary ?? "completed",
    })
  }

  function postFailed(record: SubagentTaskRecord, error: string, summary?: string): void {
    deps.registry.markTerminal(record.task.id, "failed")
    deps.queue.send({
      kind: "task.failed",
      taskId: record.task.id,
      occurredAt: new Date().toISOString(),
      error,
      summary: summary ?? "failed",
    })
  }

  function postCancelled(record: SubagentTaskRecord, summary?: string): void {
    deps.registry.markTerminal(record.task.id, "cancelled")
    deps.queue.send({
      kind: "task.cancelled",
      taskId: record.task.id,
      occurredAt: new Date().toISOString(),
      // cancel() is only reachable via the cancel_task tool — i.e. the
      // parent agent decided to stop this subagent.
      reason: "parent",
      summary: summary ?? "cancelled",
    })
  }

  async function runChild(record: SubagentTaskRecord): Promise<void> {
    const preset =
      record.presetName === undefined ? undefined : presetMap(deps.services).get(record.presetName)
    const childDeps = buildChildDeps(preset)

    // Child needs its own shell runtime so bash works inside the child loop.
    const childServices = getOrCreateTaskServices(record.childSessionId)
    enableShellRuntime(childServices)

    let lastModelText = ""
    let finishedReason: string | undefined

    try {
      await deps.runInvocation(record.childSessionId, record.prompt, childDeps, {
        signal: record.abortController.signal,
        onEvent: (event) => {
          record.childEvents.push(event)
          if (event.type === "model.completed" && typeof event.text === "string") {
            lastModelText = event.text
          }
          if (event.type === "agent.finished" && typeof event.reason === "string") {
            finishedReason = event.reason
          }
        },
      })
    } catch (err) {
      records.delete(record.task.id)
      postFailed(record, err instanceof Error ? err.message : String(err), "subagent crashed")
      return
    }

    records.delete(record.task.id)

    if (finishedReason === "cancelled") {
      postCancelled(record)
      return
    }
    if (finishedReason === "model_failed") {
      postFailed(record, lastModelText || "subagent model failed", "model failed")
      return
    }
    const summary = finishedReason === "max_steps" ? "max steps reached" : "completed"
    postCompleted(record, lastModelText || "(no final response)", summary)
  }

  return {
    kind: "delegated",

    spawn(task: Task): void {
      if (task.payload.kind !== "delegated") return
      const record: SubagentTaskRecord = {
        task,
        childSessionId: task.payload.childSessionId,
        presetName: task.payload.presetName,
        prompt: task.payload.prompt,
        abortController: new AbortController(),
        childEvents: [],
      }
      records.set(task.id, record)
      void runChild(record).catch((err: unknown) => {
        records.delete(task.id)
        postFailed(
          record,
          err instanceof Error ? err.message : String(err),
          "subagent runtime error",
        )
      })
    },

    async cancel(taskId: string): Promise<void> {
      const record = records.get(taskId)
      if (record === undefined) return
      record.abortController.abort()
    },

    snapshot(taskId: string): TaskSnapshot | undefined {
      const record = records.get(taskId)
      if (record === undefined) return undefined
      const transcript = formatChildTranscript(record.childEvents)
      return {
        output: transcript,
        byteCount: Buffer.byteLength(transcript, "utf8"),
        state: record.task.state,
      }
    },
  }
}

export function enableSubagentRuntime(
  services: SessionTaskServices,
  defaults: SubagentDefaults,
  runInvocation: typeof import("./core/invocation.js").runInvocation,
): SubagentExecutor {
  const existing = services.executors.get("delegated")
  if (existing !== undefined) return existing as SubagentExecutor
  const executor = createSubagentExecutor({
    queue: services.queue,
    registry: services.registry,
    defaults,
    runInvocation,
    services,
  })
  registerTaskExecutor(services, executor)
  return executor
}

const spawnSubagentArgs = z.object({
  prompt: z.string().describe("The task description for the subagent."),
  type: z
    .string()
    .optional()
    .describe(
      "Optional preset name. Omit to spawn a copy of the parent with the same tools and system prompt.",
    ),
  inline_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "How long (ms) to wait inline before backgrounding. Subagents usually outlive this; default 0.",
    ),
})

type SpawnSubagentArgs = z.infer<typeof spawnSubagentArgs>

export function createSpawnSubagentTool(services: SessionTaskServices): Tool<SpawnSubagentArgs> {
  const presets = listSubagentPresets(services)
  return {
    name: "spawn_subagent",
    description: buildSpawnDescription(presets),
    schema: spawnSubagentArgs,
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const taskServices = ctx.taskServices
      if (taskServices === undefined) {
        return { kind: "error", message: "spawn_subagent: task services unavailable" }
      }
      const executor = taskServices.executors.get("delegated") as SubagentExecutor | undefined
      if (executor === undefined) {
        return {
          kind: "error",
          message:
            "spawn_subagent: subagent runtime not enabled (call enableSubagentRuntime on session services)",
        }
      }
      if (args.type !== undefined && !presetMap(taskServices).has(args.type)) {
        return {
          kind: "error",
          message: `spawn_subagent: unknown preset '${args.type}'`,
        }
      }
      const childSessionId = `child_${ulid()}`
      const task: Task = {
        id: newTaskId(),
        kind: "delegated",
        sessionId: ctx.sessionId,
        state: "running",
        startedAt: new Date().toISOString(),
        payload: {
          kind: "delegated",
          childSessionId,
          presetName: args.type,
          prompt: args.prompt,
        },
      }
      taskServices.registry.register(task, executor)
      executor.spawn(task)
      const inlineMs = args.inline_ms ?? 0
      if (inlineMs <= 0) {
        return {
          kind: "started",
          task,
          summary: args.type ? `spawned ${args.type} · ${task.id}` : `spawned · ${task.id}`,
        }
      }
      // Inline wait window: race terminal vs timer.
      const terminal = taskServices.registry.whenTerminal(task.id)
      const winner = await Promise.race([
        terminal.then((state) => ({ kind: "terminal" as const, state })),
        delay(inlineMs).then(() => ({ kind: "timeout" as const })),
      ])
      if (winner.kind === "timeout") {
        return {
          kind: "started",
          task,
          summary: args.type ? `spawned ${args.type} · ${task.id}` : `spawned · ${task.id}`,
        }
      }
      // Child already terminated within the inline window — return the result inline.
      // It still went through the queue → task.* event landed; we can return either an
      // inline ok or kind: "started" and let the model see task.completed in the next
      // step. Keeping started for symmetry with bash; the next drain produces the
      // tool result the model needs anyway.
      return {
        kind: "started",
        task,
        summary: args.type ? `spawned ${args.type} · ${task.id}` : `spawned · ${task.id}`,
      }
    },
  }
}

function buildSpawnDescription(presets: SubagentPreset[]): string {
  const head = [
    "Spawn an isolated subagent to handle one focused subtask. The subagent has its own session log and its own conversation; you'll receive its final answer when it completes.",
    "Omit `type` to spawn a copy of yourself with the same tools and system prompt. Set inline_ms: 0 (default) to background immediately.",
  ]
  if (presets.length === 0) return head.join(" ")
  const catalog = presets.map((preset) => `  ${preset.name} — ${preset.description}`).join("\n")
  return `${head.join(" ")}\n\nAvailable subagent types:\n${catalog}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function formatChildTranscript(events: Event[]): string {
  const slice = events.slice(-SNAPSHOT_MAX_EVENTS)
  const lines: string[] = []
  for (const event of slice) {
    lines.push(formatEventLine(event))
  }
  let out = lines.join("\n")
  if (Buffer.byteLength(out, "utf8") <= SNAPSHOT_MAX_BYTES) return out
  // Drop oldest lines until we fit.
  while (lines.length > 0 && Buffer.byteLength(out, "utf8") > SNAPSHOT_MAX_BYTES) {
    lines.shift()
    out = lines.join("\n")
  }
  return out
}

function formatEventLine(event: Event): string {
  switch (event.type) {
    case "invocation.received":
      return `[user] ${truncate(String(event.text ?? ""), 240)}`
    case "model.completed": {
      const text = truncate(String(event.text ?? ""), 320)
      const calls = (event.toolCalls as Array<{ name?: string }> | undefined) ?? []
      const callNames = calls
        .map((call) => call?.name)
        .filter((name): name is string => typeof name === "string")
        .join(", ")
      const suffix = callNames.length > 0 ? ` [calls: ${callNames}]` : ""
      return `[assistant] ${text}${suffix}`
    }
    case "tool.started": {
      const call = event.call as { name?: string; args?: unknown } | undefined
      return `  → ${call?.name ?? "tool"}(${preview(call?.args)})`
    }
    case "tool.completed": {
      const call = event.call as { name?: string } | undefined
      const summary = typeof event.summary === "string" ? event.summary : undefined
      return `  ← ${call?.name ?? "tool"} ok${summary ? ` · ${summary}` : ""}`
    }
    case "tool.failed": {
      const call = event.call as { name?: string } | undefined
      const summary = typeof event.summary === "string" ? event.summary : undefined
      return `  ✗ ${call?.name ?? "tool"} failed${summary ? ` · ${summary}` : ""}`
    }
    case "task.started": {
      const task = event.task as { id?: string; kind?: string } | undefined
      return `  ⇣ task.started ${task?.kind ?? ""} ${task?.id ?? ""}`
    }
    case "task.completed":
      return `  ✓ task.completed ${String(event.taskId ?? "")}`
    case "agent.finished":
      return `[end] reason=${String(event.reason ?? "?")}`
    default:
      return `[${event.type}]`
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function preview(value: unknown): string {
  const text = (() => {
    try {
      return JSON.stringify(value) ?? ""
    } catch {
      return String(value)
    }
  })()
  return truncate(text, 120)
}

/** Read the child's full event log from disk for inspector tooling. */
export async function loadChildSessionEvents(childSessionId: string): Promise<Event[]> {
  return loadEvents(childSessionId)
}

// recordEvent re-export so the executor's runInvocation signature compiles
// against the harness's type without a circular reference back through index.
export type { RecordEvent }
