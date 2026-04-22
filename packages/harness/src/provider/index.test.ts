import { describe, expect, it } from "vitest"
import {
  callModel,
  type HarnessMessage,
  type Provider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
} from "./index.js"

function messageRole(m: HarnessMessage): "user" | "assistant" | "tool" {
  switch (m.role) {
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "tool":
      return "tool"
  }
}

function describeStop(s: ProviderResponse["stopReason"]): string {
  switch (s) {
    case "stop":
      return "natural stop"
    case "tool_calls":
      return "tool calls requested"
    case "length":
      return "length limit reached"
    case "error":
      return "in-band provider error"
  }
}

describe("callModel", () => {
  it("forwards the canned response from the provider", async () => {
    const canned: ProviderResponse = {
      text: "hello",
      toolCalls: [],
      stopReason: "stop",
    }
    const fake: Provider = {
      name: "fake",
      async call() {
        return canned
      },
    }
    const request: ProviderRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    }
    const result = await callModel(fake, request)
    expect(result).toBe(canned)
  })

  it("forwards the request unchanged to the provider", async () => {
    let received: ProviderRequest | undefined
    const fake: Provider = {
      name: "fake",
      async call(req) {
        received = req
        return { text: "", toolCalls: [], stopReason: "stop" }
      },
    }
    const request: ProviderRequest = {
      model: "test-model",
      system: "be helpful",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", toolCalls: [] },
      ],
      tools: [
        {
          name: "echo",
          description: "echoes",
          schemaJson: { type: "object" },
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 256,
    }
    await callModel(fake, request)
    expect(received).toEqual(request)
  })
})

describe("ProviderError", () => {
  it("captures name, providerName, message, and cause", () => {
    const cause = new Error("underlying")
    const err = new ProviderError("boom", "ollama", cause)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ProviderError")
    expect(err.message).toBe("boom")
    expect(err.providerName).toBe("ollama")
    expect(err.cause).toBe(cause)
  })

  it("allows omitting cause", () => {
    const err = new ProviderError("nope", "openai")
    expect(err.cause).toBeUndefined()
    expect(err.providerName).toBe("openai")
  })
})

describe("HarnessMessage discrimination", () => {
  it("messageRole returns the right tag for each variant", () => {
    expect(messageRole({ role: "user", content: "hi" })).toBe("user")
    expect(messageRole({ role: "assistant", content: "", toolCalls: [] })).toBe("assistant")
    expect(messageRole({ role: "tool", toolCallId: "t1", content: "ok" })).toBe("tool")
  })
})

describe("stopReason exhaustiveness", () => {
  it("describeStop covers every union member", () => {
    const reasons: ProviderResponse["stopReason"][] = ["stop", "tool_calls", "length", "error"]
    const described = reasons.map(describeStop)
    expect(described).toEqual([
      "natural stop",
      "tool calls requested",
      "length limit reached",
      "in-band provider error",
    ])
  })
})
