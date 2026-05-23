// task-drain.ts
// Background-task lifecycle hooks that the loop calls between model steps.
//
//   drainTaskQueue   — at the top of every step, pull any Messages that
//                      background executors have posted since the last drain
//                      and append them as task.* events with their original
//                      occurredAt timestamps. This is the only place outside
//                      the loop itself that records task.* terminal events,
//                      preserving the single-writer rule.
//
//   reapOrphanTasks  — runs once per invocation startup. Finds task.started
//                      events with no matching terminal in the log and no
//                      currently-running entry in the in-process registry;
//                      those are tasks the previous process spawned but never
//                      finished. They get a synthetic task.cancelled(reason:
//                      "process_exited") so the log stays internally
//                      consistent across restarts.

import type { Event } from "../events.js"
import type { Message, SessionTaskServices } from "../tasks.js"
import type { InvocationState } from "./state.js"

export async function drainTaskQueue(
  invocation: InvocationState,
  services: SessionTaskServices,
): Promise<void> {
  for (const message of services.queue.drain()) {
    await invocation.recordEvent(message.kind, messagePayload(message))
  }
}

export async function reapOrphanTasks(
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

function readEventTaskId(event: Event): string | undefined {
  if (typeof event.taskId === "string") return event.taskId
  const task = event.task as { id?: unknown } | undefined
  return typeof task?.id === "string" ? task.id : undefined
}
