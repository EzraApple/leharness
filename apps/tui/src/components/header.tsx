import type { HarnessDeps } from "@leharness/harness"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"

export function Header({
  deps,
  running,
  status,
}: {
  deps: HarnessDeps
  running: boolean
  status: string
}) {
  return (
    <Box justifyContent="space-between">
      <Box gap={1}>
        <Text bold># leharness</Text>
        {running ? (
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        ) : undefined}
      </Box>
      <Box gap={1}>
        <Text color={running ? "yellow" : "gray"}>{status}</Text>
        <Text color="gray">
          {deps.provider.name}/{deps.model}
        </Text>
      </Box>
    </Box>
  )
}

export function SessionLine({ sessionId }: { sessionId: string }) {
  return <Text color="gray">┃ session {sessionId}</Text>
}
