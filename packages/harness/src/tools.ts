// tools.ts
// The tool contract every tool implements (name + schema + async execute)
// and the runtime that invokes it. A tool carries its parameter schema in
// whichever form is native to its source: a Zod schema (first-party tools,
// validated + converted to JSON Schema for the model) OR a pre-built JSON
// Schema (external sources like MCP, passed to the model verbatim, the
// tool owns its own validation). executeToolCall validates args when a Zod
// schema is present, runs the tool, and wraps the outcome in a
// discriminated ToolResult the loop branches on. No display / naming
// concerns live here — those are the UI's job; the kernel returns raw facts.

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
  // Zod schema (first-party tools): validated before execute and
  // converted to JSON Schema for the provider. Mutually exclusive in
  // practice with `jsonSchema` — set one.
  schema?: ZodTypeAny
  // Pre-built JSON Schema (external/MCP tools): handed to the provider
  // verbatim, no Zod round-trip. When this is the only schema present,
  // executeToolCall skips validation and the tool/server owns it.
  jsonSchema?: Record<string, unknown>
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
  // Validate against the Zod schema when present. JSON-Schema-only tools
  // (MCP) skip kernel validation — the server is the source of truth for
  // its own inputs — so their args pass through untouched.
  let args: unknown = call.args
  if (tool.schema !== undefined) {
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
    args = parsed.data
  }
  try {
    const result = await tool.execute(args, ctx)
    if (result.kind === "ok") {
      // No truncation here — the loop layer decides whether to artifact
      // the full output or truncate it as a fallback (see
      // core/execute-tools.ts). Tools always hand back raw bytes.
      return { kind: "ok", call, value: result.output, summary: result.summary }
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
