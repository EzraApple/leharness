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

import {
  type ArtifactOptions,
  formatArtifactStub,
  resolveArtifactOptions,
  writeArtifact,
} from "../artifacts.js"
import type { Event } from "../events.js"
import type { Message, SessionTaskServices } from "../tasks.js"
import { truncateOutput } from "../tools.js"
import type { InvocationState } from "./state.js"

export async function drainTaskQueue(
  invocation: InvocationState,
  services: SessionTaskServices,
  artifactsConfig: ArtifactOptions | false | undefined,
): Promise<void> {
  const artifacts = resolveArtifactOptions(artifactsConfig)
  for (const message of services.queue.drain()) {
    const payload = await materializeMessage(invocation, message, artifacts)
    await invocation.recordEvent(message.kind, payload)
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

async function materializeMessage(
  invocation: InvocationState,
  message: Message,
  artifacts: { enabled: false } | { enabled: true; thresholdBytes: number },
): Promise<Record<string, unknown>> {
  if (message.kind === "task.completed") {
    const rendered = await renderLarge(invocation, message.result, artifacts, {
      sourceTaskId: message.taskId,
    })
    return {
      taskId: message.taskId,
      result: rendered.value,
      summary: message.summary,
      ts: message.occurredAt,
      ...(rendered.artifactId === undefined ? {} : { artifactId: rendered.artifactId }),
    }
  }
  if (message.kind === "task.failed") {
    const rendered = await renderLarge(invocation, message.error, artifacts, {
      sourceTaskId: message.taskId,
    })
    return {
      taskId: message.taskId,
      error: rendered.value,
      summary: message.summary,
      ts: message.occurredAt,
      ...(rendered.artifactId === undefined ? {} : { artifactId: rendered.artifactId }),
    }
  }
  return {
    taskId: message.taskId,
    reason: message.reason,
    summary: message.summary,
    ts: message.occurredAt,
  }
}

async function renderLarge(
  invocation: InvocationState,
  rawValue: string,
  artifacts: { enabled: false } | { enabled: true; thresholdBytes: number },
  meta: { sourceTaskId?: string },
): Promise<{ value: string; artifactId: string | undefined }> {
  const byteLength = Buffer.byteLength(rawValue, "utf8")
  if (artifacts.enabled && byteLength > artifacts.thresholdBytes) {
    const artifact = await writeArtifact(invocation.sessionId, rawValue, {
      mime: "text/plain",
      sourceTaskId: meta.sourceTaskId,
    })
    await invocation.recordEvent("artifact.created", {
      id: artifact.id,
      sessionId: artifact.sessionId,
      byteCount: artifact.byteCount,
      mime: artifact.mime,
      sourceTaskId: meta.sourceTaskId,
    })
    return { value: formatArtifactStub(artifact, rawValue), artifactId: artifact.id }
  }
  return { value: truncateOutput(rawValue), artifactId: undefined }
}

function readEventTaskId(event: Event): string | undefined {
  if (typeof event.taskId === "string") return event.taskId
  const task = event.task as { id?: unknown } | undefined
  return typeof task?.id === "string" ? task.id : undefined
}
