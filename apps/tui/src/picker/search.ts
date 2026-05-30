// picker/search.ts
// Pure search/scoring for the model + effort modal picker, lifted out of
// app.tsx so the stateful glue there stays small and this stays testable.
// Nothing here touches React — given a query and the current selection, it
// returns the ranked items to show.

import {
  BUILTIN_MODELS,
  findModel,
  type ModelSpec,
  qualifiedModelId,
  type ReasoningEffort,
} from "@leharness/harness"
import type { MenuItem } from "../components/slash-menu.js"

export type PickerKind = "effort" | "model"

export interface PickerState {
  kind: PickerKind
  selectedIndex: number
}

export type PickerItem =
  | (MenuItem & { kind: "model"; model: ModelSpec })
  | (MenuItem & { effort: ReasoningEffort; kind: "effort" })

// The models to offer: the builtin set, plus the current CLI/env model when
// it isn't one of the builtins (so it stays selectable).
export function allModelChoices(currentProviderName: string, currentModel: string): ModelSpec[] {
  if (findModel(currentModel, currentProviderName) !== undefined) return BUILTIN_MODELS
  return [
    {
      id: currentModel,
      provider: currentProviderName,
      label: currentModel,
      description: "Current model from CLI/env.",
      supportsReasoning: false,
    },
    ...BUILTIN_MODELS,
  ]
}

export function searchPickerItems({
  currentEffort,
  currentModel,
  currentProvider,
  kind,
  models,
  query,
}: {
  currentEffort: ReasoningEffort | undefined
  currentModel: string
  currentProvider: string
  kind: PickerKind
  models: ModelSpec[]
  query: string
}): PickerItem[] {
  const items = kind === "model" ? modelPickerItems(models) : effortPickerItems()
  return items
    .map((item, index) => ({
      index,
      item: withCurrentDescription(item, {
        currentEffort,
        currentModel,
        currentProvider,
      }),
      score: scorePickerItem(item, query),
    }))
    .filter((entry) => query.trim().length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 7)
    .map((entry) => entry.item)
}

export function pickerPlaceholder(picker: PickerState | undefined): string | undefined {
  if (picker?.kind === "model") return "Search models..."
  if (picker?.kind === "effort") return "Search effort..."
  return undefined
}

function modelPickerItems(models: ModelSpec[]): PickerItem[] {
  return models.map((model) => ({
    description: model.description,
    kind: "model",
    model,
    name: qualifiedModelId(model),
  }))
}

function effortPickerItems(): PickerItem[] {
  return [
    {
      description: "Disable provider-controlled thinking for future turns.",
      effort: "off",
      kind: "effort",
      name: "off",
    },
    {
      description: "Use the provider's stronger default thinking path.",
      effort: "high",
      kind: "effort",
      name: "high",
    },
    {
      description: "Use maximum provider-controlled thinking for harder tasks.",
      effort: "max",
      kind: "effort",
      name: "max",
    },
  ]
}

function withCurrentDescription(
  item: PickerItem,
  current: {
    currentEffort: ReasoningEffort | undefined
    currentModel: string
    currentProvider: string
  },
): PickerItem {
  if (
    item.kind === "model" &&
    item.model.id === current.currentModel &&
    item.model.provider === current.currentProvider
  ) {
    return { ...item, description: `Current. ${item.description}` }
  }
  if (item.kind === "effort" && item.effort === (current.currentEffort ?? "high")) {
    return { ...item, description: `Current. ${item.description}` }
  }
  return item
}

export function scorePickerItem(item: PickerItem, query: string): number {
  const normalizedQuery = normalize(query)
  if (normalizedQuery.length === 0) {
    if (item.kind === "effort") return 120
    return item.kind === "model" ? 100 : 90
  }

  const haystack =
    item.kind === "model"
      ? normalize(
          [
            item.name,
            item.model.id,
            item.model.provider,
            item.model.label,
            item.model.description,
          ].join(" "),
        )
      : normalize(`${item.name} ${item.description}`)
  let score = 0
  if (normalize(item.name) === normalizedQuery) score += 1000
  if (normalize(item.name).startsWith(normalizedQuery)) score += 700
  if (haystack.includes(normalizedQuery)) score += 400
  for (const token of normalizedQuery.split(/\s+/g)) {
    if (token.length > 0 && haystack.includes(token)) score += 120
  }
  return score
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/^\/+/, "").trim()
}
