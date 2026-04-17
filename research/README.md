# Harness Architecture Survey

This folder contains a local survey of five modern agent harnesses:

- `codex-architecture.md`
- `claude-code-architecture.md`
- `opencode-architecture.md`
- `opendev-architecture.md`
- `openclaw-architecture.md`
- `harness-survey.md`
- `multiagent-survey.md`
- `background-tasks-survey.md`
- `compaction-survey.md`

The emphasis is on harness internals:

- turn lifecycle
- tool abstraction and execution
- approval and sandbox boundaries
- session state, memory, and compaction
- delegation and subagents
- extensibility surfaces such as MCP, plugins, and skills

The survey intentionally de-emphasizes TUI and web UI concerns unless they materially affect the harness core.
