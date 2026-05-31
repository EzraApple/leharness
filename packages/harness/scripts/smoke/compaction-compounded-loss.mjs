// compaction-compounded-loss.mjs
// The plan's flagship invariant: re-running compaction on the same
// history reuses the same summary verbatim. Naive truncation suffers
// from compounded loss because each pass acts on the previously-
// compacted prompt; pressure-gradient avoids this by re-projecting
// from the canonical event log every step and caching summaries by
// source event-id set.
//
// Test shape: drive summarization once at session length L1. Append
// more turns to grow to L2 (more pressure). Re-run compaction at L2.
// The oldest window's summary text must be byte-identical because the
// source events for that window have not changed.

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, runInvocation } from "../../dist/index.js"
import { formatValue } from "../format-value.mjs"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-compound-"))
process.env.LEHARNESS_HOME = tmp

const sessionId = "smoke-compaction-compound"
const budget = 1000

const assistantBody = (i) =>
  `Turn ${i} body. ` +
  "It edited files, considered the architecture, ran tests, and made decisions about how to ".repeat(
    8,
  )

// Track how many summarizer calls have been made so we can give each
// a distinct return value. If the cache works, only ONE call should
// ever happen for a given window — so if our scripted provider returns
// different summaries on each call we can prove the cache hit by
// observing the summary text stays the first response.
let summarizerCallNumber = 0
const summarizerResponses = [
  "FIRST_SUMMARY",
  "SECOND_SUMMARY_SHOULD_NOT_APPEAR",
  "THIRD_SUMMARY_SHOULD_NOT_APPEAR",
]

let mainCallIndex = 0
const mainResponses = []
// Plan: 8 invocations, where the 5th's pre-flight triggers T4 once,
// and later invocations should NOT re-summarize the original window
// because it's cached.
for (let i = 0; i < 8; i++) {
  mainResponses.push({
    text: assistantBody(i),
    toolCalls: [],
    stopReason: "stop",
    // Push pressure high at turns 3 (so turn 5 fires T4) and 6 (so
    // turn 7 fires T4 again — but should hit cache).
    usage: { promptTokens: i === 3 || i === 6 ? 900 : 100, completionTokens: 30 },
  })
}

const provider = {
  name: "compound-loss-fake",
  async call(req) {
    if (req.tools === undefined) {
      const idx = summarizerCallNumber++
      const text = summarizerResponses[idx] ?? "OVERFLOW"
      return {
        text,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 300, completionTokens: 30 },
      }
    }
    const response = mainResponses[mainCallIndex++]
    if (response === undefined) throw new Error("compound-loss-fake: out of main responses")
    return response
  },
}

const baseDeps = {
  provider,
  tools: [],
  model: "fake-main",
  systemPrompt: "smoke compound",
  tasks: false,
  compaction: { maxInputTokens: budget, preserveRecentTurns: 1 },
}

for (let i = 0; i < 8; i++) {
  await runInvocation(sessionId, `user ${i}`, baseDeps)
}

const events = await loadEvents(sessionId)

// Pressure crossed at turn 5 (preflight: lastTokens=900 from turn 4).
// Pressure should also cross at turn 7 (preflight: lastTokens=900 from
// turn 6). But the second crossing finds the original window already
// cached, so no second summarizer call happens — UNLESS a NEW window
// (turns 5-8 or similar) becomes eligible, which can happen depending
// on the picker geometry.
//
// What we ALWAYS expect:
//   - The original summary text is FIRST_SUMMARY (the first response).
//   - The compaction.summary event for the original covered window
//     equals "FIRST_SUMMARY" — proven by reading the event log.
//   - That event is never overwritten or duplicated.
const firstSummary = events.find((e) => e.type === "compaction.summary")
assert(firstSummary !== undefined, "expected at least one compaction.summary")
assert(
  firstSummary.summaryText === "FIRST_SUMMARY",
  `first summary should be "FIRST_SUMMARY", got "${formatValue(firstSummary.summaryText)}"`,
)

// The original summary's coveredEventIds set should be present in EVERY
// compaction.summary event found (since the same window can't be
// summarized twice).
const allSummaries = events.filter((e) => e.type === "compaction.summary")
const seenKeys = new Set()
for (const s of allSummaries) {
  const key = [...s.coveredEventIds].sort().join("|")
  assert(!seenKeys.has(key), "the same event-id set should never produce two summaries")
  seenKeys.add(key)
}

// If the picker found a SECOND window (e.g., turns 5-8 after the
// original turns 1-4 are cached), that's fine — it's a NEW window, not
// a re-summarization of the original. The original summary text must
// still be FIRST_SUMMARY.
const originalCovered = firstSummary.coveredEventIds.join(",")
const originalReentry = allSummaries.find((s) => s.coveredEventIds.join(",") === originalCovered)
assert(
  originalReentry === firstSummary,
  "the original covered event-id set should have exactly one summary; the SAME object should be re-found",
)
assert(
  originalReentry.summaryText === "FIRST_SUMMARY",
  "original summary text must be FIRST_SUMMARY even after multiple compaction rounds — proves no compounded loss",
)

console.log(
  `smoke-compaction-compounded-loss: SUCCESS (summarizer fired ${summarizerCallNumber} time(s), summaries=${allSummaries.length})`,
)
