# Pi Mono Harness Architecture

## Scope

This note focuses on the harness-relevant parts of `pi-mono`:

- `packages/agent`, the generic stateful agent loop
- `packages/ai`, the multi-provider model layer
- `packages/coding-agent`, the productized coding-agent CLI/runtime

It de-emphasizes the TUI and web UI packages except where they reveal runtime boundaries.

## High-Level Shape

Pi has a useful split that is cleaner than several larger harnesses:

- `@mariozechner/pi-agent-core` is a generic agent loop with messages, tool execution, lifecycle events, and provider streaming.
- `@mariozechner/pi-coding-agent` wraps that loop into a coding harness with sessions, compaction, tools, extensions, skills, prompt templates, modes, and persistence.
- `@mariozechner/pi-ai` owns provider normalization and model streaming.

The important architectural distinction is that the base agent loop does not know it is a coding agent. The coding harness is layered on top.

That is directly relevant to `leharness`: it supports the idea that the harness package should stay generic, while CLI/web/TUI/product wrappers sit outside it.

## Core Loop

The low-level loop lives in `packages/agent/src/agent-loop.ts`.

Pi’s loop is message/event oriented:

- `agentLoop()` starts from new prompt messages.
- `agentLoopContinue()` resumes from existing context.
- `runLoop()` handles repeated model calls, tool calls, steering messages, and follow-up messages.
- `streamAssistantResponse()` is the boundary where `AgentMessage[]` becomes provider-compatible LLM messages.
- `executeToolCalls()` runs tool calls sequentially or in parallel depending on configuration and per-tool execution mode.

The loop has two layers:

- an inner loop for model responses and tool-call follow-ups
- an outer loop for follow-up messages that arrive after the agent would otherwise stop

```ts
async function runPiLoop(context) {
  let pending = await getSteeringMessages()

  while (true) {
    while (hasToolCalls || pending.length) {
      injectPendingMessages(pending)

      const message = await streamAssistantResponse(context)
      const toolCalls = extractToolCalls(message)
      const toolResults = await executeToolCalls(toolCalls)

      appendToolResults(context, toolResults)
      pending = await getSteeringMessages()
    }

    const followUps = await getFollowUpMessages()
    if (!followUps.length) break

    pending = followUps
  }
}
```

The interesting idea is not the exact loop shape. It is the distinction between:

- steering messages, injected after the current assistant turn finishes tool calls
- follow-up messages, injected only after the agent would otherwise stop

That is a useful vocabulary for future `leharness` ingress behavior.

## Messages, Context, and Prompt Boundary

Pi distinguishes `AgentMessage` from provider `Message`.

The base agent operates on `AgentMessage[]`, which can include standard messages plus app-specific custom messages through TypeScript declaration merging. Before each model call:

1. `transformContext()` can prune or inject context at the `AgentMessage` level.
2. `convertToLlm()` filters and converts those messages into provider-compatible messages.

```text
AgentMessage[]
  -> transformContext()
  -> AgentMessage[]
  -> convertToLlm()
  -> provider Message[]
  -> LLM
```

This maps well to the `leharness` distinction:

- `events` are canonical
- `session` is the projected runtime view
- `prompt` is the provider-facing model input

Pi’s `transformContext` / `convertToLlm` split is a concrete example of keeping app/runtime state separate from model-visible state.

## Event Model

Pi’s generic agent emits lifecycle events:

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`

These are event-stream events for UI and persistence subscribers, not exactly the same thing as `leharness`’s proposed append-only canonical event log.

The useful pattern is that the event stream is complete enough for responsive clients and session persistence. `AgentSession` subscribes to these events and persists session entries as the loop runs.

## Tool Runtime

The tool layer is compact but well-structured:

- tools define names, descriptions, schemas, execution modes, and execution functions
- arguments are prepared and validated before execution
- `beforeToolCall` can block a call after validation
- `afterToolCall` can postprocess results before they are emitted
- a tool can stream partial updates through `tool_execution_update`
- parallel mode preflights calls sequentially, then executes allowed calls concurrently
- if any tool in a batch requires sequential execution, the batch runs sequentially

This is one of the strongest insights for `leharness`’s v0 tool runtime: separate preflight from execution, and make parallelism a runtime policy rather than a property of the loop itself.

```text
Assistant tool calls
        |
        v
prepare args + validate
        |
        v
beforeToolCall hook
        |
   +----+----+
   |         |
blocked   runnable
   |         |
   v         v
error      sequential or parallel execution
             |
             v
        afterToolCall hook
             |
             v
        tool result message
```

## Sessions and Persistence

The coding-agent package adds durable sessions through `SessionManager`.

Sessions are JSONL files with:

- a session header
- append-only entries
- stable entry IDs
- `parentId` links
- branch/tree operations
- compaction entries
- custom entries for extensions
- custom message entries that can participate in model context

This is a notable design: a session is append-only but also tree-shaped. Branching can happen inside one session file by moving the leaf pointer and appending from another parent.

That is a real insight for `leharness`: event logs do not have to be strictly linear forever. A v0 can stay linear, but `parentId`-style event ancestry gives a path to branching, undo, and forked exploration later without changing the whole persistence model.

## Compaction

Pi treats compaction as a session operation layered above the generic agent loop:

- token pressure is estimated from model usage and trailing messages
- `shouldCompact()` compares context usage against model context window and reserve settings
- `prepareCompaction()` decides what to keep
- `compact()` summarizes older material
- compaction is written as a `compaction` session entry
- `buildSessionContext()` reconstructs model-visible context from branch entries plus the latest compaction summary

Pi also tracks file operations in compaction details:

- read files
- modified files

That gives the summary some artifact awareness without requiring a large standalone artifact index.

## Skills, Prompt Templates, and Extensions

Pi has a practical extension model:

- skills are markdown/frontmatter files
- prompt templates are markdown files with frontmatter
- extensions are TypeScript modules
- extensions can register tools, UI, commands, lifecycle behavior, and custom session entries
- local and global extension/skill/template locations are supported

For `leharness`, the main lesson is compatibility: markdown skills and prompt templates can stay simple, while TypeScript extensions can carry deeper behavior when needed.

## Modes and Product Wrappers

The coding agent supports several run modes:

- interactive terminal mode
- print / JSON mode
- RPC mode
- SDK embedding

The key design point is that these modes use `AgentSession` as the shared runtime. The modes are I/O layers, not separate harness implementations.

This supports the monorepo layout we discussed for `leharness`: `apps/cli`, future `apps/web`, future `apps/tui`, and package-level harness logic underneath.

## Background and Subagents

Pi’s README explicitly says it skips built-in subagents and plan mode. That means it is not a strong reference for native multi-agent architecture.

It is still relevant to background/async behavior in two ways:

- steering and follow-up queues let input arrive while the agent is working
- tool execution can stream progress and run safe calls in parallel

For `leharness`, Pi is more useful for message ingress and tool execution semantics than for subagent design.

## What Is Distinctive

The distinctive parts of Pi are:

- generic agent core separated from the productized coding agent
- `AgentMessage` vs provider `Message` as an explicit model-boundary distinction
- lifecycle event streams used for UI and persistence
- steering vs follow-up queues as two different kinds of queued input
- JSONL session files with tree-shaped `parentId` ancestry
- compact but strong tool preflight/execution/finalization pipeline
- markdown skills and prompt templates plus TypeScript extensions

## Agent Loop Diagram

```text
Prompt / Continue
       |
       v
+------------------------------+
| agentLoop / agentLoopContinue|
+------------------------------+
       |
       v
+------------------------------+
| AgentMessage Context         |
| custom messages allowed      |
+------------------------------+
       |
       v
+------------------------------+
| transformContext             |
| prune / inject context       |
+------------------------------+
       |
       v
+------------------------------+
| convertToLlm                 |
| provider-visible messages    |
+------------------------------+
       |
       v
+------------------------------+
| streamAssistantResponse      |
| provider call + deltas       |
+------------------------------+
       |
       v
+------------------------------+
| Tool Call Extraction         |
+------------------------------+
       |
       v
+------------------------------+
| Tool Preflight               |
| prepare args / validate      |
| beforeToolCall               |
+------------------------------+
       |
       v
+------------------------------+
| Tool Execution               |
| sequential or parallel       |
| streaming updates            |
+------------------------------+
       |
       v
+------------------------------+
| Tool Result Messages         |
+------------------------------+
       |
       v
+------------------------------+
| Continue?                    |
| tool calls / steering queue  |
| follow-up queue              |
+------------------------------+
   | yes                 | no
   v                     v
(next turn)          agent_end
```

## Agent Loop Semantics

Pi’s loop is not tied to chat UI. The generic `Agent` accepts prompt messages or continues from existing context, emits lifecycle events, streams a model response, executes any tool calls, and loops until no tool calls or queued messages remain.

The productized coding agent wraps this loop with session persistence, compaction, settings, tools, skills, prompt templates, extensions, and run modes.

```ts
async function runPiAgent(context) {
  emit("agent_start")

  while (true) {
    const messages = await transformContext(context.messages)
    const prompt = await convertToLlm(messages)
    const assistant = await streamModel(prompt)

    emitMessageEvents(assistant)

    const toolCalls = extractToolCalls(assistant)
    const toolResults = await executeToolCalls(toolCalls)
    context.messages.push(...toolResults)

    const steering = await getSteeringMessages()
    if (toolResults.length || steering.length) continue

    const followUps = await getFollowUpMessages()
    if (!followUps.length) break

    context.messages.push(...followUps)
  }

  emit("agent_end")
}
```

## Insights for `leharness`

Pi does introduce useful new insights:

- Keep the harness package generic and let the coding-agent behavior be one wrapper around it.
- Treat provider-visible prompt input as a projection from richer internal session state.
- Consider `steering` vs `follow-up` as two separate ingress queues instead of one generic pending-message queue.
- Make tool execution policy explicit: preflight sequentially, execute safe calls in parallel, preserve source order in final results.
- Consider `parentId` ancestry in the event log eventually, even if v0 starts linear.
- Use extension/custom entries for persisted non-model state, and custom-message entries for state that should enter model context.

What Pi does not change:

- It does not replace OpenDev as the better reference for native subagents.
- It does not remove the need for a first-class background task model in `leharness`.
- It does not make compaction worth overbuilding early.

The main integration implication is that `leharness` should probably preserve the v0 monorepo split:

- `packages/harness` as a generic agent/session runtime
- `apps/cli` as the first wrapper
- future coding-specific behavior as a layer, not as the whole core
