---
name: harness-architecture
description: Use when working on leharness core architecture, including providers, tools, tasks, subagents, MCP, skills, compaction, artifacts, CLI, or TUI behavior.
---

# Harness Architecture

## Package Map

- `packages/harness`: core invocation loop, providers, tools, events, tasks, subagents, artifacts, skills, and compaction.
- `packages/mcp`: MCP transports, auth, config parsing, and client/manager glue.
- `apps/cli`: CLI entrypoint, sample tools, local runtime setup, and smoke scripts.
- `apps/tui`: Ink terminal UI, transcript state, slash commands, pickers, MCP status, and invocation hooks.

## Invariants

- Event log payloads are the replay and resume contract. Add fields compatibly and preserve old event handling.
- Background task output must drain into events so CLI and TUI views stay consistent.
- Provider adapters should normalize provider quirks at the adapter boundary, not leak them into the core loop.
- MCP tools should adapt into the same tool shape as local tools.
- Runtime `.leharness/skills` discovery is product behavior; repo guidance belongs in `.agents/skills`.

## Change Strategy

- For core behavior, read the smoke scripts for the feature before editing.
- For TUI behavior, check transcript state and rendering together; most UI bugs are state-shape bugs first.
- For MCP auth/transport work, preserve close/error paths and avoid assuming a single transport kind.
- For compaction changes, verify both prompt projection and artifact recoverability.
