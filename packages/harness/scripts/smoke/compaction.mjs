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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-compaction-"))
process.env.LEHARNESS_HOME = tmp

const longPriorText =
  "very long prior context ".repeat(20) +
  "packages/harness/src/harness.ts packages/harness/src/prompt.ts"

const responses = [
  {
    text: `remembered details: ${longPriorText}`,
    toolCalls: [],
    stopReason: "stop",
  },
  {
    text: "answered from compacted context",
    toolCalls: [],
    stopReason: "stop",
  },
]
const seenRequests = []
let callIndex = 0

const fakeProvider = {
  name: "compaction-fake",
  async call(req) {
    seenRequests.push(req)
    const response = responses[callIndex]
    callIndex++
    if (!response) throw new Error("compaction-fake: out of scripted responses")
    return response
  },
}

const sessionId = "smoke-compaction-001"
const baseDeps = {
  provider: fakeProvider,
  tools: [],
  model: "fake-model",
  systemPrompt: "smoke compaction",
}

await runInvocation(sessionId, longPriorText, baseDeps)
await runInvocation(sessionId, "fresh question", {
  ...baseDeps,
  compaction: {
    maxInputChars: 120,
    preserveRecentMessages: 1,
  },
})

assert(callIndex === responses.length, "both scripted responses should be consumed")

const firstRequest = seenRequests[0]
const secondRequest = seenRequests[1]
assert(
  firstRequest?.messages.some((m) => m.role === "user" && m.content.includes(longPriorText)) ===
    true,
  "first request should include the long original user prompt before compaction is enabled",
)

assert(secondRequest?.messages.length === 1, "second request should keep only the newest message")
assert(
  secondRequest.messages[0]?.role === "user" &&
    secondRequest.messages[0].content === "fresh question",
  "second request should preserve the latest user message",
)
assert(
  JSON.stringify(secondRequest.messages).includes("very long prior context") === false,
  "second request should drop old oversized messages before the model call",
)

const events = await loadEvents(sessionId)
const compactionEvents = events.filter((e) => e.type === "compaction.completed")
assert(compactionEvents.length === 1, "compaction should append one compaction.completed event")

const compactionEvent = compactionEvents[0]
assert(
  compactionEvent.strategy === "naive_truncate" &&
    compactionEvent.droppedMessageCount >= 2 &&
    compactionEvent.outputChars <= 120,
  `unexpected compaction event payload: ${JSON.stringify(compactionEvent)}`,
)
assert(
  events.some((e) => e.type === "invocation.received" && e.text === longPriorText),
  "canonical event log should still retain the full prior invocation",
)

console.log("\nsmoke-compaction: SUCCESS")
