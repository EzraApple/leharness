import type { HarnessDeps } from "@leharness/harness"
import { Box, Text } from "ink"

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
  return (
    <Box
      borderColor="gray"
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
      width={Math.max(44, width)}
    >
      <Box justifyContent="space-between">
        <Text bold>leharness</Text>
        <Text color="gray">tui</Text>
      </Box>
      <Text color="gray">session {sessionId}</Text>
      <Text color="gray">
        {deps.provider.name} / {deps.model}
      </Text>
      {priorEventCount > 0 ? <Text color="gray">{priorEventCount} prior events loaded</Text> : null}
    </Box>
  )
}
