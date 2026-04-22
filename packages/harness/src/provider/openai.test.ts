import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockCreate, mockConstructor } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockConstructor: vi.fn(),
}))

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat: { completions: { create: typeof mockCreate } }
      constructor(opts: unknown) {
        mockConstructor(opts)
        this.chat = { completions: { create: mockCreate } }
      }
    },
  }
})

import { ProviderError } from "./index.js"
import { OpenAIProvider } from "./openai.js"

const ENV_KEYS = ["OPENAI_API_KEY", "LEHARNESS_OPENAI_BASE_URL", "OPENAI_ORG_ID"] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  mockCreate.mockReset()
  mockConstructor.mockReset()
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function buildSuccess(
  overrides: {
    content?: string | null
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
    finish_reason?: string | null
    usage?: { prompt_tokens: number; completion_tokens: number }
  } = {},
) {
  const message: { content: string | null; tool_calls?: unknown } = {
    content: "content" in overrides ? (overrides.content ?? null) : "ok",
  }
  if (overrides.toolCalls) {
    message.tool_calls = overrides.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }
  const response: Record<string, unknown> = {
    choices: [{ message, finish_reason: overrides.finish_reason ?? "stop" }],
  }
  if (overrides.usage) response.usage = overrides.usage
  return response
}

describe("OpenAIProvider constructor", () => {
  it("uses OPENAI_API_KEY from env when no apiKey option is provided", () => {
    process.env.OPENAI_API_KEY = "env-key"
    new OpenAIProvider()
    expect(mockConstructor).toHaveBeenCalledTimes(1)
    expect(mockConstructor.mock.calls[0]?.[0]).toMatchObject({ apiKey: "env-key" })
  })

  it("prefers options.apiKey over env", () => {
    process.env.OPENAI_API_KEY = "env-key"
    new OpenAIProvider({ apiKey: "opt-key" })
    expect(mockConstructor.mock.calls[0]?.[0]).toMatchObject({ apiKey: "opt-key" })
  })

  it("throws ProviderError when no apiKey is available anywhere", () => {
    expect(() => new OpenAIProvider()).toThrowError(ProviderError)
    try {
      new OpenAIProvider()
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).providerName).toBe("openai")
      expect((err as ProviderError).message).toMatch(/OPENAI_API_KEY/)
    }
  })

  it("honors baseURL from env and from options (options wins)", () => {
    process.env.OPENAI_API_KEY = "k"
    process.env.LEHARNESS_OPENAI_BASE_URL = "https://env.example/v1"
    new OpenAIProvider()
    expect(mockConstructor.mock.calls.at(-1)?.[0]).toMatchObject({
      baseURL: "https://env.example/v1",
    })

    new OpenAIProvider({ baseURL: "https://opt.example/v1" })
    expect(mockConstructor.mock.calls.at(-1)?.[0]).toMatchObject({
      baseURL: "https://opt.example/v1",
    })
  })

  it("omits baseURL when neither option nor env is set", () => {
    process.env.OPENAI_API_KEY = "k"
    new OpenAIProvider()
    const opts = mockConstructor.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.baseURL).toBeUndefined()
    expect("baseURL" in opts).toBe(false)
  })

  it("forwards organization from options to the SDK client", () => {
    process.env.OPENAI_API_KEY = "k"
    new OpenAIProvider({ organization: "org-123" })
    expect(mockConstructor.mock.calls[0]?.[0]).toMatchObject({ organization: "org-123" })
  })

  it("falls back to OPENAI_ORG_ID env for organization", () => {
    process.env.OPENAI_API_KEY = "k"
    process.env.OPENAI_ORG_ID = "org-env"
    new OpenAIProvider()
    expect(mockConstructor.mock.calls[0]?.[0]).toMatchObject({ organization: "org-env" })
  })
})

describe("OpenAIProvider request translation", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "k"
    mockCreate.mockResolvedValue(buildSuccess())
  })

  it("translates a single user message", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi there" }],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.messages).toEqual([{ role: "user", content: "hi there" }])
    expect(body.model).toBe("gpt-test")
    expect(body.stream).toBe(false)
  })

  it("prepends a system message when req.system is set", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ])
  })

  it("translates an assistant message with tool calls (arguments JSON-stringified)", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "echo", args: { msg: "hi", n: 2 } }],
        },
      ],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ msg: "hi", n: 2 }) },
          },
        ],
      },
    ])
  })

  it("translates a tool result message", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      messages: [{ role: "tool", toolCallId: "call_1", content: "result body" }],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "result body" },
    ])
  })

  it("translates tools and sets tool_choice to auto", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "echo",
          description: "echoes input",
          schemaJson: { type: "object", properties: { msg: { type: "string" } } },
        },
      ],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "echo",
          description: "echoes input",
          parameters: { type: "object", properties: { msg: { type: "string" } } },
        },
      },
    ])
    expect(body.tool_choice).toBe("auto")
  })

  it("omits tools and tool_choice when none are provided", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect("tools" in body).toBe(false)
    expect("tool_choice" in body).toBe(false)
  })

  it("uses the default model when req.model is empty", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "",
      messages: [{ role: "user", content: "hi" }],
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.model).toBe("gpt-4o-mini")
  })

  it("forwards temperature and maxOutputTokens when set", async () => {
    const provider = new OpenAIProvider()
    await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      maxOutputTokens: 256,
    })
    const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.temperature).toBe(0.4)
    expect(body.max_tokens).toBe(256)
  })
})

describe("OpenAIProvider response translation", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "k"
  })

  it.each([
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
    ["function_call", "tool_calls"],
    ["content_filter", "stop"],
    ["something_else", "stop"],
  ] as const)("maps finish_reason %s to stopReason %s", async (finish, expected) => {
    mockCreate.mockResolvedValue(buildSuccess({ finish_reason: finish }))
    const provider = new OpenAIProvider()
    const res = await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.stopReason).toBe(expected)
  })

  it("parses a successful tool call response (arguments JSON parsed into args)", async () => {
    mockCreate.mockResolvedValue(
      buildSuccess({
        content: null,
        finish_reason: "tool_calls",
        toolCalls: [{ id: "call_a", name: "echo", arguments: JSON.stringify({ msg: "yo", n: 3 }) }],
      }),
    )
    const provider = new OpenAIProvider()
    const res = await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.toolCalls).toEqual([{ id: "call_a", name: "echo", args: { msg: "yo", n: 3 } }])
    expect(res.text).toBe("")
    expect(res.stopReason).toBe("tool_calls")
  })

  it("captures malformed tool call JSON with __parseError marker", async () => {
    mockCreate.mockResolvedValue(
      buildSuccess({
        content: null,
        finish_reason: "tool_calls",
        toolCalls: [{ id: "call_a", name: "echo", arguments: "not json" }],
      }),
    )
    const provider = new OpenAIProvider()
    const res = await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]).toEqual({
      id: "call_a",
      name: "echo",
      args: { __raw: "not json", __parseError: true },
    })
  })

  it("surfaces usage when present", async () => {
    mockCreate.mockResolvedValue(
      buildSuccess({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    )
    const provider = new OpenAIProvider()
    const res = await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it("returns empty text when content is null", async () => {
    mockCreate.mockResolvedValue(buildSuccess({ content: null }))
    const provider = new OpenAIProvider()
    const res = await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.text).toBe("")
  })

  it("passes the raw response through on the response object", async () => {
    const raw = buildSuccess()
    mockCreate.mockResolvedValue(raw)
    const provider = new OpenAIProvider()
    const res = await provider.call({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.raw).toBe(raw)
  })
})

describe("OpenAIProvider error handling", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "k"
  })

  it("wraps SDK failures in ProviderError with cause set", async () => {
    const sdkErr = new Error("rate limit")
    mockCreate.mockRejectedValue(sdkErr)
    const provider = new OpenAIProvider()
    await expect(
      provider.call({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      providerName: "openai",
      cause: sdkErr,
      message: expect.stringContaining("rate limit"),
    })
  })

  it("throws ProviderError when the response has no choices", async () => {
    mockCreate.mockResolvedValue({ choices: [] })
    const provider = new OpenAIProvider()
    await expect(
      provider.call({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError)
  })
})
