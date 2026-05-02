import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import { buildPrompt, loadEvents, runInvocation } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-tool-error-"))
process.env.LEHARNESS_HOME = tmp

const failingTool = {
  name: "always_fails",
  description: "Always throws.",
  schema: z.object({}),
  async execute() {
    throw new Error("boom on purpose")
  },
}

const responses = [
  {
    text: "calling the failing tool",
    toolCalls: [{ id: "call_fail_1", name: "always_fails", args: {} }],
    stopReason: "tool_calls",
  },
  {
    text: "I saw the error and I'm done",
    toolCalls: [],
    stopReason: "stop",
  },
]
let callIndex = 0
const seenRequests = []

const fakeProvider = {
  name: "tool-error-fake",
  async call(req) {
    seenRequests.push(req.messages)
    const response = responses[callIndex]
    callIndex++
    if (!response) throw new Error("tool-error-fake: out of scripted responses")
    return response
  },
}

const sessionId = "smoke-tool-error-001"
await runInvocation(sessionId, "make the tool fail", {
  provider: fakeProvider,
  tools: [failingTool],
  model: "fake-model",
  systemPrompt: "smoke tool error",
})

const events = await loadEvents(sessionId)
const eventTypes = events.map((e) => e.type)
console.log(`smoke-tool-error: events = ${JSON.stringify(eventTypes)}`)

const failedEvents = events.filter((e) => e.type === "tool.failed")
assert(failedEvents.length === 1, `expected 1 tool.failed event, got ${failedEvents.length}`)
assert(
  typeof failedEvents[0].error === "string" && failedEvents[0].error.includes("boom on purpose"),
  `tool.failed event should carry the underlying error message; got ${JSON.stringify(failedEvents[0].error)}`,
)

const completedEvents = events.filter((e) => e.type === "tool.completed")
assert(completedEvents.length === 0, "thrown tool should not produce a tool.completed event")

const messages = buildPrompt(events, [failingTool], {
  model: "fake-model",
  system: "smoke tool error",
}).messages
const errorEntries = messages.filter((m) => m.role === "tool")
assert(
  errorEntries.length === 1,
  `expected 1 tool error prompt message, got ${errorEntries.length}`,
)
assert(
  errorEntries[0].toolCallId === "call_fail_1" &&
    errorEntries[0].content.includes("boom on purpose"),
  "tool error message should carry the original call id and error text",
)

const secondRequestMessages = seenRequests[1]
assert(
  secondRequestMessages?.some(
    (m) =>
      m.role === "tool" &&
      m.toolCallId === "call_fail_1" &&
      (m.content ?? "").includes("boom on purpose"),
  ) === true,
  "second turn's prompt should include the failed tool's error as a tool message so the model can react",
)

assert(callIndex === responses.length, "both scripted responses should be consumed")

const finalAssistant = [...messages].reverse().find((m) => m.role === "assistant")
assert(
  finalAssistant?.content.includes("I saw the error") === true,
  "final assistant message should reflect the model getting a chance to respond after the error",
)

console.log("\nsmoke-tool-error: SUCCESS")
