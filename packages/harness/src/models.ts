// models.ts
// Model metadata the CLI / TUI need to render picker UIs and the harness
// needs to default reasoning effort. ModelSpec captures id, friendly label,
// provider, and reasoning capability; BUILTIN_MODELS is the static list the
// /model slash command shows.

export type ReasoningEffort = "off" | "high" | "max"

export interface ModelSpec {
  id: string
  provider: string
  label: string
  description: string
  supportsReasoning: boolean
  defaultReasoningEffort?: ReasoningEffort
  contextWindowTokens?: number
}

// Fallback when a model isn't in BUILTIN_MODELS or didn't declare its window.
// Conservative so the budget is small enough to surface compaction issues
// rather than silently letting prompts blow past the provider's real cap.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000

export const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    description: "Fast, low-cost DeepSeek model with 1M context and tool calls.",
    // Flash doesn't expose controllable reasoning effort yet, so /effort stays
    // hidden for it (the deepseek provider still parses reasoning_content when
    // a model emits it).
    supportsReasoning: false,
    contextWindowTokens: 1_000_000,
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    description: "Stronger DeepSeek model for harder coding and agent tasks.",
    supportsReasoning: true,
    defaultReasoningEffort: "high",
    contextWindowTokens: 1_000_000,
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    label: "GPT-4o Mini",
    description: "OpenAI default model for inexpensive general use.",
    supportsReasoning: false,
    contextWindowTokens: 128_000,
  },
  {
    id: "granite4.1:8b",
    provider: "ollama",
    label: "Granite 4.1 8B",
    description: "Small current local model for fast harness and tool-loop tests.",
    supportsReasoning: false,
    contextWindowTokens: 32_000,
  },
  {
    id: "qwen3.6:27b-coding-nvfp4",
    provider: "ollama",
    label: "Qwen 3.6 27B Coding",
    description: "Current dense local coding model for balanced speed and quality.",
    supportsReasoning: false,
    contextWindowTokens: 128_000,
  },
  {
    id: "qwen3.6:35b-a3b-coding-nvfp4",
    provider: "ollama",
    label: "Qwen 3.6 35B A3B Coding",
    description: "Current MoE local coding model for higher-quality local runs.",
    supportsReasoning: false,
    contextWindowTokens: 128_000,
  },
  {
    id: "gemma4:26b",
    provider: "ollama",
    label: "Gemma 4 26B",
    description: "Local general model kept for comparison against Qwen coding models.",
    supportsReasoning: false,
    contextWindowTokens: 32_000,
  },
  {
    id: "gemma4:31b",
    provider: "ollama",
    label: "Gemma 4 31B",
    description: "Larger local Gemma model for quality-biased runs.",
    supportsReasoning: false,
    contextWindowTokens: 32_000,
  },
]

export function modelsForProvider(providerName: string): ModelSpec[] {
  return BUILTIN_MODELS.filter((model) => model.provider === providerName)
}

export function findModel(id: string, providerName?: string): ModelSpec | undefined {
  return BUILTIN_MODELS.find(
    (model) => model.id === id && (providerName === undefined || model.provider === providerName),
  )
}

export function modelSupportsReasoning(modelId: string, providerName?: string): boolean {
  return findModel(modelId, providerName)?.supportsReasoning === true
}

export function contextWindowTokensForModel(modelId: string, providerName?: string): number {
  return findModel(modelId, providerName)?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
}

export function defaultReasoningEffortForModel(
  modelId: string,
  providerName?: string,
): ReasoningEffort | undefined {
  return findModel(modelId, providerName)?.defaultReasoningEffort
}

export function qualifiedModelId(model: Pick<ModelSpec, "id" | "provider">): string {
  return `${model.provider}/${model.id}`
}

export function findModelByReference(
  reference: string,
  defaultProviderName?: string,
): ModelSpec | undefined {
  const slashIndex = reference.indexOf("/")
  if (slashIndex > 0) {
    const providerName = reference.slice(0, slashIndex)
    const modelId = reference.slice(slashIndex + 1)
    return findModel(modelId, providerName)
  }

  const scoped =
    defaultProviderName === undefined ? undefined : findModel(reference, defaultProviderName)
  if (scoped !== undefined) return scoped

  const matches = BUILTIN_MODELS.filter((model) => model.id === reference)
  return matches.length === 1 ? matches[0] : undefined
}
