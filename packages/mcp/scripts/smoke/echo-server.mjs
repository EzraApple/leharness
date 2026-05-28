// echo-server.mjs
// A trivial MCP server over stdio for smoke-testing the client. Speaks
// just enough protocol: initialize, tools/list (one "echo" tool),
// tools/call (returns the message back). Newline-delimited JSON-RPC.

import { createInterface } from "node:readline"

const rl = createInterface({ input: process.stdin })

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

rl.on("line", (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  // Notifications (no id) get no response.
  if (msg.id === undefined) return

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "0.0.0" },
      },
    })
    return
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back the provided message.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string", description: "Text to echo." } },
              required: ["message"],
            },
          },
        ],
      },
    })
    return
  }

  if (msg.method === "tools/call") {
    const message = msg.params?.arguments?.message ?? ""
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `echo: ${message}` }], isError: false },
    })
    return
  }

  // Unknown method.
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
})
