import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import { loadEvents, resolveSessionPath, runInvocation } from "../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-"))
process.env.LEHARNESS_HOME = tmp
console.log(`smoke: LEHARNESS_HOME = ${tmp}`)

const fakeTool = {
  name: "echo",
  description: "Return whatever you give it.",
  schema: z.object({ msg: z.string() }),
  async execute(args) {
    return { kind: "ok", output: `echoed: ${args.msg}` }
  },
}

const tools = [fakeTool]

const scriptedResponses = [
  {
    text: "I will use the echo tool first.",
    toolCalls: [{ id: "call_1", name: "echo", args: { msg: "hello world" } }],
    stopReason: "tool_calls",
    usage: { promptTokens: 10, completionTokens: 5 },
  },
  {
    text: "All done. The echo tool returned what I sent.",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 25, completionTokens: 12 },
  },
]
let callIndex = 0

const fakeProvider = {
  name: "fake",
  async call(_request) {
    const response = scriptedResponses[callIndex]
    callIndex++
    if (!response) throw new Error("FakeProvider: out of scripted responses")
    return response
  },
}

const sessionId = "smoke-001"
const deps = {
  provider: fakeProvider,
  tools,
  model: "fake-model",
  systemPrompt: "You are a smoke test.",
}

console.log("smoke: running invocation 1")
const transcript = await runInvocation(sessionId, "Please echo hello world", deps)

console.log("smoke: invocation 1 transcript")
for (const entry of transcript) {
  console.log(`  ${entry.kind}:`, JSON.stringify(entry).slice(0, 120))
}

const jsonlPath = resolveSessionPath(sessionId)
console.log(`smoke: jsonl path = ${jsonlPath}`)
const jsonlStat = await fs.stat(jsonlPath)
console.log(`smoke: jsonl size = ${jsonlStat.size} bytes`)

const raw = await fs.readFile(jsonlPath, "utf8")
const lines = raw.split("\n").filter((l) => l.length > 0)
console.log(`smoke: ${lines.length} jsonl lines`)
for (const line of lines) {
  const event = JSON.parse(line)
  console.log(`  ${event.type.padEnd(22)} v=${event.v} id=${event.id.slice(0, 10)}…`)
}

const events = await loadEvents(sessionId)
console.log(`smoke: loadEvents returned ${events.length} events`)

const directoryExists = await fs
  .stat(path.join(tmp, "sessions", sessionId))
  .then(() => true)
  .catch(() => false)
console.log(`smoke: session directory exists = ${directoryExists}`)

assert(directoryExists, "session directory should exist on disk")
assert(events.length === lines.length, "loadEvents count should match jsonl line count")
assert(callIndex === scriptedResponses.length, "all scripted provider responses should be consumed")

const expectedEventTypes = [
  "invocation.received",
  "step.started",
  "model.completed",
  "tool.completed",
  "step.started",
  "model.completed",
  "agent.finished",
]
const actualEventTypes = events.map((e) => e.type)
assert(
  JSON.stringify(actualEventTypes) === JSON.stringify(expectedEventTypes),
  `event types mismatch:\n  expected: ${JSON.stringify(expectedEventTypes)}\n  actual:   ${JSON.stringify(actualEventTypes)}`,
)

const transcriptKinds = transcript.map((e) => e.kind)
assert(
  transcriptKinds.includes("user") &&
    transcriptKinds.includes("assistant") &&
    transcriptKinds.includes("tool_result"),
  `transcript should contain user, assistant, and tool_result entries; got ${JSON.stringify(transcriptKinds)}`,
)

const finalAssistant = [...transcript].reverse().find((e) => e.kind === "assistant")
assert(
  finalAssistant?.text.includes("All done") === true,
  "final assistant entry should contain the scripted final text",
)

console.log("\nsmoke: SUCCESS")
