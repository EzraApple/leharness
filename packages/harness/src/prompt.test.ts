import { describe, expect, it } from "vitest"
import { buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompt.js"
import type { HarnessTool } from "./provider/index.js"
import { initialSessionState, type SessionState } from "./session.js"

const ECHO_TOOL: HarnessTool = {
  name: "echo",
  description: "echoes input",
  schemaJson: { type: "object", properties: { msg: { type: "string" } } },
}

describe("DEFAULT_SYSTEM_PROMPT", () => {
  it("is a non-empty short string mentioning tools", () => {
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe("string")
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/tool/i)
  })
})

describe("buildPrompt", () => {
  it("produces an empty messages array for an empty session and no tools", () => {
    const request = buildPrompt(initialSessionState(), [], { model: "m" })
    expect(request.model).toBe("m")
    expect(request.messages).toEqual([])
    expect("tools" in request).toBe(false)
    expect("system" in request).toBe(false)
    expect("temperature" in request).toBe(false)
    expect("maxOutputTokens" in request).toBe(false)
  })

  it("includes system prompt when provided", () => {
    const request = buildPrompt(initialSessionState(), [], { model: "m", system: "be brief" })
    expect(request.system).toBe("be brief")
  })

  it("includes system prompt as empty string when explicitly set to empty string", () => {
    const request = buildPrompt(initialSessionState(), [], { model: "m", system: "" })
    expect("system" in request).toBe(true)
    expect(request.system).toBe("")
  })

  it("omits the system key entirely when option is undefined", () => {
    const request = buildPrompt(initialSessionState(), [], { model: "m" })
    expect("system" in request).toBe(false)
    expect(Object.keys(request).includes("system")).toBe(false)
  })

  it("translates a single user transcript entry to a user message", () => {
    const session: SessionState = {
      transcript: [{ kind: "user", text: "hi there" }],
    }
    const request = buildPrompt(session, [], { model: "m" })
    expect(request.messages).toEqual([{ role: "user", content: "hi there" }])
  })

  it("omits the tools key when no tools are provided", () => {
    const request = buildPrompt(initialSessionState(), [], { model: "m" })
    expect("tools" in request).toBe(false)
  })

  it("includes the tools key when tools are provided", () => {
    const request = buildPrompt(initialSessionState(), [ECHO_TOOL], { model: "m" })
    expect(request.tools).toEqual([ECHO_TOOL])
  })

  it("translates an assistant entry preserving tool calls", () => {
    const session: SessionState = {
      transcript: [
        {
          kind: "assistant",
          text: "calling echo",
          toolCalls: [{ id: "c1", name: "echo", args: { msg: "hi" } }],
        },
      ],
    }
    const request = buildPrompt(session, [], { model: "m" })
    expect(request.messages).toEqual([
      {
        role: "assistant",
        content: "calling echo",
        toolCalls: [{ id: "c1", name: "echo", args: { msg: "hi" } }],
      },
    ])
  })

  it("translates a tool_result entry to a tool message", () => {
    const session: SessionState = {
      transcript: [{ kind: "tool_result", callId: "c1", toolName: "echo", content: "result body" }],
    }
    const request = buildPrompt(session, [], { model: "m" })
    expect(request.messages).toEqual([{ role: "tool", toolCallId: "c1", content: "result body" }])
  })

  it("translates a tool_error entry to a tool message prefixed with error:", () => {
    const session: SessionState = {
      transcript: [{ kind: "tool_error", callId: "c1", toolName: "echo", error: "kaboom" }],
    }
    const request = buildPrompt(session, [], { model: "m" })
    expect(request.messages).toEqual([{ role: "tool", toolCallId: "c1", content: "error: kaboom" }])
  })

  it("forwards temperature and maxOutputTokens when provided", () => {
    const request = buildPrompt(initialSessionState(), [], {
      model: "m",
      temperature: 0.4,
      maxOutputTokens: 256,
    })
    expect(request.temperature).toBe(0.4)
    expect(request.maxOutputTokens).toBe(256)
  })

  it("omits temperature and maxOutputTokens keys when undefined (exactOptionalPropertyTypes)", () => {
    const request = buildPrompt(initialSessionState(), [], { model: "m" })
    expect(Object.keys(request).includes("temperature")).toBe(false)
    expect(Object.keys(request).includes("maxOutputTokens")).toBe(false)
  })

  it("preserves transcript order across mixed entries", () => {
    const session: SessionState = {
      transcript: [
        { kind: "user", text: "do the thing" },
        {
          kind: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { msg: "x" } }],
        },
        { kind: "tool_result", callId: "c1", toolName: "echo", content: "x" },
        { kind: "assistant", text: "done", toolCalls: [] },
      ],
    }
    const request = buildPrompt(session, [ECHO_TOOL], { model: "m", system: "sys" })
    expect(request.messages).toEqual([
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "echo", args: { msg: "x" } }],
      },
      { role: "tool", toolCallId: "c1", content: "x" },
      { role: "assistant", content: "done", toolCalls: [] },
    ])
    expect(request.system).toBe("sys")
    expect(request.tools).toEqual([ECHO_TOOL])
  })
})
