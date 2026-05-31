// config.ts
// Parse .leharness/mcp.json. Format matches Claude Code / Cursor / Cline
// so users can copy-paste existing configs:
//
//   {
//     "mcpServers": {
//       "filesystem": { "command": "npx", "args": ["-y", "@mcp/fs", "/tmp"] },
//       "linear":     { "url": "https://mcp.linear.app/sse" },
//       "github":     { "url": "https://api.githubcopilot.com/mcp/",
//                       "headers": { "Authorization": "Bearer ghp_..." } }
//     }
//   }
//
// A `command` entry → stdio transport. A `url` entry → HTTP transport
// (bearer header static if provided, OAuth on 401 otherwise).

import { promises as fs } from "node:fs"
import { isRecord, readErrorMessage, readRecordField, readStringField } from "./readers.js"

export interface StdioServerConfig {
  kind: "stdio"
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface HttpServerConfig {
  kind: "http"
  name: string
  url: string
  // Static headers (e.g. a pre-shared bearer token). When absent and the
  // server 401s, the OAuth flow runs.
  headers: Record<string, string>
}

export type ServerConfig = StdioServerConfig | HttpServerConfig

export interface ParsedConfig {
  servers: ServerConfig[]
  warnings: string[]
}

export async function loadMcpConfig(configPath: string): Promise<ParsedConfig> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, "utf8")
  } catch {
    return { servers: [], warnings: [] } // no config → no servers, not an error
  }
  return parseMcpConfig(raw)
}

export function parseMcpConfig(raw: string): ParsedConfig {
  const warnings: string[] = []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { servers: [], warnings: [`mcp.json is not valid JSON: ${readErrorMessage(err)}`] }
  }

  const mcpServers = readRecordField(json, "mcpServers")
  if (mcpServers === undefined) {
    return { servers: [], warnings: ['mcp.json has no "mcpServers" object'] }
  }

  const servers: ServerConfig[] = []
  for (const [name, value] of Object.entries(mcpServers)) {
    const parsed = parseServer(name, value, warnings)
    if (parsed !== undefined) servers.push(parsed)
  }
  return { servers, warnings }
}

function parseServer(name: string, value: unknown, warnings: string[]): ServerConfig | undefined {
  if (typeof value !== "object" || value === null) {
    warnings.push(`server "${name}" is not an object — skipped`)
    return undefined
  }

  const command = readStringField(value, "command")
  if (command !== undefined) {
    return {
      kind: "stdio",
      name,
      command,
      args: stringArray(isRecord(value) ? value.args : undefined),
      env: stringRecord(isRecord(value) ? value.env : undefined),
    }
  }
  const url = readStringField(value, "url")
  if (url !== undefined) {
    return {
      kind: "http",
      name,
      url,
      headers: stringRecord(isRecord(value) ? value.headers : undefined),
    }
  }
  warnings.push(`server "${name}" has neither "command" nor "url" — skipped`)
  return undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === "string")
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(value)) return out
  for (const [k, val] of Object.entries(value)) {
    if (typeof val === "string") out[k] = val
  }
  return out
}
