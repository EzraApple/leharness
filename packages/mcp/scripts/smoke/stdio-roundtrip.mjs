// stdio-roundtrip.mjs
// Spawn the echo MCP server over stdio, drive it through the real
// McpClient + StdioTransport, and assert the full path: initialize →
// tools/list → tools/call. Also exercises config parsing.

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpClient, parseMcpConfig, StdioTransport } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const echoServer = path.join(here, "echo-server.mjs")

// --- 1. stdio round-trip ---
const transport = new StdioTransport({ command: process.execPath, args: [echoServer] })
const client = new McpClient(transport, { clientName: "smoke", clientVersion: "0.0.0" })

const init = await client.initialize()
assert(
  init.serverInfo?.name === "echo",
  `expected serverInfo.name "echo", got ${init.serverInfo?.name}`,
)

const tools = await client.listTools()
assert(tools.length === 1, `expected 1 tool, got ${tools.length}`)
assert(tools[0].name === "echo", `expected tool "echo", got ${tools[0].name}`)
assert(
  tools[0].inputSchema?.type === "object" &&
    tools[0].inputSchema?.properties?.message?.type === "string",
  "echo tool should carry its real JSON Schema (object with string message)",
)

const result = await client.callTool("echo", { message: "hello mcp" })
assert(result.isError === false, "echo call should not be an error")
assert(result.text === "echo: hello mcp", `unexpected echo result: ${JSON.stringify(result.text)}`)

await client.close()

// --- 2. config parse (Claude Code format) ---
const parsed = parseMcpConfig(
  JSON.stringify({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "@mcp/fs", "/tmp"] },
      linear: { url: "https://mcp.linear.app/sse" },
      broken: { nonsense: true },
    },
  }),
)
assert(parsed.servers.length === 2, `expected 2 valid servers, got ${parsed.servers.length}`)
const fs = parsed.servers.find((s) => s.name === "fs")
assert(fs?.kind === "stdio" && fs.command === "npx", "fs should parse as stdio with command npx")
const linear = parsed.servers.find((s) => s.name === "linear")
assert(linear?.kind === "http" && linear.url.includes("linear"), "linear should parse as http")
assert(
  parsed.warnings.length === 1,
  `expected 1 warning for the broken server, got ${parsed.warnings.length}`,
)

console.log("smoke-mcp: stdio round-trip + config parse ok")
