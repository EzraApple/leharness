import type { RecordEvent } from "../events.js"

export const DEFAULT_MAX_STEPS = 25

export async function finishIfCancelled(
  recordEvent: RecordEvent,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted !== true) return false
  await recordEvent("agent.finished", { reason: "cancelled" })
  return true
}
