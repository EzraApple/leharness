export type ReasoningEffort = "off" | "high" | "max"

export interface ModelSpec {
  id: string
  provider: string
  label: string
  description: string
  supportsReasoning: boolean
  defaultReasoningEffort?: ReasoningEffort
}

export const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    description: "Fast, low-cost DeepSeek model with 1M context and tool calls.",
    supportsReasoning: true,
    defaultReasoningEffort: "high",
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    description: "Stronger DeepSeek model for harder coding and agent tasks.",
    supportsReasoning: true,
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    label: "GPT-4o Mini",
    description: "OpenAI default model for inexpensive general use.",
    supportsReasoning: false,
  },
  {
    id: "granite4.1:8b",
    provider: "ollama",
    label: "Granite 4.1 8B",
    description: "Small current local model for fast harness and tool-loop tests.",
    supportsReasoning: false,
  },
  {
    id: "qwen3.6:27b-coding-nvfp4",
    provider: "ollama",
    label: "Qwen 3.6 27B Coding",
    description: "Current dense local coding model for balanced speed and quality.",
    supportsReasoning: false,
  },
  {
    id: "qwen3.6:35b-a3b-coding-nvfp4",
    provider: "ollama",
    label: "Qwen 3.6 35B A3B Coding",
    description: "Current MoE local coding model for higher-quality local runs.",
    supportsReasoning: false,
  },
  {
    id: "gemma4:26b",
    provider: "ollama",
    label: "Gemma 4 26B",
    description: "Local general model kept for comparison against Qwen coding models.",
    supportsReasoning: false,
  },
  {
    id: "gemma4:31b",
    provider: "ollama",
    label: "Gemma 4 31B",
    description: "Larger local Gemma model for quality-biased runs.",
    supportsReasoning: false,
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
