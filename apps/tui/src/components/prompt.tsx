import { Box, Text, useInput } from "ink"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"

export function Prompt({
  input,
  inputVersion,
  placeholder,
  running,
  setInput,
  slashNames,
  submit,
}: {
  input: string
  inputVersion: number
  placeholder?: string
  running: boolean
  setInput: (value: string) => void
  slashNames: Set<string>
  submit: (value: string) => void
}) {
  return (
    <Box borderColor={running ? "yellow" : "cyan"} borderStyle="single" marginTop={1} paddingX={1}>
      <StyledTextInput
        focus
        key={inputVersion}
        onChange={setInput}
        onSubmit={submit}
        placeholder={placeholder ?? (running ? "Queue next message..." : "Ask leharness...")}
        showCursor
        slashNames={slashNames}
        value={input}
      />
    </Box>
  )
}

function StyledTextInput({
  focus,
  onChange,
  onSubmit,
  placeholder,
  showCursor,
  slashNames,
  value,
}: {
  focus: boolean
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  placeholder: string
  showCursor: boolean
  slashNames: Set<string>
  value: string
}) {
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const mentionRanges = useMemo(() => findMentionRanges(value, slashNames), [slashNames, value])

  useInput(
    (rawInput, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && rawInput === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return
      }

      const newlineIndex = rawInput.search(/[\r\n]/)
      if (key.return || newlineIndex >= 0) {
        const pastedPrefix = newlineIndex >= 0 ? rawInput.slice(0, newlineIndex) : ""
        onSubmit(value.slice(0, cursorOffset) + pastedPrefix + value.slice(cursorOffset))
        return
      }

      let nextValue = value
      let nextCursorOffset = cursorOffset

      if (key.leftArrow) {
        if (showCursor) nextCursorOffset -= 1
      } else if (key.rightArrow) {
        if (showCursor) nextCursorOffset += 1
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
          nextCursorOffset -= 1
        }
      } else if (rawInput.length > 0) {
        nextValue = value.slice(0, cursorOffset) + rawInput + value.slice(cursorOffset)
        nextCursorOffset += rawInput.length
      }

      nextCursorOffset = Math.max(0, Math.min(nextValue.length, nextCursorOffset))
      setCursorOffset(nextCursorOffset)
      if (nextValue !== value) onChange(nextValue)
    },
    { isActive: focus },
  )

  if (value.length === 0) {
    if (!showCursor) return <Text color="gray">{placeholder}</Text>
    return (
      <Text>
        <Text inverse>{placeholder[0] ?? " "}</Text>
        <Text color="gray">{placeholder.slice(1)}</Text>
      </Text>
    )
  }

  return (
    <Text>
      {renderValueChars(value, cursorOffset, showCursor, mentionRanges)}
      {showCursor && cursorOffset === value.length ? <Text inverse> </Text> : null}
    </Text>
  )
}

interface MentionRange {
  end: number
  start: number
}

function findMentionRanges(value: string, slashNames: Set<string>): MentionRange[] {
  const ranges: MentionRange[] = []
  const matcher = /(^|\s)(\/[^\s]+)/g
  let match = matcher.exec(value)
  while (match !== null) {
    const prefix = match[1] ?? ""
    const token = match[2]
    if (token !== undefined) {
      const name = token.slice(1)
      if (slashNames.has(name)) {
        const start = match.index + prefix.length
        ranges.push({ start, end: start + token.length })
      }
    }
    match = matcher.exec(value)
  }
  return ranges
}

function renderValueChars(
  value: string,
  cursorOffset: number,
  showCursor: boolean,
  mentionRanges: MentionRange[],
): ReactNode[] {
  const nodes: ReactNode[] = []
  for (let position = 0; position < value.length; position++) {
    const char = value[position] ?? ""
    nodes.push(
      <Text
        color={colorAt(position, mentionRanges)}
        inverse={showCursor && cursorOffset === position}
        key={`char-${position}-${char.codePointAt(0) ?? 0}`}
      >
        {char}
      </Text>,
    )
  }
  return nodes
}

function colorAt(index: number, ranges: MentionRange[]): string | undefined {
  return ranges.some((range) => index >= range.start && index < range.end) ? "cyan" : undefined
}

export function Footer({
  queuedCount,
  running,
  status,
}: {
  queuedCount: number
  running: boolean
  status: string
}) {
  const action =
    running && queuedCount > 0
      ? "enter queue · empty enter interrupt"
      : running
        ? "enter queue"
        : queuedCount > 0
          ? "empty enter send queued"
          : "enter send"
  const elapsed = useElapsedRunTime(running)
  const statusParts = [status === "idle" ? undefined : status, elapsed].filter(
    (part): part is string => part !== undefined && part.length > 0,
  )

  return (
    <Box justifyContent="space-between">
      <Text color="gray">{action}</Text>
      <Text color="gray">
        {statusParts.length === 0 ? "" : `${statusParts.join(" · ")} · `}esc abort · ctrl-c exit ·
        terminal scrollback · /help
      </Text>
    </Box>
  )
}

function useElapsedRunTime(running: boolean): string | undefined {
  const [startedAt, setStartedAt] = useState<number | undefined>()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) {
      setStartedAt(undefined)
      return
    }
    const start = Date.now()
    setStartedAt(start)
    setNow(start)
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [running])

  if (!running || startedAt === undefined) return undefined
  return `worked for ${formatElapsed(now - startedAt)}`
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
}
