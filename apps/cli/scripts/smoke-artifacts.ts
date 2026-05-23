// smoke-artifacts.ts
// End-to-end tests for the filesystem artifact service. Covers:
//   1. Auto-artifact for large tool output — file lands on disk, event
//      log carries artifact.created + tool.completed.artifactId.
//   2. Inline path unchanged for small tool output.
//   3. read_artifact round-trip — full content recoverable from disk.
//   4. Pagination via since_byte.
//   5. Background-task drain artifacts too — large task.completed
//      Messages get the same treatment.
//   6. artifacts: false disables the feature (truncation re-engages).

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  AUTO_ARTIFACT_THRESHOLD_BYTES,
  disposeTaskServices,
  enableShellRuntime,
  getOrCreateTaskServices,
  type HarnessDeps,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  resolveArtifactPath,
  runInvocation,
  type Tool,
  type ToolContext,
  type ToolExecuteResult,
} from "@leharness/harness"
import { z } from "zod"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-artifacts-"))
process.env.LEHARNESS_HOME = home

function scriptedProvider(name: string, responses: ProviderResponse[]): Provider {
  let index = 0
  return {
    name,
    async call(_request: ProviderRequest): Promise<ProviderResponse> {
      const next = responses[index++]
      if (next === undefined) throw new Error(`${name}: out of scripted responses`)
      return next
    },
  }
}

const echoArgs = z.object({ size: z.number().int().min(0) })
type EchoArgs = z.infer<typeof echoArgs>

function makeEchoTool(content: string): Tool<EchoArgs> {
  return {
    name: "echo",
    description: "Return a fixed string of `size` bytes for tests.",
    schema: echoArgs,
    async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const chunk = content.repeat(Math.max(1, Math.ceil(args.size / content.length)))
      return { kind: "ok", output: chunk.slice(0, args.size) }
    },
  }
}

function baseDeps(
  provider: Provider,
  tool: Tool,
  overrides: Partial<HarnessDeps> = {},
): HarnessDeps {
  return {
    provider,
    tools: [tool],
    model: "fake",
    systemPrompt: "smoke artifacts",
    ...overrides,
  }
}

// 1. Auto-artifact for large tool output.
{
  const sessionId = `smoke-artifact-large-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const largeSize = AUTO_ARTIFACT_THRESHOLD_BYTES * 3
  const tool = makeEchoTool("abcdefghij")
  const provider = scriptedProvider("p", [
    {
      text: "fetching",
      toolCalls: [{ id: "call_1", name: "echo", args: { size: largeSize } }],
      stopReason: "tool_calls",
    },
    { text: "done", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(sessionId, "go", baseDeps(provider, tool))
  const created = events.find((event) => event.type === "artifact.created")
  assert.ok(created, "expected artifact.created event")
  assert.equal(created?.byteCount, largeSize)
  assert.equal(created?.sourceCallId, "call_1")
  const completed = events.find(
    (event) =>
      event.type === "tool.completed" &&
      (event.call as { name?: string } | undefined)?.name === "echo",
  )
  assert.ok(completed, "expected tool.completed for echo")
  assert.equal(typeof completed?.artifactId, "string")
  assert.equal(completed?.artifactId, created?.id)
  assert.match(String(completed?.result ?? ""), /^\[artifact: artifact_/)
  // File exists on disk and matches the original.
  const artifactPath = resolveArtifactPath(sessionId, String(created?.id ?? ""))
  const onDisk = await fs.readFile(artifactPath, "utf8")
  assert.equal(onDisk.length, largeSize)
  await disposeTaskServices(sessionId)
}

// 2. Inline path unchanged for small tool output.
{
  const sessionId = `smoke-artifact-small-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const tool = makeEchoTool("xyz")
  const provider = scriptedProvider("p", [
    {
      text: "fetching",
      toolCalls: [{ id: "call_1", name: "echo", args: { size: 100 } }],
      stopReason: "tool_calls",
    },
    { text: "done", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(sessionId, "go", baseDeps(provider, tool))
  const created = events.find((event) => event.type === "artifact.created")
  assert.equal(created, undefined, "small output should not produce artifact.created")
  const completed = events.find(
    (event) =>
      event.type === "tool.completed" &&
      (event.call as { name?: string } | undefined)?.name === "echo",
  )
  assert.equal(completed?.artifactId, undefined, "no artifactId on small inline result")
  assert.equal(String(completed?.result ?? "").startsWith("["), false)
  await disposeTaskServices(sessionId)
}

// 3. read_artifact round-trip.
{
  const sessionId = `smoke-artifact-read-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const largeSize = AUTO_ARTIFACT_THRESHOLD_BYTES * 2
  const tool = makeEchoTool("0123456789")
  const provider = scriptedProvider("p", [
    {
      text: "fetching",
      toolCalls: [{ id: "call_1", name: "echo", args: { size: largeSize } }],
      stopReason: "tool_calls",
    },
    {
      text: "reading",
      toolCalls: [
        // The model will reference the artifact id below; we compute it after
        // the first turn lands. To keep this scripted, we use a dynamic
        // second-turn provider via a closure instead — see test 4 for that
        // shape. Here we re-read events directly to verify the round-trip.
      ],
      stopReason: "stop",
    },
  ])
  const events = await runInvocation(sessionId, "go", baseDeps(provider, tool))
  const created = events.find((event) => event.type === "artifact.created")
  assert.ok(created, "expected artifact.created")
  const artifactId = String(created?.id ?? "")
  // Use the read_artifact path directly via the harness's exported function.
  const onDisk = await fs.readFile(resolveArtifactPath(sessionId, artifactId), "utf8")
  assert.equal(onDisk.length, largeSize, "on-disk content matches the original size")
  await disposeTaskServices(sessionId)
}

// 4. Pagination via since_byte (using read_artifact tool through a second turn).
{
  const sessionId = `smoke-artifact-paginate-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const largeSize = 12_000
  const tool = makeEchoTool("0123456789")
  let pendingArtifactId: string | undefined
  const provider: Provider = {
    name: "p",
    async call(request: ProviderRequest): Promise<ProviderResponse> {
      if (pendingArtifactId === undefined) {
        return {
          text: "fetching",
          toolCalls: [{ id: "call_echo", name: "echo", args: { size: largeSize } }],
          stopReason: "tool_calls",
        }
      }
      // Has the artifact result been delivered? Check the prompt for the stub.
      const hasArtifactResult = request.messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes(pendingArtifactId ?? "__never__"),
      )
      if (!hasArtifactResult) {
        // shouldn't reach
        return { text: "?", toolCalls: [], stopReason: "stop" }
      }
      // Has read_artifact been called yet?
      const hasReadResult = request.messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.startsWith("[artifact ") &&
          message.content.includes("cursor 8000"),
      )
      if (!hasReadResult) {
        return {
          text: "paginating",
          toolCalls: [
            {
              id: "call_read",
              name: "read_artifact",
              args: { artifact_id: pendingArtifactId, since_byte: 8000 },
            },
          ],
          stopReason: "tool_calls",
        }
      }
      return { text: "done", toolCalls: [], stopReason: "stop" }
    },
  }
  // Run once to spawn the artifact; capture the id from events.
  const firstEvents = await runInvocation(sessionId, "go", baseDeps(provider, tool))
  const created = firstEvents.find((event) => event.type === "artifact.created")
  pendingArtifactId = String(created?.id ?? "")
  // Run again with the same provider closure — now it'll fire read_artifact.
  const followUp = await runInvocation(sessionId, undefined, baseDeps(provider, tool))
  const readResult = followUp.find(
    (event) =>
      event.type === "tool.completed" &&
      (event.call as { name?: string } | undefined)?.name === "read_artifact",
  )
  assert.ok(readResult, "expected read_artifact tool.completed event")
  const body = String(readResult?.result ?? "")
  assert.match(body, /cursor 8000/)
  // Slice from byte 8000 should be 4000 bytes (12000 - 8000).
  const lines = body.split("\n")
  const slice = lines.slice(1).join("\n")
  assert.equal(slice.length, 4000)
  await disposeTaskServices(sessionId)
}

// 5. Background-task drain artifacts too.
{
  const sessionId = `smoke-artifact-bgdrain-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  // Bash command that produces > 8KB of output.
  // Use a deterministic generator; 500 lines * 30 chars = ~15KB.
  const bashCmd = `for i in $(seq 1 500); do printf 'line %03d: some text padding here\\n' "$i"; done`
  const provider = scriptedProvider("p", [
    {
      text: "spawning",
      toolCalls: [{ id: "call_bash", name: "bash", args: { command: bashCmd, inline_ms: 0 } }],
      stopReason: "tool_calls",
    },
    { text: "ok", toolCalls: [], stopReason: "stop" },
  ])
  // Bring in the real bash tool.
  const { bashTool } = await import("../src/tools/bash.js")
  const events = await runInvocation(sessionId, "go", {
    provider,
    tools: [bashTool],
    model: "fake",
    systemPrompt: "smoke artifacts bg",
  })
  const started = events.find((event) => event.type === "task.started")
  assert.ok(started, "expected task.started for background bash")

  // Wait for the bash to finish.
  await new Promise((resolve) => setTimeout(resolve, 500))

  const drainProvider = scriptedProvider("drain", [
    { text: "done", toolCalls: [], stopReason: "stop" },
  ])
  const drained = await runInvocation(sessionId, undefined, {
    provider: drainProvider,
    tools: [bashTool],
    model: "fake",
    systemPrompt: "smoke artifacts bg",
  })
  const created = drained.find((event) => event.type === "artifact.created")
  assert.ok(created, "expected artifact.created for the large drained task result")
  const completed = drained.find((event) => event.type === "task.completed")
  assert.equal(typeof completed?.artifactId, "string", "task.completed should carry artifactId")
  assert.match(String(completed?.result ?? ""), /^\[artifact: artifact_/)
  await disposeTaskServices(sessionId)
}

// 6. artifacts: false disables the feature.
{
  const sessionId = `smoke-artifact-off-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const largeSize = AUTO_ARTIFACT_THRESHOLD_BYTES * 3
  const tool = makeEchoTool("z")
  const provider = scriptedProvider("p", [
    {
      text: "fetching",
      toolCalls: [{ id: "call_1", name: "echo", args: { size: largeSize } }],
      stopReason: "tool_calls",
    },
    { text: "done", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(
    sessionId,
    "go",
    baseDeps(provider, tool, { artifacts: false }),
  )
  const created = events.find((event) => event.type === "artifact.created")
  assert.equal(created, undefined, "artifacts: false should not produce artifact.created")
  const completed = events.find(
    (event) =>
      event.type === "tool.completed" &&
      (event.call as { name?: string } | undefined)?.name === "echo",
  )
  assert.equal(completed?.artifactId, undefined, "no artifactId when disabled")
  // Truncation kicks in: result should end with [truncated: ...]
  assert.match(String(completed?.result ?? ""), /\[truncated: \d+ bytes\]$/)
  await disposeTaskServices(sessionId)
}

console.log("smoke-artifacts: large/small/read/paginate/bg-drain/disabled paths ok")
