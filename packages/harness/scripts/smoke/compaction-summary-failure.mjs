// compaction-summary-failure.mjs
// When the summarizer call throws (network error, provider rejection),
// pressure-gradient should record a compaction.summary.failed event
// containing the attempted event ids, fall through to the next tier
// (T6 truncate if pressure is high enough and a char ceiling is set),
// and let the main step proceed. Next invocation should retry summary
// since no compaction.summary event lands for the failed attempt.

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, runInvocation } from "../../dist/index.js"
import { formatValue } from "../format-value.mjs"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-fail-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-fail"
const budget = 1000

const assistantBody = (i) =>
  `Turn ${i} body. ` +
  "It edited files, considered the architecture, ran tests, and made decisions about how to ".repeat(
    8,
  )

let summarizerCalls = 0
let mainCallIndex = 0
const responses = []
for (let i = 0; i < 4; i++) {
  responses.push({
    text: assistantBody(i),
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: i === 3 ? 900 : 100, completionTokens: 30 },
  })
}
// Post-failure main response (pressure is still high since we didn't
// summarize, but the main call should still go through).
responses.push({
  text: "main response after summary failed",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 800, completionTokens: 10 },
})

const provider = {
  name: "fail-fake",
  async call(req) {
    if (req.tools === undefined) {
      summarizerCalls++
      // First summarizer call: throw. Second: succeed (next-step retry).
      if (summarizerCalls === 1) {
        throw new Error("simulated summarizer outage")
      }
      return {
        text: "RECOVERED_SUMMARY",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 300, completionTokens: 30 },
      }
    }
    const response = responses[mainCallIndex++]
    if (response === undefined) throw new Error("fail-fake: out of main responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [],
  model: "fake-main",
  systemPrompt: "smoke fail",
  tasks: false,
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

for (let i = 0; i < 5; i++) {
  await runInvocation(sessionId, `user ${i}`, baseDeps)
}

const events = await loadEvents(sessionId)

// First summarizer call threw → compaction.summary.failed event landed.
const failed = events.find((e) => e.type === "compaction.summary.failed")
assert(failed !== undefined, "expected compaction.summary.failed event")
assert(
  Array.isArray(failed.attemptedEventIds) && failed.attemptedEventIds.length > 0,
  "compaction.summary.failed should carry attemptedEventIds",
)
assert(
  typeof failed.error === "string" && failed.error.includes("simulated summarizer outage"),
  `expected error to mention the outage; got "${formatValue(failed.error)}"`,
)

// No compaction.summary event for that attempt (only the failure).
const summaries = events.filter((e) => e.type === "compaction.summary")
assert(
  summaries.length === 0,
  `expected 0 successful summaries after the failure (no cache pollution); got ${summaries.length}`,
)

// Main step proceeded — there's a model.completed after the failure.
const modelCompletedAfterFailure = events
  .slice(events.indexOf(failed) + 1)
  .find((e) => e.type === "model.completed")
assert(
  modelCompletedAfterFailure !== undefined,
  "the main provider call should have proceeded after the summarizer failure",
)

assert(
  summarizerCalls === 1,
  `expected exactly 1 summarizer attempt for this 5-invocation run; got ${summarizerCalls}`,
)

console.log("smoke-compaction-summary-failure: SUCCESS")
