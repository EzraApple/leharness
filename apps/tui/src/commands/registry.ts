// commands/registry.ts
// The one place commands are defined. The menu (commandMenuItems), the /help
// listing (helpEntries), and the dispatcher (findCommand / isSlashCommand) all
// derive from COMMANDS, so adding a command is a single edit here.

import type { SlashCommand } from "../slash/types.js"
import type { Command, CommandContext } from "./types.js"

const COMMANDS: Command[] = [
  {
    name: "help",
    description: "Show TUI commands and shortcuts.",
    run: (ctx) => ctx.showHelp(),
  },
  {
    name: "session",
    description: "Print the current session id.",
    run: (ctx) => ctx.note("session", ctx.sessionId),
  },
  {
    name: "model",
    description: "Open model picker.",
    run: (ctx, args) => ctx.openPicker("model", args.trim()),
  },
  {
    name: "effort",
    description: "Open reasoning effort picker.",
    availableWhen: ({ supportsReasoning }) => supportsReasoning,
    run: (ctx, args) => ctx.openPicker("effort", args.trim()),
  },
  {
    name: "mcp",
    description: "Manage MCP servers (list, reconnect, auth, logout).",
    run: (ctx, args) => runMcp(ctx, args),
  },
  {
    name: "clear",
    description: "Clear the visible transcript.",
    run: (ctx) => ctx.clearTranscript(),
  },
  {
    name: "exit",
    description: "Quit the current session.",
    run: (ctx) => ctx.exit(),
  },
  {
    name: "quit",
    description: "Quit alias.",
    hidden: true,
    run: (ctx) => ctx.exit(),
  },
]

// Menu metadata, filtered by capability — replaces the old SLASH_COMMANDS.
export function commandMenuItems(caps: { supportsReasoning: boolean }): SlashCommand[] {
  return COMMANDS.filter(
    (command) => !command.hidden && (command.availableWhen?.(caps) ?? true),
  ).map((command) => ({ name: command.name, description: command.description }))
}

// Rows for the /help panel: every command available for the current model (so
// /effort drops out when reasoning isn't supported), including hidden ones like
// /quit so they stay documented.
export function helpEntries(caps: {
  supportsReasoning: boolean
}): { command: string; description: string }[] {
  return COMMANDS.filter((command) => command.availableWhen?.(caps) ?? true).map((command) => ({
    command: `/${command.name}`,
    description: command.description,
  }))
}

// Resolve typed text to a command + its raw arg string, or undefined.
export function findCommand(text: string): { command: Command; args: string } | undefined {
  const token = text.trim()
  for (const command of COMMANDS) {
    if (token === `/${command.name}`) return { args: "", command }
    if (token.startsWith(`/${command.name} `)) {
      return { args: token.slice(command.name.length + 2), command }
    }
  }
  return undefined
}

// /mcp [list | reconnect <s> | auth <s> | logout <s>]. Config edits are
// agent-led (it edits .leharness/mcp.json via file tools, guided by the
// leharness-tui skill); these are the user-led ops only. We reload first so
// agent-added servers in the config are reconciled before the subcommand.
async function runMcp(ctx: CommandContext, args: string) {
  const mcp = ctx.mcp
  if (mcp === undefined) {
    ctx.note("mcp", "MCP is unavailable in this session.")
    return
  }
  await mcp.reload()
  const parts = args
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
  const sub = parts[0] ?? "list"
  const server = parts[1]

  if (sub === "list") {
    const details = mcp.details()
    if (details.size === 0) {
      ctx.note("mcp", "No MCP servers configured. Ask me to add one, or edit .leharness/mcp.json.")
      return
    }
    const lines: string[] = []
    for (const [name, detail] of details.entries()) {
      lines.push(`${name} · ${detail.status} · ${detail.toolCount} tool(s)`)
      if (detail.error !== undefined) lines.push(`    ↳ ${detail.error}`)
      if (detail.recentStderr !== undefined) {
        for (const line of detail.recentStderr.slice(-5)) lines.push(`      ${line}`)
      }
    }
    ctx.note("mcp", lines.join("\n"))
    return
  }

  if (server === undefined) {
    ctx.note("mcp", `Usage: /mcp ${sub} <server>`)
    return
  }

  try {
    if (sub === "reconnect") {
      ctx.note("mcp", `reconnecting ${server}…`)
      await mcp.reconnect(server)
      ctx.note("mcp", `${server} · ${mcp.details().get(server)?.status ?? "unknown"}`)
    } else if (sub === "auth") {
      ctx.note("mcp", `authorizing ${server} — a browser window should open…`)
      await mcp.authorizeServer(server)
      ctx.note("mcp", `${server} · ${mcp.details().get(server)?.status ?? "unknown"}`)
    } else if (sub === "logout") {
      await mcp.logout(server)
      ctx.note("mcp", `${server} · logged out (tokens cleared)`)
    } else {
      ctx.note("mcp", `unknown subcommand: ${sub}. Try list / reconnect / auth / logout.`)
      return
    }
  } catch (err) {
    ctx.note("mcp", `${server} · error: ${err instanceof Error ? err.message : String(err)}`)
  }
  mcp.syncAfterChange()
}
