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
    "Execute a shell command and return its combined stdout+stderr plus exit code. Use for directory listing, searching (prefer rg), git, tests, builds, and other shell work. Blocking — waits for the command to finish. No timeout in MVP, so do not run interactive or long-running commands.",
  schema: bashArgs,
  display: {
    pending: "running",
    completed: "ran",
    failed: "command failed",
    target: (args) => args.command,
    summarize: (output) => summarizeCommand(output),
  },
  async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
    // TODO (2026-04-22): no timeout — interactive/long-running commands block the loop. Add a configurable timeout when the CLI can surface + approve long-running tool calls.
    // TODO (2026-04-22): stdout and stderr are concatenated post-exit. Interleaving them in chronological order needs a pty or per-chunk timestamps; not worth it yet.
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

function summarizeCommand(output: string): string {
  const exit = /\[exit: (\d+)\]/.exec(output)?.[1] ?? "?"
  const body = output
    .split("\n")
    .filter((line) => !line.startsWith("$ ") && !line.startsWith("[exit:"))
    .join("\n")
    .trim()
  return `exit ${exit} · ${lineCount(body)} lines`
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split("\n").length
}
