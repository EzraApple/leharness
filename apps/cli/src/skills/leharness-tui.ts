// skills/leharness-tui.ts
// A built-in skill the agent can load_skill to understand the leharness
// TUI it's running inside — chiefly so it can manage its own MCP servers
// (add/edit .leharness/mcp.json) when the user asks. Registered at CLI
// startup via registerBuiltinSkill; the body is embedded as a string so
// it survives the esbuild bundle.

import { registerBuiltinSkill } from "@leharness/harness"

const LEHARNESS_TUI_SKILL = `# Managing the leharness TUI

You are running inside the leharness TUI (the \`lh\` command). This skill
explains how the harness stores state and how to add or manage MCP
servers on the user's behalf.

## Where state lives

All session state lives under \`.leharness/\` in the working directory,
unless the \`LEHARNESS_HOME\` env var overrides it. Relevant files:

- \`.leharness/sessions/<id>/events.jsonl\` — the session event log
- \`.leharness/mcp.json\` — configured MCP servers
- \`.leharness/mcp-auth/<server>.json\` — stored OAuth tokens (do not edit)

## Adding an MCP server (your job — do this with file tools)

When the user wants to add an MCP server (often by pasting a snippet),
edit \`.leharness/mcp.json\` yourself using read_file + edit_file (or
create_file if it doesn't exist). The format matches Claude Code /
Cursor / Cline:

\`\`\`json
{
  "mcpServers": {
    "<name>": {
      "command": "npx",
      "args": ["-y", "@scope/some-mcp-server"],
      "env": { "SOME_TOKEN": "..." }
    },
    "<http-name>": {
      "url": "https://example.com/mcp"
    }
  }
}
\`\`\`

- A server with \`command\` runs as a local subprocess (stdio). Put any
  secrets in \`env\`. Use this only for servers distributed as a local
  package/binary.
- A server with \`url\` is a remote HTTP server. If it needs a static
  token, add \`"headers": { "Authorization": "Bearer ..." }\`. If it uses
  OAuth, add no token — the user authorizes it interactively (see below).

IMPORTANT: for a **remote** server (anything with an \`https://\` endpoint,
e.g. Linear at \`https://mcp.linear.app/mcp\`), always use the \`url\` form.
leharness speaks Streamable HTTP and runs the full OAuth flow itself. Do
NOT wrap a remote server in a stdio bridge like \`mcp-remote\` or
\`supergateway\` — that bypasses leharness's built-in auth, so the server
connects as \`ready\` but exposes no tools and never triggers our browser
flow. The presence of an \`https://\` URL in the args is the tell that a
bridge is being (wrongly) used; configure the URL directly instead.

Steps:
1. Read the current \`.leharness/mcp.json\` (it may not exist yet).
2. Merge the new server into \`mcpServers\` — preserve existing entries.
3. Write it back. Validate it's still valid JSON.
4. Tell the user to run \`/mcp\` — it re-reads the config and connects any
   newly-added servers — then \`/mcp auth <name>\` if it's an OAuth server.

You CANNOT connect, authorize, or restart servers yourself — those are
user gestures via slash commands. Your job is the config edit.

## Slash commands the user runs (you cannot run these)

- \`/mcp\` — re-read the config, connect any newly-added servers, and
  list every server with its status and tool count (run after you edit
  the config)
- \`/mcp reconnect <server>\` — disconnect and retry one server (use after
  editing an existing server's command/url, or if it crashed)
- \`/mcp auth <server>\` — open the browser to authorize an OAuth server
- \`/mcp logout <server>\` — clear a server's stored tokens
- \`/model\`, \`/effort\` — switch model / reasoning effort
- \`/help\` — full command list

## Server status meanings

- \`ready\` — connected, its tools are available to you
- \`connecting\` — handshake in progress
- \`auth_required\` — needs \`/mcp auth <server>\` (OAuth)
- \`failed\` — couldn't connect (bad command/url, server crashed)
- \`exited\` — a previously-ready stdio server's process died

When an MCP server is \`ready\`, its tools appear to you namespaced as
\`<server>__<tool>\` (e.g. \`github__create_issue\`). Call them like any
other tool.
`

export function registerLeharnessTuiSkill(): void {
  registerBuiltinSkill({
    name: "leharness-tui",
    description:
      "How the leharness TUI works: where state lives, and how to add/manage MCP servers by editing .leharness/mcp.json. Load this when the user asks to add an MCP server or how the harness is configured.",
    body: LEHARNESS_TUI_SKILL,
  })
}
