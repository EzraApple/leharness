import type { ZodTypeAny } from "zod"
import type { RecordEvent } from "./events.js"
import type { SessionTaskServices, StartedTask } from "./tasks.js"

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolContext {
  sessionId: string
  recordEvent?: RecordEvent
  signal?: AbortSignal
  taskServices?: SessionTaskServices
}

export type ToolExecuteResult =
  | { kind: "ok"; output: string; summary?: string }
  | { kind: "error"; message: string; summary?: string }
  | { kind: "started"; task: StartedTask; summary?: string }

export interface Tool<Args = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  execute(args: Args, ctx: ToolContext): Promise<ToolExecuteResult>
}

export type ToolResult =
  | { kind: "ok"; call: ToolCall; value: string; summary?: string }
  | { kind: "error"; call: ToolCall; error: string; summary?: string }
  | { kind: "started"; call: ToolCall; task: StartedTask; summary?: string }

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
    return { kind: "error", call, error: `tool not found: ${call.name}` }
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
      kind: "error",
      call,
      error: `invalid args for ${call.name}: ${message}`,
    }
  }
  try {
    const result = await tool.execute(parsed.data, ctx)
    if (result.kind === "ok") {
      const value = truncateOutput(result.output)
      return { kind: "ok", call, value, summary: result.summary }
    }
    if (result.kind === "started") {
      return { kind: "started", call, task: result.task, summary: result.summary }
    }
    return { kind: "error", call, error: result.message, summary: result.summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: "error", call, error: `tool ${call.name} threw: ${message}` }
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
