# Claude Code Harness Architecture

## Scope

This note focuses on the leaked CLI runtime under `claude-code/src`, especially `QueryEngine`, the tool system, permissions, memory, and delegation. It does not treat the Ink UI as the main subject.

## High-Level Shape

Claude Code is the most monolithic codebase in this set, but its harness spine is still identifiable:

- CLI/bootstrap in `entrypoints/cli.tsx`, `main.tsx`, and `replLauncher.tsx`
- conversation execution in `QueryEngine.ts`
- tool contract in `Tool.ts`
- tool execution and batching in `services/tools/*`
- state and environment context in `state/*`, `context.ts`, and memory services
- permission and sandbox logic in `hooks/useCanUseTool.tsx`, `utils/permissions/*`, and `utils/sandbox/*`
- delegation in `tools/AgentTool/*` and `utils/forkedAgent.ts`

The main difference from the others is density. Claude Code carries many capabilities inside a single large runtime rather than splitting them into smaller packages or crates.

## Core Turn Lifecycle

The central actor is `QueryEngine`:

- one `QueryEngine` instance represents one conversation
- `submitMessage()` executes a turn while preserving conversation state across turns
- the engine assembles system and user context, then iterates over streamed messages from the model/tool pipeline
- the loop records assistant output, system events, progress state, attachments, compact boundaries, and budget checks

This is a fully stateful conversation engine, not a stateless prompt runner. Budget management, max-turn enforcement, compaction boundaries, and event streaming all live inside the same turn processor.

## Tool System

Claude Code’s tool system is rich and opinionated:

- `Tool.ts` defines the tool contract, including permissions, renderers, concurrency safety, and result mapping
- `toolExecution.ts` validates inputs, runs tool-specific checks, executes the tool, and maps output back into transcript shape
- `toolOrchestration.ts` batches concurrency-safe tools in parallel and serializes unsafe ones
- `StreamingToolExecutor.ts` is the queue-based streaming path with ordering and cancellation behavior

This is more than a list of tool handlers. It is a runtime for tool execution with explicit streaming and concurrency semantics.

## Approval and Sandbox Model

Safety is one of Claude Code’s defining architectural features:

- `useCanUseTool` is the top-level approval gate
- `permissionSetup.ts` classifies dangerous and auto-mode permissions
- `sandbox-adapter.ts` converts policy settings into runtime sandbox rules
- Bash sandbox usage is decided through explicit logic instead of one global switch

The important pattern is layering:

- model-facing permission hints
- per-tool checks
- classifier logic for risky actions
- interactive approval behavior
- OS-level sandbox settings

This is the most elaborate approval and sandbox stack in the comparison set.

## State and Memory

Claude Code has both regular state and extra memory machinery:

- `AppStateStore.ts` keeps long-lived runtime state such as plugins, MCP state, tasks, file history, and permissions
- `context.ts` adds repository state, date, and memory context into the turn prompt
- `memdir.ts` treats `MEMORY.md` plus topic files as a file-backed memory system
- `sessionMemory.ts` runs a background extraction loop to derive session memory using a subagent path

That combination matters. Claude Code does not stop at transcript history. It actively maintains separate persistent memory structures and background extraction behavior.

## Prompt and Instruction Layering

Prompt construction is careful and cache-aware:

- `constants/prompts.ts` defines the static versus dynamic prompt boundary
- `getSystemPrompt()` assembles named prompt sections such as memory, env info, MCP guidance, output style, summarization rules, and token controls
- `QueryEngine.submitMessage()` can further append custom system text and extra prompt content

This gives Claude Code a strong prompt-governance layer. Prompt construction is treated as a major subsystem rather than a helper function.

## Delegation

Delegation is substantial:

- `AgentTool` supports teammate or subagent execution with explicit guards
- `forkedAgent.ts` creates isolated fork parameters and preserves cache-safe structure
- `runAgent.ts` executes the subagent, records sidechain transcripts, and cleans up agent-scoped state afterward

The important detail is that forking is not just “run another model call.” It creates a managed sidechain with state isolation and lifecycle cleanup.

## Extensibility

Claude Code extends through the same harness mechanisms it uses for built-ins:

- bundled and dynamic plugins
- bundled and dynamic skills
- MCP tools and resources
- feature-gated tools including browser, cron, LSP, and worktree features

The tool surface is where most capability extension lands, which keeps extensions inside the normal harness flow.

## Testing and Debugging Hooks

The codebase includes useful inspection and eval hooks:

- `--dump-system-prompt` in the CLI
- `services/api/dumpPrompts.ts` for prompt and response trace logging
- test-only permission tools
- service smoke tests in `scripts/test-services.ts`

Claude Code appears to value prompt inspection and issue reproduction as core debugging workflows.

## What Is Distinctive

The distinctive parts of Claude Code are:

- the strongest layered safety model in the set
- a very developed memory architecture, including file memory and background session memory extraction
- sidechain-style delegated agents with transcript persistence
- strong cache-stability awareness in prompt assembly and forking behavior

The cost of that sophistication is complexity. Compared with the others, Claude Code feels the most mature in safety and memory, and also the least minimal.

## Agent Loop Diagram

```text
User Message
     |
     v
+-----------------------------+
| QueryEngine.submitMessage() |
+-----------------------------+
     |
     v
+-----------------------------+
| Build Context               |
| system prompt sections      |
| memory files                |
| env + repo state            |
| custom prompt additions     |
+-----------------------------+
     |
     v
+-----------------------------+
| Stream query(...)           |
| assistant events            |
| progress events             |
| attachments / system msgs   |
+-----------------------------+
     |
     v
+-----------------------------+
| Tool Selection              |
| Tool.ts contract            |
| toolExecution               |
+-----------------------------+
     |
     v
+-----------------------------+
| Permission / Safety Layer   |
| useCanUseTool               |
| permission classification   |
| sandbox adapter             |
+-----------------------------+
     |
   +-+----------------------+
   |                        |
   v                        v
denied / ask UI        approved
   |                        |
   +-----------+------------+
               |
               v
+-----------------------------+
| Tool Orchestration          |
| parallel safe tools         |
| serial unsafe tools         |
| streaming executor queue    |
+-----------------------------+
               |
               v
+-----------------------------+
| Persist Transcript + State  |
| app state store             |
| sidechain / agent records   |
| memory extraction hooks     |
+-----------------------------+
               |
               v
+-----------------------------+
| Continue turn?              |
| more tool calls             |
| compact boundary            |
| max turn / budget stop      |
+-----------------------------+
   | yes                  | no
   v                      v
(loop back into          finalize turn
 query stream)           / emit result
```
