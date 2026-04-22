# Harness Architecture Survey

This folder contains a local survey of six modern agent harnesses, plus cross-cutting topic surveys and one design doc.

Per-harness surveys:

- `codex-architecture.md`
- `claude-code-architecture.md`
- `opencode-architecture.md`
- `opendev-architecture.md`
- `openclaw-architecture.md`
- `pi-mono-architecture.md`

Cross-cutting topic surveys:

- `harness-survey.md`
- `multiagent-survey.md`
- `background-tasks-survey.md`
- `compaction-survey.md`

Design doc (the only doc in this folder that takes a position rather than describing one):

- `event-log-design.md` — `leharness`'s session-state architecture: events as truth, one writer per session, projection as pure function. Subagent topology, schema versioning, and storage backend all fall out as corollaries.

The emphasis is on harness internals:

- turn lifecycle
- tool abstraction and execution
- approval and sandbox boundaries
- session state, memory, and compaction
- delegation and subagents
- extensibility surfaces such as MCP, plugins, and skills

The surveys intentionally de-emphasize TUI and web UI concerns unless they materially affect the harness core.
