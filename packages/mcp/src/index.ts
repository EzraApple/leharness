// index.ts
// Public surface of @leharness/mcp. Products use McpManager + loadMcpConfig;
// the rest is exported for tests and advanced wiring. Harness-agnostic by
// design — this package never imports @leharness/harness. The app adapts
// McpToolDescriptor into a harness Tool.

export type { LoopbackAuthorization } from "./auth/oauth.js"
export { McpClient, type McpClientOptions } from "./client.js"
export {
  type HttpServerConfig,
  loadMcpConfig,
  type ParsedConfig,
  parseMcpConfig,
  type ServerConfig,
  type StdioServerConfig,
} from "./config.js"
export {
  type ConnectOptions,
  McpManager,
  type McpManagerOptions,
  type McpServerDetail,
  type McpStatus,
  type McpToolDescriptor,
} from "./manager.js"
export type { McpToolSpec } from "./protocol.js"
export { HttpTransport, UnauthorizedError } from "./transport/http.js"
export { StdioTransport } from "./transport/stdio.js"
export type { Transport } from "./transport/types.js"
