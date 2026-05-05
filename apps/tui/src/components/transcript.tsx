import { Box, Text } from "ink"
import { ScrollableBox } from "ink-scrollable-box"
import { useEffect, useMemo } from "react"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { Cell, TranscriptState } from "../state/types.js"
import { renderMarkdown } from "../utils/markdown.js"

interface TranscriptRow {
  backgroundColor?: string
  color?: string
  id: string
  text: string
}

export function Transcript({
  height,
  offset,
  onOffsetChange,
  onRowsChange,
  running,
  transcript,
  width,
}: {
  height: number
  offset: number
  onOffsetChange: (offset: number) => void
  onRowsChange: (rows: number) => void
  running: boolean
  transcript: TranscriptState
  width: number
}) {
  const rows = useMemo(
    () =>
      buildRows(transcript.cells, {
        running,
        width: Math.max(20, width - 4),
      }),
    [running, transcript.cells, width],
  )

  useEffect(() => {
    onRowsChange(rows.length)
  }, [onRowsChange, rows.length])

  return (
    <Box height={height} marginTop={1}>
      <ScrollableBox
        enableVimBindings={false}
        focusable={false}
        height={height}
        offset={offset}
        onOffsetChange={onOffsetChange}
        scrollbarStyle="line"
        showIndicators={false}
        showScrollbar={false}
      >
        {rows.map((row) => (
          <Text backgroundColor={row.backgroundColor} color={row.color} key={row.id}>
            {row.text}
          </Text>
        ))}
      </ScrollableBox>
    </Box>
  )
}

function buildRows(
  cells: Cell[],
  options: {
    running: boolean
    width: number
  },
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const [index, cell] of cells.entries()) {
    if (cell.kind === "user") {
      if (index > 0) pushBlank(rows, cell.id)
      pushRailedWrapped(rows, cell, cell.text, options.width, "cyan", "#1c1c1c")
    } else if (cell.kind === "assistant") {
      pushBlank(rows, cell.id)
      const text = cell.text.trim()
      if (text.length === 0) {
        pushRailedWrapped(rows, cell, options.running ? "thinking..." : " ", options.width, "gray")
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
): void {
  rows.push({ backgroundColor, color, id: `${cell.id}:${part}:${rows.length}`, text })
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
