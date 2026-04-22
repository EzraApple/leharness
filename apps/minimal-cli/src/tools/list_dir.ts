import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolContext, ToolExecuteResult } from "@leharness/harness"
import { z } from "zod"

const listDirArgs = z.object({
  path: z
    .string()
    .describe("Path to the directory, relative to the current working directory or absolute"),
})

type ListDirArgs = z.infer<typeof listDirArgs>

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true })

export const listDirTool: Tool<ListDirArgs> = {
  name: "list_dir",
  description:
    "List the entries in a directory. Returns one entry per line, with a trailing slash for directories. Useful for exploring the project structure.",
  schema: listDirArgs,
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    const target = path.resolve(process.cwd(), args.path)
    try {
      const entries = await fs.readdir(target, { withFileTypes: true })
      entries.sort((a, b) => collator.compare(a.name, b.name))
      const lines = entries.map((entry) => {
        if (entry.isSymbolicLink()) return `${entry.name}@`
        if (entry.isDirectory()) return `${entry.name}/`
        return entry.name
      })
      return { kind: "ok", output: lines.join("\n") }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message: `list_dir failed: ${message}` }
    }
  },
}
