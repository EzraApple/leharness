import { ProviderError } from "./index.js"
import { OpenAICompatProvider } from "./openai-compat.js"

export interface OpenAIProviderOptions {
  apiKey?: string
  baseURL?: string
  organization?: string
  defaultModel?: string
}

export class OpenAIProvider extends OpenAICompatProvider {
  constructor(options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new ProviderError("OPENAI_API_KEY not set; pass apiKey via options or env", "openai")
    }
    super({
      name: "openai",
      apiKey,
      baseURL: options.baseURL ?? process.env.LEHARNESS_OPENAI_BASE_URL,
      organization: options.organization ?? process.env.OPENAI_ORG_ID,
      defaultModel: options.defaultModel ?? "gpt-4o-mini",
    })
  }
}
