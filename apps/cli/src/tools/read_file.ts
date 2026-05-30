import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolContext, ToolExecuteResult } from "@leharness/harness"
import { z } from "zod"

const DEFAULT_LIMIT_LINES = 400
const MAX_LIMIT_LINES = 2000

const readFileArgs = z.object({
  path: z
    .string()
    .describe("Path to the file, relative to the current working directory or absolute"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from. Defaults to 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Number of lines to read. Defaults to ${DEFAULT_LIMIT_LINES}; capped at ${MAX_LIMIT_LINES}.`,
    ),
})

type ReadFileArgs = z.infer<typeof readFileArgs>

export const readFileTool: Tool<ReadFileArgs> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file with line-numbered output. Reads at most 400 lines by default; use offset and limit to page through larger files.",
  schema: readFileArgs,
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    const target = path.resolve(process.cwd(), args.path)
    try {
      const content = await fs.readFile(target, "utf8")
      const lines = splitLines(content)
      const offset = args.offset ?? 1
      const limit = clampLimit(args.limit)
      const startIndex = offset - 1
      const shown = startIndex < lines.length ? lines.slice(startIndex, startIndex + limit) : []
      const body = shown.map((line, index) => formatLine(offset + index, line)).join("\n")
      const endLine = shown.length === 0 ? offset - 1 : offset + shown.length - 1
      const hasMore = endLine < lines.length
      const footer = formatFooter({
        path: target,
        offset,
        endLine,
        shownCount: shown.length,
        totalLines: lines.length,
        nextOffset: hasMore ? endLine + 1 : undefined,
      })
      return {
        kind: "ok",
        output: body.length > 0 ? `${body}\n\n${footer}` : footer,
        summary: summarizeRead(target, offset, endLine, shown.length, lines.length),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message: `read_file failed: ${message}` }
    }
  },
}

function clampLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_LIMIT_LINES, MAX_LIMIT_LINES)
}

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized.split("\n")
  if (normalized.endsWith("\n")) lines.pop()
  return lines
}

function formatLine(lineNumber: number, line: string): string {
  return `${String(lineNumber).padStart(6, " ")}\t${line}`
}

function formatFooter(args: {
  path: string
  offset: number
  endLine: number
  shownCount: number
  totalLines: number
  nextOffset?: number
}): string {
  if (args.shownCount === 0) {
    return `[read_file: path=${args.path}; no lines shown; total lines: ${args.totalLines}; requested offset: ${args.offset}]`
  }
  const next = args.nextOffset === undefined ? "" : `; next offset: ${args.nextOffset}`
  return `[read_file: path=${args.path}; lines ${args.offset}-${args.endLine} of ${args.totalLines}${next}]`
}

function summarizeRead(
  filePath: string,
  offset: number,
  endLine: number,
  shownCount: number,
  totalLines: number,
): string {
  const base = path.basename(filePath)
  if (shownCount === 0) return `${base}: 0/${totalLines} lines`
  return `${base}: lines ${offset}-${endLine} of ${totalLines}`
}
