// theme.ts
// One place for the TUI's glyph + color vocabulary. Plain constants, not a
// theming system — import the names you need. The transcript uses a tree-
// connector style: a headline glyph for prose and tool calls, a connector
// for the output nested under them, a caret for user turns, and a dim dot
// for meta lines (status, model switches, compaction notes).

export const glyph = {
  // assistant prose + tool-call headline (the start of an agent "block")
  headline: "⏺ ",
  // tool output / expanded detail, hanging under a headline
  connector: "⎿ ",
  // a user turn (a tall chevron)
  user: "❯ ",
  // dim meta lines that aren't prose or tools (status, switches, compaction)
  meta: "· ",
  // continuation indent for wrapped lines, aligned under a marker
  rail: "  ",
} as const

export const color = {
  // Semantic names — what a color means here, not which color it is. Values
  // are the literal Ink color strings the components already understood, so
  // there's no lookup layer: a component writes `color={color.tool}`.
  accent: "cyan", // mentions, active prompt border, spinner ellipsis
  userBg: "#3a3a3a", // user-row background tint (grey block behind your turns)
  userChevron: "#6e6e6e", // sent-message ❯ marker — muted grey, lighter than userBg
  tool: "green", // a tool that completed ok
  toolMeta: "gray", // tool detail / secondary text
  pending: "yellow", // in-flight tool / running prompt border
  failure: "red", // errors, failed tools
  cancelled: "yellow", // cancelled tasks
  meta: "gray", // headers, footer, help, unselected menu rows
  selected: "blue", // slash-menu / picker selection
  background: "yellow", // background-task line
} as const
