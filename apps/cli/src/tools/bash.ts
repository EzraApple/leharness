import {
  runShellInBackground,
  type Tool,
  type ToolContext,
  type ToolExecuteResult,
} from "@leharness/harness"
import { z } from "zod"

const bashArgs = z.object({
  command: z.string().describe("Shell command to execute. Runs in /bin/bash on Unix."),
  inline_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "How long (ms) to wait inline before backgrounding (default 5000, cap 60000). 0 means always background.",
    ),
})

type BashArgs = z.infer<typeof bashArgs>

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description:
    "Execute a shell command. Returns inline output if the command finishes within inline_ms; otherwise hands off to a background task and returns a task_id the model can wait_task / read_task / cancel_task. Default inline_ms is 5000.",
  schema: bashArgs,
  async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
    return runShellInBackground({ command: args.command, inline_ms: args.inline_ms }, ctx)
  },
}
