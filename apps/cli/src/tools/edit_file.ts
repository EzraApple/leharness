import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolContext, ToolExecuteResult } from "@leharness/harness"
import { z } from "zod"

const editFileArgs = z.object({
  path: z
    .string()
    .describe("Path to the file to edit, relative to the current working directory or absolute"),
  old_string: z.string().describe("Exact existing text to replace. Must match exactly once."),
  new_string: z.string().describe("Replacement text."),
})

type EditFileArgs = z.infer<typeof editFileArgs>

export const editFileTool: Tool<EditFileArgs> = {
  name: "edit_file",
  description:
    "Edit a UTF-8 text file by replacing one exact old_string with new_string. The old_string must appear exactly once; include enough surrounding context to make it unique.",
  schema: editFileArgs,
  display: {
    pending: "editing",
    completed: "edited",
    failed: "could not edit",
    target: (args) => args.path,
  },
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    if (args.old_string.length === 0) {
      return { kind: "error", message: "edit_file failed: old_string must not be empty" }
    }

    const target = path.resolve(process.cwd(), args.path)
    let before: string
    try {
      const stat = await fs.stat(target)
      if (!stat.isFile()) return { kind: "error", message: "edit_file failed: path is not a file" }
      before = await fs.readFile(target, "utf8")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message: `edit_file failed: ${message}` }
    }

    const matches = countMatches(before, args.old_string)
    if (matches !== 1) {
      return {
        kind: "error",
        message: `edit_file failed: old_string matched ${matches} times`,
        summary: `old_string matched ${matches} times`,
      }
    }

    const after = before.replace(args.old_string, args.new_string)
    try {
      await writeFileAtomic(target, after)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message: `edit_file failed: ${message}` }
    }

    const summary = editSummary(args.old_string, args.new_string)
    return {
      kind: "ok",
      output: `Edited ${args.path}\n${summary}`,
      summary,
    }
  },
}

function countMatches(value: string, needle: string): number {
  let count = 0
  let index = value.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = value.indexOf(needle, index + needle.length)
  }
  return count
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const directory = path.dirname(target)
  const basename = path.basename(target)
  const tmp = path.join(directory, `.${basename}.leharness-${process.pid}-${Date.now()}.tmp`)
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx" })
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function editSummary(oldString: string, newString: string): string {
  const { addedLines, removedLines } = replacementLineDelta(oldString, newString)
  return formatLineChange(addedLines, removedLines)
}

function replacementLineDelta(
  oldString: string,
  newString: string,
): { addedLines: number; removedLines: number } {
  const oldLines = splitLines(oldString)
  const newLines = splitLines(newString)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    addedLines: newLines.length - prefix - suffix,
    removedLines: oldLines.length - prefix - suffix,
  }
}

function formatLineChange(addedLines: number, removedLines: number): string {
  if (addedLines > 0 && removedLines === 0) return `Added ${plural(addedLines, "line")}`
  if (removedLines > 0 && addedLines === 0) return `Removed ${plural(removedLines, "line")}`
  return `Changed +${addedLines} -${removedLines} lines`
}

function splitLines(value: string): string[] {
  if (value.length === 0) return []
  return value.split("\n")
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
