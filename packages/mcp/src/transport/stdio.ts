// transport/stdio.ts
// Spawn an MCP server as a subprocess and frame JSON-RPC over its
// stdin/stdout. MCP's stdio framing is newline-delimited JSON: one
// JSON-RPC message per line on stdout, one per line written to stdin.
// The server's stderr is forwarded for debugging but is not part of
// the protocol.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import type { JsonRpcNotification, JsonRpcRequest } from "../protocol.js"
import { isResponse } from "../protocol.js"
import type { IncomingMessage, Transport } from "./types.js"

interface StdioTransportOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // Forwarded the server's stderr lines for debugging.
  onStderr?: (line: string) => void
}

export class StdioTransport implements Transport {
  private proc: ChildProcessWithoutNullStreams | undefined
  private messageHandler: ((message: IncomingMessage) => void) | undefined
  private closeHandler: ((reason: string) => void) | undefined
  private stdoutBuffer = ""
  private closed = false

  constructor(private readonly options: StdioTransportOptions) {}

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler
  }

  async start(): Promise<void> {
    const proc = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    this.proc = proc

    proc.stdout.setEncoding("utf8")
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    proc.stderr.setEncoding("utf8")
    proc.stderr.on("data", (chunk: string) => {
      if (this.options.onStderr) {
        for (const line of chunk.split("\n")) {
          if (line.trim().length > 0) this.options.onStderr(line)
        }
      }
    })
    proc.on("exit", (code, signal) => {
      this.closed = true
      this.closeHandler?.(`process exited (code=${code ?? "null"} signal=${signal ?? "null"})`)
    })
    proc.on("error", (err) => {
      this.closed = true
      this.closeHandler?.(`process error: ${err.message}`)
    })

    // The process is "started" as soon as it's spawned; the initialize
    // handshake (driven by the client) confirms it actually speaks MCP.
  }

  async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this.proc === undefined || this.closed) {
      throw new Error("stdio transport not running")
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.proc !== undefined && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM")
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line.length > 0) this.dispatchLine(line)
      newlineIndex = this.stdoutBuffer.indexOf("\n")
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Non-JSON line on stdout — some servers log here by mistake.
      this.options.onStderr?.(`(non-JSON stdout) ${line}`)
      return
    }
    // Responses have an id; notifications have a method and no id.
    if (isResponse(parsed) || isNotification(parsed)) {
      this.messageHandler?.(parsed as IncomingMessage)
    }
  }
}

function isNotification(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && "method" in msg && !("id" in msg)
}
