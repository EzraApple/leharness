import type { PromptInput } from "../prompt.js"
import { naiveTruncate } from "./naive-truncate.js"

export { naiveTruncate } from "./naive-truncate.js"

export async function compact(input: PromptInput): Promise<PromptInput> {
  return naiveTruncate(input)
}
