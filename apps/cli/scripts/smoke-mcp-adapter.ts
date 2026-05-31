// smoke-mcp-adapter.ts
// The adapter glue: an McpToolDescriptor (JSON-Schema-native) becomes a
// harness Tool whose jsonSchema reaches the provider verbatim, and which
// dispatches through executeToolCall WITHOUT zod validation (the MCP
// server owns inputs). Also confirms the kernel back-compat: a normal
// zod tool alongside it still validates as before.

import assert from "node:assert/strict"
import { buildPrompt, executeToolCall, type Tool } from "@leharness/harness"
import type { McpToolDescriptor } from "@leharness/mcp"
import { z } from "zod"
import { mcpToolToHarnessTool } from "../src/mcp/adapter.js"

// A fake MCP descriptor carrying a real JSON Schema.
let lastArgs: unknown
const descriptor: McpToolDescriptor = {
  name: "github__create_issue",
  serverName: "github",
  toolName: "create_issue",
  description: "Create a GitHub issue.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      body: { type: "string" },
    },
    required: ["title"],
  },
  async call(args) {
    lastArgs = args
    return { text: "created issue #42", isError: false }
  },
}

const tool = mcpToolToHarnessTool(descriptor)

// 1. The adapter carries jsonSchema, not a zod schema.
assert.equal(tool.name, "github__create_issue")
assert.equal(tool.schema, undefined, "MCP tool should have no zod schema")
assert.ok(tool.jsonSchema, "MCP tool should carry jsonSchema")
assert.deepEqual(tool.jsonSchema, descriptor.inputSchema, "jsonSchema should pass through verbatim")

// 2. The provider projection uses the MCP schema byte-for-byte (no zod round-trip).
const request = buildPrompt([], [tool], { model: "fake" })
const projected = request.tools?.find((t) => t.name === "github__create_issue")
assert.ok(projected, "tool should appear in the provider request")
assert.deepEqual(
  projected.schemaJson,
  descriptor.inputSchema,
  "model-facing schema should equal the MCP inputSchema exactly",
)

// 3. executeToolCall dispatches WITHOUT zod validation — args pass through untouched.
const result = await executeToolCall(
  { id: "c1", name: "github__create_issue", args: { title: "bug", body: "boom" } },
  [tool],
  { sessionId: "mcp-adapter-smoke" },
)
assert.equal(result.kind, "ok")
assert.equal(result.kind === "ok" ? result.value : "", "created issue #42")
assert.deepEqual(
  lastArgs,
  { title: "bug", body: "boom" },
  "args should reach the MCP call untouched",
)

// 4. An MCP error result maps to a harness tool error.
const errDescriptor: McpToolDescriptor = {
  ...descriptor,
  name: "github__broken",
  toolName: "broken",
  async call() {
    return { text: "permission denied", isError: true }
  },
}
const errResult = await executeToolCall(
  { id: "c2", name: "github__broken", args: {} },
  [mcpToolToHarnessTool(errDescriptor)],
  { sessionId: "mcp-adapter-smoke" },
)
assert.equal(errResult.kind, "error")
assert.equal(errResult.kind === "error" ? errResult.error : "", "permission denied")

// 5. Back-compat: a zod tool next to the MCP tool still validates as before.
const zodTool: Tool<{ count: number }> = {
  name: "zod_tool",
  description: "A normal zod-native tool.",
  schema: z.object({ count: z.number().int() }),
  async execute(args) {
    return { kind: "ok", output: `count=${args.count}` }
  },
}
const badArgs = await executeToolCall(
  { id: "c3", name: "zod_tool", args: { count: "not a number" } },
  [zodTool],
  { sessionId: "mcp-adapter-smoke" },
)
assert.equal(badArgs.kind, "error", "zod tool should still reject invalid args")
const goodArgs = await executeToolCall(
  { id: "c4", name: "zod_tool", args: { count: 7 } },
  [zodTool],
  { sessionId: "mcp-adapter-smoke" },
)
assert.equal(goodArgs.kind, "ok")
assert.equal(goodArgs.kind === "ok" ? goodArgs.value : "", "count=7")

console.log("smoke-mcp-adapter: jsonSchema passthrough + dispatch + zod back-compat ok")
