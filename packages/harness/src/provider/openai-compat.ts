// openai-compat.ts
// Shared adapter for any provider that speaks the OpenAI chat-completions
// API shape (OpenAI itself, Ollama via its /v1 endpoint, DeepSeek). Owns the
// HarnessMessage → openai request translation, streaming response parsing,
// and ProviderError mapping. Per-provider files (openai.ts, ollama.ts,
// deepseek.ts) extend this with their own auth / base-URL config.

import OpenAI from "openai"
import type { ToolCall } from "../tools.js"
import {
  type HarnessMessage,
  type HarnessTool,
  type Provider,
  ProviderError,
  type ProviderRequest,
  type ProviderResponse,
  type ToolCallDelta,
} from "./index.js"

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant"
      content: string | null
      reasoning_content?: string
      tool_calls?: OpenAIToolCall[]
    }
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
  stream: boolean
  stream_options?: { include_usage: boolean }
  [key: string]: unknown
}

interface OpenAIChatCompletion {
  choices: Array<{
    message: {
      content: string | null
      reasoning?: string
      reasoning_content?: string
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface OpenAIChunkToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIChatChunk {
  choices: Array<{
    delta?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
      tool_calls?: OpenAIChunkToolCallDelta[]
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface OpenAICompatOptions {
  name: string
  apiKey: string
  baseURL?: string
  organization?: string
  defaultModel: string
  replayReasoningContent?: boolean
}

export class OpenAICompatProvider implements Provider {
  readonly name: string
  protected client: OpenAI
  protected defaultModel: string
  protected replayReasoningContent: boolean

  constructor(options: OpenAICompatOptions) {
    this.name = options.name
    this.defaultModel = options.defaultModel
    this.replayReasoningContent = options.replayReasoningContent ?? false
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      organization: options.organization,
    })
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.onText || req.onReasoningText || req.onToolCallDelta) return this.callStreaming(req)
    return this.callNonStreaming(req)
  }

  protected buildBody(req: ProviderRequest, stream: boolean): OpenAIChatRequest {
    const messages: OpenAIMessage[] = []
    if (req.system) messages.push({ role: "system", content: req.system })
    for (const msg of req.messages) messages.push(this.translateMessage(msg))

    const body: OpenAIChatRequest = {
      model: req.model || this.defaultModel,
      messages,
      stream,
    }
    if (stream) body.stream_options = { include_usage: true }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(translateTool)
      body.tool_choice = "auto"
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens
    this.customizeBody(req, body)
    return body
  }

  protected customizeBody(_req: ProviderRequest, _body: OpenAIChatRequest) {}

  protected translateMessage(msg: HarnessMessage): OpenAIMessage {
    switch (msg.role) {
      case "user":
        return { role: "user", content: msg.content }
      case "assistant": {
        const out: OpenAIMessage = { role: "assistant", content: msg.content || null }
        if (this.replayReasoningContent && msg.reasoningText !== undefined) {
          out.reasoning_content = msg.reasoningText
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

  private async callNonStreaming(req: ProviderRequest): Promise<ProviderResponse> {
    const body = this.buildBody(req, false)
    let response: OpenAIChatCompletion
    try {
      // oxlint-disable-next-line leharness/no-as-cast -- OpenAI SDK overloads do not accept the shared provider-compatible request body.
      response = (await this.client.chat.completions.create(body as never, {
        signal: req.signal,
      })) as unknown as OpenAIChatCompletion
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`${this.name} call failed: ${message}`, this.name, err)
    }

    const choice = response?.choices?.[0]
    if (!choice) throw new ProviderError(`${this.name} response had no choices`, this.name)

    const normalized = normalizeReasoningText(
      choice.message?.content ?? "",
      choice.message?.reasoning_content ?? choice.message?.reasoning,
    )
    const result: ProviderResponse = {
      text: normalized.text,
      reasoningText: normalized.reasoningText,
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

  private async callStreaming(req: ProviderRequest): Promise<ProviderResponse> {
    const body = this.buildBody(req, true)
    let stream: AsyncIterable<OpenAIChatChunk>
    try {
      // oxlint-disable-next-line leharness/no-as-cast -- OpenAI SDK overloads do not accept the shared provider-compatible streaming body.
      stream = (await this.client.chat.completions.create(body as never, {
        signal: req.signal,
      })) as unknown as AsyncIterable<OpenAIChatChunk>
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`${this.name} stream open failed: ${message}`, this.name, err)
    }

    let text = ""
    let reasoningText = ""
    const inlineReasoning = new InlineReasoningParser(
      (delta) => {
        text += delta
        req.onText?.(delta)
      },
      (delta) => {
        reasoningText += delta
        req.onReasoningText?.(delta)
      },
    )
    const toolCalls: OpenAIToolCall[] = []
    let finishReason: string | null = null
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
    let lastChunk: OpenAIChatChunk | null = null

    try {
      for await (const chunk of stream) {
        if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError")
        lastChunk = chunk
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        if (delta.content) {
          if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError")
          inlineReasoning.write(delta.content)
        }
        const nativeReasoning = delta.reasoning_content ?? delta.reasoning
        if (nativeReasoning) {
          if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError")
          reasoningText += nativeReasoning
          req.onReasoningText?.(nativeReasoning)
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } }
            }
            const slot = toolCalls[idx]
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.function.name += tc.function.name
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
            emitToolCallDelta(req, idx, slot, tc.function?.arguments)
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
      inlineReasoning.finish()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`${this.name} stream failed: ${message}`, this.name, err)
    }

    const result: ProviderResponse = {
      text,
      reasoningText: reasoningText.length > 0 ? reasoningText : undefined,
      toolCalls: toolCalls.map(parseToolCall),
      stopReason: mapStopReason(finishReason),
      raw: lastChunk,
    }
    if (usage) {
      result.usage = {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      }
    }
    return result
  }
}

function translateTool(tool: HarnessTool): OpenAITool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.schemaJson },
  }
}

function parseToolCall(tc: OpenAIToolCall): ToolCall {
  let args: unknown
  try {
    args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
  } catch {
    args = { __raw: tc.function.arguments, __parseError: true }
  }
  return { id: tc.id, name: tc.function.name, args }
}

function emitToolCallDelta(
  req: ProviderRequest,
  index: number,
  slot: OpenAIToolCall,
  argumentsDelta: string | undefined,
) {
  const delta: ToolCallDelta = { index }
  if (slot.id.length > 0) delta.id = slot.id
  if (slot.function.name.length > 0) delta.name = slot.function.name
  if (argumentsDelta !== undefined) delta.argumentsDelta = argumentsDelta
  if (slot.function.arguments.length > 0) delta.argumentsText = slot.function.arguments
  req.onToolCallDelta?.(delta)
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

function normalizeReasoningText(
  rawText: string,
  nativeReasoningText: string | undefined,
): { text: string; reasoningText?: string } {
  const extracted = extractThinkTags(rawText)
  const reasoningParts = [nativeReasoningText, extracted.reasoningText].filter(
    (part): part is string => part !== undefined && part.length > 0,
  )
  return {
    text: extracted.text,
    reasoningText: reasoningParts.length > 0 ? reasoningParts.join("\n") : undefined,
  }
}

function extractThinkTags(rawText: string): { text: string; reasoningText?: string } {
  const parser = new InlineReasoningParser()
  parser.write(rawText)
  parser.finish()
  return parser.result()
}

class InlineReasoningParser {
  private buffer = ""
  private mode: "text" | "reasoning" = "text"
  private readonly textParts: string[] = []
  private readonly reasoningParts: string[] = []

  constructor(
    private readonly onText?: (delta: string) => void,
    private readonly onReasoningText?: (delta: string) => void,
  ) {}

  write(chunk: string) {
    this.buffer += chunk
    this.drain(false)
  }

  finish() {
    this.drain(true)
  }

  result(): { text: string; reasoningText?: string } {
    const text = this.textParts.join("")
    const reasoningText = this.reasoningParts.join("")
    return { text, reasoningText: reasoningText.length > 0 ? reasoningText : undefined }
  }

  private drain(final: boolean) {
    while (this.buffer.length > 0) {
      const tag = this.mode === "text" ? "<think>" : "</think>"
      const index = this.buffer.indexOf(tag)
      if (index >= 0) {
        this.emit(this.buffer.slice(0, index))
        this.buffer = this.buffer.slice(index + tag.length)
        this.mode = this.mode === "text" ? "reasoning" : "text"
        continue
      }

      if (final) {
        this.emit(this.buffer)
        this.buffer = ""
        return
      }

      const keep = partialTagPrefixLength(this.buffer, tag)
      const emitLength = this.buffer.length - keep
      if (emitLength <= 0) return
      this.emit(this.buffer.slice(0, emitLength))
      this.buffer = this.buffer.slice(emitLength)
    }
  }

  private emit(value: string) {
    if (value.length === 0) return
    if (this.mode === "text") {
      this.textParts.push(value)
      this.onText?.(value)
      return
    }
    this.reasoningParts.push(value)
    this.onReasoningText?.(value)
  }
}

function partialTagPrefixLength(value: string, tag: string): number {
  const maxLength = Math.min(value.length, tag.length - 1)
  for (let length = maxLength; length > 0; length--) {
    if (tag.startsWith(value.slice(value.length - length))) return length
  }
  return 0
}
