# 009 — MCP Integration

## Goal

Let `lh` connect to Model Context Protocol servers and use the tools
they expose, so the agent can reach the entire MCP ecosystem
(filesystem, GitHub, Slack, Linear, Playwright, custom internal
servers, …) without leharness writing a per-integration shim for each.

The shape: a self-contained `@leharness/mcp` package that products
(CLI/TUI) bundle. It reads a config file, connects the listed servers,
fetches their tools, and hands them back as descriptors the app adapts
into harness `Tool`s. The kernel stays essentially untouched — MCP
tools flow in through the existing `HarnessDeps.tools` seam.

This plan deliberately does not cover:
- MCP **resources** and **prompts** (tools are ~95% of server value;
  resources can later map onto the skills system from plan 003).
- MCP **sampling** (server calling back into our provider for
  inference — very few servers use it).
- Being an MCP **server** (we're a client only).
- A GUI for editing the config (hand-edit JSON for v1, like every
  other harness).

## Why this shape

### MCP is the integration unlock

leharness has a clean tool runtime but every tool today is hand-written
in `apps/cli/src/tools/`. MCP flips that: thousands of servers already
exist, each exposing tools through one protocol. Speaking MCP once gets
the agent all of them. It's the single highest-leverage step toward the
"bespoke system for rapid integrations" goal — custom agents, product
surfaces, and third-party hookups all get cheaper once MCP is underneath.

### Product-layer, not kernel

The kernel already takes `HarnessDeps.tools: Tool[]` from the app and
handles injection + dispatch. **MCP tools are just more `Tool[]`.** So
MCP needs no new kernel concept and no "session-start hook" machinery —
the app's existing "build deps before `runInvocation`" *is* the
integration seam. The flow:

```
product startup (TUI/CLI)
  → @leharness/mcp reads .leharness/mcp.json
  → connects servers (stdio / HTTP / OAuth)
  → fetches tool descriptors
  → app adapts each to a harness Tool, concatenates with builtins
  → HarnessDeps.tools = [...builtinTools, ...mcpTools]
  → runInvocation (kernel never imports @leharness/mcp)
```

Connection lifecycle and status live in app/TUI state (like
`activeTasks` and `contextUsage` already do), not the kernel event log
— connections happen outside invocations (at startup, while idle).

### Vendor the client, don't take the full SDK

`@modelcontextprotocol/sdk` is the official reference, but it's a
client+server bundle: 17 transitive deps / 4.3MB, and most of it is
server-side web framework (`express`, `hono`, `cors`,
`express-rate-limit`, `raw-body`). A client that spawns subprocesses
and makes `fetch` calls inherits none of that value. leharness's kernel
runs on 3 deps; we keep that ethos.

So we vendor the small, stable client surface and lean on focused libs
only for the genuinely-dangerous-to-roll-your-own crypto:

| Piece | Approach | New deps |
| ----- | -------- | -------- |
| jsonrpc client + capability negotiation | hand-roll (~200 lines) | 0 |
| stdio transport | node `child_process` | 0 |
| HTTP / SSE transport | `fetch` (node 20+) + `eventsource-parser` | 1 |
| OAuth flow (discovery, exchange, refresh) | hand-roll the *flow* | 0 |
| OAuth crypto (PKCE, JWT verify) | `pkce-challenge` + `jose` | 2 |
| protocol types | hand-write TS, pinned to a spec version | 0 |

Net: **3 small focused deps** (`eventsource-parser`, `pkce-challenge`,
`jose`) vs the SDK's 17. We own the protocol code (small, stable client
surface — `initialize`, `tools/list`, `tools/call`, `notifications/*`),
but never reimplement crypto primitives. The SDK's MIT-licensed client
code is a reference while building; if we copy substantial chunks we
keep the attribution.

## Position vs neighbouring harnesses

- **Claude Code / Cursor / Cline** all use the same config shape:
  `{"mcpServers": {"<name>": {"command", "args", "env"}}}` (stdio) or a
  `url` field (HTTP). We match it verbatim so users can copy-paste
  existing configs.
- **Claude Code** stores servers in `.mcp.json` (project) / user
  settings; status + auth surfaced in-product. Same split we're taking.
- All major clients lean on the official SDK; we're the outlier in
  vendoring — justified by the kernel's minimal-deps ethos and the
  client surface being small.

## Decisions locked in

| Area | Decision |
| ---- | -------- |
| Package | New `@leharness/mcp` workspace package. Bundled by products; kernel never imports it. |
| Kernel change | **One additive change**: `Tool` gains an optional `jsonSchema?: Record<string, unknown>`. When present, the provider projection uses it directly and arg-validation is a passthrough. Generalizes the tool abstraction for *any* JSON-Schema tool source — not MCP-specific code in the kernel. See "The one kernel touch". |
| Config file | `.leharness/mcp.json`, format `{"mcpServers": {"<name>": {...}}}` matching Claude Code / Cursor / Cline. |
| Transports v1 | stdio + Streamable HTTP (with SSE). Both in v1 since the goal is to test big real servers off the bat. |
| Auth v1 | All three: stdio (none), HTTP bearer (token in config/env), OAuth 2.0 + PKCE (browser flow). Crypto via `jose` + `pkce-challenge`. |
| Token storage | `.leharness/mcp-auth/<server>.json`, file perms 600. Refresh tokens persisted; access tokens refreshed on expiry. |
| Capabilities v1 | Tools only. Resources / prompts / sampling explicitly deferred. |
| Connection status | App/TUI state, not kernel events. A `McpManager` exposes per-server status (`connecting` / `ready` / `auth_required` / `failed` / `exited`); the TUI renders badges and offers re-auth. |
| Tool naming | MCP tools namespaced as `<server>__<tool>` to avoid collisions with builtins and across servers (e.g. `github__create_issue`). |
| Lifecycle | Servers connect once at product startup, persist across invocations within a session. A crashed stdio server is surfaced, not auto-restarted in v1. |
| Failure isolation | A server that fails to connect logs a warning and is skipped; its absence never blocks the session or other servers. |

## The one kernel touch

Today `Tool` is zod-native:

```ts
export interface Tool<Args = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  execute(args: Args, ctx: ToolContext): Promise<ToolExecuteResult>
}
```

`prompt.ts:toHarnessTool` converts `schema` → JSON Schema for the
provider, and `tools.ts:executeToolCall` runs `schema.safeParse(args)`
before dispatch. MCP tools are JSON-Schema-native (`inputSchema`), so a
pure-adapter approach has to either (a) round-trip JSON→zod→JSON (lossy,
needs a conversion dep) or (b) use a permissive `z.any()` schema — which
makes the provider see a useless `{type: object}` and lose the tool's
real parameters. Both are bad.

The clean fix is a minimal additive field:

```ts
export interface Tool<Args = unknown> {
  name: string
  description: string
  schema?: ZodTypeAny                       // now optional
  jsonSchema?: Record<string, unknown>      // new — pre-built JSON Schema
  execute(args: Args, ctx: ToolContext): Promise<ToolExecuteResult>
}
```

- `toHarnessTool`: if `jsonSchema` is set, use it verbatim; else convert
  `schema` as today.
- `executeToolCall`: if `schema` is set, validate as today; else
  (jsonSchema-only) pass `call.args` through untouched and let the MCP
  server validate.

This is ~10 lines, fully backwards-compatible (every existing tool sets
`schema` and is unaffected), and it generalizes the tool contract rather
than special-casing MCP. It's the *only* kernel file MCP work touches.

## Package structure

```
packages/mcp/                       # @leharness/mcp
├── package.json                    # deps: eventsource-parser, pkce-challenge, jose
├── src/
│   ├── index.ts                    # public surface
│   ├── protocol.ts                 # hand-written MCP types + jsonrpc framing
│   ├── client.ts                   # McpClient: initialize, listTools, callTool over a Transport
│   ├── transport/
│   │   ├── types.ts                # Transport interface (send/recv/close)
│   │   ├── stdio.ts                # spawn subprocess, frame jsonrpc over stdio
│   │   └── http.ts                 # fetch + SSE via eventsource-parser
│   ├── auth/
│   │   ├── oauth.ts                # discovery (RFC 8414), PKCE, token exchange/refresh
│   │   └── token-store.ts          # persist/load tokens under .leharness/mcp-auth/
│   ├── config.ts                   # parse .leharness/mcp.json
│   └── manager.ts                  # McpManager: connect all, lifecycle, status, listAllTools()
└── scripts/smoke/
    └── stdio-roundtrip.mjs         # spawn a trivial echo MCP server, list + call a tool
```

`McpManager` is the one object products touch:

```ts
const manager = new McpManager(loadMcpConfig())
await manager.connectAll({ onAuthRequired: (server, url) => openBrowser(url) })
const mcpTools: McpToolDescriptor[] = manager.listAllTools()
// status for the UI:
manager.status() // → Map<serverName, "ready" | "auth_required" | "failed" | ...>
```

`@leharness/mcp` stays harness-agnostic — it exposes
`McpToolDescriptor { name, description, inputSchema, call(args) }`, not
harness `Tool`s. A ~15-line adapter in `apps/cli` turns each descriptor
into a `Tool` using the new `jsonSchema` field. Keeps the package
reusable beyond leharness.

## Auth tiers

1. **stdio** (no auth) — server runs as a local subprocess; env vars
   from config carry any secrets (e.g. `GITHUB_TOKEN`). Covers the
   majority of popular servers. The SDK's `cross-spawn` equivalent is
   just `child_process.spawn`.
2. **HTTP + bearer** — `url` + a static token (config field or env
   reference). One header, no flow.
3. **OAuth 2.0 + PKCE** — on `connect()` the server responds 401 with
   `WWW-Authenticate`; we run discovery (RFC 8414), generate a PKCE
   challenge (`pkce-challenge`), open the browser to the auth URL
   (callback to a localhost loopback we spin up briefly), exchange the
   code for tokens, verify/decode with `jose`, persist via token-store,
   and reconnect. Refresh on expiry. This mirrors the SDK's
   `simpleOAuthClient` flow — same libraries, our own ~150-line flow.

The localhost loopback redirect handler is the one piece of real
plumbing; everything else is request/response.

## Files to add or modify

| File | Change |
| ---- | ------ |
| `packages/mcp/**` *(new)* | The whole package (above). |
| `packages/harness/src/tools.ts` | Make `schema` optional; add `jsonSchema?`; passthrough validation when only `jsonSchema` present. |
| `packages/harness/src/prompt.ts` | `toHarnessTool`: use `jsonSchema` verbatim when set. |
| `apps/cli/src/mcp/adapter.ts` *(new)* | `McpToolDescriptor` → harness `Tool` (~15 lines). |
| `apps/cli/src/cli.ts` | At startup: build `McpManager`, connect, adapt tools, concat into `deps.tools`. Keep the manager alive for the session. |
| `apps/cli/src/mcp/auth-ux.ts` *(new)* | Open browser + localhost loopback for OAuth callback. |
| `apps/tui/src/components/...` | Server-status badges; `/mcp list`, `/mcp status`, `/mcp reauth <server>` slash commands. |
| `apps/tui/src/state/types.ts` + `transcript.ts` | Track `mcpServers: Map<name, McpStatus>` for the badge row. |
| `package.json` (root) | Add `packages/mcp` smoke to `smoke:harness` or a new `smoke:mcp`. |

## Verification

Offline / scripted (`packages/mcp/scripts/smoke/`):

1. **stdio round-trip.** Ship a trivial in-repo echo MCP server (Node
   script that speaks the protocol over stdio). `McpClient` spawns it,
   `initialize`s, `listTools` returns the echo tool, `callTool` returns
   the echoed payload. Asserts framing + capability negotiation work.
2. **Tool adapter.** An `McpToolDescriptor` with a real `inputSchema`
   adapts to a harness `Tool` whose `jsonSchema` is the same object;
   `executeToolCall` dispatches without zod and the args pass through
   untouched.
3. **Config parse.** `.leharness/mcp.json` in Claude Code format parses
   into server specs; malformed entries are skipped with a warning, not
   a throw.
4. **Kernel back-compat.** Existing zod tools still validate + project
   exactly as before (run the current tool smokes — they must stay
   green untouched).

Live / manual (`lh` against real servers):

5. **stdio server** — wire up `@modelcontextprotocol/server-filesystem`
   (or similar) via `mcp.json`; confirm `lh` lists its tools and the
   model can call them against the sandbox FS.
6. **OAuth server** — wire up a real OAuth-gated server (e.g. a hosted
   GitHub or Linear MCP); confirm the browser flow completes, tokens
   persist, and a second `lh` run reuses the stored token without
   re-auth.
7. **Status + reauth** — kill a server's token, confirm the TUI shows
   `auth_required` and `/mcp reauth` re-runs the flow.

## Removability

`@leharness/mcp` is a standalone package; deleting it + the ~15-line
adapter + the startup wiring in `cli.ts` removes the feature entirely.
The kernel's `Tool.jsonSchema` field stays (it's a general improvement,
harmless when unused) or reverts trivially. No event-log schema, no
projection changes, no compaction interaction.

## What this rules out, what it leaves open

Ruled out for v1:
- MCP resources / prompts / sampling.
- leharness as an MCP server.
- Auto-restart of crashed stdio servers (surface, don't restart).
- Config GUI.

Left open:
- Resources → skills bridge (plan 003 shape fits surprisingly well).
- Per-subagent MCP server scoping (a subagent gets a subset of servers).
- Hot-reload of `mcp.json` without restarting the session.
- A `/mcp add` command that writes the config for you.
- Sampling, if a compelling server needs it.

## Naming alternatives

| Concept | Proposed | Alternatives |
| ------- | -------- | ------------ |
| Package | `@leharness/mcp` | `@leharness/mcp-client` — shorter wins; we're only ever a client |
| Manager object | `McpManager` | `McpHub`, `McpRegistry` — "manager" matches its lifecycle role |
| Tool namespacing | `<server>__<tool>` | `<server>.<tool>`, `<server>/<tool>` — double-underscore avoids tool-name char issues some providers have with dots/slashes |
| Config file | `.leharness/mcp.json` | `.mcp.json` (Claude Code) — keep it under `.leharness/` with our other state; matching the *inner* format is what enables copy-paste |
| Tool descriptor | `McpToolDescriptor` | `McpTool` — "descriptor" signals it's data, not the executable harness Tool |
