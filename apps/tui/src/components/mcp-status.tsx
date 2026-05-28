// components/mcp-status.tsx
// A dim one-line MCP server status row, shown above the footer when any
// servers are configured. Mirrors the ActiveTasks line. Color vocab:
// ready (green), connecting (yellow), auth_required (orange), failed/
// exited (red). auth_required servers hint the command to fix them.

import type { McpServerDetail, McpStatus } from "@leharness/mcp"
import { Box, Text } from "ink"

const MARK: Record<McpStatus, string> = {
  ready: "✓",
  connecting: "…",
  auth_required: "⚠",
  failed: "✗",
  exited: "✗",
}

const COLOR: Record<McpStatus, string> = {
  ready: "green",
  connecting: "yellow",
  auth_required: "yellow",
  failed: "red",
  exited: "red",
}

export function McpStatusLine({ servers }: { servers: Map<string, McpServerDetail> }) {
  if (servers.size === 0) return null

  const entries = [...servers.entries()]
  const needsAuth = entries.find(([, d]) => d.status === "auth_required")?.[0]

  return (
    <Box>
      <Text color="gray">mcp </Text>
      {entries.map(([name, detail], i) => (
        <Text key={name}>
          {i > 0 ? <Text color="gray"> · </Text> : null}
          <Text color={COLOR[detail.status]}>{MARK[detail.status]} </Text>
          <Text color="gray">{name}</Text>
        </Text>
      ))}
      {needsAuth !== undefined ? <Text color="gray">{`  (/mcp auth ${needsAuth})`}</Text> : null}
    </Box>
  )
}
