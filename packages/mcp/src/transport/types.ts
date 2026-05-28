// transport/types.ts
// What McpClient needs from any transport: send a JSON-RPC message,
// receive messages via a callback, and close. stdio frames messages
// over a subprocess's stdio; http POSTs them and reads JSON or an SSE
// stream back. The client doesn't care which.

import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../protocol.js"

export type IncomingMessage = JsonRpcResponse | JsonRpcNotification

export interface Transport {
  // Open the underlying channel (spawn the process / establish the
  // HTTP session). Resolves once ready to send.
  start(): Promise<void>
  // Send one outbound JSON-RPC request or notification.
  send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>
  // Register the handler that receives every inbound message. Set once
  // before start().
  onMessage(handler: (message: IncomingMessage) => void): void
  // Register a handler for transport-level failure (process exit,
  // connection drop). Lets the manager surface "exited"/"failed".
  onClose(handler: (reason: string) => void): void
  // Tear down the channel.
  close(): Promise<void>
}
