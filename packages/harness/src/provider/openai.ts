import OpenAI from "openai"
import {
  type HarnessMessage,
  type HarnessTool,
  type HarnessToolCall,
  type Provider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
} from "./index.js"

export interface OpenAIProviderOptions {
  apiKey?: string
  baseURL?: string
  organization?: string
  defaultModel?: string
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
      }>
    }
  | { role: "tool"; tool_call_id: string; content: string }

interface OpenAITool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ChatCompletionBody {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: "auto"
  temperature?: number
  max_tokens?: number
  stream: false
}

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAIChoice {
  message: {
    content: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: string | null
}

interface OpenAIChatCompletion {
  choices: OpenAIChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

export class OpenAIProvider implements Provider {
  readonly name = "openai"
  private client: OpenAI
  private defaultModel: string

  constructor(options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new ProviderError("OPENAI_API_KEY not set; pass apiKey via options or env", "openai")
    }
    const baseURL = options.baseURL ?? process.env.LEHARNESS_OPENAI_BASE_URL
    const organization = options.organization ?? process.env.OPENAI_ORG_ID

    const clientOpts: { apiKey: string; baseURL?: string; organization?: string } = { apiKey }
    if (baseURL !== undefined) clientOpts.baseURL = baseURL
    if (organization !== undefined) clientOpts.organization = organization

    this.client = new OpenAI(clientOpts)
    this.defaultModel = options.defaultModel ?? "gpt-4o-mini"
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const messages: OpenAIMessage[] = []
    if (req.system) {
      messages.push({ role: "system", content: req.system })
    }
    for (const msg of req.messages) {
      messages.push(translateMessage(msg))
    }

    const body: ChatCompletionBody = {
      model: req.model || this.defaultModel,
      messages,
      stream: false,
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(translateTool)
      body.tool_choice = "auto"
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature
    }
    if (req.maxOutputTokens !== undefined) {
      body.max_tokens = req.maxOutputTokens
    }

    let response: OpenAIChatCompletion
    try {
      response = (await this.client.chat.completions.create(
        body as never,
      )) as unknown as OpenAIChatCompletion
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`openai call failed: ${message}`, "openai", err)
    }

    const choice = response?.choices?.[0]
    if (!choice) {
      throw new ProviderError("openai response had no choices", "openai")
    }

    const text = choice.message?.content ?? ""
    const rawToolCalls = choice.message?.tool_calls ?? []
    const toolCalls: HarnessToolCall[] = rawToolCalls.map((tc) => parseToolCall(tc))

    const result: ProviderResponse = {
      text,
      toolCalls,
      stopReason: mapStopReason(choice.finish_reason),
      raw: response,
    }
    if (response.usage) {
      result.usage = {
        promptTokens: response.usage.prompt_tokens ?? 0,
        completionTokens: response.usage.completion_tokens ?? 0,
      }
    }
    return result
  }
}

function translateMessage(msg: HarnessMessage): OpenAIMessage {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content }
    case "assistant": {
      const out: OpenAIMessage = {
        role: "assistant",
        content: msg.content || null,
      }
      if (msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }))
      }
      return out
    }
    case "tool":
      return { role: "tool", tool_call_id: msg.toolCallId, content: msg.content }
  }
}

function translateTool(tool: HarnessTool): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schemaJson,
    },
  }
}

function parseToolCall(tc: OpenAIToolCall): HarnessToolCall {
  let args: unknown
  try {
    args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
  } catch {
    args = { __raw: tc.function.arguments, __parseError: true }
  }
  return { id: tc.id, name: tc.function.name, args }
}

function mapStopReason(reason: string | null | undefined): ProviderResponse["stopReason"] {
  switch (reason) {
    case "stop":
      return "stop"
    case "tool_calls":
      return "tool_calls"
    case "length":
      return "length"
    case "function_call":
      return "tool_calls"
    case "content_filter":
      return "stop"
    default:
      return "stop"
  }
}
