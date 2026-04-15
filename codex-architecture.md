# Codex Harness Architecture

## Scope

This note focuses on the Rust harness core under `codex/codex-rs/core`, not the desktop shell, website, or editor integrations.

## High-Level Shape

Codex is organized more like a composable execution kernel than a single monolithic chat loop. The main hub is `core/src/lib.rs`, which fans out into:

- session and turn state
- prompt assembly and instruction fragments
- tool routing, registry, orchestration, and sandboxing
- task runners
- plugins and skills
- memory extraction and history
- delegation and review flows

The important design move is separation of concerns. Prompt composition, tool execution, state management, approvals, and delegation are distinct layers instead of being blended into one loop implementation.

## Core Turn Lifecycle

The session task system is the entry point for real work:

- `tasks/mod.rs` treats work as typed tasks such as regular execution, review, and compaction.
- `Session::spawn_task` and `start_task` prepare per-turn input, abort any superseded task, and start the async runner.
- `codex.rs::run_turn` handles prompt building, pending input, model sampling, tool-call follow-up, recursion, and completion.
- `on_task_finished` drains pending input and can schedule a follow-on idle turn.

This means Codex does not treat a turn as a single request-response pair. A turn is a stateful async process that may recursively continue through more model calls and more tool results before it is considered complete.

## Tool System

The tool system has several explicit layers:

- `tools/context.rs` normalizes tool payloads and invocation data.
- `tools/router.rs` maps model output into concrete tool calls and resolves local, MCP, and custom tools.
- `tools/registry.rs` dispatches handlers and wraps execution with hooks and telemetry.
- `tools/parallel.rs` enforces runtime concurrency rules so safe tools can run together while unsafe tools serialize.
- `tools/orchestrator.rs` is the central execution state machine for approval, sandboxing, retries, and error handling.

This is one of the cleaner separations in the set. Routing, policy, and handler execution are not the same module, which makes the harness easier to reason about.

## Approval and Sandbox Model

Codex treats approval and sandboxing as first-class protocol concepts:

- `tools/sandboxing.rs` defines traits such as `Approvable`, `Sandboxable`, `ApprovalStore`, and `ToolRuntime`.
- Individual tools, especially shell and patch tools, define their own approval keys and escalation behavior.
- MCP calls go through their own approval path rather than being treated like ordinary local tools.

The key pattern is that approval is not just a UI dialog. It is part of the tool execution contract, and sandboxing is modeled alongside the tool runtime instead of being bolted on after the fact.

## State and Memory

Codex splits long-lived and turn-local state cleanly:

- `state/session.rs` stores session-scoped history, previously granted permissions, connector selection, rate limits, and prewarmed services.
- `state/turn.rs` stores pending approvals, dynamic tool responses, pending user input, and per-turn counters.
- `state/service.rs` carries the operational dependency bag used by a running session.
- `context_manager/history.rs` holds conversation history.

Memory is not just transcript storage:

- `memories/` implements a multi-phase memory pipeline.
- `memory_trace.rs` converts traces into summarized memories.

This makes Codex closer to an agent runtime with memory services than a simple terminal chatbot.

## Prompt and Instruction Layering

Codex is unusually explicit about prompt structure:

- base instructions live in `protocol/src/prompts/base_instructions/default.md`
- project and user instructions are merged through the instructions subsystem
- `project_doc.rs` and `environment_context.rs` add repository and environment context
- `codex.rs` appends personality, app-specific rules, skills, plugins, and turn-local context

The important thing here is fragment-based assembly. Instructions are treated as composable blocks rather than one giant static system prompt string.

## Delegation

Delegation is a native runtime path:

- `codex_delegate.rs` can spawn subordinate Codex runs with inherited services and forwarded events
- `tasks/review.rs` shows a tightly scoped delegated review flow
- `agent/control.rs` keeps active-agent bookkeeping

Subagents are not just a higher-level trick. They are part of the harness’s runtime model.

## Extensibility

Codex exposes multiple extension layers:

- skills via `skills.rs`
- plugins via `plugins/mod.rs` and `plugins/render.rs`
- discoverable and deferred tools through tool specs and router params
- MCP support through its tool router rather than as a sidecar integration

The per-turn assembly of the available tool surface is a notable trait. The model does not always receive one fixed universal tool catalog.

## Testing and Debugging Hooks

The core crate has a broad test surface under `core/tests`, including approvals, compaction, plugins, skills, and state behavior. `prompt_debug.rs` is especially useful because it reconstructs real prompt context for inspection.

## What Is Distinctive

The distinctive parts of Codex are:

- strong separation between prompt fragments, tool routing, orchestration, and task running
- explicit modeling of turn state versus session state
- approval and sandbox policy integrated into the tool runtime contract
- built-in delegation paths that feel like part of the kernel, not a bolt-on feature

If you strip away the surrounding product layers, Codex looks like a carefully modular execution substrate for coding-agent work.

## Agent Loop Diagram

```text
User / External Input
        |
        v
+---------------------------+
| Session::spawn_task       |
| start_task                |
| tasks/mod.rs              |
+---------------------------+
        |
        v
+---------------------------+
| Turn State + Session State|
| pending input             |
| history / permissions     |
+---------------------------+
        |
        v
+---------------------------+
| Prompt Assembly           |
| base instructions         |
| project docs              |
| env context               |
| skills / plugins          |
+---------------------------+
        |
        v
+---------------------------+
| run_turn                  |
| sample model              |
| parse assistant output    |
+---------------------------+
        |
        v
+---------------------------+
| Tool Router               |
| local / MCP / custom      |
+---------------------------+
        |
        v
+---------------------------+
| Tool Orchestrator         |
| approval                  |
| sandbox policy            |
| retries / parallel rules  |
+---------------------------+
        |
   +----+----+
   |         |
   v         v
tool ok   tool result/error
   |         |
   +----+----+
        |
        v
+---------------------------+
| Update history + turn     |
| state                     |
+---------------------------+
        |
        v
+---------------------------+
| Need follow-up?           |
| more tool calls?          |
| compaction?               |
| delegated task?           |
+---------------------------+
   | yes                | no
   v                    v
(loop to prompt /      finish task,
 sampling path)        drain pending input
```
