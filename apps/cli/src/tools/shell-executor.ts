import type { ChildProcess } from "node:child_process"
import type {
  MessageQueue,
  Task,
  TaskExecutor,
  TaskRegistry,
  TaskSnapshot,
} from "@leharness/harness"

interface ShellTaskRecord {
  task: Task
  child: ChildProcess
  buffer: Buffer[]
  command: string
  killTimer?: NodeJS.Timeout
}

export interface ShellExecutor extends TaskExecutor {
  readonly kind: "shell"
  adopt(child: ChildProcess, task: Task, prebuffer: Buffer[]): void
}

const SIGKILL_DELAY_MS = 2000

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
        reason: "user",
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
      const command = (task.payload as { kind: "shell"; command: string }).command
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

    async cancel(taskId: string): Promise<void> {
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

function renderOutput(
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
