# Workflow

Use this doc for the normal repo working loop: inspect, understand ownership, edit narrowly, and keep the worktree reviewable.

## Working Loop

1. Inspect branch and dirty state:

   ```bash
   git status --short
   git branch --show-current
   ```

2. Search with `rg` before editing. Read the codepath that owns the behavior.
3. Identify the contract being touched: public exports, event log shape, provider response, tool result, task lifecycle, MCP transport/auth, TUI transcript state, packaging, or docs only.
4. Make the smallest change that fits the existing ownership boundary.
5. Run the narrowest useful command while iterating, then broaden before handoff. See `.agents/skills/development-workflow/verification.md`.

## Ownership Cues

| Surface | Likely owner |
| --- | --- |
| Invocation, events, providers, tools, tasks, subagents, skills, artifacts, compaction | `packages/harness` |
| MCP protocol, config, stdio/http transport, auth, manager lifecycle | `packages/mcp` |
| CLI entrypoint, built-in tools, smoke scripts, local runtime setup | `apps/cli` |
| Ink UI, transcript reducer, prompt input, slash commands, pickers | `apps/tui` |
| Repo developer-agent guidance | `.agents/skills` plus `.claude/skills` symlinks |
| Runtime skill discovery fixtures | `.leharness/skills` |

## Guardrails

- Preserve event log shapes, exported package APIs, and smoke-test contracts unless the task asks to change them.
- Prefer typed parsing helpers at dynamic boundaries over casts.
- Add or update smoke coverage when behavior crosses package, CLI, TUI, MCP, task, provider, or compaction boundaries.
- Do not mix unrelated cleanup into the branch unless lint or verification requires it.
