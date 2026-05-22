// compaction/index.ts
// Entry point for compaction strategies. Called by the loop before each
// model invocation: takes a PromptInput, returns a possibly-shrunk one if
// the input exceeds the configured budget. Dispatches to a concrete
// strategy (naive-truncate today; more later) and records a
// compaction.completed event when it ran.

import type { PromptInput } from "../prompt.js"
import { naiveTruncate } from "./naive-truncate.js"

export { naiveTruncate } from "./naive-truncate.js"

export async function compact(input: PromptInput): Promise<PromptInput> {
  return naiveTruncate(input)
}
