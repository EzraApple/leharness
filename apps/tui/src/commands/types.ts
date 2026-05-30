// commands/types.ts
// The shape of a slash command and the capabilities it can reach. Behavior
// used to live inline in app.tsx's submit() ladder; pulling it behind these
// interfaces lets the menu, the /help listing, and the dispatcher all derive
// from one COMMANDS array (see registry.ts) instead of drifting apart.

import type { McpServerDetail } from "@leharness/mcp"

// The MCP user-ops a /mcp subcommand needs. A thin slice of the live manager
// plus a "push the change back into React" callback, assembled in app.tsx
// from the injected McpControls so a command never imports React state.
export interface McpCommandControls {
  reload(): Promise<void>
  details(): Map<string, McpServerDetail>
  reconnect(server: string): Promise<void>
  authorizeServer(server: string): Promise<void>
  logout(server: string): Promise<void>
  // Reflect any status/tool change after an op (reconnect/auth/logout).
  syncAfterChange(): void
}

// The capability surface a command runs against. Each method maps to behavior
// that previously sat inline in app.tsx, repackaged under an intent-named call.
export interface CommandContext {
  // Append a system / error note to the transcript.
  note(title: string, text: string): void
  noteError(title: string, text: string): void
  // Clear the visible transcript (and dismiss help + composer).
  clearTranscript(): void
  // Open the model / effort modal picker, seeded with an optional query.
  openPicker(kind: "model" | "effort", query: string): void
  // Show the help panel.
  showHelp(): void
  // Quit the session.
  exit(): void
  // The current session id, for /session.
  sessionId: string
  // MCP controls, or undefined when MCP is unavailable this session.
  mcp: McpCommandControls | undefined
}

export interface Command {
  name: string
  description: string
  // Dispatchable and valid, but never listed in the menu (e.g. the /quit alias).
  hidden?: boolean
  // Commands gated on a capability return false to drop out of the menu.
  // Absent = always listed. Note: a hidden-from-menu command can still be
  // typed and dispatched; this only affects what the menu offers.
  availableWhen?(caps: { supportsReasoning: boolean }): boolean
  // `args` is the raw text after `/name ` so each command parses its own.
  run(ctx: CommandContext, args: string): void | Promise<void>
}
