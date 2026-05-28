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
  manager: McpManager
  // Re-read .leharness/mcp.json and reconcile the manager's server set,
  // connecting servers added to the config after startup. Lets the TUI
  // pick up agent-led config edits without a restart.
  reload: () => Promise<void>
}

interface SetupMcpOptions {
  // TUI passes false: OAuth servers needing a browser flow are marked
  // auth_required at startup rather than blocking on a browser. One-shot
  // / minimal modes pass true (block + open browser inline).
  interactiveAuth: boolean
  // Forward MCP server stderr + connect status to this process's stderr.
  // The TUI owns the screen, so it passes false to stay quiet — failures
  // still surface via /mcp status. One-shot / minimal pass true so the
  // logs are visible while debugging.
  forwardServerLogs: boolean
}

export async function setupMcp(options: SetupMcpOptions): Promise<McpSetupResult> {
  const home = resolveLeharnessHome()
  const configPath = path.join(home, "mcp.json")
  const log = options.forwardServerLogs ? (line: string) => process.stderr.write(line) : () => {}

  const { servers, warnings } = await loadMcpConfig(configPath)
  for (const w of warnings) log(`[mcp] config warning: ${w}\n`)

  // Always create the manager — even with zero servers — so a config
  // edited mid-session (an agent-led add) can be picked up via reload()
  // without restarting the process.
  const manager = new McpManager({
    servers,
    authDir: path.join(home, "mcp-auth"),
    clientName: "leharness",
    clientVersion: cliVersion(),
  })

  const { beginAuthorization } = createOAuthAuthorizer()
  // connectAll also seeds the connect options the manager reuses for any
  // later reload() — so it must run even when the initial set is empty.
  await manager.connectAll({
    beginAuthorization,
    interactiveAuth: options.interactiveAuth,
    onStderr: (server, line) => log(`[mcp:${server}] ${line}\n`),
  })

  if (servers.length > 0) {
    const ready = [...manager.status().values()].filter((s) => s === "ready").length
    log(`[mcp] ${ready}/${servers.length} server(s) ready\n`)
  }

  const reload = async (): Promise<void> => {
    const { servers: latest, warnings: reloadWarnings } = await loadMcpConfig(configPath)
    for (const w of reloadWarnings) log(`[mcp] config warning: ${w}\n`)
    await manager.syncServers(latest)
  }

  const tools = manager.listAllTools().map(mcpToolToHarnessTool)
  return { tools, manager, reload }
}

function cliVersion(): string {
  return process.env.npm_package_version ?? "0.4.0"
}
