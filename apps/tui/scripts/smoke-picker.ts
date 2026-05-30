import assert from "node:assert/strict"
import type { ModelSpec } from "@leharness/harness"
import { allModelChoices, scorePickerItem, searchPickerItems } from "../src/picker/search.js"

const MODELS: ModelSpec[] = [
  {
    id: "gpt-5.4",
    provider: "openai",
    label: "GPT-5.4",
    description: "Frontier reasoning model.",
    supportsReasoning: true,
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    description: "Most capable Claude.",
    supportsReasoning: true,
  },
]

// scorePickerItem: an exact name match outranks a substring/description hit.
const opus = {
  description: "Most capable Claude.",
  kind: "model",
  model: MODELS[1],
  name: "anthropic/claude-opus-4-8",
} as const
const gpt = {
  description: "Frontier reasoning model.",
  kind: "model",
  model: MODELS[0],
  name: "openai/gpt-5.4",
} as const
assert.ok(
  scorePickerItem(opus, "anthropic/claude-opus-4-8") >
    scorePickerItem(gpt, "anthropic/claude-opus-4-8"),
  "exact-ish name match should score higher than an unrelated model",
)
assert.equal(scorePickerItem(gpt, "nonsense-xyz"), 0, "no match scores zero")

// searchPickerItems: empty query returns all models; a query filters + ranks.
const all = searchPickerItems({
  currentEffort: undefined,
  currentModel: "gpt-5.4",
  currentProvider: "openai",
  kind: "model",
  models: MODELS,
  query: "",
})
assert.equal(all.length, 2, "empty query lists every model")
assert.ok(
  all.find((item) => item.name === "openai/gpt-5.4")?.description.startsWith("Current."),
  "the current model is marked Current.",
)

const filtered = searchPickerItems({
  currentEffort: undefined,
  currentModel: "gpt-5.4",
  currentProvider: "openai",
  kind: "model",
  models: MODELS,
  query: "opus",
})
assert.equal(filtered[0]?.name, "anthropic/claude-opus-4-8", "query ranks the matching model first")

// effort picker always offers the three effort levels and marks the current one.
const efforts = searchPickerItems({
  currentEffort: "high",
  currentModel: "gpt-5.4",
  currentProvider: "openai",
  kind: "effort",
  models: MODELS,
  query: "",
})
assert.deepEqual(
  efforts.map((item) => item.name),
  ["off", "high", "max"],
  "effort options are off / high / max",
)
assert.ok(
  efforts.find((item) => item.name === "high")?.description.startsWith("Current."),
  "the active effort is marked Current.",
)

// allModelChoices prepends the live CLI/env model when it isn't a builtin.
const withCustom = allModelChoices("openai", "some-custom-model")
assert.equal(withCustom[0]?.id, "some-custom-model", "an unknown current model is offered first")

console.log("smoke-picker: scoring, model/effort search, and current-model injection ok")
