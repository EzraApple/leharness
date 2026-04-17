# OpenDev Harness Architecture

## Scope

This note focuses on the Rust workspace under `opendev/crates`, especially the agent runtime, tool framework, prompt system, session persistence, and subagent infrastructure.

## High-Level Shape

OpenDev is a very explicitly modular architecture. The workspace is split by subsystem:

- CLI and runtime orchestration
- agents and ReAct loop
- tool traits, registry, and implementations
- context and compaction
- history and file checkpoints
- plugins, MCP, channels, and sandbox config
- TUI and web frontends as separate consumers

The central coordinating object is `AgentRuntime`, which owns session state, prompt composer, tool registry, checkpointing, approvals, and other runtime services.

## Core Turn Lifecycle

OpenDev’s core loop is `ReactLoop`:

- collect reminders and live context
- apply safety checks
- filter the active tool schema set
- call the model
- parse the response
- dispatch tool calls in parallel or serial form
- handle completion, truncation, todo checks, and background-task conditions

The codebase makes the ReAct machinery very visible.

## Tool System

The tool framework is strongly typed:

- `BaseTool` defines tool identity, schema, execution, read-only flags, concurrency safety, and category metadata
- `ToolRegistry` plus its execution pipeline handle alias resolution, validation, middleware, deduplication, timeouts, output normalization, and sanitization
- the registry supports deferred tool schemas, so only a core subset plus activated tools are exposed to the model on a given turn

That deferred-schema idea is important. OpenDev is very explicit about keeping the model’s live tool surface narrower than the full installed tool universe.

## Approval, Sandbox, and Undo Boundaries

OpenDev uses explicit approval channels:

- tool approval requests are sent through a channel and resolved asynchronously
- bash-like commands and MCP calls have special approval handling
- file edits can trigger plan-review style gating
- approval rules can persist as allow, deny, or ask decisions

It also separates approval from undo:

- file checkpoint middleware snapshots edited files per turn
- checkpoint manifests live independently of approval state

One subtle point from the surveyed code is that OpenDev has sandbox configuration machinery, but the main strength here is approval and policy coordination rather than a visibly dominant OS sandbox layer like Claude Code.

## State, History, and Memory

OpenDev has multiple layers of state:

- `SessionManager` persists session metadata and message history
- `FileCheckpointManager` stores per-turn editable-file snapshots for undo
- `LoopState` keeps cross-iteration runtime memory such as activated tools, approval prefixes, background-task counts, and compaction state
- `ToolContext.shared_state` provides broader cross-tool shared state

The codebase also includes a memory subsystem and context engineering crate, though the most visible differentiators in the survey are history integrity, file checkpointing, and prompt composition rather than a Claude-style file-memory system.

## Prompt and Instruction Layering

Prompt construction is a major subsystem:

- `PromptComposer` registers prompt sections with priority and cache policy
- sections may be static, cached dynamic, or uncached dynamic
- factories assemble identity, safety, tool guidance, code-quality, workflow, provider-specific, and environment sections
- instruction discovery pulls from project docs, global docs, config-defined paths, and managed system locations

This is a very systematic prompt-composition framework. It resembles infrastructure more than prompt text.

## Delegation

Delegation is deeply integrated:

- `SpawnSubagentTool` creates isolated child ReAct loops
- child agents can run in background mode
- subagents can override model and working directory
- `SubagentManager` loads built-in and custom markdown-defined agents
- teammate and mailbox flows let agents share tasks through team-oriented tools and runners
- there are both full and simplified runner variants

OpenDev leans hard into multi-agent execution. It treats spawning and managing agent fleets as a core harness feature, not an edge feature.

## Extensibility

OpenDev supports several extension modes:

- custom tools from project directories
- markdown skills with frontmatter and companion files
- plugins with installation and discovery logic
- MCP support with multiple transport types

The nice architectural trait is that these capabilities feed back into the same runtime loop rather than forcing a separate orchestration path.

## Testing and Benchmarks

The workspace includes broad unit and integration testing plus Criterion benchmarks for selected agent subsystems. I did not find a distinct eval harness in the explored paths.

## What Is Distinctive

The distinctive parts of OpenDev are:

- very explicit crate-by-crate harness decomposition
- prompt sections with explicit caching policy
- deferred tool exposure
- streaming early execution of safe tools
- file-level checkpointing as a normal runtime capability
- isolated and background-capable subagents as a first-class part of the loop

OpenDev reads like a consciously modular compound-agent runtime, built to make concurrency and role separation central rather than optional.

## Agent Loop Diagram

```text
User Input / Runtime Trigger
            |
            v
+-----------------------------+
| AgentRuntime                |
| session state               |
| prompt composer             |
| tool registry               |
| approvals / checkpoints     |
+-----------------------------+
            |
            v
+-----------------------------+
| ReactLoop                   |
| reminders                   |
| live context collectors     |
| safety checks               |
+-----------------------------+
            |
            v
+-----------------------------+
| Prompt Composer             |
| static sections             |
| cached dynamic sections     |
| uncached dynamic sections   |
+-----------------------------+
            |
            v
+-----------------------------+
| Active Tool Schema Filter   |
| core tools                  |
| activated deferred tools    |
+-----------------------------+
            |
            v
+-----------------------------+
| Model Call                  |
| parse response              |
| identify tool calls         |
+-----------------------------+
            |
            v
+-----------------------------+
| Tool Approval Channel       |
| ask / allow / deny          |
| edit review gates           |
+-----------------------------+
            |
      +-----+------+
      |            |
      v            v
   denied       approved
      |            |
      +-----+------+
            |
            v
+-----------------------------+
| ToolRegistry Execution      |
| normalize / validate        |
| middleware / dedup          |
| parallel or serial dispatch |
+-----------------------------+
            |
            v
+-----------------------------+
| Session + File State        |
| history persistence         |
| loop state                  |
| file checkpoints            |
+-----------------------------+
            |
            v
+-----------------------------+
| Completion Phase            |
| truncation                  |
| todo checks                 |
| background task checks      |
+-----------------------------+
   | more work            | done
   v                      v
(loop into next          return
 ReactLoop iteration)    AgentResult
```

## Agent Loop Semantics

Conceptually, the outer loop starts when a session receives new input or a follow-up condition requires another pass. One iteration builds the current prompt from session state, filters the active tool set, calls the model, routes any tool requests through approval and execution, persists updated state and checkpoints, then runs completion checks to decide whether another pass is needed. What makes OpenDev distinct is that this is not treated as a single opaque chat turn: the loop is explicit, sessioned, approval-aware, and split into composable stages so orchestration, tools, memory, and completion can evolve independently.

```ts
async function runOpenDevInvocation(invocation) {
  agentRuntime.recordInput(invocation)

  while (true) {
    const loopState = agentRuntime.collectLoopState()
    const prompt = promptComposer.compose(loopState)
    const tools = toolRegistry.filterActiveSchemas(loopState)
    const response = await reactLoop.callModel(prompt, tools)

    const approvedCalls = await approvals.resolve(response.toolCalls)
    await toolRegistry.execute(approvedCalls, loopState)
    await history.persist(loopState)
    await checkpoints.capture(loopState)

    if (!reactLoop.shouldContinue(loopState, response)) {
      return agentRuntime.buildResult()
    }
  }
}
```
