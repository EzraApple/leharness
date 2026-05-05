import { Box, Text } from "ink"
import TextInput from "ink-text-input"

export function Prompt({
  input,
  inputVersion,
  running,
  setInput,
  submit,
}: {
  input: string
  inputVersion: number
  running: boolean
  setInput: (value: string) => void
  submit: (value: string) => void
}) {
  return (
    <Box borderColor={running ? "yellow" : "cyan"} borderStyle="single" marginTop={1} paddingX={1}>
      <TextInput
        focus
        highlightPastedText
        key={inputVersion}
        onChange={setInput}
        onSubmit={submit}
        placeholder={running ? "Queue next message..." : "Ask leharness..."}
        showCursor
        value={input}
      />
    </Box>
  )
}

export function Footer({ queuedCount, running }: { queuedCount: number; running: boolean }) {
  const action =
    running && queuedCount > 0
      ? "enter queue · empty enter interrupt"
      : running
        ? "enter queue"
        : queuedCount > 0
          ? "empty enter send queued"
          : "enter send"

  return (
    <Box justifyContent="space-between">
      <Text color="gray">{action}</Text>
      <Text color="gray">esc abort · ctrl-c exit · scroll: pgup/pgdn home/end · /help</Text>
    </Box>
  )
}
