import type { Event } from "@leharness/harness"
import { describe, expect, it } from "vitest"
import { renderEvent, renderTranscript } from "./render.js"

function envelope(): { v: 1; id: string; ts: string } {
  return { v: 1, id: "01TESTID", ts: "2026-04-22T00:00:00.000Z" }
}

describe("renderEvent", () => {
  it("renders invocation.received as `> <text>`", () => {
    const event: Event = { ...envelope(), type: "invocation.received", text: "hello world" }
    expect(renderEvent(event)).toBe("> hello world")
  })

  it("returns null for step.started", () => {
    const event: Event = { ...envelope(), type: "step.started", stepNumber: 1 }
    expect(renderEvent(event)).toBeNull()
  })

  it("returns null for model.requested", () => {
    const event: Event = { ...envelope(), type: "model.requested", request: {} }
    expect(renderEvent(event)).toBeNull()
  })

  it("renders model.completed text only when there are no tool calls", () => {
    const event: Event = {
      ...envelope(),
      type: "model.completed",
      text: "the answer is 42",
      toolCalls: [],
    }
    expect(renderEvent(event)).toBe("the answer is 42")
  })

  it("renders model.completed text followed by tool-call lines", () => {
    const event: Event = {
      ...envelope(),
      type: "model.completed",
      text: "let me check",
      toolCalls: [{ id: "call-1", name: "read_file", args: { path: "README.md" } }],
    }
    expect(renderEvent(event)).toBe('let me check\n· read_file({"path":"README.md"})')
  })

  it("renders tool calls only when text is empty", () => {
    const event: Event = {
      ...envelope(),
      type: "model.completed",
      text: "",
      toolCalls: [{ id: "call-1", name: "list_dir", args: { path: "." } }],
    }
    expect(renderEvent(event)).toBe('· list_dir({"path":"."})')
  })

  it("renders two tool calls on separate lines", () => {
    const event: Event = {
      ...envelope(),
      type: "model.completed",
      text: "",
      toolCalls: [
        { id: "call-1", name: "read_file", args: { path: "a.txt" } },
        { id: "call-2", name: "list_dir", args: { path: "src" } },
      ],
    }
    expect(renderEvent(event)).toBe('· read_file({"path":"a.txt"})\n· list_dir({"path":"src"})')
  })

  it("renders model.failed", () => {
    const event: Event = {
      ...envelope(),
      type: "model.failed",
      error: "rate limited",
    }
    expect(renderEvent(event)).toBe("! model error: rate limited")
  })

  it("returns null for tool.started", () => {
    const event: Event = {
      ...envelope(),
      type: "tool.started",
      call: { id: "call-1", name: "read_file", args: {} },
    }
    expect(renderEvent(event)).toBeNull()
  })

  it("renders tool.completed with single short line", () => {
    const event: Event = {
      ...envelope(),
      type: "tool.completed",
      call: { id: "call-1", name: "read_file", args: {} },
      result: "ok",
    }
    expect(renderEvent(event)).toBe("< call-1: ok")
  })

  it("renders tool.completed with truncated single long line", () => {
    const longResult = "x".repeat(200)
    const event: Event = {
      ...envelope(),
      type: "tool.completed",
      call: { id: "call-9", name: "bash", args: {} },
      result: longResult,
    }
    expect(renderEvent(event)).toBe(`< call-9: ${"x".repeat(80)}…`)
  })

  it("renders tool.completed with multi-line result as line count", () => {
    const event: Event = {
      ...envelope(),
      type: "tool.completed",
      call: { id: "call-2", name: "bash", args: {} },
      result: "line 1\nline 2\nline 3",
    }
    expect(renderEvent(event)).toBe("< call-2: 3 lines")
  })

  it("renders tool.failed", () => {
    const event: Event = {
      ...envelope(),
      type: "tool.failed",
      call: { id: "call-3", name: "read_file", args: { path: "missing" } },
      error: "ENOENT: no such file",
    }
    expect(renderEvent(event)).toBe("! tool error (read_file): ENOENT: no such file")
  })

  it("renders agent.finished", () => {
    const event: Event = { ...envelope(), type: "agent.finished", reason: "no_tool_calls" }
    expect(renderEvent(event)).toBe("[done: no_tool_calls]")
  })
})

describe("renderTranscript", () => {
  it("filters nulls and joins with newlines", () => {
    const events: Event[] = [
      { ...envelope(), type: "invocation.received", text: "hi" },
      { ...envelope(), type: "step.started", stepNumber: 1 },
      { ...envelope(), type: "model.requested", request: {} },
      { ...envelope(), type: "model.completed", text: "hello back", toolCalls: [] },
      { ...envelope(), type: "agent.finished", reason: "no_tool_calls" },
    ]
    expect(renderTranscript(events)).toBe("> hi\nhello back\n[done: no_tool_calls]")
  })

  it("returns an empty string for an empty event list", () => {
    expect(renderTranscript([])).toBe("")
  })
})
