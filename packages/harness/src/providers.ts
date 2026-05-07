import { DeepSeekProvider } from "./provider/deepseek.js"
import type { Provider } from "./provider/index.js"
import { OllamaProvider } from "./provider/ollama.js"
import { OpenAIProvider } from "./provider/openai.js"

export const SUPPORTED_PROVIDERS = ["ollama", "openai", "deepseek"] as const

export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number]

export function isProviderName(value: string): value is ProviderName {
  return SUPPORTED_PROVIDERS.includes(value as ProviderName)
}

export function buildProvider(name: string): Provider {
  switch (name) {
    case "ollama":
      return new OllamaProvider()
    case "openai":
      return new OpenAIProvider()
    case "deepseek":
      return new DeepSeekProvider()
    default:
      throw new Error(`unknown provider: ${name}. Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`)
  }
}

export function defaultModelFor(providerName: string): string {
  if (providerName === "ollama") return "qwen3.6:27b-coding-nvfp4"
  if (providerName === "openai") return "gpt-4o-mini"
  if (providerName === "deepseek") return "deepseek-v4-flash"
  throw new Error(`no default model for provider: ${providerName}`)
}
