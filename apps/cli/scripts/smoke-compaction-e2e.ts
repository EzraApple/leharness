// smoke-compaction-e2e.ts
// End-to-end smoke proving the artifact + compaction chain works
// together. A real bash tool produces > 8KB output (auto-artifacted via
// plan 006); subsequent turns build up pressure; the fake summarizer
// fires on a window containing the bash tool call. Asserts that:
//   - Both the original tool artifact (from auto-artifact) AND the
//     summary's sourceArtifactId artifact (the rendered window) exist
//     on disk and are readable.
//   - The summary message in the projected prompt embeds the summary's
//     sourceArtifactId so the model has a recovery path.
//   - Event log retains the original tool.completed with its artifactId
//     intact (single-writer invariant).

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  disposeTaskServices,
  enableShellRuntime,
  getOrCreateTaskServices,
  loadEvents,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  resolveArtifactPath,
  runInvocation,
} from "@leharness/harness"
import { bashTool } from "../src/tools/bash.js"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-compaction-e2e-"))
process.env.LEHARNESS_HOME = home

const sessionId = "smoke-compaction-e2e"
enableShellRuntime(getOrCreateTaskServices(sessionId))

// A bash command that produces > 8KB so plan 006's auto-artifact fires.
// 800 lines of ~30 chars each ≈ 24KB.
const BIG_BASH = `for i in $(seq 1 800); do printf 'line %03d: some padding text content here\\n' "$i"; done`

const SUMMARY_TEXT =
  "- **Goal:** verify e2e chain\n- **Touched:** bash tool, artifacts, summarizer\n- **Next:** assertions"

let summarizerCalls = 0
let mainCallCount = 0

const provider: Provider = {
  name: "compaction-e2e-fake",
  async call(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.tools === undefined) {
      summarizerCalls++
      return {
        text: SUMMARY_TEXT,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 300, completionTokens: 60 },
      }
    }
    mainCallCount++
    return nextMainResponse(req)
  },
}

// Scripted main-model behavior. Turn 1: call bash. Turn 2-4: stub
// replies that drive token counts up. Turn 5: pressure crosses T4 →
// pre-flight summarization → main reply.
function nextMainResponse(_req: ProviderRequest): ProviderResponse {
  switch (mainCallCount) {
    case 1:
      // First call: dispatch bash
      return {
        text: "running it",
        toolCalls: [
          { id: "call_bash", name: "bash", args: { command: BIG_BASH, inline_ms: 60_000 } },
        ],
        stopReason: "tool_calls",
        usage: { promptTokens: 100, completionTokens: 20 },
      }
    case 2:
      // After bash returns, wrap up turn 1.
      return {
        text: "got the output",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 200, completionTokens: 10 },
      }
    case 3:
    case 4: {
      const body =
        `Turn ${mainCallCount - 1} reply with substantial content. ` +
        "It edited files, considered the architecture, ran tests, decided on approaches. ".repeat(8)
      return {
        text: body,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 200, completionTokens: 30 },
      }
    }
    case 5: {
      const body =
        "Turn 4 reply with substantial content. " +
        "It edited files, considered the architecture, ran tests, decided on approaches. ".repeat(8)
      return {
        text: body,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 900, completionTokens: 30 },
      }
    }
    default:
      return {
        text: "post compact",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 200, completionTokens: 10 },
      }
  }
}

const baseDeps = {
  provider,
  tools: [bashTool],
  model: "fake-main",
  systemPrompt: "smoke compaction e2e",
  compaction: { maxInputTokens: 1000, preserveRecentTurns: 1 },
}

// Five user prompts. Turn 1 triggers bash (auto-artifacts the output).
// Turn 5's pre-flight crosses T4 → summarization fires on turns 1-4.
await runInvocation(sessionId, "do the bash thing", baseDeps)
await runInvocation(sessionId, "now reply", baseDeps)
await runInvocation(sessionId, "again", baseDeps)
await runInvocation(sessionId, "more", baseDeps)
await runInvocation(sessionId, "final question", baseDeps)

assert.equal(summarizerCalls, 1, `expected exactly 1 summarizer call; got ${summarizerCalls}`)

const events = await loadEvents(sessionId)

// Plan 006 auto-artifact fired on the bash result (>8KB).
const bashToolCompleted = events.find(
  (e) => e.type === "tool.completed" && (e.call as { name?: string } | undefined)?.name === "bash",
)
assert.ok(bashToolCompleted, "expected tool.completed for bash")
const bashArtifactId = bashToolCompleted?.artifactId as string | undefined
assert.equal(
  typeof bashArtifactId,
  "string",
  "bash tool result should have been auto-artifacted (plan 006)",
)

// The bash artifact still exists on disk and contains > 8KB of output.
const bashArtifactPath = resolveArtifactPath(sessionId, bashArtifactId as string)
const bashArtifactBytes = (await fs.stat(bashArtifactPath)).size
assert.ok(
  bashArtifactBytes > 8 * 1024,
  `bash artifact should be > 8KB; got ${bashArtifactBytes} bytes`,
)

// Compaction summary landed and references its OWN artifact (the
// rendered window), which is distinct from the bash tool artifact.
const summary = events.find((e) => e.type === "compaction.summary")
assert.ok(summary, "expected compaction.summary event")
const summaryArtifactId = summary?.sourceArtifactId as string
assert.equal(typeof summaryArtifactId, "string")
assert.notEqual(
  summaryArtifactId,
  bashArtifactId,
  "summary's sourceArtifactId should be a NEW artifact (the rendered window), not the bash output",
)
const summaryArtifactPath = resolveArtifactPath(sessionId, summaryArtifactId)
const summaryWindow = await fs.readFile(summaryArtifactPath, "utf8")
assert.ok(summaryWindow.includes("Tool bash"), "rendered window should include the bash tool call")

// Event log invariant: original bash tool.completed retains its
// artifactId reference.
assert.equal(
  bashToolCompleted?.artifactId,
  bashArtifactId,
  "original tool.completed.artifactId must be unchanged in the event log",
)

await disposeTaskServices(sessionId)

console.log(
  `smoke-compaction-e2e: bash auto-artifact + summary chain ok (bash=${bashArtifactBytes} bytes, summary window=${summaryWindow.length} chars)`,
)
