import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolContext, ToolExecuteResult } from "@leharness/harness"
import { z } from "zod"

const readFileArgs = z.object({
  path: z
    .string()
    .describe("Path to the file, relative to the current working directory or absolute"),
})

type ReadFileArgs = z.infer<typeof readFileArgs>

export const readFileTool: Tool<ReadFileArgs> = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the file contents as a UTF-8 string. Useful for inspecting source code, configs, READMEs, etc.",
  schema: readFileArgs,
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    const target = path.resolve(process.cwd(), args.path)
    try {
      const content = await fs.readFile(target, "utf8")
      return { kind: "ok", output: content }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message: `read_file failed: ${message}` }
    }
  },
}
