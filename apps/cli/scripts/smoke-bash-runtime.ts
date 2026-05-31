// smoke-bash-runtime.ts
// End-to-end tests for the bash tool driven through runInvocation with a
// scripted fake provider. Covers the four core background-task paths:
//   1. Foreground bash that finishes within inline_ms — inline result.
//   2. Background promotion — bash crosses inline_ms, returns started.
//   3. Cross-invocation drain — a completion lands while idle, a follow-up
//      runInvocation(userText: undefined) drains it as task.completed.
//   4. cancel_task end-to-end — model fires cancel_task; task.cancelled
//      (reason: "parent") lands in the log.

import assert from "node:assert/strict"
import {
  disposeTaskServices,
  enableShellRuntime,
  getOrCreateTaskServices,
  type HarnessDeps,
  hasPendingBackgroundUpdates,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  readStringField,
  readToolCall,
  runInvocation,
  taskManagementCapability,
} from "@leharness/harness"
import { bashTool } from "../src/tools/bash.js"

function scriptedProvider(responses: ProviderResponse[]): Provider {
  let index = 0
  return {
    name: "fake",
    async call(_request: ProviderRequest): Promise<ProviderResponse> {
      const next = responses[index++]
      if (next === undefined) throw new Error("scriptedProvider: out of scripted responses")
      return next
    },
  }
}

function dynamicProvider(handler: (request: ProviderRequest) => ProviderResponse): Provider {
  return {
    name: "fake",
    async call(request: ProviderRequest): Promise<ProviderResponse> {
      return handler(request)
    },
  }
}

function findTaskIdInRequest(request: ProviderRequest): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue
    try {
      const taskId = readStringField(JSON.parse(message.content), "task_id")
      if (taskId !== undefined) return taskId
    } catch {
      // Not a JSON-shaped tool message; skip.
    }
  }
  return undefined
}

function baseDeps(provider: Provider): HarnessDeps {
  return {
    provider,
    tools: [bashTool],
    model: "fake-model",
    systemPrompt: "smoke bash runtime",
    capabilities: [taskManagementCapability()],
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 1. Foreground bash inline — finishes within the default inline window.
{
  const sessionId = `smoke-bash-fg-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const provider = scriptedProvider([
    {
      text: "running it",
      toolCalls: [{ id: "call_1", name: "bash", args: { command: "echo hi" } }],
      stopReason: "tool_calls",
    },
    { text: "done", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(sessionId, "run echo hi", baseDeps(provider))
  const completed = events.find(
    (event) => event.type === "tool.completed" && readToolCall(event.call)?.name === "bash",
  )
  assert.ok(completed, "expected tool.completed for foreground bash")
  assert.match(String(completed?.result ?? ""), /hi/, "result should contain echoed text")
  assert.match(String(completed?.summary ?? ""), /exit 0/, "summary should mention exit 0")
  assert.equal(
    events.find((event) => event.type === "task.started"),
    undefined,
    "no task.started should fire for an inline command",
  )
  await disposeTaskServices(sessionId)
}

// 2. Background promotion — sleep outlives the inline_ms budget.
{
  const sessionId = `smoke-bash-bg-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const provider = scriptedProvider([
    {
      text: "kicking it off",
      toolCalls: [
        {
          id: "call_1",
          name: "bash",
          args: { command: "sleep 0.3", inline_ms: 50 },
        },
      ],
      stopReason: "tool_calls",
    },
    { text: "ok", toolCalls: [], stopReason: "stop" },
  ])
  const events = await runInvocation(sessionId, "kick off sleep", baseDeps(provider))
  const started = events.find((event) => event.type === "task.started")
  assert.ok(started, "expected task.started once inline_ms expired")
  const inlineCompleted = events.find(
    (event) => event.type === "tool.completed" && readToolCall(event.call)?.name === "bash",
  )
  assert.equal(
    inlineCompleted,
    undefined,
    "tool.completed should not fire when the call backgrounded",
  )
  // Let the actual sleep finish before disposing so we're not tearing down a
  // child that's still running.
  await delay(500)
  await disposeTaskServices(sessionId)
}

// 3. Cross-invocation drain — a completion lands between turns.
{
  const sessionId = `smoke-bash-drain-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  const firstProvider = scriptedProvider([
    {
      text: "starting",
      toolCalls: [
        {
          id: "call_1",
          name: "bash",
          args: { command: "sleep 0.2", inline_ms: 0 },
        },
      ],
      stopReason: "tool_calls",
    },
    { text: "ok", toolCalls: [], stopReason: "stop" },
  ])
  await runInvocation(sessionId, "kick off background", baseDeps(firstProvider))
  // Wait long enough for the child to exit and post task.completed to the
  // queue.
  await delay(400)
  assert.equal(
    hasPendingBackgroundUpdates(sessionId),
    true,
    "queue should hold the pending completion",
  )
  const secondProvider = scriptedProvider([{ text: "got it", toolCalls: [], stopReason: "stop" }])
  const secondEvents = await runInvocation(sessionId, undefined, baseDeps(secondProvider))
  assert.ok(
    secondEvents.find((event) => event.type === "invocation.auto"),
    "expected invocation.auto when userText is undefined",
  )
  assert.ok(
    secondEvents.find((event) => event.type === "task.completed"),
    "expected task.completed drained into the new invocation",
  )
  assert.equal(hasPendingBackgroundUpdates(sessionId), false, "queue should be empty after drain")
  await disposeTaskServices(sessionId)
}

// 4. cancel_task end-to-end — model spawns then cancels.
{
  const sessionId = `smoke-bash-cancel-${Date.now()}`
  enableShellRuntime(getOrCreateTaskServices(sessionId))
  let cancelIssued = false
  const provider = dynamicProvider((request) => {
    const knownTaskId = findTaskIdInRequest(request)
    if (knownTaskId === undefined) {
      return {
        text: "starting",
        toolCalls: [
          {
            id: "call_bg",
            name: "bash",
            args: { command: "sleep 30", inline_ms: 0 },
          },
        ],
        stopReason: "tool_calls",
      }
    }
    if (!cancelIssued) {
      cancelIssued = true
      return {
        text: "cancelling",
        toolCalls: [{ id: "call_cancel", name: "cancel_task", args: { task_id: knownTaskId } }],
        stopReason: "tool_calls",
      }
    }
    return { text: "done", toolCalls: [], stopReason: "stop" }
  })
  await runInvocation(sessionId, "cancel test", baseDeps(provider))
  // SIGTERM is asynchronous from the executor's perspective; give the child
  // a moment to exit and post task.cancelled to the queue.
  await delay(250)
  const drainProvider = scriptedProvider([{ text: "noted", toolCalls: [], stopReason: "stop" }])
  const events = await runInvocation(sessionId, undefined, baseDeps(drainProvider))
  const cancelled = events.find((event) => event.type === "task.cancelled")
  assert.ok(cancelled, "expected task.cancelled event in the drained log")
  assert.equal(
    readStringField(cancelled, "reason"),
    "parent",
    "cancellation reason should be 'parent' (parent agent called cancel_task)",
  )
  await disposeTaskServices(sessionId)
}

console.log(
  "smoke-bash-runtime: foreground / background / cross-invocation drain / cancel paths ok",
)
