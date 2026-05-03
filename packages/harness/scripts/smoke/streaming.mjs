import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runInvocation } from "../../dist/index.js"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-stream-"))
process.env.LEHARNESS_HOME = tmp

const tokenChunks = ["Hel", "lo", " wor", "ld!"]

const streamingProvider = {
  name: "stream-fake",
  async call(req) {
    if (!req.onText) throw new Error("expected onText to be wired through")
    for (const chunk of tokenChunks) {
      req.onText(chunk)
    }
    return {
      text: tokenChunks.join(""),
      toolCalls: [],
      stopReason: "stop",
    }
  },
}

const seenDeltas = []
const seenEvents = []

const events = await runInvocation(
  "smoke-stream-001",
  "say hello",
  { provider: streamingProvider, tools: [], model: "fake", systemPrompt: "test" },
  {
    onText: (delta) => seenDeltas.push(delta),
    onEvent: (event) => seenEvents.push(event.type),
  },
)

console.log(`smoke-streaming: deltas seen = ${JSON.stringify(seenDeltas)}`)
console.log(`smoke-streaming: events seen = ${JSON.stringify(seenEvents)}`)
console.log(`smoke-streaming: persisted events = ${events.length}`)

if (seenDeltas.join("") !== "Hello world!") {
  console.error("FAIL: onText did not receive the expected deltas")
  process.exit(1)
}
if (!seenEvents.includes("invocation.received") || !seenEvents.includes("agent.finished")) {
  console.error("FAIL: onEvent missed required event types")
  process.exit(1)
}

console.log("\nsmoke-streaming: SUCCESS")
