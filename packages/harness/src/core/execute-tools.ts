// execute-tools.ts
// One step's worth of tool dispatch. The model produced N tool calls; this
// runs them sequentially, emits `tool.started` before each, then routes the
// result to the right terminal event:
//   ok      → tool.completed   (large outputs auto-artifacted)
//   error   → tool.failed
//   started → task.started     (handed off to a background executor)
// Returns whether the step was cancelled mid-flight so the loop can stop.

import {
  type Artifact,
  AUTO_ARTIFACT_THRESHOLD_BYTES,
  formatArtifactStub,
  writeArtifact,
} from "../artifacts.js"
import {
  executeToolCall,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  truncateOutput,
} from "../tools.js"

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
    if (ctx.signal?.aborted === true) return { kind: "cancelled", results }
    await ctx.recordEvent?.("tool.started", { call })
    const result = await executeToolCall(call, tools, ctx)
    results.push(result)
    if (result.kind === "ok") {
      const sized = await sizeForContext(ctx, result.value, { sourceCallId: result.call.id })
      if (sized.artifact !== undefined) {
        await ctx.recordEvent?.("artifact.created", {
          id: sized.artifact.id,
          sessionId: sized.artifact.sessionId,
          byteCount: sized.artifact.byteCount,
          mime: sized.artifact.mime,
          sourceCallId: result.call.id,
        })
        await ctx.recordEvent?.("tool.completed", {
          call: result.call,
          result: sized.value,
          summary: result.summary,
          artifactId: sized.artifact.id,
        })
      } else {
        await ctx.recordEvent?.("tool.completed", {
          call: result.call,
          result: sized.value,
          summary: result.summary,
        })
      }
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

  return ctx.signal?.aborted === true
    ? { kind: "cancelled", results }
    : { kind: "completed", results }
}

/**
 * Decide what the in-context `value` should be for a tool's raw output:
 * outputs above AUTO_ARTIFACT_THRESHOLD_BYTES land on disk as artifacts
 * and the caller sees a short stub; everything else passes through
 * inline (still subject to `truncateOutput` as a last-resort safety
 * net for adversarially-huge results, which auto-artifacting would
 * normally have already caught).
 */
async function sizeForContext(
  ctx: ToolContext,
  rawValue: string,
  meta: { sourceCallId?: string; sourceTaskId?: string },
): Promise<{ value: string; artifact: Artifact | undefined }> {
  if (Buffer.byteLength(rawValue, "utf8") > AUTO_ARTIFACT_THRESHOLD_BYTES) {
    const artifact = await writeArtifact(ctx.sessionId, rawValue, {
      mime: "text/plain",
      sourceCallId: meta.sourceCallId,
      sourceTaskId: meta.sourceTaskId,
    })
    return { value: formatArtifactStub(artifact, rawValue), artifact }
  }
  return { value: truncateOutput(rawValue), artifact: undefined }
}
