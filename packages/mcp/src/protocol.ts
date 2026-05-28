// protocol.ts
// The slice of MCP we speak as a tools-only client: JSON-RPC 2.0 framing
// plus the handful of method shapes we send/receive (initialize,
// notifications/initialized, tools/list, tools/call). Hand-written and
// pinned to a protocol version rather than pulling the official SDK,
// whose bulk is server-side. Resources / prompts / sampling are out of
// scope (plan 009).

// We advertise this protocol version on initialize; servers echo their
// own and we accept whatever they return (MCP is lenient on minor skew).
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

export function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === "object" && msg !== null && "id" in msg && ("result" in msg || "error" in msg)
  )
}

// ---- initialize ----

export interface InitializeResult {
  protocolVersion: string
  capabilities: Record<string, unknown>
  serverInfo?: { name?: string; version?: string }
}

export function buildInitializeParams(clientName: string, clientVersion: string): unknown {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    // We're a tools-only client; advertise nothing we can't honor.
    capabilities: {},
    clientInfo: { name: clientName, version: clientVersion },
  }
}

// ---- tools/list ----

export interface McpToolSpec {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export function parseListToolsResult(result: unknown): McpToolSpec[] {
  if (typeof result !== "object" || result === null) return []
  const tools = (result as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  const out: McpToolSpec[] = []
  for (const t of tools) {
    if (typeof t !== "object" || t === null) continue
    const spec = t as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof spec.name !== "string") continue
    out.push({
      name: spec.name,
      description: typeof spec.description === "string" ? spec.description : undefined,
      inputSchema:
        typeof spec.inputSchema === "object" && spec.inputSchema !== null
          ? (spec.inputSchema as Record<string, unknown>)
          : undefined,
    })
  }
  return out
}

// ---- tools/call ----

export interface CallToolResult {
  text: string
  isError: boolean
}

// MCP tool results are an array of content blocks; for a tools-only text
// client we flatten text blocks and note any non-text blocks by type.
export function parseCallToolResult(result: unknown): CallToolResult {
  if (typeof result !== "object" || result === null) {
    return { text: "", isError: false }
  }
  const r = result as { content?: unknown; isError?: unknown }
  const isError = r.isError === true
  if (!Array.isArray(r.content)) return { text: "", isError }
  const parts: string[] = []
  for (const block of r.content) {
    if (typeof block !== "object" || block === null) continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text)
    } else if (typeof b.type === "string") {
      parts.push(`[${b.type} content omitted]`)
    }
  }
  return { text: parts.join("\n"), isError }
}
