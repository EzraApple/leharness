// compaction-t3-tool-bodies.mjs
// Drive pressure across T3 (>= 0.75) and assert that older tool result
// bodies are replaced with a tombstone in the projected prompt. Uses a
// small inline tool result (under T2's 1KB promotion threshold) so we
// can isolate T3 from T2 — only T1 + T3 should fire on this tool.

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import { loadEvents, runInvocation } from "../../dist/index.js"
import { formatValue } from "../format-value.mjs"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-t3-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-t3"
const budget = 1000
const promptTokensForStep1 = 800 // 800/1000 = 0.80 → T1+T2+T3 thresholds met

const smallResult = "hello world result text"

const smallEchoTool = {
  name: "echo_small",
  description: "Return a tiny string.",
  schema: z.object({}),
  async execute() {
    return { kind: "ok", output: smallResult }
  },
}

const seenRequests = []
let callIndex = 0
const responses = [
  {
    text: "calling",
    toolCalls: [{ id: "call_a", name: "echo_small", args: {} }],
    stopReason: "tool_calls",
    usage: { promptTokens: 80, completionTokens: 5 },
  },
  {
    text: "done",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: promptTokensForStep1, completionTokens: 5 },
  },
  {
    text: "ok",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 80, completionTokens: 5 },
  },
]
const provider = {
  name: "compaction-t3-fake",
  async call(req) {
    seenRequests.push(req)
    const response = responses[callIndex++]
    if (response === undefined) throw new Error("t3-fake: out of scripted responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [smallEchoTool],
  model: "fake-model",
  systemPrompt: "smoke t3",
  tasks: false,
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

await runInvocation(sessionId, "go", baseDeps)
await runInvocation(sessionId, "again", baseDeps)

assert(
  callIndex === responses.length,
  `expected ${responses.length} provider calls, got ${callIndex}`,
)

const events = await loadEvents(sessionId)
const compactionCompleted = events.find((e) => e.type === "compaction.completed")
assert(compactionCompleted !== undefined, "expected a compaction.completed event")
assert(
  compactionCompleted.watermarksCrossed.includes("drop_old_tool_bodies"),
  `expected drop_old_tool_bodies watermark, got ${formatValue(compactionCompleted.watermarksCrossed)}`,
)
assert(
  !compactionCompleted.watermarksCrossed.includes("promote_inline_results"),
  "T2 should not have fired on a sub-1KB inline result",
)
assert(
  compactionCompleted.droppedToolBodyCount === 1,
  `expected 1 dropped tool body, got ${formatValue(compactionCompleted.droppedToolBodyCount)}`,
)

// Projected prompt should have the tombstone in place of the original
// (small) tool result body.
const secondInvocationRequest = seenRequests[2]
const toolMessage = secondInvocationRequest.messages.find(
  (m) => m.role === "tool" && m.toolCallId === "call_a",
)
assert(toolMessage !== undefined, "expected tool message in second-invocation prompt")
assert(
  toolMessage.content === "[tool result dropped during compaction]",
  `expected tombstone, got "${toolMessage.content}"`,
)

// Original tool.completed event still has the full result inline.
const original = events.find((e) => e.type === "tool.completed" && e.call?.id === "call_a")
assert(original?.result === smallResult, "original tool.completed.result must be untouched")

// The assistant's tool-call narrative (toolCalls on the model.completed)
// should still be present so the thread of reasoning is intact.
const olderAssistant = secondInvocationRequest.messages.find(
  (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
)
assert(olderAssistant !== undefined, "older assistant message with toolCalls should survive")
assert(
  olderAssistant.toolCalls.some((c) => c.id === "call_a"),
  "toolCalls should still reference call_a",
)

console.log("smoke-compaction-t3: SUCCESS")
