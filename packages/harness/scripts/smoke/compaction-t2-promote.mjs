// compaction-t2-promote.mjs
// Drive pressure across the T2 watermark (>= 0.65) with a prior turn
// whose tool.completed carries an inline result over 1KB. Assert that
// pressure-gradient retroactively writes the result to an artifact,
// records artifact.created + compaction.tool_promoted, and replaces
// the projected tool message content with the artifact stub. Original
// event log retains the full result (single-writer invariant).

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { z } from "zod"
import { loadEvents, resolveArtifactPath, runInvocation } from "../../dist/index.js"
import { formatValue } from "../format-value.mjs"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-t2-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-t2"
const budget = 1000
// Pressure ratio for step 2 = 700 / 1000 = 0.70 → crosses T1 (0.50) and T2 (0.65).
const promptTokensForStep1 = 700

// A 2KB inline tool result — big enough to trigger T2's promotion threshold.
const bigResult = "X".repeat(2 * 1024)

// Echo tool that returns the canned 2KB body.
const echoTool = {
  name: "echo_big",
  description: "Return a fixed 2KB string.",
  schema: z.object({}),
  async execute() {
    return { kind: "ok", output: bigResult }
  },
}

const seenRequests = []
let callIndex = 0

const responses = [
  // Step 1 — model decides to call the echo tool.
  {
    text: "calling the tool",
    toolCalls: [{ id: "call_1", name: "echo_big", args: {} }],
    stopReason: "tool_calls",
    usage: { promptTokens: 100, completionTokens: 10 },
  },
  // Step 1 — model wraps up with the result inline.
  {
    text: "got the result",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: promptTokensForStep1, completionTokens: 10 },
  },
  // Step 2 — pre-flight compaction fires; this is the new invocation's
  // model call after T1+T2 have applied.
  {
    text: "done",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 100, completionTokens: 5 },
  },
]

const provider = {
  name: "compaction-t2-fake",
  async call(req) {
    seenRequests.push(req)
    const response = responses[callIndex++]
    if (response === undefined) throw new Error("t2-fake: out of scripted responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [echoTool],
  model: "fake-model",
  systemPrompt: "smoke t2",
  tasks: false,
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

await runInvocation(sessionId, "do the thing", baseDeps)
await runInvocation(sessionId, "and another", baseDeps)

assert(
  callIndex === responses.length,
  `expected ${responses.length} provider calls, got ${callIndex}`,
)

const events = await loadEvents(sessionId)
const compactionCompleted = events.find((e) => e.type === "compaction.completed")
assert(compactionCompleted !== undefined, "expected a compaction.completed event")
assert(
  compactionCompleted.watermarksCrossed.includes("promote_inline_results"),
  `expected promote_inline_results watermark, got ${formatValue(compactionCompleted.watermarksCrossed)}`,
)
assert(
  compactionCompleted.promotedInlineCount === 1,
  `expected 1 promoted, got ${formatValue(compactionCompleted.promotedInlineCount)}`,
)

const promoted = events.find((e) => e.type === "compaction.tool_promoted")
assert(promoted !== undefined, "expected a compaction.tool_promoted event")
assert(
  promoted.sourceCallId === "call_1",
  `unexpected sourceCallId: ${formatValue(promoted.sourceCallId)}`,
)
assert(typeof promoted.artifactId === "string", "promoted should have an artifactId")

const artifactCreated = events.find(
  (e) => e.type === "artifact.created" && e.sourceCallId === "call_1",
)
assert(artifactCreated !== undefined, "expected an artifact.created event for call_1")
assert(
  artifactCreated.byteCount === bigResult.length,
  `byteCount mismatch: ${formatValue(artifactCreated.byteCount)} vs ${bigResult.length}`,
)

// On-disk artifact matches the original byte-for-byte.
const artifactPath = resolveArtifactPath(sessionId, artifactCreated.id)
const onDisk = await fs.readFile(artifactPath, "utf8")
assert(onDisk === bigResult, "promoted artifact content should equal the original tool result")

// Projected prompt on step 2 should have the artifact stub in place of
// the original 2KB body.
const secondInvocationRequest = seenRequests[2]
assert(secondInvocationRequest !== undefined, "expected a 3rd provider request (step 2 model call)")
const toolMessage = secondInvocationRequest.messages.find(
  (m) => m.role === "tool" && m.toolCallId === "call_1",
)
assert(toolMessage !== undefined, "expected the tool message for call_1 in the projected prompt")
assert(
  toolMessage.content.length < bigResult.length,
  `tool message should be replaced with a stub (was ${toolMessage.content.length} chars, original ${bigResult.length})`,
)
assert(
  toolMessage.content.startsWith("[artifact:"),
  `tool message should start with [artifact: stub; got "${toolMessage.content.slice(0, 60)}"`,
)
assert(toolMessage.content.includes(artifactCreated.id), "stub should reference the artifact id")

// Event log invariant: original tool.completed retains its full result.
const originalToolCompleted = events.find(
  (e) => e.type === "tool.completed" && e.call?.id === "call_1",
)
assert(
  typeof originalToolCompleted?.result === "string" &&
    originalToolCompleted.result.length === bigResult.length,
  "original tool.completed.result should be unchanged in the event log",
)

console.log("smoke-compaction-t2: SUCCESS")
