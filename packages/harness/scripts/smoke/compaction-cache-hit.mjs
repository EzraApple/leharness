// compaction-cache-hit.mjs
// After T4 fires once and lands a compaction.summary event, a second
// pass that picks the same window must NOT call the summarizer again —
// it should hit the cache. Verifies the core "no compounded loss"
// invariant: the same source event-id set always resolves to the same
// summary without re-running the summarizer.

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-cache-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-cache-hit"
const budget = 1000

const assistantBody = (i) =>
  `Turn ${i} body. ` +
  "It edited files, considered the architecture, ran tests, and made decisions about how to ".repeat(
    8,
  )

const responses = []
for (let i = 0; i < 4; i++) {
  responses.push({
    text: assistantBody(i),
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: i === 3 ? 900 : 100, completionTokens: 50 },
  })
}
// Two more responses: invocation 5 (triggers T4) + invocation 6 (re-runs,
// pressure still high, but cache should hit).
responses.push({
  text: "post-compact 1",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 950, completionTokens: 10 },
})
responses.push({
  text: "post-compact 2",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 200, completionTokens: 10 },
})

const SUMMARY_TEXT = "- **Goal:** test cache hit\n- **Next:** verify no second call"

let summarizerCallCount = 0
let mainCallIndex = 0
const seenMainRequests = []
const provider = {
  name: "cache-hit-fake",
  async call(req) {
    if (req.tools === undefined) {
      summarizerCallCount++
      return {
        text: SUMMARY_TEXT,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 200, completionTokens: 50 },
      }
    }
    seenMainRequests.push(req)
    const response = responses[mainCallIndex++]
    if (response === undefined) throw new Error("cache-hit-fake: out of responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [],
  model: "fake-main",
  systemPrompt: "smoke cache hit",
  tasks: false,
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

// 5 invocations: turn 5's pre-flight compacts turns 1-4. summarizer fires once.
for (let i = 0; i < 5; i++) {
  await runInvocation(sessionId, `user ${i}`, baseDeps)
}
assert(
  summarizerCallCount === 1,
  `after 5 invocations expected 1 summarizer call, got ${summarizerCallCount}`,
)

// 6th invocation: turn 5's model.completed reported promptTokens=950
// so pressure is still high. Pre-flight should consult the cached
// summary for turns 1-4 and skip the summarizer entirely.
await runInvocation(sessionId, "user 5", baseDeps)
assert(
  summarizerCallCount === 1,
  `cache hit on 6th invocation should NOT trigger a second summarizer call; got ${summarizerCallCount}`,
)

const events = await loadEvents(sessionId)
const summaries = events.filter((e) => e.type === "compaction.summary")
assert(
  summaries.length === 1,
  `cache hit means we should still have only 1 compaction.summary, got ${summaries.length}`,
)

// Exactly one compaction.completed (the original tier-firing one).
// Re-application of cached summaries on subsequent steps is silent —
// it changes projection but is not a "new decision" worth logging.
const completedEvents = events.filter((e) => e.type === "compaction.completed")
assert(
  completedEvents.length === 1,
  `pure cache-application should not record a new compaction.completed; got ${completedEvents.length}`,
)

// Exactly one compaction.started (from the original summarization).
// No "started" event on the cache-hit step since no summarizer call
// was made.
const startedEvents = events.filter((e) => e.type === "compaction.started")
assert(
  startedEvents.length === 1,
  `cache hit should not emit another compaction.started; got ${startedEvents.length}`,
)

// The 6th invocation's MAIN model request should still contain the
// synthetic summary message — cached application is silent in events
// but visible in the projected prompt.
const sixthMainRequest = seenMainRequests[5]
assert(sixthMainRequest !== undefined, "expected 6 main requests")
const summaryMsg = sixthMainRequest.messages.find(
  (m) => m.role === "user" && m.content.startsWith("[Earlier work — full transcript at "),
)
assert(
  summaryMsg !== undefined,
  "6th invocation's projected prompt should still include the cached summary message",
)
assert(
  summaryMsg.content.includes(SUMMARY_TEXT),
  "summary message in 6th request should still contain the original summary text",
)

console.log("smoke-compaction-cache-hit: SUCCESS")
