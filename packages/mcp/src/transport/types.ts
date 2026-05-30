// transport/types.ts
// What McpClient needs from any transport: send a JSON-RPC message,
// receive messages via a callback, and close. stdio frames messages
// over a subprocess's stdio; http POSTs them and reads JSON or an SSE
// stream back. The client doesn't care which.

import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../protocol.js"

export type IncomingMessage = JsonRpcResponse | JsonRpcNotification

export interface Transport {
  start(): Promise<void>
  send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>
  // Register the inbound-message handler; must be set before start().
  onMessage(handler: (message: IncomingMessage) => void): void
  // Register a handler for transport-level failure (process exit, dropped
  // connection) so the manager can surface "exited"/"failed".
  onClose(handler: (reason: string) => void): void
  close(): Promise<void>
}
