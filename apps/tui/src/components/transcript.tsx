import type { HarnessDeps } from "@leharness/harness"
import { Box, Static, Text } from "ink"
import Spinner from "ink-spinner"
import { useMemo } from "react"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { Cell, TranscriptState } from "../state/types.js"
import { renderMarkdown } from "../utils/markdown.js"
import { SessionHeader } from "./header.js"

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
  resetKey,
  running,
  sessionId,
  transcript,
  width,
}: {
  deps: HarnessDeps
  priorEventCount: number
  resetKey: number
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
  const staticItems = useMemo<StaticTranscriptItem[]>(
    () => committedCells.map((cell): StaticTranscriptItem => ({ cell, kind: "cell" })),
    [committedCells],
  )
  const liveRows = useMemo(
    () =>
      buildRows(visibleLiveCells, {
        running,
        startIndex: committedCells.length,
        width: bodyWidth,
      }),
    [bodyWidth, committedCells.length, running, visibleLiveCells],
  )

  return (
    <Box flexDirection="column" marginTop={1}>
      <SessionHeader
        deps={deps}
        priorEventCount={priorEventCount}
        sessionId={sessionId}
        width={width - 2}
      />
      <Static items={staticItems} key={resetKey}>
        {(item, index) => {
          return (
            <TranscriptCell
              cell={item.cell}
              key={item.cell.id}
              running={false}
              transcriptIndex={index}
              width={bodyWidth}
            />
          )
        }}
      </Static>
      {liveRows.map((row) => (
        <TranscriptRowText key={row.id} row={row} />
      ))}
    </Box>
  )
}

type StaticTranscriptItem = {
  cell: Cell
  kind: "cell"
}

function TranscriptCell({
  cell,
  running,
  transcriptIndex,
  width,
}: {
  cell: Cell
  running: boolean
  transcriptIndex: number
  width: number
}) {
  const rows = buildRows([cell], { running, startIndex: transcriptIndex, width })
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <TranscriptRowText key={row.id} row={row} />
      ))}
    </Box>
  )
}

function TranscriptRowText({ row }: { row: TranscriptRow }) {
  if (row.spinner === true) {
    return (
      <Text backgroundColor={row.backgroundColor} color={row.color}>
        {row.marker === undefined ? null : <Text color={row.markerColor}>{row.marker}</Text>}
        {row.text}
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
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
    running: boolean
    startIndex?: number
    width: number
  },
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
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
      pushDottedWrapped(rows, cell, cell.text.trim(), options.width, "gray", "gray")
    }
  }
  return rows
}

function pushThinking(rows: TranscriptRow[], cell: Cell, width: number): void {
  pushDottedWrapped(rows, cell, "thinking", width, "gray", "gray", undefined, true)
}

function pushUserWrapped(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  const prefix = "┃ "
  const bodyWidth = Math.max(8, width - visibleWidth(prefix))
  for (const [index, line] of wrapText(text, bodyWidth).entries()) {
    const rowText = `${prefix}${line}`
    pushLine(rows, cell, `user-${index}`, padToWidth(rowText, width), undefined, "#2a2a2a")
  }
}

function pushTool(rows: TranscriptRow[], cell: Cell, width: number): void {
  const title = renderToolDisplayTitle(cell)
  if (cell.status === "pending") {
    pushPendingTool(rows, cell, title, width)
    return
  }

  const failed = cell.status === "failed"
  pushBlank(rows, cell.id)
  pushDottedWrapped(
    rows,
    cell,
    [title, cell.text.trim()].filter((part) => part.length > 0).join("\n"),
    width,
    failed ? "red" : "green",
    failed ? "red" : "gray",
  )
}

function pushPendingTool(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  pushDottedWrapped(rows, cell, text, width, "yellow", "yellow", undefined, true, "pending")
}

function renderToolDisplayTitle(cell: Cell): string {
  const display = cell.display
  if (display === undefined) {
    const title = cell.title ?? "tool"
    if (cell.status === "pending") return title
    return `${title} ${cell.status === "failed" ? "failed" : "ok"}`
  }

  const verb =
    cell.status === "pending"
      ? display.pending
      : cell.status === "failed"
        ? display.failed
        : display.completed
  return [verb, display.target].filter((part) => part !== undefined && part.length > 0).join(" ")
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
  const markerWidth = visibleWidth("● ")
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
      index === 0 ? "● " : "  ",
      markerColor,
    )
  }
}

function pushDottedMarkdown(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  const markerWidth = visibleWidth("● ")
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
      index === 0 ? "● " : "  ",
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
