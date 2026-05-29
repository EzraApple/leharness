// manager-sync.mjs
// Drive McpManager through the reconcile paths used for live config edits
// (the /mcp reload feature): start empty, add servers, drop one, reconnect
// one whose definition changed, and confirm a crashing server fails
// silently but surfaces its reason + recent stderr via details().

import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpManager } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const echoServer = path.join(here, "echo-server.mjs")
const authDir = path.join(os.tmpdir(), `leharness-mcp-sync-smoke-${process.pid}`)

// No HTTP/OAuth servers here, so beginAuthorization must never be called.
const opts = {
  interactiveAuth: false,
  beginAuthorization: async () => {
    throw new Error("beginAuthorization unexpectedly invoked")
  },
}

const echo = (name) => ({ name, kind: "stdio", command: process.execPath, args: [echoServer] })
const crash = (name) => ({
  name,
  kind: "stdio",
  command: process.execPath,
  // Write to stderr, then exit non-zero — a server that dies during the
  // handshake. The 30ms delay lets the stderr line flush before exit.
  args: [
    "-e",
    "process.stderr.write('boom: simulated startup failure\\n'); setTimeout(() => process.exit(1), 30)",
  ],
})

// --- 1. start empty, then add via syncServers (the reload-from-zero path) ---
const manager = new McpManager({
  servers: [],
  authDir,
  clientName: "smoke",
  clientVersion: "0.0.0",
})
await manager.connectAll(opts) // no servers yet; seeds the connect options reused by syncServers
assert(manager.details().size === 0, "expected no servers after an empty connectAll")

await manager.syncServers([echo("echo")])
let d = manager.details()
assert(d.get("echo")?.status === "ready", `echo should be ready, got ${d.get("echo")?.status}`)
assert(
  manager.listAllTools().some((t) => t.name === "echo__echo"),
  "echo__echo tool should be available after the add",
)

// --- 2. add a second server; both connect, both contribute tools ---
await manager.syncServers([echo("echo"), echo("echo2")])
d = manager.details()
assert(
  d.get("echo")?.status === "ready" && d.get("echo2")?.status === "ready",
  "both echo servers should be ready",
)
assert(
  manager.listAllTools().length === 2,
  `expected 2 tools, got ${manager.listAllTools().length}`,
)

// --- 3. drop the first server; it disappears, the other stays ---
await manager.syncServers([echo("echo2")])
d = manager.details()
assert(!d.has("echo"), "echo should be dropped after removal from the config")
assert(d.get("echo2")?.status === "ready", "echo2 should remain ready, untouched")

// --- 4. change echo2's definition → reconnect → failed, with reason + stderr ---
await manager.syncServers([crash("echo2")])
d = manager.details()
const detail = d.get("echo2")
assert(
  detail?.status === "failed",
  `changed config should reconnect to failed, got ${detail?.status}`,
)
assert(
  typeof detail?.error === "string" && detail.error.length > 0,
  "a failed server should carry an error reason",
)
assert(
  (detail?.recentStderr ?? []).some((line) => line.includes("boom")),
  `a failed server should surface its recent stderr, got ${JSON.stringify(detail?.recentStderr)}`,
)
assert(manager.listAllTools().length === 0, "a failed server contributes no tools")

await manager.closeAll()
console.log("smoke-mcp-manager: connect / add / drop / reconnect-on-change / failure-capture ok")
