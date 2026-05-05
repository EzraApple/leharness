import { Box, Text } from "ink"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { QueuedMessage } from "../state/types.js"

const MAX_VISIBLE_MESSAGES = 4

export function queuedMessagesHeight(messages: QueuedMessage[]): number {
  if (messages.length === 0) return 0
  const hidden = Math.max(0, messages.length - MAX_VISIBLE_MESSAGES)
  return Math.min(messages.length, MAX_VISIBLE_MESSAGES) + (hidden > 0 ? 1 : 0)
}

export function QueuedMessages({ messages, width }: { messages: QueuedMessage[]; width: number }) {
  if (messages.length === 0) return null

  const visible = messages.slice(0, MAX_VISIBLE_MESSAGES)
  const hidden = messages.length - visible.length
  const rowWidth = Math.max(24, width - 4)

  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((message) => (
        <Text color="gray" key={message.id}>
          {formatQueuedRow(message.text, rowWidth)}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text color="gray">{padToWidth(`┃ + ${hidden} more queued`, rowWidth)}</Text>
      ) : null}
    </Box>
  )
}

function formatQueuedRow(text: string, width: number): string {
  const prefix = "┃ › "
  const bodyWidth = Math.max(8, width - stringWidth(prefix))
  const oneLine = text.replace(/\s+/g, " ").trim()
  const firstLine = wrapAnsi(oneLine, bodyWidth, {
    hard: true,
    trim: true,
    wordWrap: true,
  }).split("\n")[0]
  const body =
    stringWidth(oneLine) > bodyWidth ? `${trimToWidth(firstLine ?? "", bodyWidth - 1)}…` : oneLine
  return padToWidth(`${prefix}${body}`, width)
}

function trimToWidth(text: string, width: number): string {
  let out = ""
  for (const char of text) {
    if (stringWidth(`${out}${char}`) > width) break
    out += char
  }
  return out
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - stringWidth(text)))}`
}
