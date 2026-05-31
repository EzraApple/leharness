// protocol.ts
// The tools-only slice of MCP we speak: JSON-RPC 2.0 framing plus the
// method shapes we send and receive (initialize, notifications/initialized,
// tools/list, tools/call), pinned to a fixed protocol version. Resources,
// prompts, and sampling are out of scope.

// Advertised to the server on initialize; we accept whatever version it
// echoes back (MCP tolerates minor skew).
import {
  isRecord,
  readArrayField,
  readBooleanField,
  readRecordField,
  readStringField,
} from "./readers.js"

const MCP_PROTOCOL_VERSION = "2025-06-18"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

interface JsonRpcSuccess {
  jsonrpc: "2.0"
  id: number | string
  result: unknown
}

interface JsonRpcError {
  jsonrpc: "2.0"
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export function isJsonRpcError(msg: JsonRpcResponse): msg is JsonRpcError {
  return "error" in msg
}

// The inbound shapes a tools-only client handles: a response to one of our
// requests, or a server notification. Server→client requests are ignored.
export function isIncomingMessage(msg: unknown): msg is JsonRpcResponse | JsonRpcNotification {
  if (!isRecord(msg)) return false
  if ("id" in msg) return "result" in msg || "error" in msg
  return "method" in msg
}

export interface InitializeResult {
  protocolVersion: string
  capabilities: Record<string, unknown>
  serverInfo?: { name?: string; version?: string }
}

export function parseInitializeResult(result: unknown): InitializeResult {
  const protocolVersion = readStringField(result, "protocolVersion") ?? ""
  const rawServerInfo = readRecordField(result, "serverInfo")
  const serverInfo =
    rawServerInfo === undefined
      ? undefined
      : {
          name: readStringField(rawServerInfo, "name"),
          version: readStringField(rawServerInfo, "version"),
        }
  return {
    protocolVersion,
    capabilities: readRecordField(result, "capabilities") ?? {},
    serverInfo,
  }
}

export function buildInitializeParams(clientName: string, clientVersion: string): unknown {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    // Tools-only: advertise no capabilities we can't honor.
    capabilities: {},
    clientInfo: { name: clientName, version: clientVersion },
  }
}

export interface McpToolSpec {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export function parseListToolsResult(result: unknown): McpToolSpec[] {
  const tools = readArrayField(result, "tools")
  const out: McpToolSpec[] = []
  for (const t of tools) {
    if (!isRecord(t)) continue
    if (typeof t.name !== "string") continue
    out.push({
      name: t.name,
      description: readStringField(t, "description"),
      inputSchema: readRecordField(t, "inputSchema"),
    })
  }
  return out
}

export interface CallToolResult {
  text: string
  isError: boolean
}

// Tool results are an array of content blocks; flatten the text blocks and
// replace any non-text block with a type marker.
export function parseCallToolResult(result: unknown): CallToolResult {
  if (!isRecord(result)) {
    return { text: "", isError: false }
  }
  const isError = readBooleanField(result, "isError") === true
  const content = readArrayField(result, "content")
  if (content.length === 0) return { text: "", isError }
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const type = readStringField(block, "type")
    const text = readStringField(block, "text")
    if (type === "text" && text !== undefined) {
      parts.push(text)
    } else if (type !== undefined) {
      parts.push(`[${type} content omitted]`)
    }
  }
  return { text: parts.join("\n"), isError }
}
