import type { HarnessMessage, HarnessTool, ProviderRequest } from "./provider/index.js"
import type { SessionState } from "./session.js"

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful coding assistant operating inside a harness. You have access to tools when provided. Call tools when you need information or actions; respond directly when you have what you need. Stop calling tools when the task is complete and reply with a short summary."

export interface BuildPromptOptions {
  model: string
  system?: string
  temperature?: number
  maxOutputTokens?: number
}

export function buildPrompt(
  session: SessionState,
  tools: HarnessTool[],
  options: BuildPromptOptions,
): ProviderRequest {
  const messages: HarnessMessage[] = []
  for (const entry of session.transcript) {
    switch (entry.kind) {
      case "user":
        messages.push({ role: "user", content: entry.text })
        break
      case "assistant":
        messages.push({
          role: "assistant",
          content: entry.text,
          toolCalls: entry.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
        })
        break
      case "tool_result":
        messages.push({ role: "tool", toolCallId: entry.callId, content: entry.content })
        break
      case "tool_error":
        messages.push({
          role: "tool",
          toolCallId: entry.callId,
          content: `error: ${entry.error}`,
        })
        break
    }
  }

  const request: ProviderRequest = {
    model: options.model,
    ...(options.system !== undefined ? { system: options.system } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
  }
  return request
}
