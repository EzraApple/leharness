import { ulid } from "ulid"
import { z } from "zod"
import type { Tool, ToolContext, ToolDisplaySnapshot, ToolExecuteResult } from "./tools.js"

export type TaskKind = "shell" // | "delegated" | "compaction" — reserved for future plans

export type TaskState = "running" | "completed" | "failed" | "cancelled"

export type CancelReason = "user" | "process_exited"

export type TaskPayload = { kind: "shell"; command: string }

export interface Task {
  id: string
  kind: TaskKind
  sessionId: string
  state: TaskState
  startedAt: string
  payload: TaskPayload
  display: ToolDisplaySnapshot
}

export interface StartedTask {
  id: string
  kind: TaskKind
  sessionId: string
  payload: TaskPayload
  display: ToolDisplaySnapshot
  startedAt: string
}

export interface TaskSnapshot {
  output: string
  byteCount: number
  state: TaskState
}

export type Message =
  | {
      kind: "task.completed"
      taskId: string
      occurredAt: string
      result: string
      summary?: string
    }
  | {
      kind: "task.failed"
      taskId: string
      occurredAt: string
      error: string
      summary?: string
    }
  | {
      kind: "task.cancelled"
      taskId: string
      occurredAt: string
      reason: CancelReason
      summary?: string
    }

export type MessageListener = (message: Message) => void

export class MessageQueue {
  private buffer: Message[] = []
  private listeners = new Set<MessageListener>()

  send(message: Message): void {
    this.buffer.push(message)
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch {
        // Listener throws are not the queue's problem.
      }
    }
  }

  drain(): Message[] {
    const items = this.buffer
    this.buffer = []
    return items
  }

  size(): number {
    return this.buffer.length
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface TaskExecutor {
  readonly kind: TaskKind
  cancel(taskId: string): Promise<void>
  snapshot(taskId: string): TaskSnapshot | undefined
}

export class TaskRegistry {
  private tasks = new Map<string, Task>()
  private executors = new Map<string, TaskExecutor>()
  private terminalResolvers = new Map<string, Array<(state: TaskState) => void>>()

  register(task: Task, executor: TaskExecutor): void {
    this.tasks.set(task.id, task)
    this.executors.set(task.id, executor)
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  list(sessionId: string): Task[] {
    const out: Task[] = []
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId) out.push(task)
    }
    return out
  }

  executorFor(taskId: string): TaskExecutor | undefined {
    return this.executors.get(taskId)
  }

  markTerminal(taskId: string, state: TaskState): void {
    const task = this.tasks.get(taskId)
    if (task === undefined) return
    task.state = state
    const resolvers = this.terminalResolvers.get(taskId)
    if (resolvers === undefined) return
    this.terminalResolvers.delete(taskId)
    for (const resolve of resolvers) resolve(state)
  }

  async whenTerminal(taskId: string, signal?: AbortSignal): Promise<TaskState> {
    const task = this.tasks.get(taskId)
    if (task === undefined) throw new Error(`task not found: ${taskId}`)
    if (task.state !== "running") return task.state
    if (signal?.aborted === true) {
      throw new DOMException("Aborted", "AbortError")
    }
    return new Promise<TaskState>((resolve, reject) => {
      const resolvers = this.terminalResolvers.get(taskId) ?? []
      const onResolve = (state: TaskState) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(state)
      }
      const onAbort = () => {
        const list = this.terminalResolvers.get(taskId) ?? []
        const index = list.indexOf(onResolve)
        if (index >= 0) list.splice(index, 1)
        reject(new DOMException("Aborted", "AbortError"))
      }
      resolvers.push(onResolve)
      this.terminalResolvers.set(taskId, resolvers)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}

export interface SessionTaskServices {
  sessionId: string
  queue: MessageQueue
  registry: TaskRegistry
  executors: Map<TaskKind, TaskExecutor>
}

const servicesBySession = new Map<string, SessionTaskServices>()

export function getOrCreateTaskServices(sessionId: string): SessionTaskServices {
  let services = servicesBySession.get(sessionId)
  if (services === undefined) {
    services = {
      sessionId,
      queue: new MessageQueue(),
      registry: new TaskRegistry(),
      executors: new Map(),
    }
    servicesBySession.set(sessionId, services)
  }
  return services
}

export function registerTaskExecutor(services: SessionTaskServices, executor: TaskExecutor): void {
  services.executors.set(executor.kind, executor)
}

export function newTaskId(): string {
  return `task_${ulid()}`
}

export function shortId(id: string, head = 10): string {
  return id.length <= head + 1 ? id : `${id.slice(0, head)}…`
}

const DEFAULT_WAIT_TIMEOUT_MS = 60_000
const MAX_WAIT_TIMEOUT_MS = 5 * 60_000

const waitTaskArgs = z.object({
  task_id: z.string().describe("Id of the background task to wait on."),
  timeout_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `How long to block, in milliseconds (default ${DEFAULT_WAIT_TIMEOUT_MS}, capped at ${MAX_WAIT_TIMEOUT_MS}).`,
    ),
})

type WaitTaskArgs = z.infer<typeof waitTaskArgs>

export const waitTaskTool: Tool<WaitTaskArgs> = {
  name: "wait_task",
  description:
    "Block until a background task reaches a terminal state (completed, failed, cancelled) or the timeout elapses. Does not return the task output — call read_task for that. Times out without killing the task.",
  schema: waitTaskArgs,
  display: {
    pending: "waiting on",
    completed: "finished waiting on",
    failed: "wait failed for",
    target: (args) => shortId(args.task_id),
  },
  async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
    const services = ctx.taskServices
    if (services === undefined) {
      return { kind: "error", message: "wait_task: task services not available" }
    }
    const task = services.registry.get(args.task_id)
    if (task === undefined) {
      return { kind: "error", message: `wait_task: unknown task_id ${args.task_id}` }
    }
    if (task.state !== "running") {
      return {
        kind: "ok",
        output: `task ${args.task_id} ${task.state}`,
        summary: task.state,
      }
    }
    const timeoutMs = clampMs(args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS)
    const startedAt = Date.now()
    const terminal = services.registry.whenTerminal(args.task_id, ctx.signal)
    const winner = await raceWithTimeout(terminal, timeoutMs)
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
    if (winner.kind === "timeout") {
      return {
        kind: "ok",
        output: `task ${args.task_id} still running after ${elapsed}s`,
        summary: `still running · timed out`,
      }
    }
    return {
      kind: "ok",
      output: `task ${args.task_id} ${winner.value} after ${elapsed}s`,
      summary: `${winner.value} · ${elapsed}s`,
    }
  },
}

const readTaskArgs = z.object({
  task_id: z.string().describe("Id of the background task to read output from."),
  since_byte: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Byte cursor to read from; omit to read from the start."),
})

type ReadTaskArgs = z.infer<typeof readTaskArgs>

export const readTaskTool: Tool<ReadTaskArgs> = {
  name: "read_task",
  description:
    "Read the current accumulated output of a background task, optionally from a byte cursor. Returns a 'next_byte_cursor' so callers can poll incrementally. The task continues running.",
  schema: readTaskArgs,
  display: {
    pending: "reading",
    completed: "read",
    failed: "read failed for",
    target: (args) => shortId(args.task_id),
    summarize: (output) => firstLineSummary(output),
  },
  async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
    const services = ctx.taskServices
    if (services === undefined) {
      return { kind: "error", message: "read_task: task services not available" }
    }
    const executor = services.registry.executorFor(args.task_id)
    const snapshot = executor?.snapshot(args.task_id)
    const task = services.registry.get(args.task_id)
    if (task === undefined) {
      return { kind: "error", message: `read_task: unknown task_id ${args.task_id}` }
    }
    if (snapshot === undefined) {
      return {
        kind: "ok",
        output: `task ${args.task_id} state ${task.state} · no output buffer available`,
        summary: `${task.state} · no buffer`,
      }
    }
    const cursor = args.since_byte ?? 0
    const slice =
      cursor >= snapshot.byteCount
        ? ""
        : Buffer.from(snapshot.output, "utf8").subarray(cursor).toString("utf8")
    const body = [
      `task ${args.task_id} state ${snapshot.state} · ${snapshot.byteCount} bytes total · cursor ${cursor} → ${snapshot.byteCount}`,
      slice,
    ]
      .filter((part) => part.length > 0)
      .join("\n")
    return {
      kind: "ok",
      output: body,
      summary: `${snapshot.state} · ${snapshot.byteCount} bytes`,
    }
  },
}

const cancelTaskArgs = z.object({
  task_id: z.string().describe("Id of the background task to cancel."),
})

type CancelTaskArgs = z.infer<typeof cancelTaskArgs>

export const cancelTaskTool: Tool<CancelTaskArgs> = {
  name: "cancel_task",
  description:
    "Ask the executor to cancel a background task. For shell tasks this sends SIGTERM then SIGKILL. The cancellation is asynchronous — a task.cancelled event lands on completion.",
  schema: cancelTaskArgs,
  display: {
    pending: "cancelling",
    completed: "cancelled",
    failed: "cancel failed for",
    target: (args) => shortId(args.task_id),
  },
  async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
    const services = ctx.taskServices
    if (services === undefined) {
      return { kind: "error", message: "cancel_task: task services not available" }
    }
    const task = services.registry.get(args.task_id)
    if (task === undefined) {
      return { kind: "error", message: `cancel_task: unknown task_id ${args.task_id}` }
    }
    if (task.state !== "running") {
      return {
        kind: "ok",
        output: `task ${args.task_id} already ${task.state}`,
        summary: `already ${task.state}`,
      }
    }
    const executor = services.registry.executorFor(args.task_id)
    if (executor === undefined) {
      return {
        kind: "error",
        message: `cancel_task: no executor registered for ${args.task_id}`,
      }
    }
    await executor.cancel(args.task_id)
    return {
      kind: "ok",
      output: `requested cancel on ${args.task_id}`,
      summary: "cancel requested",
    }
  },
}

export const builtInTaskTools: Tool[] = [waitTaskTool, readTaskTool, cancelTaskTool]

function clampMs(value: number, cap: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return value > cap ? cap : Math.floor(value)
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "value"; value: T } | { kind: "timeout" }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ kind: "timeout" })
    }, timeoutMs)
    promise
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: "value", value })
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: "timeout" })
      })
  })
}

function firstLineSummary(output: string): string {
  const firstLine = output.split("\n").find((line) => line.trim().length > 0)
  if (firstLine === undefined) return "no output"
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
}
