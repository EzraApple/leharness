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

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

interface OpenAITool {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
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

interface OpenAIChatCompletion {
  choices: Array<{
    message: { content: string | null; tool_calls?: OpenAIToolCall[] }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface OpenAICompatOptions {
  name: string
  apiKey: string
  baseURL?: string
  organization?: string
  defaultModel: string
}

export class OpenAICompatProvider implements Provider {
  readonly name: string
  protected client: OpenAI
  protected defaultModel: string

  constructor(options: OpenAICompatOptions) {
    this.name = options.name
    this.defaultModel = options.defaultModel
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      organization: options.organization,
    })
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const messages: OpenAIMessage[] = []
    if (req.system) messages.push({ role: "system", content: req.system })
    for (const msg of req.messages) messages.push(translateMessage(msg))

    const body: OpenAIChatRequest = {
      model: req.model || this.defaultModel,
      messages,
      stream: false,
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(translateTool)
      body.tool_choice = "auto"
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens

    let response: OpenAIChatCompletion
    try {
      response = (await this.client.chat.completions.create(body as never, {
        signal: req.signal,
      })) as unknown as OpenAIChatCompletion
    } catch (err) {
      if (req.signal?.aborted) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`${this.name} call failed: ${message}`, this.name, err)
    }

    const choice = response?.choices?.[0]
    if (!choice) {
      throw new ProviderError(`${this.name} response had no choices`, this.name)
    }

    const result: ProviderResponse = {
      text: choice.message?.content ?? "",
      toolCalls: (choice.message?.tool_calls ?? []).map(parseToolCall),
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
      const out: OpenAIMessage = { role: "assistant", content: msg.content || null }
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
    function: { name: tool.name, description: tool.description, parameters: tool.schemaJson },
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
    case "tool_calls":
    case "function_call":
      return "tool_calls"
    case "length":
      return "length"
    default:
      return "stop"
  }
}
