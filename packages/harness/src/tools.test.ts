import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  allowAllPermissions,
  executeToolCall,
  executeToolCalls,
  type PermissionHandle,
  type Tool,
  type ToolCall,
  type ToolContext,
  ToolRegistry,
  truncateOutput,
} from "./tools.js"

const ctx: ToolContext = {
  sessionId: "test-session",
  permission: allowAllPermissions,
}

function makeTool(overrides: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    description: overrides.description ?? "test tool",
    schema: overrides.schema ?? z.object({}).passthrough(),
    execute: overrides.execute ?? (async () => ({ kind: "ok", output: "" })),
    ...overrides,
  }
}

describe("ToolRegistry", () => {
  it("registers and looks up tools", () => {
    const registry = new ToolRegistry()
    const tool = makeTool({ name: "echo" })
    registry.register(tool)

    expect(registry.has("echo")).toBe(true)
    expect(registry.get("echo")).toBe(tool)
    expect(registry.list()).toEqual([tool])
  })

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry()
    registry.register(makeTool({ name: "echo" }))
    expect(() => registry.register(makeTool({ name: "echo" }))).toThrow(/already registered/)
  })
})

describe("executeToolCall", () => {
  it("returns ok value on happy path", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "hello",
        schema: z.object({}).passthrough(),
        execute: async () => ({ kind: "ok", output: "hello" }),
      }),
    )

    const result = await executeToolCall({ id: "c1", name: "hello", args: {} }, registry, ctx)

    expect(result).toEqual({ ok: true, callId: "c1", value: "hello" })
  })

  it("returns not-found error for unknown tool", async () => {
    const registry = new ToolRegistry()
    const result = await executeToolCall({ id: "c1", name: "nope", args: {} }, registry, ctx)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/not found/)
    expect(result.error).toMatch(/nope/)
  })

  it("returns permission denied error", async () => {
    const denyAll: PermissionHandle = {
      async check() {
        return "deny"
      },
    }
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "danger",
        execute: async () => ({ kind: "ok", output: "should not run" }),
      }),
    )

    const result = await executeToolCall({ id: "c1", name: "danger", args: {} }, registry, {
      sessionId: "s",
      permission: denyAll,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/permission denied/)
    expect(result.error).toMatch(/danger/)
  })

  it("returns invalid args error from zod", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "greet",
        schema: z.object({ name: z.string() }),
        execute: async (args) => ({
          kind: "ok",
          output: `hi ${(args as { name: string }).name}`,
        }),
      }),
    )

    const result = await executeToolCall(
      { id: "c1", name: "greet", args: { name: 42 } },
      registry,
      ctx,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/invalid args for greet/)
    expect(result.error).toMatch(/name/)
  })

  it("captures thrown errors from tool execute", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "boom",
        execute: async () => {
          throw new Error("kaboom")
        },
      }),
    )

    const result = await executeToolCall({ id: "c1", name: "boom", args: {} }, registry, ctx)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/tool boom threw/)
    expect(result.error).toMatch(/kaboom/)
  })

  it("returns error variant from tool execute", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "fail",
        execute: async () => ({ kind: "error", message: "boom" }),
      }),
    )

    const result = await executeToolCall({ id: "c1", name: "fail", args: {} }, registry, ctx)

    expect(result).toEqual({ ok: false, callId: "c1", error: "boom" })
  })

  it("truncates oversized output", async () => {
    const big = "x".repeat(32 * 1024)
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "big",
        execute: async () => ({ kind: "ok", output: big }),
      }),
    )

    const result = await executeToolCall({ id: "c1", name: "big", args: {} }, registry, ctx)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContain("[truncated:")
    const valueBytes = Buffer.byteLength(result.value, "utf8")
    expect(valueBytes).toBeLessThanOrEqual(16 * 1024 + 64)
  })

  it("preserves small ASCII output without truncation marker", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "tiny",
        execute: async () => ({ kind: "ok", output: "tiny" }),
      }),
    )

    const result = await executeToolCall({ id: "c1", name: "tiny", args: {} }, registry, ctx)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("tiny")
    expect(result.value).not.toContain("[truncated:")
  })
})

describe("executeToolCalls", () => {
  it("runs calls sequentially and emits started/completed events in order", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "echo",
        schema: z.object({ msg: z.string() }),
        execute: async (args) => ({
          kind: "ok",
          output: (args as { msg: string }).msg,
        }),
      }),
    )

    const events: { type: string; callId: string }[] = []
    const append = async (event: unknown) => {
      const e = event as { type: string; call: ToolCall }
      events.push({ type: e.type, callId: e.call.id })
    }

    const calls: ToolCall[] = [
      { id: "c1", name: "echo", args: { msg: "one" } },
      { id: "c2", name: "echo", args: { msg: "two" } },
      { id: "c3", name: "echo", args: { msg: "three" } },
    ]

    const results = await executeToolCalls(calls, registry, ctx, append)

    expect(results).toEqual([
      { ok: true, callId: "c1", value: "one" },
      { ok: true, callId: "c2", value: "two" },
      { ok: true, callId: "c3", value: "three" },
    ])

    expect(events).toEqual([
      { type: "tool.started", callId: "c1" },
      { type: "tool.completed", callId: "c1" },
      { type: "tool.started", callId: "c2" },
      { type: "tool.completed", callId: "c2" },
      { type: "tool.started", callId: "c3" },
      { type: "tool.completed", callId: "c3" },
    ])
  })

  it("continues after a failed call and emits tool.failed", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "ok-tool",
        execute: async () => ({ kind: "ok", output: "fine" }),
      }),
    )
    registry.register(
      makeTool({
        name: "bad-tool",
        execute: async () => {
          throw new Error("nope")
        },
      }),
    )

    const events: { type: string; callId: string }[] = []
    const append = async (event: unknown) => {
      const e = event as { type: string; call: ToolCall }
      events.push({ type: e.type, callId: e.call.id })
    }

    const calls: ToolCall[] = [
      { id: "c1", name: "ok-tool", args: {} },
      { id: "c2", name: "bad-tool", args: {} },
      { id: "c3", name: "ok-tool", args: {} },
    ]

    const results = await executeToolCalls(calls, registry, ctx, append)

    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
    expect(results[2]?.ok).toBe(true)

    expect(events).toEqual([
      { type: "tool.started", callId: "c1" },
      { type: "tool.completed", callId: "c1" },
      { type: "tool.started", callId: "c2" },
      { type: "tool.failed", callId: "c2" },
      { type: "tool.started", callId: "c3" },
      { type: "tool.completed", callId: "c3" },
    ])
  })
})

describe("truncateOutput", () => {
  it("returns the same string when under cap", () => {
    expect(truncateOutput("hello")).toBe("hello")
  })

  it("truncates and appends a marker when over cap", () => {
    const big = "a".repeat(32 * 1024)
    const result = truncateOutput(big)
    expect(result).not.toBe(big)
    expect(result).toMatch(/\n\[truncated: \d+ bytes\]$/)
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(16 * 1024 + 64)
  })
})
