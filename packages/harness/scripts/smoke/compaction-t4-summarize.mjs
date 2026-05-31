// compaction-t4-summarize.mjs
// Drive pressure across T4 (>= 0.85) with enough turn history that
// the M=4 window picker has a non-empty candidate. Asserts that:
//   - A compaction.started event fires (so TUI can flip to "compacting…")
//   - The summarizer call uses a distinct system prompt (no tools)
//   - A compaction.summary event lands with coveredEventIds,
//     sourceArtifactId, summaryText, generatedByModel
//   - The full window is stashed at sourceArtifactId on disk
//   - The projected prompt replaces the covered events with a single
//     synthetic user message containing the summary + framing line

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, resolveArtifactPath, runInvocation } from "../../dist/index.js"
import { formatValue } from "../format-value.mjs"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-t4-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-t4"
const budget = 1000

// Build 5 turns of history. Each turn's assistant body is comfortably
// over the per-event 500-char render cap so after rendering the window
// is > 2KB (the summarize_min_window threshold). Each rendered turn
// will be ~500 chars; 4 turns ≈ 2KB+separators ≈ comfortably over 2KB.
const assistantBody = (turnIndex) =>
  `Turn ${turnIndex} assistant response — the agent did meaningful work here. ` +
  "It edited files, considered the architecture, ran tests, and made decisions about how to ".repeat(
    8,
  )

const responses = []
for (let i = 0; i < 4; i++) {
  responses.push({
    text: assistantBody(i),
    toolCalls: [],
    stopReason: "stop",
    // First three turns: low usage; turn 4 reports a high promptTokens
    // so the *fifth* invocation's pre-flight sees pressure 0.90 (T4).
    usage: { promptTokens: i === 3 ? 900 : 100, completionTokens: 50 },
  })
}
// Fifth turn's response (after compaction has fired).
responses.push({
  text: "answered with compacted context",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 200, completionTokens: 10 },
})

// Summary text the scripted provider returns when the summarizer call
// fires. Identified by `req.tools === undefined` (summarizer doesn't
// include tools).
const SUMMARY_TEXT =
  "- **Goal:** stand in for the user's real goal in the test\n" +
  "- **Touched:** smoke harness, pressure gradient\n" +
  "- **Decisions:** trust the test\n" +
  "- **Next:** assert the right events land"

const seenRequests = []
let mainCallIndex = 0
let summarizerCallCount = 0

const provider = {
  name: "compaction-t4-fake",
  async call(req) {
    seenRequests.push(req)
    if (req.tools === undefined) {
      summarizerCallCount++
      return {
        text: SUMMARY_TEXT,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 400, completionTokens: 120 },
      }
    }
    const response = responses[mainCallIndex++]
    if (response === undefined) throw new Error("t4-fake: out of main responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [],
  model: "fake-main",
  systemPrompt: "smoke t4",
  tasks: false,
  // 5 turns total, preserve the last turn so the M=4 picker can take
  // turns 0..3 as the window.
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

for (let i = 0; i < 5; i++) {
  await runInvocation(sessionId, `user message ${i}`, baseDeps)
}

const events = await loadEvents(sessionId)

assert(summarizerCallCount === 1, `expected exactly 1 summarizer call, got ${summarizerCallCount}`)

const started = events.find((e) => e.type === "compaction.started")
assert(started !== undefined, "expected compaction.started event")
assert(
  started.phase === "summarizing" && started.windowCount === 1,
  `unexpected compaction.started payload: ${JSON.stringify(started)}`,
)

const summary = events.find((e) => e.type === "compaction.summary")
assert(summary !== undefined, "expected compaction.summary event")
assert(
  Array.isArray(summary.coveredEventIds) && summary.coveredEventIds.length >= 4,
  `coveredEventIds should be non-trivial; got ${formatValue(summary.coveredEventIds)}`,
)
assert(
  typeof summary.sourceArtifactId === "string" && summary.sourceArtifactId.startsWith("artifact_"),
  `sourceArtifactId looks wrong: ${formatValue(summary.sourceArtifactId)}`,
)
assert(summary.summaryText === SUMMARY_TEXT, "summaryText should match the scripted return")
assert(
  summary.generatedByModel === "fake-main",
  `unexpected summarizer model: ${formatValue(summary.generatedByModel)}`,
)

// The full window is on disk under sourceArtifactId.
const windowPath = resolveArtifactPath(sessionId, summary.sourceArtifactId)
const windowOnDisk = await fs.readFile(windowPath, "utf8")
assert(
  windowOnDisk.length >= 2 * 1024,
  `window artifact should be > 2KB, got ${windowOnDisk.length}`,
)
assert(
  windowOnDisk.includes("user message 0"),
  "window should include the first turn's user message",
)
assert(
  windowOnDisk.includes("Turn 0 assistant response"),
  "window should include the first turn's assistant body",
)

const completed = events.find((e) => e.type === "compaction.completed")
assert(completed !== undefined, "expected compaction.completed")
assert(
  completed.watermarksCrossed.includes("summarize_one_window"),
  `expected summarize_one_window watermark, got ${formatValue(completed.watermarksCrossed)}`,
)
assert(
  completed.summarizedWindowCount === 1,
  `expected summarizedWindowCount=1, got ${formatValue(completed.summarizedWindowCount)}`,
)

// The 5th main provider request (the one after compaction) should have
// the synthetic summary message in place of the original 4 turns.
const fifthMainRequest = seenRequests.filter((r) => r.tools !== undefined).slice(-1)[0]
assert(fifthMainRequest !== undefined, "expected fifth main request")
const userMessages = fifthMainRequest.messages.filter((m) => m.role === "user")
const summaryMsg = userMessages.find((m) =>
  m.content.startsWith("[Earlier work — full transcript at "),
)
assert(
  summaryMsg !== undefined,
  "expected the synthetic summary user message in the projected prompt",
)
assert(
  summaryMsg.content.includes(summary.sourceArtifactId),
  "summary message should embed the artifact id",
)
assert(
  summaryMsg.content.includes("Current focus appears to be:"),
  "summary message should include relevance overlay",
)
assert(
  summaryMsg.content.includes(SUMMARY_TEXT),
  "summary message should embed the canned summaryText",
)

// The original 4 turns should NOT be in the prompt anymore.
const oldUserMsg = userMessages.find((m) => m.content === "user message 0")
assert(oldUserMsg === undefined, "the oldest user message should have been replaced by the summary")

// Event log invariant: the original events are still in the log
// (single-writer rule). We can confirm by counting invocation.received
// events — there should be 5.
const userInvocations = events.filter((e) => e.type === "invocation.received")
assert(
  userInvocations.length === 5,
  `expected 5 invocation.received in the log, got ${userInvocations.length}`,
)

console.log("smoke-compaction-t4: SUCCESS")
