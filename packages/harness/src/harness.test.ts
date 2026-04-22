import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { type Event, loadEvents, newEventId, resolveSessionPath } from "./events.js"
import { type HarnessDeps, runInvocation, shouldCompact, shouldContinue } from "./harness.js"
import {
  type Provider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider/index.js"
import { type Tool, type ToolExecuteResult, ToolRegistry } from "./tools.js"

type ProviderResponder = (req: ProviderRequest, callIndex: number) => Promise<ProviderResponse>

interface FakeProviderHandle {
  provider: Provider
  calls: ProviderRequest[]
}

function makeFakeProvider(responder: ProviderResponder): FakeProviderHandle {
  const calls: ProviderRequest[] = []
  let idx = 0
  const provider: Provider = {
    name: "fake",
    async call(req: ProviderRequest): Promise<ProviderResponse> {
      calls.push(req)
      const i = idx
      idx++
      return responder(req, i)
    },
  }
  return { provider, calls }
}

function scriptedProvider(responses: ProviderResponse[]): FakeProviderHandle {
  return makeFakeProvider(async (_req, i) => {
    const r = responses[i]
    if (r === undefined) {
      throw new Error(`fake provider exhausted at call ${i}; no scripted response`)
    }
    return r
  })
}

function textResponse(text: string): ProviderResponse {
  return { text, toolCalls: [], stopReason: "stop" }
}

function toolCallResponse(
  toolCalls: Array<{ id: string; name: string; args: unknown }>,
  text = "",
): ProviderResponse {
  return { text, toolCalls, stopReason: "tool_calls" }
}

interface FakeToolOptions {
  name?: string
  schema?: Tool["schema"]
  execute?: (args: unknown) => Promise<ToolExecuteResult>
}

function makeFakeTool(opts: FakeToolOptions = {}): Tool {
  return {
    name: opts.name ?? "fake_tool",
    description: "a fake tool",
    schema: opts.schema ?? z.object({}).passthrough(),
    execute: opts.execute ?? (async () => ({ kind: "ok", output: "tool ran" })),
  }
}

interface TestCtx {
  home: string
  sessionId: string
  cleanup: () => Promise<void>
}

async function setup(): Promise<TestCtx> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-harness-"))
  const previous = process.env.LEHARNESS_HOME
  process.env.LEHARNESS_HOME = home
  return {
    home,
    sessionId: newEventId(),
    cleanup: async () => {
      if (previous === undefined) {
        delete process.env.LEHARNESS_HOME
      } else {
        process.env.LEHARNESS_HOME = previous
      }
      try {
        await fs.rm(home, { recursive: true, force: true })
      } catch {}
    },
  }
}

function eventTypes(events: Event[]): string[] {
  return events.map((e) => e.type)
}

function depsFor(
  provider: Provider,
  registry: ToolRegistry,
  overrides: Partial<HarnessDeps> = {},
): HarnessDeps {
  return {
    provider,
    tools: registry,
    model: "test-model",
    ...overrides,
  }
}

describe("runInvocation - single turn, no tools", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("emits the canonical single-step event sequence and reaches no_tool_calls", async () => {
    const handle = scriptedProvider([textResponse("all done")])
    const registry = new ToolRegistry()

    const finalState = await runInvocation(
      ctx.sessionId,
      "say hi",
      depsFor(handle.provider, registry),
    )

    expect(finalState.transcript).toEqual([
      { kind: "user", text: "say hi" },
      { kind: "assistant", text: "all done", toolCalls: [] },
    ])

    const events = await loadEvents(ctx.sessionId)
    expect(eventTypes(events)).toEqual([
      "invocation.received",
      "step.started",
      "model.requested",
      "model.completed",
      "agent.finished",
    ])

    const stepEvents = events.filter((e) => e.type === "step.started")
    expect(stepEvents).toHaveLength(1)

    const finished = events.find((e) => e.type === "agent.finished")
    expect(finished).toBeDefined()
    if (finished?.type === "agent.finished") {
      expect(finished.reason).toBe("no_tool_calls")
    }

    expect(handle.calls).toHaveLength(1)
    expect(handle.calls[0]?.messages).toEqual([{ role: "user", content: "say hi" }])
  })
})

describe("runInvocation - tool round-trip", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("calls the tool, feeds the result back, and stops on the next step", async () => {
    const handle = scriptedProvider([
      toolCallResponse([{ id: "call_1", name: "fake_tool", args: { x: 1 } }]),
      textResponse("we are done"),
    ])
    const registry = new ToolRegistry()
    registry.register(
      makeFakeTool({
        name: "fake_tool",
        schema: z.object({ x: z.number() }),
        execute: async () => ({ kind: "ok", output: "tool ran" }),
      }),
    )

    const finalState = await runInvocation(ctx.sessionId, "go", depsFor(handle.provider, registry))

    expect(finalState.transcript).toEqual([
      { kind: "user", text: "go" },
      {
        kind: "assistant",
        text: "",
        toolCalls: [{ id: "call_1", name: "fake_tool", args: { x: 1 } }],
      },
      { kind: "tool_result", callId: "call_1", toolName: "fake_tool", content: "tool ran" },
      { kind: "assistant", text: "we are done", toolCalls: [] },
    ])

    const events = await loadEvents(ctx.sessionId)
    const types = eventTypes(events)
    expect(types).toContain("tool.started")
    expect(types).toContain("tool.completed")
    const stepEvents = events.filter((e) => e.type === "step.started")
    expect(stepEvents).toHaveLength(2)

    const finished = events.find((e) => e.type === "agent.finished")
    if (finished?.type === "agent.finished") {
      expect(finished.reason).toBe("no_tool_calls")
    }

    expect(handle.calls).toHaveLength(2)
    const secondCallMessages = handle.calls[1]?.messages
    expect(secondCallMessages?.some((m) => m.role === "tool" && m.content === "tool ran")).toBe(
      true,
    )
  })
})

describe("runInvocation - tool failure handled in transcript", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("emits tool.failed, surfaces tool_error to the model, and continues", async () => {
    const handle = scriptedProvider([
      toolCallResponse([{ id: "call_1", name: "fake_tool", args: {} }]),
      textResponse("recovered"),
    ])
    const registry = new ToolRegistry()
    registry.register(
      makeFakeTool({
        execute: async () => ({ kind: "error", message: "boom" }),
      }),
    )

    const finalState = await runInvocation(ctx.sessionId, "go", depsFor(handle.provider, registry))

    const lastEntry = finalState.transcript.at(-1)
    expect(lastEntry).toEqual({ kind: "assistant", text: "recovered", toolCalls: [] })
    expect(
      finalState.transcript.some(
        (e) => e.kind === "tool_error" && e.callId === "call_1" && e.error === "boom",
      ),
    ).toBe(true)

    const events = await loadEvents(ctx.sessionId)
    expect(eventTypes(events)).toContain("tool.failed")

    const finished = events.find((e) => e.type === "agent.finished")
    if (finished?.type === "agent.finished") {
      expect(finished.reason).toBe("no_tool_calls")
    }

    const recoveryMessages = handle.calls[1]?.messages
    expect(recoveryMessages?.some((m) => m.role === "tool" && m.content === "error: boom")).toBe(
      true,
    )
  })
})

describe("runInvocation - multiple tool calls in one step", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("executes both calls sequentially and surfaces both results in the next prompt", async () => {
    const handle = scriptedProvider([
      toolCallResponse([
        { id: "call_a", name: "fake_tool", args: { i: 1 } },
        { id: "call_b", name: "fake_tool", args: { i: 2 } },
      ]),
      textResponse("done"),
    ])
    const registry = new ToolRegistry()
    registry.register(
      makeFakeTool({
        schema: z.object({ i: z.number() }),
        execute: async (args) => ({
          kind: "ok",
          output: `ran-${(args as { i: number }).i}`,
        }),
      }),
    )

    const finalState = await runInvocation(ctx.sessionId, "go", depsFor(handle.provider, registry))

    const toolResults = finalState.transcript.filter((e) => e.kind === "tool_result")
    expect(toolResults).toEqual([
      { kind: "tool_result", callId: "call_a", toolName: "fake_tool", content: "ran-1" },
      { kind: "tool_result", callId: "call_b", toolName: "fake_tool", content: "ran-2" },
    ])

    const events = await loadEvents(ctx.sessionId)
    const toolFlow = events
      .filter(
        (e) => e.type === "tool.started" || e.type === "tool.completed" || e.type === "tool.failed",
      )
      .map((e) => {
        if (e.type === "tool.started" || e.type === "tool.completed" || e.type === "tool.failed") {
          return { type: e.type, callId: e.call.id }
        }
        return { type: e.type, callId: "" }
      })
    expect(toolFlow).toEqual([
      { type: "tool.started", callId: "call_a" },
      { type: "tool.completed", callId: "call_a" },
      { type: "tool.started", callId: "call_b" },
      { type: "tool.completed", callId: "call_b" },
    ])
  })
})

describe("runInvocation - provider throws", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("logs model.failed + agent.finished(model_error) and resolves without throwing", async () => {
    const provider: Provider = {
      name: "boom",
      async call() {
        throw new ProviderError("kaboom", "boom")
      },
    }
    const registry = new ToolRegistry()

    const finalState = await runInvocation(ctx.sessionId, "go", depsFor(provider, registry))
    expect(finalState.transcript).toEqual([{ kind: "user", text: "go" }])

    const events = await loadEvents(ctx.sessionId)
    const types = eventTypes(events)
    expect(types).toContain("model.failed")
    expect(types[types.length - 1]).toBe("agent.finished")

    const failed = events.find((e) => e.type === "model.failed")
    if (failed?.type === "model.failed") {
      expect(failed.error).toBe("kaboom")
    }
    const finished = events.find((e) => e.type === "agent.finished")
    if (finished?.type === "agent.finished") {
      expect(finished.reason).toBe("model_error")
    }
  })
})

describe("runInvocation - max steps safety", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("stops after the configured max steps with reason max_steps", async () => {
    const handle = makeFakeProvider(async (_req, i) =>
      toolCallResponse([{ id: `call_${i}`, name: "fake_tool", args: {} }]),
    )
    const registry = new ToolRegistry()
    registry.register(makeFakeTool())

    const finalState = await runInvocation(
      ctx.sessionId,
      "go",
      depsFor(handle.provider, registry, { maxSteps: 3 }),
    )

    expect(finalState).toBeDefined()
    const events = await loadEvents(ctx.sessionId)
    const stepEvents = events.filter((e) => e.type === "step.started")
    expect(stepEvents).toHaveLength(3)

    const finished = events.find((e) => e.type === "agent.finished")
    if (finished?.type === "agent.finished") {
      expect(finished.reason).toBe("max_steps")
    }
  })
})

describe("runInvocation - resumption across two invocations", () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await setup()
  })
  afterEach(async () => {
    await ctx.cleanup()
  })

  it("appends to the same JSONL and the second projection extends the first transcript", async () => {
    const handle = scriptedProvider([textResponse("first"), textResponse("second")])
    const registry = new ToolRegistry()

    const firstState = await runInvocation(
      ctx.sessionId,
      "hello",
      depsFor(handle.provider, registry),
    )
    expect(firstState.transcript).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "first", toolCalls: [] },
    ])

    const secondState = await runInvocation(
      ctx.sessionId,
      "follow up",
      depsFor(handle.provider, registry),
    )

    expect(secondState.transcript.slice(0, 2)).toEqual(firstState.transcript)
    expect(secondState.transcript).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "first", toolCalls: [] },
      { kind: "user", text: "follow up" },
      { kind: "assistant", text: "second", toolCalls: [] },
    ])

    const filePath = resolveSessionPath(ctx.sessionId)
    const raw = await fs.readFile(filePath, "utf8")
    const invocations = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Event)
      .filter((e) => e.type === "invocation.received")
    expect(invocations).toHaveLength(2)
  })
})

describe("shouldContinue (unit)", () => {
  it("returns true when tool calls are present and step is under max", () => {
    const r: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "c1", name: "x", args: {} }],
      stopReason: "tool_calls",
    }
    expect(shouldContinue(r, 1, 5)).toBe(true)
  })

  it("returns false when there are no tool calls", () => {
    const r: ProviderResponse = { text: "done", toolCalls: [], stopReason: "stop" }
    expect(shouldContinue(r, 1, 5)).toBe(false)
  })

  it("returns false when max steps is reached, even if tool calls are present", () => {
    const r: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "c1", name: "x", args: {} }],
      stopReason: "tool_calls",
    }
    expect(shouldContinue(r, 5, 5)).toBe(false)
  })
})

describe("shouldCompact (stub)", () => {
  it("always returns false in MVP", () => {
    expect(shouldCompact({ transcript: [] })).toBe(false)
    expect(
      shouldCompact({
        transcript: [{ kind: "user", text: "anything" }],
      }),
    ).toBe(false)
  })
})
