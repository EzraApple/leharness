import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import { loadEvents, resolveSessionPath, runInvocation } from "../dist/index.js"

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

console.log("\nsmoke: SUCCESS")
