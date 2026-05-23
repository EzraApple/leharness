// execute-tools.ts
// One step's worth of tool dispatch. The model produced N tool calls; this
// runs them sequentially, emits `tool.started` before each, then routes the
// result to the right terminal event:
//   ok      → tool.completed   (auto-artifacted or truncated for big outputs)
//   error   → tool.failed
//   started → task.started     (handed off to a background executor)
// Returns whether the step was cancelled mid-flight so the loop can stop.

import {
  type Artifact,
  type ArtifactOptions,
  formatArtifactStub,
  resolveArtifactOptions,
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
  artifactsConfig: ArtifactOptions | false | undefined,
): Promise<ToolRun> {
  const results: ToolResult[] = []
  const artifacts = resolveArtifactOptions(artifactsConfig)

  for (const call of calls) {
    if (ctx.signal?.aborted === true) return { kind: "cancelled", results }
    await ctx.recordEvent?.("tool.started", { call })
    const result = await executeToolCall(call, tools, ctx)
    results.push(result)
    if (result.kind === "ok") {
      const sized = await sizeAndArtifact(ctx, result.value, artifacts, {
        sourceCallId: result.call.id,
      })
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
 *
 *   - artifacts enabled + output ≥ threshold → write artifact, return stub
 *   - artifacts disabled + output > 16 KB    → truncate as today
 *   - otherwise                              → pass through raw
 */
async function sizeAndArtifact(
  ctx: ToolContext,
  rawValue: string,
  artifacts: { enabled: false } | { enabled: true; thresholdBytes: number },
  meta: { sourceCallId?: string; sourceTaskId?: string },
): Promise<{ value: string; artifact: Artifact | undefined }> {
  const byteLength = Buffer.byteLength(rawValue, "utf8")
  if (artifacts.enabled && byteLength > artifacts.thresholdBytes) {
    const artifact = await writeArtifact(ctx.sessionId, rawValue, {
      mime: "text/plain",
      sourceCallId: meta.sourceCallId,
      sourceTaskId: meta.sourceTaskId,
    })
    return { value: formatArtifactStub(artifact, rawValue), artifact }
  }
  return { value: truncateOutput(rawValue), artifact: undefined }
}
