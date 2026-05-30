import type { HarnessDeps } from "@leharness/harness"
import type { McpServerDetail } from "@leharness/mcp"
import { Box, Text } from "ink"
import { useEffect, useMemo, useState } from "react"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { Cell, TranscriptState } from "../state/types.js"
import { color, glyph } from "../theme.js"
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
  mcpServers,
  priorEventCount,
  running,
  sessionId,
  transcript,
  width,
}: {
  deps: HarnessDeps
  mcpServers: Map<string, McpServerDetail>
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
        mcpServers={mcpServers}
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
        <Text color={color.accent}>{ellipsis}</Text>
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
          pushHeadlineWrapped(rows, cell, " ", options.width, color.meta, color.meta)
        }
      } else {
        pushHeadlineMarkdown(rows, cell, text, options.width)
      }
    } else if (cell.kind === "tool") {
      if (previousKind !== undefined && previousKind !== "assistant" && previousKind !== "tool") {
        pushBlank(rows, cell.id)
      }
      pushTool(rows, cell, options.width)
    } else if (cell.kind === "error") {
      pushBlank(rows, cell.id)
      pushHeadlineWrapped(
        rows,
        cell,
        `${cell.title ?? ""}\n${cell.text}`.trim(),
        options.width,
        color.failure,
        color.failure,
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
  pushHeadlineWrapped(rows, cell, "thinking", width, color.meta, color.meta, undefined, true)
}

function pushUserWrapped(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  pushWrapped(rows, cell, text, width, {
    backgroundColor: color.userBg,
    contMarker: glyph.rail,
    firstMarker: glyph.user,
    markerColor: color.userChevron,
    partPrefix: "user",
  })
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
  pushTreeBlock(rows, cell, {
    body: toolBody(cell),
    bodyColor: failed ? color.failure : color.toolMeta,
    headline: toolHeadline(title, cell),
    headlineMarkerColor: failed ? color.failure : color.tool,
    headlineTextColor: failed ? color.failure : color.toolMeta,
    width,
  })
}

function pushBackgroundTool(rows: TranscriptRow[], cell: Cell, width: number): void {
  const marker = cell.background
  if (marker === undefined) return
  const idSuffix = `· background ${shortTaskId(marker.taskId)}`
  const title = renderToolDisplayTitle(cell)

  if (marker.phase === "started") {
    pushTreeBlock(rows, cell, {
      headline: `${title} · started in background · ${shortTaskId(marker.taskId)}`,
      headlineMarkerColor: color.background,
      headlineTextColor: color.toolMeta,
      width,
    })
    return
  }
  if (marker.phase === "completed") {
    pushTreeBlock(rows, cell, {
      body: toolBody(cell),
      bodyColor: color.toolMeta,
      headline: `${toolHeadline(title, cell)} ${idSuffix}`,
      headlineMarkerColor: color.tool,
      headlineTextColor: color.toolMeta,
      width,
    })
    return
  }
  if (marker.phase === "failed") {
    pushTreeBlock(rows, cell, {
      body: toolBody(cell),
      bodyColor: color.failure,
      headline: `${toolHeadline(title, cell)} ${idSuffix} failed`,
      headlineMarkerColor: color.failure,
      headlineTextColor: color.failure,
      width,
    })
    return
  }
  // cancelled
  const reasonText =
    marker.reason === "process_exited"
      ? "process exited"
      : marker.reason === "parent"
        ? "parent"
        : "user"
  pushTreeBlock(rows, cell, {
    headline: `${title} ${idSuffix} cancelled (${reasonText})`,
    headlineMarkerColor: color.cancelled,
    headlineTextColor: color.cancelled,
    width,
  })
}

function shortTaskId(id: string, head = 12): string {
  return id.length <= head + 1 ? id : `${id.slice(0, head)}…`
}

function pushSystem(rows: TranscriptRow[], cell: Cell, width: number): void {
  pushBlank(rows, cell.id)
  const tone =
    cell.outcome === "failed"
      ? color.failure
      : cell.outcome === "cancelled"
        ? color.cancelled
        : color.meta
  pushWrapped(rows, cell, cell.text.trim(), width, {
    contMarker: glyph.rail,
    firstMarker: glyph.meta,
    markerColor: tone,
    partPrefix: "sys",
    textColor: tone,
  })
}

function pushPendingTool(rows: TranscriptRow[], cell: Cell, text: string, width: number): void {
  pushHeadlineWrapped(
    rows,
    cell,
    text,
    width,
    color.pending,
    color.pending,
    undefined,
    true,
    "pending",
  )
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

// The agent "block" for a tool: a `⏺ verb target` headline and, for compact
// file edits, the change summary folded inline (`edited a.ts · changed …`).
function toolHeadline(title: string, cell: Cell): string {
  const text = cell.text.trim()
  if (text.length > 0 && isCompactFileTool(cell) && !text.includes("\n")) {
    return `${title} · ${lowerFirst(text)}`
  }
  return title
}

// The output that hangs under the headline on a `⎿` connector: the tool's
// summary/output plus any expanded detail. Returns undefined when the summary
// was already folded into the headline (compact edits) or there's nothing.
function toolBody(cell: Cell): string | undefined {
  const text = cell.text.trim()
  const summary =
    text.length === 0 || (isCompactFileTool(cell) && !text.includes("\n")) ? undefined : text
  const detail = expandedDetail(cell)
  const joined = [summary, detail]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n")
  return joined.length > 0 ? joined : undefined
}

function isCompactFileTool(cell: Cell): boolean {
  return cell.status === "completed" && (cell.title === "edit_file" || cell.title === "create_file")
}

function lowerFirst(value: string): string {
  const first = value[0]
  if (first === undefined) return value
  return `${first.toLowerCase()}${value.slice(1)}`
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
  return detail.length > 0 ? detail : undefined
}

// A tree block: a headline marked with `⏺`, and optional output hanging
// under it on a `⎿` connector (continuation lines align under the marker).
function pushTreeBlock(
  rows: TranscriptRow[],
  cell: Cell,
  opts: {
    body?: string
    bodyColor?: string
    headline: string
    headlineMarkerColor?: string
    headlineTextColor?: string
    width: number
  },
): void {
  pushWrapped(rows, cell, opts.headline, opts.width, {
    contMarker: glyph.rail,
    firstMarker: glyph.headline,
    markerColor: opts.headlineMarkerColor,
    partPrefix: "head",
    textColor: opts.headlineTextColor,
  })
  if (opts.body !== undefined && opts.body.length > 0) {
    pushWrapped(rows, cell, opts.body, opts.width, {
      contMarker: glyph.rail,
      firstMarker: glyph.connector,
      markerColor: opts.bodyColor,
      partPrefix: "body",
      textColor: opts.bodyColor,
    })
  }
}

// A single `⏺`-headed block with no connector body — assistant prose,
// errors, the thinking placeholder, and pending tools all share this shape.
function pushHeadlineWrapped(
  rows: TranscriptRow[],
  cell: Cell,
  text: string,
  width: number,
  markerColor?: string,
  textColor?: string,
  backgroundColor?: string,
  spinner?: boolean,
  partPrefix = "dot",
): void {
  pushWrapped(rows, cell, text, width, {
    backgroundColor,
    contMarker: glyph.rail,
    firstMarker: glyph.headline,
    markerColor,
    partPrefix,
    spinner,
    textColor,
  })
}

function pushHeadlineMarkdown(
  rows: TranscriptRow[],
  cell: Cell,
  text: string,
  width: number,
): void {
  const markerWidth = visibleWidth(glyph.headline)
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
      index === 0 ? glyph.headline : glyph.rail,
    )
  }
}

// Wrap `text` to the available width and emit one row per line, marking the
// first line with `firstMarker` and continuations with `contMarker` so the
// body stays aligned under the marker.
function pushWrapped(
  rows: TranscriptRow[],
  cell: Cell,
  text: string,
  width: number,
  opts: {
    backgroundColor?: string
    contMarker: string
    firstMarker: string
    markerColor?: string
    pad?: boolean
    partPrefix?: string
    spinner?: boolean
    textColor?: string
  },
): void {
  const markerWidth = visibleWidth(opts.firstMarker)
  const bodyWidth = Math.max(8, width - markerWidth)
  const prefix = opts.partPrefix ?? "row"
  for (const [index, line] of wrapText(text, bodyWidth).entries()) {
    pushLine(
      rows,
      cell,
      `${prefix}-${index}`,
      opts.pad === false ? line : padToWidth(line, bodyWidth),
      opts.textColor,
      opts.backgroundColor,
      opts.spinner === true && index === 0,
      index === 0 ? opts.firstMarker : opts.contMarker,
      opts.markerColor,
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
  textColor?: string,
  backgroundColor?: string,
  spinner?: boolean,
  marker?: string,
  markerColor?: string,
): void {
  rows.push({
    backgroundColor,
    color: textColor,
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
