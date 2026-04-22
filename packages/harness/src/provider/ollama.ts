import { OpenAICompatProvider } from "./openai-compat.js"

export interface OllamaProviderOptions {
  baseURL?: string
  apiKey?: string
  defaultModel?: string
}

export class OllamaProvider extends OpenAICompatProvider {
  constructor(options: OllamaProviderOptions = {}) {
    super({
      name: "ollama",
      apiKey: options.apiKey ?? "ollama",
      baseURL:
        options.baseURL ?? process.env.LEHARNESS_OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      defaultModel: options.defaultModel ?? "gemma4:26b",
    })
  }
}
