import { Box, Text, useInput } from "ink"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { color, glyph } from "../theme.js"

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
  const accent = running ? color.pending : color.accent
  return (
    <Box borderColor={accent} borderStyle="single" marginTop={1} paddingX={1}>
      <Text color={accent}>{glyph.user}</Text>
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

export type TextKeyAction =
  | { kind: "submit" }
  | { kind: "update"; value: string; cursorOffset: number }

// How a text-editing keypress changes the prompt buffer. Pure, so the
// paste / shift+enter / submit rules can be tested without rendering Ink.
// `key` is the subset of Ink's Key this prompt acts on (the component has
// already filtered out the navigation/control keys it ignores), so the
// raw Ink Key object is assignable.
export function reduceTextKey(
  value: string,
  cursorOffset: number,
  rawInput: string,
  key: {
    return?: boolean
    shift?: boolean
    meta?: boolean
    leftArrow?: boolean
    rightArrow?: boolean
    backspace?: boolean
    delete?: boolean
  },
  showCursor: boolean,
): TextKeyAction {
  // Normalize CRLF/CR so pasted line endings become "\n" in the buffer.
  const text = rawInput.replace(/\r\n?/g, "\n")

  // Compose a newline instead of submitting on Option/Alt+Enter (Ink
  // reports this as meta+Enter), or on Shift+Enter where the terminal
  // reports the modifier. Most terminals send a bare CR for Shift+Enter,
  // so Option+Enter is the reliable newline; pasting multi-line text works.
  if (key.return && (key.shift || key.meta)) {
    return {
      kind: "update",
      value: `${value.slice(0, cursorOffset)}\n${value.slice(cursorOffset)}`,
      cursorOffset: cursorOffset + 1,
    }
  }

  const isPaste = text.length > 1

  // A lone Enter submits. A multi-character paste — even one containing
  // newlines — is inserted instead, so a multi-line snippet survives
  // intact rather than being truncated to its first line and fired off.
  if (!isPaste && (key.return || text === "\n")) {
    return { kind: "submit" }
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
  } else if (text.length > 0) {
    nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset)
    nextCursorOffset += text.length
  }

  nextCursorOffset = Math.max(0, Math.min(nextValue.length, nextCursorOffset))
  return { kind: "update", value: nextValue, cursorOffset: nextCursorOffset }
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
        key.escape ||
        rawInput === "\u001b" ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return
      }

      const action = reduceTextKey(value, cursorOffset, rawInput, key, showCursor)
      if (action.kind === "submit") {
        onSubmit(value)
        return
      }
      setCursorOffset(action.cursorOffset)
      if (action.value !== value) onChange(action.value)
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
  compactionInProgress,
  contextUsage,
  queuedCount,
  running,
  status,
}: {
  compactionInProgress?: boolean
  contextUsage?: { tokens: number; budget: number }
  queuedCount: number
  running: boolean
  status: string
}) {
  // One contextual hint for the action that matters right now; the full key
  // list lives in /help so the footer stays quiet.
  const hint =
    running && queuedCount > 0
      ? "enter queue · empty enter to send now"
      : running
        ? "esc to interrupt"
        : queuedCount > 0
          ? "empty enter to send queued"
          : "/help for commands"
  const elapsed = useElapsedRunTime(running)
  const usageLabel = formatContextUsage(contextUsage)
  const statusParts = [
    status === "idle" ? undefined : status,
    elapsed,
    compactionInProgress ? "compacting…" : undefined,
    usageLabel,
  ].filter((part): part is string => part !== undefined && part.length > 0)

  return (
    <Box justifyContent="space-between">
      <Text color={color.meta}>{hint}</Text>
      <Text color={color.meta}>{statusParts.join(" · ")}</Text>
    </Box>
  )
}

function formatContextUsage(usage?: { tokens: number; budget: number }): string | undefined {
  if (usage === undefined || usage.tokens <= 0) return undefined
  const used = formatTokenCount(usage.tokens)
  if (usage.budget <= 0) return `${used} ctx`
  const pct = Math.round((usage.tokens / usage.budget) * 100)
  return `${used} / ${formatTokenCount(usage.budget)} (${pct}%)`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`
  return String(tokens)
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
