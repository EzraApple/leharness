import { type ChildProcess, spawn } from "node:child_process"
import {
  newTaskId,
  type Task,
  type Tool,
  type ToolContext,
  type ToolExecuteResult,
} from "@leharness/harness"
import { z } from "zod"
import type { ShellExecutor } from "./shell-executor.js"

const DEFAULT_INLINE_MS = 5_000
const MAX_INLINE_MS = 60_000

const bashArgs = z.object({
  command: z.string().describe("Shell command to execute. Runs in /bin/bash on Unix."),
  inline_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `How long (ms) to wait inline before backgrounding (default ${DEFAULT_INLINE_MS}, cap ${MAX_INLINE_MS}). 0 means always background.`,
    ),
})

type BashArgs = z.infer<typeof bashArgs>

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

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description:
    "Execute a shell command. Returns inline output if the command finishes within inline_ms; otherwise hands off to a background task and returns a task_id the model can wait_task / read_task / cancel_task. Default inline_ms is 5000.",
  schema: bashArgs,
  async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
    const child = spawn("/bin/bash", ["-c", args.command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const buffer: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => buffer.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => buffer.push(chunk))

    const inlineMs = resolveInlineMs(args.inline_ms, ctx)
    const outcome = await raceInline(child, inlineMs)

    if (outcome.kind === "inline") {
      const output = formatInlineOutput(args.command, buffer, outcome.code, outcome.signal)
      return { kind: "ok", output, summary: summarizeCommand(output) }
    }
    if (outcome.kind === "error") {
      return { kind: "error", message: outcome.message }
    }

    const executor = ctx.taskServices?.executors.get("shell") as ShellExecutor | undefined
    if (ctx.taskServices === undefined || executor === undefined) {
      // No background runtime available — wait inline indefinitely so existing
      // call sites without task services still work.
      const closed = await waitForClose(child)
      if (closed.kind === "error") {
        return { kind: "error", message: closed.message }
      }
      const output = formatInlineOutput(args.command, buffer, closed.code, closed.signal)
      return { kind: "ok", output, summary: summarizeCommand(output) }
    }

    const task = makeShellTask(args.command, ctx.sessionId)
    ctx.taskServices.registry.register(task, executor)
    executor.adopt(child, task, buffer)
    return {
      kind: "started",
      task,
      summary: `started · ${task.id}`,
    }
  },
}

function resolveInlineMs(requested: number | undefined, ctx: ToolContext): number {
  // If no task services are available, ignore the budget — always wait inline.
  if (ctx.taskServices === undefined) return Number.POSITIVE_INFINITY
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
    if (!Number.isFinite(inlineMs)) {
      // Caller wants pure inline — no timer.
      return
    }
    const timer = setTimeout(
      () => {
        finish({ kind: "timeout" })
      },
      Math.max(0, inlineMs),
    )
  })
}

function waitForClose(child: ChildProcess): Promise<InlineCompletion | InlineSpawnFailure> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ kind: "inline", code, signal })
    })
    child.once("error", (err: NodeJS.ErrnoException) => {
      resolve({ kind: "error", message: `bash failed to spawn: ${err.message}` })
    })
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

function makeShellTask(command: string, sessionId: string): Task {
  return {
    id: newTaskId(),
    kind: "shell",
    sessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command },
  }
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
