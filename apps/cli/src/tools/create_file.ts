import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolContext, ToolExecuteResult } from "@leharness/harness"
import { z } from "zod"

const createFileArgs = z.object({
  content: z.string().describe("UTF-8 text content to write into the new file."),
  path: z
    .string()
    .describe("Path to the file to create, relative to the current working directory or absolute"),
})

type CreateFileArgs = z.infer<typeof createFileArgs>

export const createFileTool: Tool<CreateFileArgs> = {
  name: "create_file",
  description:
    "Create a new UTF-8 text file. Fails if the file already exists. Use edit_file for existing files.",
  schema: createFileArgs,
  display: {
    pending: "creating",
    completed: "created",
    failed: "could not create",
    target: (args) => args.path,
  },
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    const target = path.resolve(process.cwd(), args.path)
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, args.content, { encoding: "utf8", flag: "wx" })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        kind: "error",
        message: `create_file failed: ${message}`,
        summary: summarizeCreateError(err),
      }
    }

    const summary = `Added ${plural(lineCount(args.content), "line")}`
    return {
      kind: "ok",
      output: `Created ${args.path}\n${summary}`,
      summary,
    }
  },
}

function summarizeCreateError(err: unknown): string {
  if ((err as NodeJS.ErrnoException).code === "EEXIST") return "file already exists"
  return err instanceof Error ? err.message : String(err)
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split("\n").length
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
