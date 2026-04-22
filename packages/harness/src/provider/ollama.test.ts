import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError, type ProviderRequest } from "./index.js"

interface MockState {
  constructorOpts: { baseURL?: string; apiKey?: string } | undefined
  createCalls: unknown[]
  cannedResponse: unknown
  createImpl: ((args: unknown) => Promise<unknown>) | undefined
}

const mockState: MockState = {
  constructorOpts: undefined,
  createCalls: [],
  cannedResponse: undefined,
  createImpl: undefined,
}

vi.mock("openai", () => {
  class MockOpenAI {
    chat: { completions: { create: (args: unknown) => Promise<unknown> } }

    constructor(opts: { baseURL?: string; apiKey?: string }) {
      mockState.constructorOpts = opts
      this.chat = {
        completions: {
          create: async (args: unknown) => {
            mockState.createCalls.push(args)
            if (mockState.createImpl) {
              return mockState.createImpl(args)
            }
            return mockState.cannedResponse
          },
        },
      }
    }
  }
  return { default: MockOpenAI }
})

import { OllamaProvider } from "./ollama.js"

function defaultCanned() {
  return {
    choices: [
      {
        message: { content: "hello", tool_calls: [] },
        finish_reason: "stop",
      },
    ],
  }
}

function lastCall(): Record<string, unknown> {
  const call = mockState.createCalls.at(-1)
  if (!call) throw new Error("no SDK call recorded")
  return call as Record<string, unknown>
}

beforeEach(() => {
  mockState.constructorOpts = undefined
  mockState.createCalls = []
  mockState.cannedResponse = defaultCanned()
  mockState.createImpl = undefined
  vi.unstubAllEnvs()
})

describe("OllamaProvider constructor", () => {
  it("uses defaults when no options are provided", () => {
    new OllamaProvider({})
    expect(mockState.constructorOpts).toEqual({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    })
  })

  it("honors explicit options", () => {
    new OllamaProvider({
      baseURL: "http://example:9999/v1",
      apiKey: "custom-key",
      defaultModel: "llama3:8b",
    })
    expect(mockState.constructorOpts).toEqual({
      baseURL: "http://example:9999/v1",
      apiKey: "custom-key",
    })
  })

  it("honors LEHARNESS_OLLAMA_BASE_URL env var over default", () => {
    vi.stubEnv("LEHARNESS_OLLAMA_BASE_URL", "http://from-env:1234/v1")
    new OllamaProvider()
    expect(mockState.constructorOpts?.baseURL).toBe("http://from-env:1234/v1")
  })

  it("explicit baseURL wins over env var", () => {
    vi.stubEnv("LEHARNESS_OLLAMA_BASE_URL", "http://from-env:1234/v1")
    new OllamaProvider({ baseURL: "http://explicit:1/v1" })
    expect(mockState.constructorOpts?.baseURL).toBe("http://explicit:1/v1")
  })
})

describe("OllamaProvider message translation", () => {
  it("translates a single user message", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      messages: [{ role: "user", content: "hi" }],
    }
    await provider.call(req)
    expect(lastCall().messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("prepends system prompt when provided", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
    }
    await provider.call(req)
    expect(lastCall().messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ])
  })

  it("translates assistant messages with tool calls", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", args: { path: "./README.md" } }],
        },
      ],
    }
    await provider.call(req)
    const messages = lastCall().messages as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "./README.md" }),
          },
        },
      ],
    })
  })

  it("translates tool result messages", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      messages: [{ role: "tool", toolCallId: "call_1", content: "file contents" }],
    }
    await provider.call(req)
    expect(lastCall().messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ])
  })
})

describe("OllamaProvider tool translation", () => {
  it("translates harness tools and sets tool_choice auto", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          name: "read_file",
          description: "reads a file",
          schemaJson: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    }
    await provider.call(req)
    const sent = lastCall()
    expect(sent.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "reads a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ])
    expect(sent.tool_choice).toBe("auto")
  })

  it("omits tools and tool_choice when no tools are provided", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      messages: [{ role: "user", content: "go" }],
    }
    await provider.call(req)
    const sent = lastCall()
    expect("tools" in sent).toBe(false)
    expect("tool_choice" in sent).toBe(false)
  })
})

describe("OllamaProvider response translation", () => {
  it.each([
    ["stop", "stop"],
    ["tool_calls", "tool_calls"],
    ["length", "length"],
  ] as const)("maps finish_reason %s to stopReason %s", async (finish, expected) => {
    mockState.cannedResponse = {
      choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: finish }],
    }
    const provider = new OllamaProvider()
    const res = await provider.call({
      model: "gemma4:26b",
      messages: [{ role: "user", content: "x" }],
    })
    expect(res.stopReason).toBe(expected)
  })

  it("parses a successful tool call response", async () => {
    mockState.cannedResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_a",
                function: {
                  name: "read_file",
                  arguments: '{"path":"./README.md"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }
    const provider = new OllamaProvider()
    const res = await provider.call({
      model: "gemma4:26b",
      messages: [{ role: "user", content: "go" }],
    })
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]).toEqual({
      id: "call_a",
      name: "read_file",
      args: { path: "./README.md" },
    })
  })

  it("handles malformed tool call JSON via sentinel object", async () => {
    mockState.cannedResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_bad",
                function: { name: "read_file", arguments: "not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }
    const provider = new OllamaProvider()
    const res = await provider.call({
      model: "gemma4:26b",
      messages: [{ role: "user", content: "go" }],
    })
    expect(res.toolCalls[0]?.args).toEqual({
      __raw: "not json",
      __parseError: true,
    })
  })

  it("surfaces usage when present", async () => {
    mockState.cannedResponse = {
      choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
    const provider = new OllamaProvider()
    const res = await provider.call({
      model: "gemma4:26b",
      messages: [{ role: "user", content: "x" }],
    })
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it("returns empty text when content is null", async () => {
    mockState.cannedResponse = {
      choices: [{ message: { content: null, tool_calls: [] }, finish_reason: "stop" }],
    }
    const provider = new OllamaProvider()
    const res = await provider.call({
      model: "gemma4:26b",
      messages: [{ role: "user", content: "x" }],
    })
    expect(res.text).toBe("")
  })
})

describe("OllamaProvider error handling", () => {
  it("throws ProviderError on SDK failure with cause set", async () => {
    const cause = new Error("network down")
    mockState.createImpl = async () => {
      throw cause
    }
    const provider = new OllamaProvider()
    await expect(
      provider.call({
        model: "gemma4:26b",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      providerName: "ollama",
      cause,
    })
  })

  it("wraps non-Error throws into ProviderError", async () => {
    mockState.createImpl = async () => {
      throw "string failure"
    }
    const provider = new OllamaProvider()
    await expect(
      provider.call({
        model: "gemma4:26b",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError)
  })
})

describe("OllamaProvider default model", () => {
  it("uses defaultModel when request omits model", async () => {
    const provider = new OllamaProvider()
    const req: ProviderRequest = {
      model: "gemma4:26b",
      messages: [{ role: "user", content: "x" }],
    }
    delete (req as { model?: string }).model
    await provider.call(req)
    expect(lastCall().model).toBe("gemma4:26b")
  })

  it("uses configured defaultModel when request omits model", async () => {
    const provider = new OllamaProvider({ defaultModel: "llama3:8b" })
    const req: ProviderRequest = {
      model: "",
      messages: [{ role: "user", content: "x" }],
    }
    await provider.call(req)
    expect(lastCall().model).toBe("llama3:8b")
  })
})
