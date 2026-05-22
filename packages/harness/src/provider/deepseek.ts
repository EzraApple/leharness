// deepseek.ts
// DeepSeek Provider: wraps OpenAICompatProvider against
// https://api.deepseek.com (LEHARNESS_DEEPSEEK_BASE_URL overrides). Adds
// DeepSeek-specific reasoning-effort handling — when effort is "high" /
// "max" the API expects a different model name suffix, so the request is
// rewritten before being sent.

import type { ReasoningEffort } from "../models.js"
import type { ProviderRequest } from "./index.js"
import { ProviderError } from "./index.js"
import { OpenAICompatProvider } from "./openai-compat.js"

export interface DeepSeekProviderOptions {
  apiKey?: string
  baseURL?: string
  defaultModel?: string
}

export class DeepSeekProvider extends OpenAICompatProvider {
  constructor(options: DeepSeekProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY
    if (!apiKey) {
      throw new ProviderError(
        "DEEPSEEK_API_KEY not set; pass apiKey via options or env",
        "deepseek",
      )
    }
    super({
      name: "deepseek",
      apiKey,
      baseURL:
        options.baseURL ?? process.env.LEHARNESS_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      defaultModel: options.defaultModel ?? "deepseek-v4-flash",
      replayReasoningContent: true,
    })
  }

  protected override customizeBody(req: ProviderRequest, body: Record<string, unknown>): void {
    body.thinking = deepSeekThinking(req.reasoningEffort)
  }
}

function deepSeekThinking(effort: ReasoningEffort | undefined): {
  type: "enabled" | "disabled"
  reasoning_effort?: "high" | "max"
} {
  if (effort === "off") return { type: "disabled" }
  if (effort === "max") return { type: "enabled", reasoning_effort: "max" }
  return { type: "enabled", reasoning_effort: "high" }
}
