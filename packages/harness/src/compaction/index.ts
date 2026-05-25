// compaction/index.ts
// Entry point for compaction strategies. Called by the loop before each
// model invocation: takes a PromptInput, returns a possibly-shrunk one
// if the input exceeds the configured budget. Default strategy is
// pressure-gradient (plan 007): six tiers that kick in at intermediate
// watermarks, with LLM-summarized turn windows cached via
// compaction.summary events. naiveTruncate stays exported so smokes
// can exercise the floor in isolation.

import type { PromptInput } from "../prompt.js"
import { pressureGradient } from "./pressure-gradient.js"

export type { CompactionSummary, SummaryCache } from "./cache.js"
export { loadSummaryCache } from "./cache.js"
export { naiveTruncate } from "./naive-truncate.js"
export { pressureGradient } from "./pressure-gradient.js"
export { type CompactionTurn, groupEventsIntoTurns } from "./turns.js"

export async function compact(input: PromptInput): Promise<PromptInput> {
  return pressureGradient(input)
}
