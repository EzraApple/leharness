import type { ZodTypeAny } from "zod"
import type { RecordEvent } from "./events.js"

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolContext {
  sessionId: string
  recordEvent?: RecordEvent
  signal?: AbortSignal
}

export interface ToolDisplay<Args = unknown> {
  pending: string
  completed: string
  failed?: string
  target?(args: Args): string
  summarize?(output: string, args: Args): string
  summarizeError?(error: string, args: Args): string
}

export interface ToolDisplaySnapshot {
  pending: string
  completed: string
  failed: string
  target?: string
  summary?: string
}

export type ToolExecuteResult =
  | { kind: "ok"; output: string; summary?: string }
  | { kind: "error"; message: string; summary?: string }

export interface Tool<Args = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  display?: ToolDisplay<Args>
  execute(args: Args, ctx: ToolContext): Promise<ToolExecuteResult>
}

export type ToolResult =
  | { ok: true; call: ToolCall; display: ToolDisplaySnapshot; value: string }
  | { ok: false; call: ToolCall; display: ToolDisplaySnapshot; error: string }

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024

export function truncateOutput(output: string): string {
  const buf = Buffer.from(output, "utf8")
  if (buf.byteLength <= MAX_TOOL_OUTPUT_BYTES) return output
  let cut = MAX_TOOL_OUTPUT_BYTES
  while (cut > 0) {
    const byte = buf[cut]
    if (byte === undefined) break
    if ((byte & 0xc0) !== 0x80) break
    cut--
  }
  const head = buf.subarray(0, cut).toString("utf8")
  return `${head}\n[truncated: ${buf.byteLength - cut} bytes]`
}

export async function executeToolCall(
  call: ToolCall,
  tools: Tool[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.name)
  if (tool === undefined) {
    return {
      ok: false,
      call,
      display: fallbackDisplay(call),
      error: `tool not found: ${call.name}`,
    }
  }
  const parsed = tool.schema.safeParse(call.args)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const pathStr = issue.path.length > 0 ? issue.path.join(".") : "(root)"
        return `${pathStr}: ${issue.message}`
      })
      .join("; ")
    return {
      ok: false,
      call,
      display: fallbackDisplay(call),
      error: `invalid args for ${call.name}: ${message}`,
    }
  }
  try {
    const result = await tool.execute(parsed.data, ctx)
    if (result.kind === "ok") {
      const value = truncateOutput(result.output)
      return {
        ok: true,
        call,
        display: completedDisplay(tool, parsed.data, value, result.summary),
        value,
      }
    }
    return {
      ok: false,
      call,
      display: failedDisplay(tool, parsed.data, result.message, result.summary),
      error: result.message,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      call,
      display: failedDisplay(tool, parsed.data, message),
      error: `tool ${call.name} threw: ${message}`,
    }
  }
}

export async function executeToolCalls(
  calls: ToolCall[],
  tools: Tool[],
  ctx: ToolContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const call of calls) {
    if (ctx.signal?.aborted) break
    results.push(await executeToolCall(call, tools, ctx))
  }
  return results
}

export function pendingDisplayForToolCall(call: ToolCall, tools: Tool[]): ToolDisplaySnapshot {
  const tool = tools.find((candidate) => candidate.name === call.name)
  if (tool === undefined) return fallbackDisplay(call)
  const parsed = tool.schema.safeParse(call.args)
  if (!parsed.success) return fallbackDisplay(call)
  return baseDisplay(tool, parsed.data)
}

function completedDisplay<Args>(
  tool: Tool<Args>,
  args: Args,
  output: string,
  explicitSummary: string | undefined,
): ToolDisplaySnapshot {
  const display = baseDisplay(tool, args)
  const summary = explicitSummary ?? tool.display?.summarize?.(output, args)
  return summary === undefined ? display : { ...display, summary }
}

function failedDisplay<Args>(
  tool: Tool<Args>,
  args: Args,
  error: string,
  explicitSummary?: string,
): ToolDisplaySnapshot {
  const display = baseDisplay(tool, args)
  const summary = explicitSummary ?? tool.display?.summarizeError?.(error, args)
  return summary === undefined ? display : { ...display, summary }
}

function baseDisplay<Args>(tool: Tool<Args>, args: Args): ToolDisplaySnapshot {
  const { pending, completed, failed } = baseDisplayWithoutTarget(tool)
  const target = safeDisplayTarget(tool, args)
  return target === undefined
    ? { completed, failed, pending }
    : { completed, failed, pending, target }
}

function baseDisplayWithoutTarget(tool: Tool): ToolDisplaySnapshot {
  return {
    completed: tool.display?.completed ?? `${tool.name} ok`,
    failed: tool.display?.failed ?? `${tool.name} failed`,
    pending: tool.display?.pending ?? tool.name,
  }
}

function safeDisplayTarget<Args>(tool: Tool<Args>, args: Args): string | undefined {
  try {
    const target = tool.display?.target?.(args).trim()
    return target === undefined || target.length === 0 ? undefined : target
  } catch {
    return undefined
  }
}

function fallbackDisplay(call: ToolCall): ToolDisplaySnapshot {
  return {
    ...baseFallbackDisplay(call.name),
    target: argsPreview(call.args),
  }
}

function baseFallbackDisplay(name: string): ToolDisplaySnapshot {
  return {
    completed: `${name} ok`,
    failed: `${name} failed`,
    pending: name,
  }
}

function argsPreview(args: unknown): string {
  const preview = JSON.stringify(args) ?? ""
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview
}
