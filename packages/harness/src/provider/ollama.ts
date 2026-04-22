import OpenAI from "openai"
import {
  type HarnessToolCall,
  type Provider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
} from "./index.js"

export interface OllamaProviderOptions {
  baseURL?: string
  apiKey?: string
  defaultModel?: string
}

const DEFAULT_BASE_URL = "http://localhost:11434/v1"
const DEFAULT_API_KEY = "ollama"
const DEFAULT_MODEL = "gemma4:26b"

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAITool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: "auto"
  temperature?: number
  max_tokens?: number
  stream: false
}

export class OllamaProvider implements Provider {
  readonly name = "ollama"
  private client: OpenAI
  private defaultModel: string

  constructor(options: OllamaProviderOptions = {}) {
    const baseURL = options.baseURL ?? process.env.LEHARNESS_OLLAMA_BASE_URL ?? DEFAULT_BASE_URL
    const apiKey = options.apiKey ?? DEFAULT_API_KEY
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL
    this.client = new OpenAI({ baseURL, apiKey })
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const messages: OpenAIMessage[] = []
    if (req.system) {
      messages.push({ role: "system", content: req.system })
    }
    for (const msg of req.messages) {
      if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content })
      } else if (msg.role === "assistant") {
        const entry: OpenAIMessage = {
          role: "assistant",
          content: msg.content || null,
        }
        if (msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        }
        messages.push(entry)
      } else {
        messages.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        })
      }
    }

    const payload: OpenAIChatRequest = {
      model: req.model || this.defaultModel,
      messages,
      stream: false,
    }
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schemaJson,
        },
      }))
      payload.tool_choice = "auto"
    }
    if (req.temperature !== undefined) {
      payload.temperature = req.temperature
    }
    if (req.maxOutputTokens !== undefined) {
      payload.max_tokens = req.maxOutputTokens
    }

    let response: unknown
    try {
      response = await this.client.chat.completions.create(
        payload as unknown as Parameters<typeof this.client.chat.completions.create>[0],
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`ollama call failed: ${message}`, "ollama", err)
    }

    const completion = response as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }> | null
        }
        finish_reason?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const choice = completion.choices?.[0]
    if (!choice) {
      throw new ProviderError("ollama call returned no choices", "ollama")
    }

    const text = choice.message?.content ?? ""
    const rawToolCalls = choice.message?.tool_calls ?? []
    const toolCalls: HarnessToolCall[] = rawToolCalls.map((tc) => {
      let args: unknown
      // Note (Ezra, 2026-04-22): smaller Ollama-hosted models occasionally emit malformed
      // tool-call JSON; we surface it as a sentinel arg object so the tool runtime's schema
      // validation rejects it as a normal tool error rather than crashing the loop.
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
      } catch {
        args = { __raw: tc.function.arguments, __parseError: true }
      }
      return { id: tc.id, name: tc.function.name, args }
    })

    const result: ProviderResponse = {
      text,
      toolCalls,
      stopReason: mapStopReason(choice.finish_reason),
      raw: response,
    }
    if (completion.usage) {
      result.usage = {
        promptTokens: completion.usage.prompt_tokens ?? 0,
        completionTokens: completion.usage.completion_tokens ?? 0,
      }
    }
    return result
  }
}

function mapStopReason(reason: string | undefined): ProviderResponse["stopReason"] {
  switch (reason) {
    case "stop":
      return "stop"
    case "tool_calls":
    case "function_call":
      return "tool_calls"
    case "length":
      return "length"
    case "content_filter":
      return "stop"
    default:
      return "stop"
  }
}
