import type { SlashCommand } from "./types.js"

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    description: "Show TUI commands and shortcuts.",
    name: "help",
  },
  {
    description: "Print the current session id.",
    name: "session",
  },
  {
    description: "Open model picker.",
    name: "model",
  },
  {
    description: "Open reasoning effort picker.",
    name: "effort",
  },
  {
    description: "Manage MCP servers (list, reconnect, auth, logout).",
    name: "mcp",
  },
  {
    description: "Clear the visible transcript.",
    name: "clear",
  },
  {
    description: "Quit the current session.",
    name: "exit",
  },
]

export function isSlashCommand(text: string, commands = SLASH_COMMANDS): boolean {
  return (
    commands.some(
      (command) => text === `/${command.name}` || text.startsWith(`/${command.name} `),
    ) || text === "/quit"
  )
}
