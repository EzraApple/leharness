import { spawn } from "node:child_process"
import type { Tool, ToolContext, ToolExecuteResult } from "@leharness/harness"
import { z } from "zod"

const bashArgs = z.object({
  command: z.string().describe("Shell command to execute. Runs in /bin/bash on Unix."),
})

type BashArgs = z.infer<typeof bashArgs>

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description:
    "Execute a shell command and return its combined stdout+stderr plus exit code. Blocking — waits for the command to finish. No timeout in MVP, so do not run interactive or long-running commands.",
  schema: bashArgs,
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    // Note (Ezra, 2026-04-22): no timeout in MVP — interactive or long-running commands will block the loop indefinitely. Add a configurable timeout when CLI gains a way to surface and approve long-running tool calls.
    // Note (Ezra, 2026-04-22): stdout and stderr are captured into separate buffers and concatenated stdout-then-stderr after the process exits. Cleanly interleaving the two streams in chronological order would require a pty or per-chunk timestamping, which is more complexity than MVP needs.
    return new Promise<ToolExecuteResult>((resolve) => {
      const child = spawn("/bin/bash", ["-c", args.command], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("error", (err) => {
        resolve({ kind: "error", message: `bash failed to spawn: ${err.message}` })
      })
      child.on("close", (code, signal) => {
        const combined =
          Buffer.concat(stdout).toString("utf8") + Buffer.concat(stderr).toString("utf8")
        const lines = [`$ ${args.command}`, combined, "", `[exit: ${code ?? 0}]`]
        if (signal !== null) lines.push(`[signal: ${signal}]`)
        resolve({ kind: "ok", output: lines.join("\n") })
      })
    })
  },
}
