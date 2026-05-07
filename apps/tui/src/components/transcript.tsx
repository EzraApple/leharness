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
    () => [
      {
        deps,
        id: "session-header",
        kind: "header",
        priorEventCount,
        sessionId,
      },
      ...committedCells.map((cell): StaticTranscriptItem => ({ cell, kind: "cell" })),
    ],
    [committedCells, deps, priorEventCount, sessionId],
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
      <Static items={staticItems} key={resetKey}>
        {(item, index) => {
          if (item.kind === "header") {
            return (
              <SessionHeader
                deps={item.deps}
                key={item.id}
                priorEventCount={item.priorEventCount}
                sessionId={item.sessionId}
                width={width - 2}
              />
            )
          }
          return (
            <TranscriptCell
              cell={item.cell}
              key={item.cell.id}
              running={false}
              transcriptIndex={index - 1}
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

type StaticTranscriptItem =
  | {
      deps: HarnessDeps
      id: string
      kind: "header"
      priorEventCount: number
      sessionId: string
    }
  | {
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
        {row.text}
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
      </Text>
    )
  }

  return (
    <Text backgroundColor={row.backgroundColor} color={row.color}>
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
      pushRailedWrapped(rows, cell, cell.text, options.width, "cyan", "#1c1c1c")
    } else if (cell.kind === "assistant") {
      pushBlank(rows, cell.id)
      const text = cell.text.trim()
      if (text.length === 0) {
        if (options.running) {
          pushThinking(rows, cell)
        } else {
          pushRailedWrapped(rows, cell, " ", options.width, "gray")
        }
      } else {
        pushRailedMarkdown(rows, cell, text, options.width)
      }
    } else if (cell.kind === "tool") {
      pushTool(rows, cell, options.width)
    } else if (cell.kind === "error") {
      pushBlank(rows, cell.id)
      pushRailedWrapped(
        rows,
        cell,
        `${cell.title ?? ""}\n${cell.text}`.trim(),
        options.width,
        "red",
      )
    } else {
      pushRailedWrapped(rows, cell, cell.text.trim(), options.width, "gray")
    }
  }
  return rows
}

function pushThinking(rows: TranscriptRow[], cell: Cell): void {
  const prefix = "┃"
  pushLine(rows, cell, "thinking", prefix, "gray", undefined, true)
}

function pushTool(rows: TranscriptRow[], cell: Cell, width: number): void {
  const title = cell.title ?? "tool"
  if (cell.status === "pending") {
    pushRailedWrapped(rows, cell, `${title} ${cell.text}`, width, "yellow")
    return
  }

  const failed = cell.status === "failed"
  pushBlank(rows, cell.id)
  pushRailedWrapped(
    rows,
    cell,
    `${title} ${failed ? "failed" : "ok"}\n${cell.text}`,
    width,
    failed ? "red" : "gray",
  )
}

function pushRailedWrapped(
  rows: TranscriptRow[],
  cell: Cell,
  text: string,
  width: number,
  color?: string,
  backgroundColor?: string,
): void {
  const prefix = "┃ "
  const bodyWidth = Math.max(8, width - visibleWidth(prefix))
  for (const [index, line] of wrapText(text, bodyWidth).entries()) {
    const rowText = `${prefix}${line}`
    pushLine(rows, cell, `rail-${index}`, padToWidth(rowText, width), color, backgroundColor)
  }
}

function pushRailedMarkdown(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  const prefix = "┃ "
  const bodyWidth = Math.max(8, width - visibleWidth(prefix))
  const rendered = renderMarkdown(text, bodyWidth)
  for (const [index, line] of wrapText(rendered, bodyWidth).entries()) {
    pushLine(rows, cell, `markdown-${index}`, `${prefix}${line}`)
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
): void {
  rows.push({ backgroundColor, color, id: `${cell.id}:${part}:${rows.length}`, spinner, text })
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
