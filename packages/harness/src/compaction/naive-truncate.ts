// naive-truncate.ts
// The simplest compaction strategy: when the prompt's char count exceeds
// the budget, drop oldest non-system messages until it fits, optionally
// preserving the most recent N turns. Lossy and basic on purpose — first
// strategy to land so the seam is exercised; smarter approaches plug in
// next to this file.

import type { PromptInput } from "../prompt.js"
import type { HarnessMessage, HarnessTool } from "../provider/index.js"

export async function naiveTruncate(input: PromptInput): Promise<PromptInput> {
  const maxInputChars = input.compaction?.maxInputChars
  if (maxInputChars === undefined) return input

  const beforeChars = measure(input, input.messages)
  if (beforeChars <= maxInputChars) return input

  const messages = [...input.messages]
  const preserveRecentMessages = Math.max(0, input.compaction?.preserveRecentMessages ?? 1)
  let droppedMessageCount = 0

  while (messages.length > preserveRecentMessages && measure(input, messages) > maxInputChars) {
    messages.shift()
    droppedMessageCount++
  }

  while (messages.length > preserveRecentMessages && messages[0]?.role === "tool") {
    messages.shift()
    droppedMessageCount++
  }

  if (droppedMessageCount === 0) return input

  const afterChars = measure(input, messages)
  await input.recordEvent?.("compaction.completed", {
    strategy: "naive_truncate",
    reason: "input_too_large",
    maxInputChars,
    inputChars: beforeChars,
    outputChars: afterChars,
    droppedMessageCount,
    preservedMessageCount: messages.length,
  })

  return {
    ...input,
    messages,
  }
}

function measure(input: PromptInput, messages: HarnessMessage[]): number {
  return (
    measureText(input.system) +
    measureJson(messages) +
    measureTools(input.tools) +
    measureText(input.model)
  )
}

function measureTools(tools: HarnessTool[] | undefined): number {
  if (tools === undefined) return 0
  return measureJson(tools)
}

function measureText(text: string | undefined): number {
  return text?.length ?? 0
}

function measureJson(value: unknown): number {
  return JSON.stringify(value).length
}
