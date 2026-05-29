// mcp/types.ts
// What the CLI hands the TUI to drive MCP: the live manager (status,
// reconnect, auth, logout) plus a closure that re-adapts the manager's
// current tools into harness Tools. The adapter lives in the CLI (it
// bridges @leharness/mcp ↔ @leharness/harness at the product layer), so
// the TUI takes it as an injected function rather than importing it.

import type { Tool } from "@leharness/harness"
import type { McpManager } from "@leharness/mcp"

export interface McpControls {
  manager: McpManager
  // MCP tools already connected at startup (folded into the first
  // invocation's deps).
  initialTools: Tool[]
  // Re-adapt the manager's current tools after reconnect/auth/logout.
  refreshTools: () => Tool[]
  // Re-read .leharness/mcp.json and reconcile the manager's server set,
  // connecting servers the agent added to the config mid-session.
  reload: () => Promise<void>
}
