import type { HarnessDeps } from "@leharness/harness"
import { Box, Text } from "ink"
import { useEffect, useMemo, useState } from "react"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { Cell, TranscriptState } from "../state/types.js"
import { renderMarkdown } from "../utils/markdown.js"
import { SessionHeader } from "./header.js"

const ASSISTANT_MARKER = "• "
const RAIL_INDENT = "  "

interface TranscriptRow {
  backgroundColor?: string
  color?: string
  id: string
  marker?: string
  markerColor?: string
  spinner?: boolean
  text: string
}

export function Transcript({
  deps,
  priorEventCount,
  running,
  sessionId,
  transcript,
  width,
}: {
  deps: HarnessDeps
  priorEventCount: number
  running: boolean
  sessionId: string
  transcript: TranscriptState
  width: number
}) {
  const bodyWidth = Math.max(20, width - 4)
  const { committedCells, liveCells } = useMemo(
    () => splitTranscriptCells(transcript),
    [transcript],
  )
  const visibleLiveCells = useMemo(
    () => addThinkingPlaceholder(liveCells, transcript, running),
    [liveCells, running, transcript],
  )
  const rows = useMemo(
    () =>
      buildRows([...committedCells, ...visibleLiveCells], {
        running,
        width: bodyWidth,
      }),
    [bodyWidth, committedCells, running, visibleLiveCells],
  )

  return (
    <Box flexDirection="column" marginTop={1}>
      <SessionHeader
        deps={deps}
        priorEventCount={priorEventCount}
        sessionId={sessionId}
        width={width - 2}
      />
      {rows.map((row) => (
        <TranscriptRowText key={row.id} row={row} />
      ))}
    </Box>
  )
}

function TranscriptRowText({ row }: { row: TranscriptRow }) {
  const ellipsis = useAnimatedEllipsis(row.spinner === true)

  if (row.spinner === true) {
    return (
      <Text backgroundColor={row.backgroundColor} color={row.color}>
        {row.marker === undefined ? null : <Text color={row.markerColor}>{row.marker}</Text>}
        {row.text}
        <Text color="cyan">{ellipsis}</Text>
      </Text>
    )
  }

  return (
    <Text backgroundColor={row.backgroundColor} color={row.color}>
      {row.marker === undefined ? null : <Text color={row.markerColor}>{row.marker}</Text>}
      {row.text}
    </Text>
  )
}

function useAnimatedEllipsis(active: boolean): string {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    const interval = setInterval(() => setFrame((current) => (current + 1) % 3), 350)
    return () => clearInterval(interval)
  }, [active])

  if (!active) return ""
  return ".".repeat(frame + 1).padEnd(3, " ")
}

function addThinkingPlaceholder(
  liveCells: Cell[],
  transcript: TranscriptState,
  running: boolean,
): Cell[] {
  if (!running) return liveCells
  if (transcript.activeAssistantIndex !== undefined) return liveCells
  if (transcript.cells.length === 0) return liveCells
  if (transcript.cells.some((cell) => cell.kind === "tool" && cell.status === "pending")) {
    return liveCells
  }
  return [
    ...liveCells,
    {
      id: "cell-thinking",
      kind: "assistant",
      text: "",
    },
  ]
}

function splitTranscriptCells(transcript: TranscriptState): {
  committedCells: Cell[]
  liveCells: Cell[]
} {
  const mutableIndexes = transcript.cells.flatMap((cell, index) => {
    if (index === transcript.activeAssistantIndex) return [index]
    if (cell.kind === "tool" && cell.status === "pending") return [index]
    return []
  })
  const firstMutableIndex =
    mutableIndexes.length === 0 ? transcript.cells.length : Math.min(...mutableIndexes)
  return {
    committedCells: transcript.cells.slice(0, firstMutableIndex),
    liveCells: transcript.cells.slice(firstMutableIndex),
  }
}

function buildRows(
  cells: Cell[],
  options: {
    previousKind?: Cell["kind"]
    running: boolean
    startIndex?: number
    width: number
  },
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let previousKind = options.previousKind
  for (const [index, cell] of cells.entries()) {
    const transcriptIndex = (options.startIndex ?? 0) + index
    if (cell.kind === "user") {
      if (transcriptIndex > 0) pushBlank(rows, cell.id)
      pushUserWrapped(rows, cell, cell.text, options.width)
    } else if (cell.kind === "assistant") {
      pushBlank(rows, cell.id)
      const text = cell.text.trim()
      if (text.length === 0) {
        if (options.running) {
          pushThinking(rows, cell, options.width)
        } else {
          pushDottedWrapped(rows, cell, " ", options.width, "gray", "gray")
        }
      } else {
        pushDottedMarkdown(rows, cell, text, options.width)
      }
    } else if (cell.kind === "tool") {
      if (previousKind !== undefined && previousKind !== "assistant" && previousKind !== "tool") {
        pushBlank(rows, cell.id)
      }
      pushTool(rows, cell, options.width)
    } else if (cell.kind === "error") {
      pushBlank(rows, cell.id)
      pushDottedWrapped(
        rows,
        cell,
        `${cell.title ?? ""}\n${cell.text}`.trim(),
        options.width,
        "red",
        "red",
      )
    } else {
      if (cell.text.trim().length > 0) pushSystem(rows, cell, options.width)
    }
    previousKind = cell.kind
  }
  return rows
}

export const transcriptTestInternals = {
  buildRows,
}

function pushThinking(rows: TranscriptRow[], cell: Cell, width: number): void {
  pushDottedWrapped(rows, cell, "thinking", width, "gray", "gray", undefined, true)
}

function pushUserWrapped(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  const prefix = RAIL_INDENT
  const bodyWidth = Math.max(8, width - visibleWidth(prefix))
  for (const [index, line] of wrapText(text, bodyWidth).entries()) {
    const rowText = `${prefix}${line}`
    pushLine(rows, cell, `user-${index}`, padToWidth(rowText, width), undefined, "#2a2a2a")
  }
}

function pushTool(rows: TranscriptRow[], cell: Cell, width: number): void {
  if (cell.background !== undefined) {
    pushBackgroundTool(rows, cell, width)
    return
  }
  const title = renderToolDisplayTitle(cell)
  if (cell.status === "pending") {
    pushPendingTool(rows, cell, title, width)
    return
  }

  const failed = cell.status === "failed" || cell.outcome === "failed"
  const detail = expandedDetail(cell)
  const text = compactToolLine(title, cell)
  pushDottedWrapped(
    rows,
    cell,
    [text, detail]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n"),
    width,
    failed ? "red" : "green",
    failed ? "red" : "gray",
  )
}

function pushBackgroundTool(rows: TranscriptRow[], cell: Cell, width: number): void {
  const marker = cell.background
  if (marker === undefined) return
  const idSuffix = `· background ${shortTaskId(marker.taskId)}`
  const title = renderToolDisplayTitle(cell)
  if (marker.phase === "started") {
    const text = `${title} · started in background · ${shortTaskId(marker.taskId)}`
    pushDottedWrapped(rows, cell, text, width, "yellow", "gray", undefined, false, "bg-started")
    return
  }
  if (marker.phase === "completed") {
    const text = `${compactToolLine(title, cell)} ${idSuffix}`
    const detail = expandedDetail(cell)
    pushDottedWrapped(
      rows,
      cell,
      [text, detail]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n"),
      width,
      "green",
      "gray",
    )
    return
  }
  if (marker.phase === "failed") {
    const text = `${compactToolLine(title, cell)} ${idSuffix} failed`
    const detail = expandedDetail(cell)
    pushDottedWrapped(
      rows,
      cell,
      [text, detail]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n"),
      width,
      "red",
      "red",
    )
    return
  }
  // cancelled
  const reasonText =
    marker.reason === "process_exited"
      ? "process exited"
      : marker.reason === "parent"
        ? "parent"
        : "user"
  const text = `${title} ${idSuffix} cancelled (${reasonText})`
  pushDottedWrapped(rows, cell, text, width, "yellow", "yellow", undefined, false, "bg-cancelled")
}

function shortTaskId(id: string, head = 12): string {
  return id.length <= head + 1 ? id : `${id.slice(0, head)}…`
}

function pushSystem(rows: TranscriptRow[], cell: Cell, width: number): void {
  pushBlank(rows, cell.id)
  const color = cell.outcome === "failed" ? "red" : cell.outcome === "cancelled" ? "yellow" : "gray"
  pushDottedWrapped(rows, cell, cell.text.trim(), width, color, color)
}

function pushPendingTool(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  pushDottedWrapped(rows, cell, text, width, "yellow", "yellow", undefined, true, "pending")
}

function renderToolDisplayTitle(cell: Cell): string {
  const display = cell.display
  if (display === undefined) {
    const title = formatToolLabel(cell.title ?? "tool")
    if (cell.status === "pending") return title
    return `${title} ${cell.status === "failed" ? "failed" : "ok"}`
  }

  const verb =
    cell.status === "pending"
      ? display.pending
      : cell.status === "failed"
        ? display.failed
        : display.completed
  return [formatToolLabel(verb), display.target]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" ")
}

function formatToolLabel(value: string): string {
  return value.replaceAll("_", " ").toLowerCase()
}

function compactToolLine(title: string, cell: Cell): string {
  const text = cell.text.trim()
  if (text.length === 0) return title
  if (!isCompactFileTool(cell) || text.includes("\n")) return [title, text].join("\n")
  return `${title} · ${lowerFirst(text)}`
}

function isCompactFileTool(cell: Cell): boolean {
  return cell.status === "completed" && (cell.title === "edit_file" || cell.title === "create_file")
}

function lowerFirst(value: string): string {
  const first = value[0]
  if (first === undefined) return value
  return `${first.toLowerCase()}${value.slice(1)}`
}

function indentDetail(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function expandedDetail(cell: Cell): string | undefined {
  if (cell.expanded !== true || cell.detail === undefined) return undefined
  const summaryLines = new Set(
    cell.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
  const detail = cell.detail
    .trim()
    .split("\n")
    .filter((line) => !summaryLines.has(line.trim()))
    .join("\n")
    .trim()
  return detail.length > 0 ? indentDetail(detail) : undefined
}

function pushDottedWrapped(
  rows: TranscriptRow[],
  cell: Cell,
  text: string,
  width: number,
  markerColor?: string,
  color?: string,
  backgroundColor?: string,
  spinner?: boolean,
  partPrefix = "dot",
): void {
  const markerWidth = visibleWidth(ASSISTANT_MARKER)
  const bodyWidth = Math.max(8, width - markerWidth)
  for (const [index, line] of wrapText(text, bodyWidth).entries()) {
    pushLine(
      rows,
      cell,
      `${partPrefix}-${index}`,
      padToWidth(line, bodyWidth),
      color,
      backgroundColor,
      spinner && index === 0,
      index === 0 ? ASSISTANT_MARKER : RAIL_INDENT,
      markerColor,
    )
  }
}

function pushDottedMarkdown(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  const markerWidth = visibleWidth(ASSISTANT_MARKER)
  const bodyWidth = Math.max(8, width - markerWidth)
  const rendered = renderMarkdown(text, bodyWidth)
  for (const [index, line] of wrapText(rendered, bodyWidth).entries()) {
    pushLine(
      rows,
      cell,
      `markdown-${index}`,
      line,
      undefined,
      undefined,
      false,
      index === 0 ? ASSISTANT_MARKER : RAIL_INDENT,
    )
  }
}

function pushBlank(rows: TranscriptRow[], cellId: string): void {
  rows.push({ id: `${cellId}:blank:${rows.length}`, text: " " })
}

function pushLine(
  rows: TranscriptRow[],
  cell: Cell,
  part: string,
  text: string,
  color?: string,
  backgroundColor?: string,
  spinner?: boolean,
  marker?: string,
  markerColor?: string,
): void {
  rows.push({
    backgroundColor,
    color,
    id: `${cell.id}:${part}:${rows.length}`,
    marker,
    markerColor,
    spinner,
    text,
  })
}

function visibleWidth(text: string): number {
  return stringWidth(text)
}

function wrapText(text: string, width: number): string[] {
  return wrapAnsi(text, width, { hard: true, trim: true, wordWrap: true }).split("\n")
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`
}
