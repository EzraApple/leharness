import type { RecordEvent } from "../events.js"
import type { ProviderResponse } from "../provider/index.js"
import { executeToolCalls, type Tool, type ToolContext } from "../tools.js"

export async function recordToolResults(
  calls: ProviderResponse["toolCalls"],
  tools: Tool[],
  ctx: ToolContext,
  recordEvent: RecordEvent,
): Promise<void> {
  const toolResults = await executeToolCalls(calls, tools, ctx)
  for (const result of toolResults) {
    if (result.ok) {
      await recordEvent("tool.completed", { call: result.call, result: result.value })
    } else {
      await recordEvent("tool.failed", { call: result.call, error: result.error })
    }
  }
}
