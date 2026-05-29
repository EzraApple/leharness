// client.ts
// Drives a Transport through the MCP handshake and tool methods. The
// client is transport-agnostic: it matches responses to requests by
// JSON-RPC id and exposes initialize / listTools / callTool. It's the
// only place that knows the request/response correlation; transports
// just move bytes.

import {
  buildInitializeParams,
  type CallToolResult,
  type InitializeResult,
  isJsonRpcError,
  type JsonRpcRequest,
  type McpToolSpec,
  parseCallToolResult,
  parseListToolsResult,
} from "./protocol.js"
import type { IncomingMessage, Transport } from "./transport/types.js"

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

export interface McpClientOptions {
  clientName: string
  clientVersion: string
  // Per-request timeout. A hung server shouldn't wedge the whole
  // session's startup.
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class McpClient {
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private serverInfo: InitializeResult["serverInfo"]

  constructor(
    private readonly transport: Transport,
    private readonly options: McpClientOptions,
  ) {
    transport.onMessage((msg) => this.handleMessage(msg))
    transport.onClose((reason) => this.handleClose(reason))
  }

  get server(): InitializeResult["serverInfo"] {
    return this.serverInfo
  }

  // Handshake: start the transport, send initialize, then the
  // notifications/initialized notification per the MCP lifecycle.
  async initialize(): Promise<InitializeResult> {
    await this.transport.start()
    const result = (await this.request(
      "initialize",
      buildInitializeParams(this.options.clientName, this.options.clientVersion),
    )) as InitializeResult
    this.serverInfo = result?.serverInfo
    await this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
    return result
  }

  async listTools(): Promise<McpToolSpec[]> {
    const result = await this.request("tools/list", {})
    return parseListToolsResult(result)
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} })
    return parseCallToolResult(result)
  }

  async close(): Promise<void> {
    await this.transport.close()
    this.rejectAllPending("client closed")
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      // send() can reject synchronously (e.g. 401 from the HTTP
      // transport) — surface that to the request's promise.
      this.transport.send(message).catch((err) => {
        const pending = this.pending.get(id)
        if (pending !== undefined) {
          this.pending.delete(id)
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  private handleMessage(msg: IncomingMessage): void {
    if (!("id" in msg)) return // notification — no tools-only handling yet
    // A JSON-RPC error can carry id=null (e.g. parse errors not tied to a
    // request); we can't correlate those to a pending call.
    if (msg.id === null) return
    const pending = this.pending.get(msg.id)
    if (pending === undefined) return
    this.pending.delete(msg.id)
    if (isJsonRpcError(msg)) {
      pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleClose(reason: string): void {
    this.rejectAllPending(reason)
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`MCP transport closed: ${reason}`))
    }
    this.pending.clear()
  }
}
