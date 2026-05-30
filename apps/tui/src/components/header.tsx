import type { HarnessDeps } from "@leharness/harness"
import type { McpServerDetail, McpStatus } from "@leharness/mcp"
import { Box, Text } from "ink"
import stringWidth from "string-width"
import { color } from "../theme.js"

// A small status mark + readable phrase per MCP state. Shown once in the
// startup header (not as a sticky bar) so connected servers are visible at a
// glance and scroll away as the conversation grows.
const MCP_MARK: Record<McpStatus, string> = {
  ready: "✓",
  connecting: "…",
  auth_required: "⚠",
  failed: "✗",
  exited: "✗",
}

const MCP_COLOR: Record<McpStatus, string> = {
  ready: color.tool,
  connecting: color.pending,
  auth_required: color.pending,
  failed: color.failure,
  exited: color.failure,
}

export function SessionHeader({
  deps,
  mcpServers,
  priorEventCount,
  sessionId,
  width,
}: {
  deps: HarnessDeps
  mcpServers: Map<string, McpServerDetail>
  priorEventCount: number
  sessionId: string
  width: number
}) {
  const runtime = [
    `${deps.provider.name}/${deps.model}`,
    deps.reasoningEffort === undefined ? undefined : `effort ${deps.reasoningEffort}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ")
  const session = `session ${sessionId}`
  const prior = priorEventCount > 0 ? `${priorEventCount} prior events` : undefined
  const innerWidth = Math.max(20, width - 4)

  return (
    <Box
      borderColor={color.meta}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
      width={Math.max(40, width)}
    >
      <Box justifyContent="space-between">
        <Text bold>leharness</Text>
        <Text color={color.meta}>{prior ?? "tui"}</Text>
      </Box>
      <Text color={color.meta}>{trimToWidth(`${runtime} · ${session}`, innerWidth)}</Text>
      <McpSection servers={mcpServers} width={innerWidth} />
    </Box>
  )
}

function McpSection({ servers, width }: { servers: Map<string, McpServerDetail>; width: number }) {
  if (servers.size === 0) return null

  const entries = [...servers.entries()]
  const nameWidth = Math.min(
    20,
    entries.reduce((max, [name]) => Math.max(max, stringWidth(name)), 0),
  )
  // glyph (2) + name column + a space before the status phrase.
  const statusWidth = Math.max(8, width - 2 - nameWidth - 1)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.meta}>mcp servers</Text>
      {entries.map(([name, detail]) => (
        <Box key={name}>
          <Text color={MCP_COLOR[detail.status]}>{`${MCP_MARK[detail.status]} `}</Text>
          <Box width={nameWidth}>
            <Text>{trimToWidth(name, nameWidth)}</Text>
          </Box>
          <Text
            color={color.meta}
          >{` ${trimToWidth(mcpStatusPhrase(name, detail), statusWidth)}`}</Text>
        </Box>
      ))}
    </Box>
  )
}

function mcpStatusPhrase(name: string, detail: McpServerDetail): string {
  switch (detail.status) {
    case "ready":
      return `ready · ${plural(detail.toolCount, "tool")}`
    case "connecting":
      return "connecting…"
    case "auth_required":
      return `needs sign-in · /mcp auth ${name}`
    case "failed":
      return "failed · /mcp for details"
    case "exited":
      return "stopped · /mcp for details"
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function trimToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  const target = Math.max(1, width - 1)
  let out = ""
  for (const char of text) {
    if (stringWidth(`${out}${char}`) > target) break
    out += char
  }
  return `${out}…`
}
