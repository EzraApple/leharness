// transport/http.ts
// Streamable HTTP transport: POST each JSON-RPC message to the server
// URL and read the reply, which is either a single application/json
// response or a text/event-stream (SSE) of one or more messages. The
// server may issue an Mcp-Session-Id on initialize that we echo back on
// every later request.
//
// Auth is a bearer token supplied by the caller via getAuthHeader().
// A 401 throws UnauthorizedError so the manager can run the OAuth flow
// and retry — the transport itself stays auth-agnostic.

import { createParser } from "eventsource-parser"
import type { JsonRpcNotification, JsonRpcRequest } from "../protocol.js"
import { isIncomingMessage } from "../protocol.js"
import type { IncomingMessage, Transport } from "./types.js"

export class UnauthorizedError extends Error {
  constructor(
    message: string,
    // Points at the resource metadata the OAuth flow needs, when present.
    readonly wwwAuthenticate: string | undefined,
  ) {
    super(message)
    this.name = "UnauthorizedError"
  }
}

interface HttpTransportOptions {
  url: string
  // Called per request so a refreshed token is picked up without rebuilding
  // the transport.
  getAuthHeader?: () => string | undefined
}

export class HttpTransport implements Transport {
  private messageHandler: ((message: IncomingMessage) => void) | undefined
  private sessionId: string | undefined
  private closed = false

  constructor(private readonly options: HttpTransportOptions) {}

  onMessage(handler: (message: IncomingMessage) => void) {
    this.messageHandler = handler
  }

  onClose(_handler: (reason: string) => void) {
    // No connection to drop: per-request failures surface as thrown errors
    // from send() instead.
  }

  async start() {
    // Nothing to open; the first send() establishes the session.
  }

  async send(message: JsonRpcRequest | JsonRpcNotification) {
    if (this.closed) throw new Error("http transport closed")

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }
    const auth = this.options.getAuthHeader?.()
    if (auth !== undefined) headers.authorization = auth
    if (this.sessionId !== undefined) headers["mcp-session-id"] = this.sessionId

    const res = await fetch(this.options.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    })

    if (res.status === 401) {
      throw new UnauthorizedError(
        `server requires authorization (401)`,
        res.headers.get("www-authenticate") ?? undefined,
      )
    }
    if (!res.ok && res.status !== 202) {
      throw new Error(`MCP HTTP error ${res.status}: ${await safeText(res)}`)
    }

    const newSession = res.headers.get("mcp-session-id")
    if (newSession !== null && newSession.length > 0) this.sessionId = newSession

    // 202 Accepted (e.g. for notifications) has no body.
    if (res.status === 202 || res.body === null) return

    const contentType = res.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream")) {
      await this.consumeSse(res)
    } else {
      const payload = await res.json()
      this.dispatch(payload)
    }
  }

  async close() {
    this.closed = true
  }

  private async consumeSse(res: Response) {
    const parser = createParser({
      onEvent: (event) => {
        if (event.data.length === 0) return
        try {
          this.dispatch(JSON.parse(event.data))
        } catch {
          // ignore non-JSON SSE data
        }
      },
    })
    const reader = res.body?.getReader()
    if (reader === undefined) return
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
  }

  private dispatch(payload: unknown) {
    if (isIncomingMessage(payload)) this.messageHandler?.(payload)
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return "<no body>"
  }
}
