import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, runInvocation } from "../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-resume-"))
process.env.LEHARNESS_HOME = tmp

const responses = [
  { text: "first turn done", toolCalls: [], stopReason: "stop" },
  { text: "second turn sees prior history", toolCalls: [], stopReason: "stop" },
]
let callIndex = 0
const seenRequests = []

const fakeProvider = {
  name: "resume-fake",
  async call(req) {
    seenRequests.push(req.messages)
    const response = responses[callIndex]
    callIndex++
    if (!response) throw new Error("resume-fake: out of scripted responses")
    return response
  },
}

const sessionId = "smoke-resume-001"
const deps = {
  provider: fakeProvider,
  tools: [],
  model: "fake-model",
  systemPrompt: "smoke resume",
}

const transcript1 = await runInvocation(sessionId, "first prompt", deps)
const transcript2 = await runInvocation(sessionId, "second prompt", deps)

const events = await loadEvents(sessionId)
const eventTypes = events.map((e) => e.type)

console.log(`smoke-resume: events after two invocations = ${JSON.stringify(eventTypes)}`)
console.log(`smoke-resume: transcript1 length = ${transcript1.length}`)
console.log(`smoke-resume: transcript2 length = ${transcript2.length}`)

assert(
  callIndex === responses.length,
  "both scripted responses should be consumed across invocations",
)

const invocationsReceived = events.filter((e) => e.type === "invocation.received")
assert(
  invocationsReceived.length === 2 &&
    invocationsReceived[0].text === "first prompt" &&
    invocationsReceived[1].text === "second prompt",
  "event log should contain both user invocations in order",
)

const finishedCount = events.filter((e) => e.type === "agent.finished").length
assert(
  finishedCount === 2,
  `expected 2 agent.finished events across invocations, got ${finishedCount}`,
)

assert(
  transcript2.length > transcript1.length,
  `second transcript should include first invocation's history; got ${transcript1.length} -> ${transcript2.length}`,
)

const userTurnsInTranscript2 = transcript2.filter((e) => e.kind === "user")
assert(
  userTurnsInTranscript2.length === 2 &&
    userTurnsInTranscript2[0].text === "first prompt" &&
    userTurnsInTranscript2[1].text === "second prompt",
  "resumed transcript should replay both user turns in order",
)

const secondRequestMessages = seenRequests[1]
assert(
  secondRequestMessages?.some(
    (m) => m.role === "user" && (m.content ?? "").includes("first prompt"),
  ) === true,
  "second invocation's prompt should include the first user turn (history replay through to the model)",
)

console.log("\nsmoke-resume: SUCCESS")
