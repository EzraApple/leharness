---
name: harness-architecture
description: Use when working on leharness core architecture, including invocation flow, providers, tools, tasks, subagents, MCP, skills, events, compaction, artifacts, CLI, TUI transcript state, package exports, or runtime boundaries.
---

# Harness Architecture

Leharness is an event-sourced local agent harness. Keep core contracts boring: normalize external systems at the edge, record durable behavior as events, and let CLI/TUI/package surfaces project from those contracts.

## Package Map

| Area | Owns |
| --- | --- |
| `packages/harness` | Invocation loop, providers, tools, event log, tasks, subagents, artifacts, skills, compaction, settings |
| `packages/mcp` | MCP protocol shapes, config parsing, stdio/http transports, OAuth/token handling, manager lifecycle |
| `apps/cli` | CLI entrypoint, local runtime setup, built-in tools, app smoke scripts |
| `apps/tui` | Ink UI, transcript reducer, tool displays, slash commands, model/effort pickers, invocation hooks |
| `.leharness` | Runtime state and product-discovered skills, not repo developer guidance |
| `.agents/skills` | Repo developer-agent guidance |

## Core Invariants

- **Events are the durable contract.** Resume, transcript rendering, prompt building, background task drain, and compaction all depend on event compatibility. Add fields compatibly and tolerate older event shapes.
- **Provider quirks stop at adapters.** OpenAI-compatible, DeepSeek, and Ollama differences should normalize into shared provider responses before core logic sees them.
- **Tools have one shape.** MCP tools, local tools, and task-returning tools should adapt into the same tool-call and tool-result contracts.
- **Tasks finish through events.** Background shell and delegated subagent output must drain into `task.*` events so CLI, TUI, and future invocations agree.
- **Compaction projects from the event log.** Preserve artifact recoverability and avoid mutating historical events.
- **TUI is a projection.** Most UI regressions are transcript-state or event-shape bugs first. Fix the state contract before polishing rendering.

## Boundary Guidance

| Change | Read first | Watch for |
| --- | --- | --- |
| Event shape or replay | `packages/harness/src/events.ts`, prompt builders, TUI transcript state | Breaking old sessions, assuming optional payload fields exist |
| Provider adapter | Existing adapter plus `packages/harness/src/providers.ts` | Leaking provider-specific fields into core logic |
| Tool execution | `packages/harness/src/tools.ts`, app built-in tools, smoke scripts | Unobserved promises, inconsistent error summaries, lost started tasks |
| Shell or subagents | `packages/harness/src/shell.ts`, `packages/harness/src/subagents.ts`, task drain | Cancellation races, orphaned background tasks |
| MCP | `packages/mcp/src/protocol.ts`, transports, manager, app adapter smoke | Trusting remote JSON, closing transports incorrectly, auth retry loops |
| Compaction | `packages/harness/src/compaction/*`, compaction smoke scripts | Losing original tool bodies, summarizing the same window twice, prompt/event divergence |
| TUI transcript | `apps/tui/src/state/transcript.ts`, `apps/tui/src/display/tools.ts` | Display state not matching event state, pending cells never closing |
| Skills | `packages/harness/src/skills.ts`, `.agents/skills`, `.claude/skills` | Confusing runtime skills with repo guidance |

## Implementation Rules

- Parse dynamic payloads once at the boundary using typed readers or schema validation. Do not scatter casts through projections.
- Keep package `index.ts` exports intentional. Export public harness API, not app-local helpers.
- Prefer extending an existing event/tool/task path over adding a parallel one.
- If a new abstraction has one caller, prove why the existing path cannot own it.
- When adding an optional field to an event or config shape, update readers and smoke coverage for missing-field behavior.

## Verification

- Core/event/provider/tool/task changes: `pnpm smoke:harness`
- MCP changes: `pnpm smoke:mcp`
- CLI/TUI projection changes: `pnpm smoke:apps`
- Cross-boundary behavior: `pnpm smoke`
- Public exports or package metadata: `pnpm knip` and `pnpm package:verify`
