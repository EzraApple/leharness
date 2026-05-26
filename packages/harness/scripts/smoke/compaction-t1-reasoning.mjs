// compaction-t1-reasoning.mjs
// Smallest end-to-end: drive pressure across only the T1 watermark
// (>= 0.50, < 0.65) and assert that the older turn's reasoningText is
// stripped from the projected prompt while the recent turn's reasoning
// survives. No artifacts, no summarization.

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, runInvocation } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-t1-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-t1"
const budget = 1000

const seenRequests = []
let callIndex = 0

// Scripted responses:
// 1. First invocation — fills the event log with reasoning text;
//    reports usage.promptTokens = 600 so the *next* step sees pressure = 0.60.
// 2. Second invocation — pressure is 0.60 → T1 fires; assistant responds plainly.
const responses = [
  {
    text: "I will help you with this task.",
    reasoningText:
      "Long reasoning that should be dropped from the older turn once pressure builds: " +
      "this is the kind of intermediate chain-of-thought that doesn't need to persist.",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 600, completionTokens: 30 },
  },
  {
    text: "Answered with compacted context.",
    reasoningText: "Fresh reasoning for the recent turn.",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 600, completionTokens: 10 },
  },
]

const provider = {
  name: "compaction-t1-fake",
  async call(req) {
    seenRequests.push(req)
    const response = responses[callIndex++]
    if (response === undefined) throw new Error("t1-fake: out of scripted responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [],
  model: "fake-model",
  systemPrompt: "smoke t1",
  tasks: false,
  // Override preserveRecentTurns=1 so the first turn is eligible for
  // compaction by the second turn's pre-flight pass; default of 2 would
  // require a third turn to have anything to compact.
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

await runInvocation(sessionId, "first user message", baseDeps)
await runInvocation(sessionId, "second user message", baseDeps)

assert(callIndex === responses.length, "both scripted responses should be consumed")

const events = await loadEvents(sessionId)
const compactionEvents = events.filter((e) => e.type === "compaction.completed")
assert(
  compactionEvents.length === 1,
  `expected 1 compaction.completed, got ${compactionEvents.length}`,
)

const compaction = compactionEvents[0]
assert(
  compaction.strategy === "pressure_gradient",
  `expected pressure_gradient strategy, got ${compaction.strategy}`,
)
assert(
  Array.isArray(compaction.watermarksCrossed) &&
    compaction.watermarksCrossed.includes("drop_old_reasoning"),
  `expected watermarksCrossed to include drop_old_reasoning, got ${JSON.stringify(compaction.watermarksCrossed)}`,
)
assert(!compaction.watermarksCrossed.includes("promote_inline_results"), "T2 should not have fired")
assert(!compaction.watermarksCrossed.includes("summarize_one_window"), "T4 should not have fired")
assert(
  compaction.droppedReasoningCount >= 1,
  `expected at least one reasoning drop, got ${compaction.droppedReasoningCount}`,
)

// The PROJECTED prompt sent to the provider on step 2 should have the
// older turn's reasoning stripped. Look at the second seen request and
// find the assistant message corresponding to turn 1.
const secondRequest = seenRequests[1]
assert(secondRequest !== undefined, "second provider request should exist")
const olderAssistant = secondRequest.messages.find(
  (m) => m.role === "assistant" && m.content === "I will help you with this task.",
)
assert(olderAssistant !== undefined, "expected the older assistant turn in the projected prompt")
assert(
  olderAssistant.reasoningText === undefined,
  `T1 should have stripped reasoningText from the older assistant message; got ${olderAssistant.reasoningText}`,
)

// Event log invariant: the original reasoning text MUST still exist in
// the canonical event log. Compaction only changes projection, not
// storage.
const firstModelCompleted = events.find((e) => e.type === "model.completed")
assert(
  typeof firstModelCompleted?.reasoningText === "string" &&
    firstModelCompleted.reasoningText.length > 0,
  "older model.completed event should retain its reasoningText (event log is append-only)",
)

console.log("smoke-compaction-t1: SUCCESS")
