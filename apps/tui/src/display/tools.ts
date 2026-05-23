import type { TaskKind, ToolCall } from "@leharness/harness"

interface ToolDisplay {
  pending: string
  completed: string
  failed: string
  target?(args: unknown): string | undefined
  summarize?(output: string, args: unknown): string | undefined
}

export interface ToolDisplaySnapshot {
  pending: string
  completed: string
  failed: string
  target?: string
  summary?: string
}

const TOOL_DISPLAYS: Record<string, ToolDisplay> = {
  bash: {
    pending: "running",
    completed: "ran",
    failed: "command failed",
    target: (args) => readField(args, "command"),
    summarize: (output) => summarizeCommandOutput(output),
  },
  read_file: {
    pending: "reading",
    completed: "read",
    failed: "could not read",
    target: (args) => readField(args, "path"),
    summarize: (output) => plural(lineCount(output), "line"),
  },
  create_file: {
    pending: "creating",
    completed: "created",
    failed: "could not create",
    target: (args) => readField(args, "path"),
  },
  edit_file: {
    pending: "editing",
    completed: "edited",
    failed: "could not edit",
    target: (args) => readField(args, "path"),
  },
  load_skill: {
    pending: "loading",
    completed: "loaded",
    failed: "could not load",
    target: (args) => {
      const name = readField(args, "name")
      return name === undefined ? undefined : `/${name}`
    },
  },
  wait_task: {
    pending: "waiting on",
    completed: "finished waiting on",
    failed: "wait failed for",
    target: (args) => shortTaskId(readField(args, "task_id")),
  },
  read_task: {
    pending: "reading",
    completed: "read",
    failed: "read failed for",
    target: (args) => shortTaskId(readField(args, "task_id")),
    summarize: (output) => firstLineSummary(output),
  },
  cancel_task: {
    pending: "cancelling",
    completed: "cancelled",
    failed: "cancel failed for",
    target: (args) => shortTaskId(readField(args, "task_id")),
  },
  spawn_subagent: {
    pending: "spawning",
    completed: "spawned",
    failed: "spawn failed for",
    target: (args) => {
      const type = readField(args, "type")
      const prompt = readField(args, "prompt")
      if (type !== undefined) return `${type}: ${truncate(prompt ?? "", 60)}`
      return truncate(prompt ?? "subagent", 80)
    },
  },
}

const SUBAGENT_DISPLAY: ToolDisplay = {
  pending: "running",
  completed: "ran subagent",
  failed: "subagent failed",
  target: (payload) => {
    if (typeof payload !== "object" || payload === null) return undefined
    const record = payload as { presetName?: unknown; prompt?: unknown }
    const presetName = typeof record.presetName === "string" ? record.presetName : undefined
    const prompt = typeof record.prompt === "string" ? record.prompt : undefined
    if (presetName !== undefined) return `${presetName}: ${truncate(prompt ?? "", 60)}`
    return truncate(prompt ?? "subagent", 80)
  },
}

const TASK_KIND_DISPLAYS: Record<TaskKind, ToolDisplay> = {
  shell: TOOL_DISPLAYS.bash as ToolDisplay,
  delegated: SUBAGENT_DISPLAY,
}

function displayForToolName(name: string): ToolDisplay | undefined {
  return TOOL_DISPLAYS[name]
}

function displayForTaskKind(kind: TaskKind): ToolDisplay | undefined {
  return TASK_KIND_DISPLAYS[kind]
}

export function pendingSnapshotForCall(call: ToolCall): ToolDisplaySnapshot {
  const display = displayForToolName(call.name)
  if (display === undefined) return fallback(call.name, call.args)
  return baseSnapshot(display, call.args)
}

export function completedSnapshotForCall(
  call: ToolCall,
  output: string,
  summary: string | undefined,
): ToolDisplaySnapshot {
  const display = displayForToolName(call.name)
  if (display === undefined) {
    return { ...fallback(call.name, call.args), summary }
  }
  const base = baseSnapshot(display, call.args)
  const computedSummary = summary ?? display.summarize?.(output, call.args)
  return computedSummary === undefined ? base : { ...base, summary: computedSummary }
}

export function failedSnapshotForCall(
  call: ToolCall,
  _error: string,
  summary: string | undefined,
): ToolDisplaySnapshot {
  const display = displayForToolName(call.name)
  if (display === undefined) {
    return { ...fallback(call.name, call.args), summary }
  }
  const base = baseSnapshot(display, call.args)
  return summary === undefined ? base : { ...base, summary }
}

export function snapshotForTaskKind(
  kind: TaskKind,
  payload: unknown,
  summary?: string,
): ToolDisplaySnapshot {
  const display = displayForTaskKind(kind)
  if (display === undefined) {
    return {
      pending: kind,
      completed: kind,
      failed: kind,
      target: undefined,
      summary,
    }
  }
  const base = baseSnapshot(display, payload)
  return summary === undefined ? base : { ...base, summary }
}

function baseSnapshot(display: ToolDisplay, args: unknown): ToolDisplaySnapshot {
  const target = safeTarget(display, args)
  return target === undefined
    ? { pending: display.pending, completed: display.completed, failed: display.failed }
    : { pending: display.pending, completed: display.completed, failed: display.failed, target }
}

function safeTarget(display: ToolDisplay, args: unknown): string | undefined {
  if (display.target === undefined) return undefined
  try {
    const value = display.target(args)
    if (value === undefined) return undefined
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  } catch {
    return undefined
  }
}

function fallback(name: string, args: unknown): ToolDisplaySnapshot {
  return {
    pending: name,
    completed: `${name} ok`,
    failed: `${name} failed`,
    target: argsPreview(args),
  }
}

function argsPreview(args: unknown): string {
  const preview = JSON.stringify(args) ?? ""
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview
}

function readField(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function shortTaskId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.length <= 13 ? value : `${value.slice(0, 12)}…`
}

function summarizeCommandOutput(output: string): string {
  const exit = /\[exit: (\d+)\]/.exec(output)?.[1] ?? "?"
  const body = output
    .split("\n")
    .filter((line) => !line.startsWith("$ ") && !line.startsWith("[exit:"))
    .join("\n")
    .trim()
  return `exit ${exit} · ${lineCount(body)} lines`
}

function firstLineSummary(output: string): string {
  const firstLine = output.split("\n").find((line) => line.trim().length > 0)
  if (firstLine === undefined) return "no output"
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split("\n").length
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
