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
    description: "Clear the visible transcript.",
    name: "clear",
  },
  {
    description: "Quit the current session.",
    name: "exit",
  },
]

export function isSlashCommand(text: string): boolean {
  return SLASH_COMMANDS.some((command) => text === `/${command.name}`) || text === "/quit"
}
