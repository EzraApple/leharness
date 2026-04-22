import type { ZodTypeAny } from "zod"
import { type Event, newEventId, nowIso } from "./events.js"

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface PermissionHandle {
  check(toolName: string, args: unknown): Promise<"allow" | "deny">
}

export const allowAllPermissions: PermissionHandle = {
  async check() {
    return "allow"
  },
}

export interface ToolContext {
  sessionId: string
  permission: PermissionHandle
}

export type ToolExecuteResult = { kind: "ok"; output: string } | { kind: "error"; message: string }

export interface Tool<Args = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  execute(args: Args, ctx: ToolContext): Promise<ToolExecuteResult>
}

export type ToolResult =
  | { ok: true; callId: string; value: string }
  | { ok: false; callId: string; error: string }

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return Array.from(this.tools.values())
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }
}

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024

export function truncateOutput(output: string): string {
  const buf = Buffer.from(output, "utf8")
  const totalBytes = buf.byteLength
  if (totalBytes <= MAX_TOOL_OUTPUT_BYTES) {
    return output
  }

  let cut = MAX_TOOL_OUTPUT_BYTES
  while (cut > 0) {
    const byte = buf[cut]
    if (byte === undefined) break
    if ((byte & 0xc0) !== 0x80) break
    cut--
  }

  const head = buf.subarray(0, cut).toString("utf8")
  const elided = totalBytes - cut
  return `${head}\n[truncated: ${elided} bytes]`
}

export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(call.name)
  if (tool === undefined) {
    return { ok: false, callId: call.id, error: `tool not found: ${call.name}` }
  }

  const decision = await ctx.permission.check(call.name, call.args)
  if (decision === "deny") {
    return {
      ok: false,
      callId: call.id,
      error: `permission denied for tool: ${call.name}`,
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
      callId: call.id,
      error: `invalid args for ${call.name}: ${message}`,
    }
  }

  try {
    const result = await tool.execute(parsed.data, ctx)
    if (result.kind === "ok") {
      return { ok: true, callId: call.id, value: truncateOutput(result.output) }
    }
    return { ok: false, callId: call.id, error: result.message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      callId: call.id,
      error: `tool ${call.name} threw: ${message}`,
    }
  }
}

export type AppendEvent = (event: Event) => Promise<void>

export async function executeToolCalls(
  calls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  append: AppendEvent,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const call of calls) {
    await append({
      type: "tool.started",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      call,
    })

    const result = await executeToolCall(call, registry, ctx)
    results.push(result)

    if (result.ok) {
      await append({
        type: "tool.completed",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        call,
        result: result.value,
      })
    } else {
      await append({
        type: "tool.failed",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        call,
        error: result.error,
      })
    }
  }
  return results
}
