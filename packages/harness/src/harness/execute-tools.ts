// execute-tools.ts
// One step's worth of tool dispatch. The model produced N tool calls; this
// runs them sequentially, emits `tool.started` before each, then routes the
// result to the right terminal event:
//   ok      → tool.completed
//   error   → tool.failed
//   started → task.started   (handed off to a background executor)
// Returns whether the step was cancelled mid-flight so the loop can stop.

import {
  executeToolCall,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from "../tools.js"
import { isCancelled } from "./cancellation.js"

type ToolRun =
  | { kind: "completed"; results: ToolResult[] }
  | { kind: "cancelled"; results: ToolResult[] }

export async function executeTools(
  calls: ToolCall[],
  tools: Tool[],
  ctx: ToolContext,
): Promise<ToolRun> {
  const results: ToolResult[] = []

  for (const call of calls) {
    if (isCancelled(ctx.signal)) return { kind: "cancelled", results }
    await ctx.recordEvent?.("tool.started", { call })
    const result = await executeToolCall(call, tools, ctx)
    results.push(result)
    if (result.kind === "ok") {
      await ctx.recordEvent?.("tool.completed", {
        call: result.call,
        result: result.value,
        summary: result.summary,
      })
    } else if (result.kind === "started") {
      await ctx.recordEvent?.("task.started", {
        callId: result.call.id,
        task: result.task,
        summary: result.summary,
      })
    } else {
      await ctx.recordEvent?.("tool.failed", {
        call: result.call,
        error: result.error,
        summary: result.summary,
      })
    }
  }

  return isCancelled(ctx.signal) ? { kind: "cancelled", results } : { kind: "completed", results }
}
