// mcp/adapter.ts
// Turns an McpToolDescriptor (harness-agnostic, from @leharness/mcp) into
// a harness Tool. Uses the kernel's jsonSchema field so the server's
// parameter schema reaches the model verbatim — no zod round-trip. The
// MCP server owns input validation, so no kernel-side schema is set.

import type { Tool } from "@leharness/harness"
import type { McpToolDescriptor } from "@leharness/mcp"

export function mcpToolToHarnessTool(descriptor: McpToolDescriptor): Tool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    jsonSchema: descriptor.inputSchema,
    async execute(args) {
      const result = await descriptor.call(args)
      if (result.isError) {
        return { kind: "error", message: result.text || "MCP tool reported an error" }
      }
      return { kind: "ok", output: result.text }
    },
  }
}
