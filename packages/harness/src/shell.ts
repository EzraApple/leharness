// shell.ts
// The shell archetype of a background task. Apps decide whether to expose a
// `bash` (or similar) tool to the model; this file owns the actual process
// management.
//
//   ShellExecutor          — TaskExecutor impl; adopts a running child,
//                            buffers stdout/stderr, sends task.* Messages
//                            on exit/error, handles SIGTERM-then-SIGKILL
//                            cancellation.
//   enableShellRuntime     — one-call setup: create + register the executor
//                            on a session's services.
//   runShellInBackground   — what an app-side tool's execute() delegates to.
//                            Spawns the child, races inline_ms, hands off to
//                            the executor on timeout, returns inline output
//                            otherwise. Errors clearly if the shell runtime
//                            hasn't been enabled.

import { type ChildProcess, spawn } from "node:child_process"
import {
  type MessageQueue,
  newTaskId,
  registerTaskExecutor,
  type SessionTaskServices,
  type Task,
  type TaskExecutor,
  type TaskRegistry,
  type TaskSnapshot,
} from "./tasks.js"
import type { ToolContext, ToolExecuteResult } from "./tools.js"

const DEFAULT_INLINE_MS = 5_000
const MAX_INLINE_MS = 60_000
const SIGKILL_DELAY_MS = 2_000

export interface ShellExecutor extends TaskExecutor {
  readonly kind: "shell"
  adopt(child: ChildProcess, task: Task, prebuffer: Buffer[]): void
}

interface ShellTaskRecord {
  task: Task
  child: ChildProcess
  buffer: Buffer[]
  command: string
  killTimer?: NodeJS.Timeout
}

export function createShellExecutor(deps: {
  queue: MessageQueue
  registry: TaskRegistry
}): ShellExecutor {
  const records = new Map<string, ShellTaskRecord>()

  function complete(record: ShellTaskRecord, code: number | null, signal: NodeJS.Signals | null) {
    records.delete(record.task.id)
    if (record.killTimer !== undefined) clearTimeout(record.killTimer)
    const occurredAt = new Date().toISOString()
    const output = renderOutput(record.command, record.buffer, code, signal)
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      deps.registry.markTerminal(record.task.id, "cancelled")
      deps.queue.send({
        kind: "task.cancelled",
        taskId: record.task.id,
        occurredAt,
        // SIGTERM/SIGKILL only come from this executor's cancel() path,
        // which is driven by the cancel_task tool — i.e. the parent agent.
        reason: "parent",
        summary: signal.toLowerCase(),
      })
      return
    }
    const exit = code ?? 0
    if (exit !== 0) {
      deps.registry.markTerminal(record.task.id, "failed")
      deps.queue.send({
        kind: "task.failed",
        taskId: record.task.id,
        occurredAt,
        error: output,
        summary: `exit ${exit}`,
      })
      return
    }
    deps.registry.markTerminal(record.task.id, "completed")
    deps.queue.send({
      kind: "task.completed",
      taskId: record.task.id,
      occurredAt,
      result: output,
      summary: `exit ${exit}`,
    })
  }

  return {
    kind: "shell",

    adopt(child, task, prebuffer) {
      const command = task.payload.kind === "shell" ? task.payload.command : ""
      const record: ShellTaskRecord = { task, child, buffer: prebuffer, command }
      records.set(task.id, record)

      child.stdout?.on("data", (chunk: Buffer) => record.buffer.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => record.buffer.push(chunk))

      child.on("close", (code, signal) => complete(record, code, signal))
      child.on("error", (err: NodeJS.ErrnoException) => {
        records.delete(task.id)
        if (record.killTimer !== undefined) clearTimeout(record.killTimer)
        deps.registry.markTerminal(task.id, "failed")
        deps.queue.send({
          kind: "task.failed",
          taskId: task.id,
          occurredAt: new Date().toISOString(),
          error: err.message,
          summary: "spawn error",
        })
      })

      if (child.exitCode !== null || child.signalCode !== null) {
        complete(record, child.exitCode, child.signalCode)
      }
    },

    async cancel(taskId: string) {
      const record = records.get(taskId)
      if (record === undefined) return
      try {
        record.child.kill("SIGTERM")
      } catch {
        // Already dead — close listener will fire and reconcile.
      }
      record.killTimer = setTimeout(() => {
        const current = records.get(taskId)
        if (current === undefined) return
        try {
          current.child.kill("SIGKILL")
        } catch {
          // Already gone.
        }
      }, SIGKILL_DELAY_MS)
    },

    snapshot(taskId: string): TaskSnapshot | undefined {
      const record = records.get(taskId)
      if (record === undefined) return undefined
      const output = Buffer.concat(record.buffer).toString("utf8")
      return {
        output,
        byteCount: Buffer.byteLength(output, "utf8"),
        state: "running",
      }
    },
  }
}

export function enableShellRuntime(services: SessionTaskServices): ShellExecutor {
  const existing = services.executors.get("shell")
  if (isShellExecutor(existing)) return existing
  const executor = createShellExecutor({ queue: services.queue, registry: services.registry })
  registerTaskExecutor(services, executor)
  return executor
}

export interface RunShellArgs {
  command: string
  inline_ms?: number
}

export async function runShellInBackground(
  args: RunShellArgs,
  ctx: ToolContext,
): Promise<ToolExecuteResult> {
  const services = ctx.taskServices
  const executor = services?.executors.get("shell")
  if (services === undefined || !isShellExecutor(executor)) {
    return {
      kind: "error",
      message: "shell runtime not enabled (call enableShellRuntime on session services first)",
    }
  }

  const child = spawn("/bin/bash", ["-c", args.command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const buffer: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => buffer.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => buffer.push(chunk))

  const inlineMs = clampInlineMs(args.inline_ms)
  const outcome = await raceInline(child, inlineMs)

  if (outcome.kind === "inline") {
    const output = formatInlineOutput(args.command, buffer, outcome.code, outcome.signal)
    return { kind: "ok", output, summary: summarizeCommand(output) }
  }
  if (outcome.kind === "error") {
    return { kind: "error", message: outcome.message }
  }

  const task: Task = {
    id: newTaskId(),
    kind: "shell",
    sessionId: ctx.sessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command: args.command },
  }
  services.registry.register(task, executor)
  executor.adopt(child, task, buffer)
  return { kind: "started", task, summary: `started · ${task.id}` }
}

function isShellExecutor(executor: TaskExecutor | undefined): executor is ShellExecutor {
  return executor?.kind === "shell" && "adopt" in executor && typeof executor.adopt === "function"
}

interface InlineCompletion {
  kind: "inline"
  code: number | null
  signal: NodeJS.Signals | null
}

interface InlineSpawnFailure {
  kind: "error"
  message: string
}

interface InlineTimeout {
  kind: "timeout"
}

type InlineRaceOutcome = InlineCompletion | InlineSpawnFailure | InlineTimeout

function clampInlineMs(requested: number | undefined): number {
  const value = requested ?? DEFAULT_INLINE_MS
  if (!Number.isFinite(value) || value < 0) return 0
  return value > MAX_INLINE_MS ? MAX_INLINE_MS : Math.floor(value)
}

function raceInline(child: ChildProcess, inlineMs: number): Promise<InlineRaceOutcome> {
  return new Promise<InlineRaceOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: InlineRaceOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener("close", onClose)
      child.removeListener("error", onError)
      resolve(outcome)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ kind: "inline", code, signal })
    }
    const onError = (err: NodeJS.ErrnoException) => {
      finish({ kind: "error", message: `bash failed to spawn: ${err.message}` })
    }
    child.once("close", onClose)
    child.once("error", onError)
    const timer = setTimeout(
      () => {
        finish({ kind: "timeout" })
      },
      Math.max(0, inlineMs),
    )
  })
}

function formatInlineOutput(
  command: string,
  buffer: Buffer[],
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const body = Buffer.concat(buffer).toString("utf8")
  const lines = [`$ ${command}`, body, "", `[exit: ${code ?? 0}]`]
  if (signal !== null) lines.push(`[signal: ${signal}]`)
  return lines.join("\n")
}

function renderOutput(
  command: string,
  buffer: Buffer[],
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return formatInlineOutput(command, buffer, code, signal)
}

function summarizeCommand(output: string): string {
  const exit = /\[exit: (\d+)\]/.exec(output)?.[1] ?? "?"
  const body = output
    .split("\n")
    .filter((line) => !line.startsWith("$ ") && !line.startsWith("[exit:"))
    .join("\n")
    .trim()
  return `exit ${exit} · ${lineCount(body)} lines`
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split("\n").length
}
