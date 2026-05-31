// smoke-artifacts.ts
// End-to-end tests for the filesystem artifact service. Covers:
//   1. Auto-artifact for large tool output — file lands on disk, event
//      log carries artifact.created + tool.completed.artifactId.
//   2. Inline path unchanged for small tool output.
//   3. Artifact stub carries a real file path and content is recoverable from disk.
//   4. read_file can page through artifact files by line offset/limit.
//   5. Background-task drain artifacts too — large task.completed
//      Messages get the same treatment.

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
  readStringField,
  readToolCall,
  resolveArtifactPath,
  runInvocation,
  type Tool,
  type ToolContext,
  type ToolExecuteResult,
} from "@leharness/harness"
import { z } from "zod"
import { readFileTool } from "../src/tools/read_file.js"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-artifacts-"))
process.env.LEHARNESS_HOME = home

function scriptedProvider(
  name: string,
  responses: ProviderResponse[],
  onRequest?: (request: ProviderRequest) => void,
): Provider {
  let index = 0
  return {
    name,
    async call(request: ProviderRequest): Promise<ProviderResponse> {
      onRequest?.(request)
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
  const requestedToolNames: string[] = []
  const provider = scriptedProvider(
    "p",
    [
      {
        text: "fetching",
        toolCalls: [{ id: "call_1", name: "echo", args: { size: largeSize } }],
        stopReason: "tool_calls",
      },
      { text: "done", toolCalls: [], stopReason: "stop" },
    ],
    (request) => {
      requestedToolNames.push(...(request.tools?.map((requestTool) => requestTool.name) ?? []))
    },
  )
  const events = await runInvocation(sessionId, "go", baseDeps(provider, tool))
  assert.deepEqual(
    [...new Set(requestedToolNames)],
    ["echo"],
    "artifact smoke should expose only caller tools",
  )
  const created = events.find((event) => event.type === "artifact.created")
  assert.ok(created, "expected artifact.created event")
  assert.equal(created?.byteCount, largeSize)
  assert.equal(created?.sourceCallId, "call_1")
  const completed = events.find(
    (event) => event.type === "tool.completed" && readToolCall(event.call)?.name === "echo",
  )
  assert.ok(completed, "expected tool.completed for echo")
  assert.equal(typeof completed?.artifactId, "string")
  assert.equal(completed?.artifactId, created?.id)
  assert.match(String(completed?.result ?? ""), /^\[artifact: .+artifact_/)
  // File exists on disk and matches the original.
  const artifactId = readStringField(created, "id")
  assert.ok(artifactId, "artifact.created should carry id")
  const artifactPath = resolveArtifactPath(sessionId, artifactId)
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
    (event) => event.type === "tool.completed" && readToolCall(event.call)?.name === "echo",
  )
  assert.equal(completed?.artifactId, undefined, "no artifactId on small inline result")
  assert.equal(String(completed?.result ?? "").startsWith("["), false)
  await disposeTaskServices(sessionId)
}

// 3. Artifact path round-trip.
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
  const artifactId = readStringField(created, "id")
  assert.ok(artifactId, "artifact.created should carry id")
  const artifactPath = resolveArtifactPath(sessionId, artifactId)
  const completed = events.find(
    (event) => event.type === "tool.completed" && readToolCall(event.call)?.name === "echo",
  )
  assert.match(String(completed?.result ?? ""), new RegExp(escapeRegExp(artifactPath)))
  assert.match(String(completed?.result ?? ""), /Use read_file with path=/)
  const onDisk = await fs.readFile(artifactPath, "utf8")
  assert.equal(onDisk.length, largeSize, "on-disk content matches the original size")
  await disposeTaskServices(sessionId)
}

// 4. Bounded line pagination via read_file against an artifact path.
{
  const sessionId = `smoke-artifact-read-file-${Date.now()}`
  const artifactPath = resolveArtifactPath(sessionId, "manual_artifact")
  await fs.mkdir(path.dirname(artifactPath), { recursive: true })
  await fs.writeFile(
    artifactPath,
    Array.from({ length: 500 }, (_, index) => `artifact line ${index + 1}`).join("\n"),
  )
  const defaultResult = await readFileTool.execute({ path: artifactPath }, { sessionId })
  assert.equal(defaultResult.kind, "ok")
  assert.match(defaultResult.output, /^\s+1\tartifact line 1/m)
  assert.match(defaultResult.output, /^\s+400\tartifact line 400/m)
  assert.doesNotMatch(defaultResult.output, /^\s+401\tartifact line 401/m)
  assert.match(defaultResult.output, /lines 1-400 of 500; next offset: 401/)

  const pageResult = await readFileTool.execute(
    { path: artifactPath, offset: 401, limit: 20 },
    { sessionId },
  )
  assert.equal(pageResult.kind, "ok")
  assert.match(pageResult.output, /^\s+401\tartifact line 401/m)
  assert.match(pageResult.output, /^\s+420\tartifact line 420/m)
  assert.doesNotMatch(pageResult.output, /^\s+421\tartifact line 421/m)
  assert.match(pageResult.output, /lines 401-420 of 500; next offset: 421/)
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
  assert.equal(
    typeof readStringField(completed, "artifactId"),
    "string",
    "task.completed should carry artifactId",
  )
  assert.match(String(completed?.result ?? ""), /^\[artifact: .+artifact_/)
  await disposeTaskServices(sessionId)
}

console.log("smoke-artifacts: large/small/path/read_file/bg-drain paths ok")

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
