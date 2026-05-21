import type { HarnessDeps } from "@leharness/harness"
import { Box, Text } from "ink"
import stringWidth from "string-width"

export function SessionHeader({
  deps,
  priorEventCount,
  sessionId,
  width,
}: {
  deps: HarnessDeps
  priorEventCount: number
  sessionId: string
  width: number
}) {
  const runtime = [
    `${deps.provider.name}/${deps.model}`,
    deps.reasoningEffort === undefined ? undefined : `effort ${deps.reasoningEffort}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ")
  const session = `session ${sessionId}`
  const prior = priorEventCount > 0 ? `${priorEventCount} prior events` : undefined

  return (
    <Box
      borderColor="gray"
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
      width={Math.max(40, width)}
    >
      <Box justifyContent="space-between">
        <Text bold>leharness</Text>
        <Text color="gray">{prior ?? "tui"}</Text>
      </Box>
      <Text color="gray">{trimToWidth(`${runtime} · ${session}`, Math.max(20, width - 4))}</Text>
    </Box>
  )
}

function trimToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  const target = Math.max(1, width - 1)
  let out = ""
  for (const char of text) {
    if (stringWidth(`${out}${char}`) > target) break
    out += char
  }
  return `${out}…`
}
