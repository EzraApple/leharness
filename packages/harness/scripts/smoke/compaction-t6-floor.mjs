// compaction-t6-floor.mjs
// Drive pressure across T6 (>= 1.0 → char ceiling exceeded) and assert
// that the truncate-front floor engages on top of the other tiers.
// Uses a tiny maxInputChars so the char ceiling fires even after the
// upper tiers have already trimmed.

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-t6-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-t6"
const budgetTokens = 1000
// Char ceiling chosen so even the projected prompt (with tool schemas)
// still exceeds it — forcing T6 to drop messages from the front.
const charCeiling = 500

const responses = []
for (let i = 0; i < 3; i++) {
  responses.push({
    text: `Turn ${i} response with some body content here to make the prompt non-trivial`,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: i === 2 ? 1100 : 100, completionTokens: 20 }, // turn 2 pushes pressure > 1.0
  })
}
responses.push({
  text: "post-truncate",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 100, completionTokens: 5 },
})

const seenRequests = []
let mainCallIndex = 0
const provider = {
  name: "compaction-t6-fake",
  async call(req) {
    seenRequests.push(req)
    if (req.tools === undefined) {
      // T6 test shouldn't hit summarizer (window too small to summarize anyway),
      // but if it does just return something benign.
      return {
        text: "stub",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 50, completionTokens: 10 },
      }
    }
    const response = responses[mainCallIndex++]
    if (response === undefined) throw new Error("t6-fake: out of responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [],
  model: "fake-model",
  systemPrompt: "smoke t6",
  tasks: false,
  compaction: {
    maxInputTokens: budgetTokens,
    maxInputChars: charCeiling,
    preserveRecentTurns: 1,
  },
}

await runInvocation(sessionId, "first", baseDeps)
await runInvocation(sessionId, "second", baseDeps)
await runInvocation(sessionId, "third", baseDeps)
await runInvocation(sessionId, "fourth", baseDeps)

const events = await loadEvents(sessionId)
const completed = events.find((e) => e.type === "compaction.completed")
assert(completed !== undefined, "expected compaction.completed event")
assert(
  Array.isArray(completed.watermarksCrossed) &&
    completed.watermarksCrossed.includes("truncate_front"),
  `expected truncate_front in watermarksCrossed, got ${formatValue(completed.watermarksCrossed)}`,
)
assert(
  completed.truncatedFromFrontCount > 0,
  `expected truncatedFromFrontCount > 0, got ${formatValue(completed.truncatedFromFrontCount)}`,
)

// The fourth invocation's main request should be smaller than what it
// would have been without truncation. We don't have a precise number,
// but assert at least that it's not enormous.
const fourthRequest = seenRequests.filter((r) => r.tools !== undefined).slice(-1)[0]
assert(fourthRequest !== undefined, "expected the 4th main provider request")
const charCount =
  JSON.stringify(fourthRequest.messages).length + (fourthRequest.system?.length ?? 0)
assert(charCount < 4_000, `projected prompt should have been truncated; got ${charCount} chars`)

console.log("smoke-compaction-t6: SUCCESS")
