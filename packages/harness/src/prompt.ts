import type { HarnessMessage, HarnessTool, ProviderRequest } from "./provider/index.js"
import type { SessionState } from "./session.js"

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful coding assistant operating inside a harness. You have access to tools when provided. Call tools when you need information or actions; respond directly when you have what you need. Stop calling tools when the task is complete and reply with a short summary."

export interface BuildPromptOptions {
  model: string
  system?: string | undefined
  temperature?: number | undefined
  maxOutputTokens?: number | undefined
}

export function buildPrompt(
  session: SessionState,
  tools: HarnessTool[],
  options: BuildPromptOptions,
): ProviderRequest {
  const messages: HarnessMessage[] = session.transcript.map(transcriptToMessage)
  return {
    model: options.model,
    system: options.system,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
  }
}

function transcriptToMessage(entry: SessionState["transcript"][number]): HarnessMessage {
  switch (entry.kind) {
    case "user":
      return { role: "user", content: entry.text }
    case "assistant":
      return { role: "assistant", content: entry.text, toolCalls: entry.toolCalls }
    case "tool_result":
      return { role: "tool", toolCallId: entry.callId, content: entry.content }
    case "tool_error":
      return { role: "tool", toolCallId: entry.callId, content: `error: ${entry.error}` }
  }
}
