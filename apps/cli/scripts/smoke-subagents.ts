// smoke-subagents.ts
// End-to-end tests for the subagent runtime. Drives both parent and child
// invocations through runInvocation with scripted fake providers. Covers:
//   1. Spawn with explicit preset — child runs with the preset's tools and
//      systemPrompt; result drains back into parent.
//   2. Spawn without type — parent-clone fallback uses the parent's deps.
//   3. Cross-invocation drain — the parent invocation that fired the spawn
//      can finish before the child does; the next runInvocation(undefined)
//      picks up task.completed.
//   4. Cancellation — cancel_task aborts the child's runInvocation; parent
//      sees task.cancelled(reason: "parent").
//   5. Unknown preset — spawn_subagent({ type: "nope" }) returns a clean
//      tool error without crashing the loop.

import assert from "node:assert/strict"
import {
  disposeTaskServices,
  enableShellRuntime,
  enableSubagentRuntime,
  getOrCreateTaskServices,
  type HarnessDeps,
  hasPendingBackgroundUpdates,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  readRecordField,
  readStringField,
  registerSubagentPreset,
  runInvocation,
} from "@leharness/harness"
import { bashTool } from "../src/tools/bash.js"
import { readFileTool } from "../src/tools/read_file.js"

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

function findStartedTask(events: ReadonlyArray<{ type: string; task?: unknown }>):
  | {
      id: string
      kind: string
      payload: { kind?: string; childSessionId?: string; presetName?: string; prompt?: string }
    }
  | undefined {
  for (const event of events) {
    if (event.type !== "task.started") continue
    const task = readRecordField(event, "task")
    const payload = readRecordField(task, "payload")
    const id = readStringField(task, "id")
    if (readStringField(task, "kind") === "delegated" && id !== undefined) {
      return {
        id,
        kind: "delegated",
        payload: {
          kind: readStringField(payload, "kind"),
          childSessionId: readStringField(payload, "childSessionId"),
          presetName: readStringField(payload, "presetName"),
          prompt: readStringField(payload, "prompt"),
        },
      }
    }
  }
  return undefined
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parentDeps(provider: Provider): HarnessDeps {
  return {
    provider,
    tools: [bashTool, readFileTool],
    model: "fake-parent",
    systemPrompt: "smoke subagent parent",
  }
}

// 1. Spawn with explicit preset.
{
  const parentSessionId = `smoke-sub-preset-${Date.now()}`
  const services = getOrCreateTaskServices(parentSessionId)
  enableShellRuntime(services)
  const childProvider = scriptedProvider("child", [
    { text: "found three places", toolCalls: [], stopReason: "stop" },
  ])
  enableSubagentRuntime(
    services,
    {
      provider: childProvider,
      model: "fake-child",
      systemPrompt: "default child",
      tools: [readFileTool, bashTool],
    },
    runInvocation,
  )
  registerSubagentPreset(services, {
    name: "explore",
    description: "Read-only codebase exploration.",
    systemPrompt: "you are an explorer",
    tools: [readFileTool],
  })
  const parentProvider = scriptedProvider("parent", [
    {
      text: "delegating",
      toolCalls: [
        {
          id: "call_spawn",
          name: "spawn_subagent",
          args: { type: "explore", prompt: "find foo references" },
        },
      ],
      stopReason: "tool_calls",
    },
    { text: "ok", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(
    parentSessionId,
    "delegate to explore",
    parentDeps(parentProvider),
  )
  const started = findStartedTask(events)
  assert.ok(started, "expected task.started (delegated)")
  assert.equal(started.payload.presetName, "explore")
  assert.equal(started.payload.kind, "delegated")
  assert.ok(started.payload.childSessionId, "expected childSessionId in task payload")

  await delay(150) // let the (trivially short) child finish

  const drainProvider = scriptedProvider("drain", [
    { text: "got it", toolCalls: [], stopReason: "stop" },
  ])
  const drained = await runInvocation(parentSessionId, undefined, parentDeps(drainProvider))
  const completed = drained.find((event) => event.type === "task.completed")
  assert.ok(completed, "expected task.completed drained")
  assert.equal(String(completed?.result ?? ""), "found three places")

  if (started.payload.childSessionId) await disposeTaskServices(started.payload.childSessionId)
  await disposeTaskServices(parentSessionId)
}

// 2. Spawn without type — parent-clone fallback.
{
  const parentSessionId = `smoke-sub-clone-${Date.now()}`
  const services = getOrCreateTaskServices(parentSessionId)
  enableShellRuntime(services)
  let childPromptSeen: string | undefined
  const childProvider: Provider = {
    name: "child",
    async call(request: ProviderRequest): Promise<ProviderResponse> {
      // Capture what the child saw — verifies parent-clone deps wired through.
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user")
      if (lastUser && typeof lastUser.content === "string") childPromptSeen = lastUser.content
      return { text: "cloned and done", toolCalls: [], stopReason: "stop" }
    },
  }
  enableSubagentRuntime(
    services,
    {
      provider: childProvider,
      model: "fake-child",
      systemPrompt: "default child", // unused when parent-clone applies
      tools: [readFileTool, bashTool],
    },
    runInvocation,
  )
  const parentProvider = scriptedProvider("parent", [
    {
      text: "spawning clone",
      toolCalls: [
        {
          id: "call_spawn",
          name: "spawn_subagent",
          args: { prompt: "do the thing without a type" },
        },
      ],
      stopReason: "tool_calls",
    },
    { text: "ok", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(parentSessionId, "spawn clone", parentDeps(parentProvider))
  const started = findStartedTask(events)
  assert.ok(started, "expected task.started (delegated) for clone")
  assert.equal(started.payload.presetName, undefined, "no preset name on clone spawn")

  await delay(150)
  assert.equal(
    childPromptSeen,
    "do the thing without a type",
    "child should see the parent's prompt",
  )

  const drainProvider = scriptedProvider("drain", [
    { text: "noted", toolCalls: [], stopReason: "stop" },
  ])
  const drained = await runInvocation(parentSessionId, undefined, parentDeps(drainProvider))
  const completed = drained.find((event) => event.type === "task.completed")
  assert.ok(completed, "expected task.completed for parent-clone child")
  assert.equal(String(completed?.result ?? ""), "cloned and done")

  if (started.payload.childSessionId) await disposeTaskServices(started.payload.childSessionId)
  await disposeTaskServices(parentSessionId)
}

// 3. Cross-invocation drain — fire and forget, then drain in a fresh invocation.
{
  const parentSessionId = `smoke-sub-drain-${Date.now()}`
  const services = getOrCreateTaskServices(parentSessionId)
  enableShellRuntime(services)
  const childProvider = scriptedProvider("child", [
    { text: "drained child done", toolCalls: [], stopReason: "stop" },
  ])
  enableSubagentRuntime(
    services,
    {
      provider: childProvider,
      model: "fake-child",
      systemPrompt: "child",
      tools: [readFileTool],
    },
    runInvocation,
  )
  registerSubagentPreset(services, {
    name: "explore",
    description: "explorer",
    systemPrompt: "you are an explorer",
    tools: [readFileTool],
  })
  const parentProvider = scriptedProvider("parent", [
    {
      text: "fire and forget",
      toolCalls: [
        {
          id: "call_spawn",
          name: "spawn_subagent",
          args: { type: "explore", prompt: "do this in the background" },
        },
      ],
      stopReason: "tool_calls",
    },
    { text: "moving on", toolCalls: [], stopReason: "stop" },
  ])
  const firstEvents = await runInvocation(parentSessionId, "drain test", parentDeps(parentProvider))
  const started = findStartedTask(firstEvents)
  assert.ok(started, "expected task.started for drain test")

  // Give the child time to finish.
  await delay(200)
  assert.equal(hasPendingBackgroundUpdates(parentSessionId), true, "queue should hold completion")

  const drainProvider = scriptedProvider("drain", [
    { text: "got it", toolCalls: [], stopReason: "stop" },
  ])
  const drainedEvents = await runInvocation(parentSessionId, undefined, parentDeps(drainProvider))
  assert.ok(
    drainedEvents.find((event) => event.type === "invocation.auto"),
    "expected invocation.auto",
  )
  assert.ok(
    drainedEvents.find((event) => event.type === "task.completed"),
    "expected task.completed in drained events",
  )

  if (started.payload.childSessionId) await disposeTaskServices(started.payload.childSessionId)
  await disposeTaskServices(parentSessionId)
}

// 4. Cancellation — cancel_task aborts the child mid-flight.
{
  const parentSessionId = `smoke-sub-cancel-${Date.now()}`
  const services = getOrCreateTaskServices(parentSessionId)
  enableShellRuntime(services)
  // Child that calls a long bash so it stays running until cancelled.
  const childProvider: Provider = {
    name: "child",
    async call(_request: ProviderRequest): Promise<ProviderResponse> {
      return {
        text: "sleeping",
        toolCalls: [
          {
            id: "child_bash",
            name: "bash",
            args: { command: "sleep 10", inline_ms: 0 },
          },
        ],
        stopReason: "tool_calls",
      }
    },
  }
  enableSubagentRuntime(
    services,
    {
      provider: childProvider,
      model: "fake-child",
      systemPrompt: "child",
      tools: [bashTool],
    },
    runInvocation,
  )
  // The parent: first spawn, then cancel.
  let cancelled = false
  const parentProvider: Provider = {
    name: "parent",
    async call(request: ProviderRequest): Promise<ProviderResponse> {
      // Find the most recent delegated task_id projected into the prompt.
      let lastTaskId: string | undefined
      for (const message of request.messages) {
        if (message.role !== "tool" || typeof message.content !== "string") continue
        try {
          lastTaskId = readStringField(JSON.parse(message.content), "task_id") ?? lastTaskId
        } catch {
          // skip
        }
      }
      if (lastTaskId === undefined) {
        return {
          text: "spawning",
          toolCalls: [
            {
              id: "call_spawn",
              name: "spawn_subagent",
              args: { prompt: "do something that won't return" },
            },
          ],
          stopReason: "tool_calls",
        }
      }
      if (!cancelled) {
        cancelled = true
        return {
          text: "cancelling",
          toolCalls: [{ id: "call_cancel", name: "cancel_task", args: { task_id: lastTaskId } }],
          stopReason: "tool_calls",
        }
      }
      return { text: "done", toolCalls: [], stopReason: "stop" }
    },
  }
  await runInvocation(parentSessionId, "cancel test", parentDeps(parentProvider))
  await delay(300)

  const drainProvider = scriptedProvider("drain", [
    { text: "noted", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(parentSessionId, undefined, parentDeps(drainProvider))
  const cancelledEvent = events.find((event) => event.type === "task.cancelled")
  assert.ok(cancelledEvent, "expected task.cancelled drained")
  assert.equal(readStringField(cancelledEvent, "reason"), "parent")

  const started = findStartedTask(events)
  if (started?.payload.childSessionId) await disposeTaskServices(started.payload.childSessionId)
  await disposeTaskServices(parentSessionId)
}

// 5. Unknown preset — clean tool error, no crash.
{
  const parentSessionId = `smoke-sub-unknown-${Date.now()}`
  const services = getOrCreateTaskServices(parentSessionId)
  enableShellRuntime(services)
  const childProvider = scriptedProvider("child", [
    { text: "should never run", toolCalls: [], stopReason: "stop" },
  ])
  enableSubagentRuntime(
    services,
    {
      provider: childProvider,
      model: "fake-child",
      systemPrompt: "child",
      tools: [readFileTool],
    },
    runInvocation,
  )
  const parentProvider = scriptedProvider("parent", [
    {
      text: "trying unknown preset",
      toolCalls: [
        {
          id: "call_spawn",
          name: "spawn_subagent",
          args: { type: "nope-not-real", prompt: "should fail validation" },
        },
      ],
      stopReason: "tool_calls",
    },
    { text: "noted the error", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(parentSessionId, "bad preset", parentDeps(parentProvider))
  const failed = events.find((event) => event.type === "tool.failed")
  assert.ok(failed, "expected tool.failed for unknown preset")
  assert.match(String(failed?.error ?? ""), /unknown preset/)
  assert.equal(
    events.find((event) => event.type === "task.started"),
    undefined,
    "no task.started should fire for an unknown preset",
  )

  await disposeTaskServices(parentSessionId)
}

console.log("smoke-subagents: preset / parent-clone / drain / cancel / unknown-preset paths ok")
