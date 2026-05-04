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

function requestSize(req) {
  return (
    (req.model?.length ?? 0) +
    (req.system?.length ?? 0) +
    JSON.stringify(req.messages ?? []).length +
    JSON.stringify(req.tools ?? []).length
  )
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-compaction-"))
process.env.LEHARNESS_HOME = tmp

const longPriorText =
  "very long prior context ".repeat(20) +
  "packages/harness/src/harness/index.ts packages/harness/src/prompt.ts"

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

assert(
  secondRequest?.messages.some((m) => m.role === "user" && m.content === "fresh question") === true,
  "second request should preserve the latest user message",
)
assert(
  requestSize(secondRequest) <= 120,
  `second request should fit the compaction budget; got ${requestSize(secondRequest)}`,
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
  typeof compactionEvent.strategy === "string" &&
    compactionEvent.reason === "input_too_large" &&
    compactionEvent.outputChars <= 120,
  `unexpected compaction event payload: ${JSON.stringify(compactionEvent)}`,
)
assert(
  events.some((e) => e.type === "invocation.received" && e.text === longPriorText),
  "canonical event log should still retain the full prior invocation",
)

console.log("\nsmoke-compaction: SUCCESS")
