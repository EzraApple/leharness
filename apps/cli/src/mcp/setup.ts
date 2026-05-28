// mcp/setup.ts
// Ties MCP into the CLI startup: read .leharness/mcp.json, connect the
// servers, adapt their tools into harness Tools. Returns the tools (to
// concat into HarnessDeps.tools) plus the live manager (so the caller
// can close it / read status later). Failures are non-fatal — a broken
// MCP server never blocks the session.

import path from "node:path"
import process from "node:process"
import { resolveLeharnessHome, type Tool } from "@leharness/harness"
import { loadMcpConfig, McpManager } from "@leharness/mcp"
import { mcpToolToHarnessTool } from "./adapter.js"
import { createOAuthAuthorizer } from "./auth-ux.js"

interface McpSetupResult {
  tools: Tool[]
  manager: McpManager | undefined
}

export async function setupMcp(): Promise<McpSetupResult> {
  const home = resolveLeharnessHome()
  const configPath = path.join(home, "mcp.json")
  const { servers, warnings } = await loadMcpConfig(configPath)

  for (const w of warnings) process.stderr.write(`[mcp] config warning: ${w}\n`)
  if (servers.length === 0) return { tools: [], manager: undefined }

  const manager = new McpManager({
    servers,
    authDir: path.join(home, "mcp-auth"),
    clientName: "leharness",
    clientVersion: cliVersion(),
  })

  const { redirectUri, authorize } = createOAuthAuthorizer()
  await manager.connectAll({
    redirectUri,
    authorize,
    onStderr: (server, line) => process.stderr.write(`[mcp:${server}] ${line}\n`),
  })

  const status = manager.status()
  const ready = [...status.values()].filter((s) => s === "ready").length
  process.stderr.write(`[mcp] ${ready}/${servers.length} server(s) ready\n`)

  const tools = manager.listAllTools().map(mcpToolToHarnessTool)
  return { tools, manager }
}

function cliVersion(): string {
  return process.env.npm_package_version ?? "0.3.1"
}
