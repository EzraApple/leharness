# Comparative Survey of Coding-Agent Harnesses

## Scope and Framing

This survey compares four harnesses:

- OpenAI Codex
- Claude Code
- OpenCode
- OpenDev

The goal is not to rank them, design a new one, or prescribe how `leharness` should be built. The goal is to isolate the architectural pieces that repeatedly show up in strong harnesses, then describe what each system does that is genuinely distinctive, and finally separate broadly important patterns from patterns that are more situational.

The emphasis is on harness internals rather than product shell:

- turn loop
- tool layer
- approval and sandbox boundaries
- transcript and state model
- delegation and subagents
- memory and compaction
- extensibility

## 1. Shared Harness Architecture Bits

### 1.1 A Turn Engine, Not Just a Prompt Wrapper

All four repos implement some form of a persistent turn engine rather than a naive:

1. send user prompt
2. receive answer
3. maybe call a tool

Instead, each harness has a loop that:

- preserves conversation state across turns
- invokes the model repeatedly until the current unit of work is done
- integrates tool results back into the same turn or session
- handles interrupts, retries, continuation, or compaction

This is the core architectural boundary of a real harness. The essential unit is not a single model completion. It is a managed turn or task that may involve multiple model calls and tool executions.

### 1.2 A Real Tool Runtime

All four harnesses treat tools as structured runtime objects with some combination of:

- a name and schema
- argument validation
- execution hooks
- output normalization
- concurrency rules
- permission or sandbox metadata

The stronger harnesses do not just map tool names to functions. They add a routing or orchestration layer that decides:

- whether the tool is available
- whether it can run in parallel
- whether it needs approval
- how output should be sanitized or truncated
- how errors are folded back into the transcript

This is one of the clearest shared essentials. The harness needs a tool execution subsystem, not only tool implementations.

### 1.3 Approval and Boundary Management

All four harnesses distinguish between:

- what the model is allowed to ask for
- what the runtime is allowed to execute
- what the user must explicitly approve

The exact style differs, but the shared pattern is stable:

- file editing is treated differently from read-only inspection
- shell commands are a separate risk class
- path escape or external directory access is treated as a distinct boundary
- persistent allow or deny memory is often kept somewhere in session or runtime state

This is essential harness architecture. Without it, the harness is not really managing the consequences of tools; it is only exposing them.

### 1.4 Transcript and Session State Are First-Class

Every repo has a persistent or semi-persistent representation of session state beyond raw chat text. Common tracked data includes:

- transcript history
- tool calls and tool results
- session metadata
- approval state
- pending input or background work
- compaction markers or summaries

The main architectural lesson is that the transcript is not just for display. It is operational state.

### 1.5 Prompt Construction Is Its Own Subsystem

None of the four repos treat the system prompt as a single static string. All of them layer prompt content from multiple sources such as:

- base instructions
- project instructions like `AGENTS.md` or `CLAUDE.md`
- runtime environment context
- tool instructions
- session or memory state
- agent-specific or mode-specific guidance

The better harnesses also separate stable from dynamic prompt content, either explicitly or implicitly, because prompt cache stability and prompt auditability matter in long-running agent systems.

### 1.6 Compaction or Memory Pressure Handling

All four repos have some response to context growth:

- explicit compaction turns
- summaries
- memory extraction
- token-budget boundaries
- truncation of large tool output

This does not always appear as one unified memory subsystem, but some form of context-management machinery is universal.

### 1.7 Delegation Is Moving from Optional to Core

All four repos support some form of delegation or subtask execution:

- subagents
- forked runs
- task tools
- agent fleets
- mode-specific helper agents

This is now close to a shared modern harness pattern. A strong harness increasingly assumes that some work should happen in isolated secondary contexts instead of inside one giant primary transcript.

### 1.8 Extension Surfaces Matter

All four repos expose at least some of the following:

- MCP integration
- plugins
- skills or instruction modules
- custom tools

The shared takeaway is that harnesses age badly if capability is hard-coded. A useful harness usually needs a way to add tool surfaces and instruction surfaces without rewriting the core loop.

## 2. What Each Harness Is Uniquely Good At

### 2.1 Codex

Codex is strongest where architectural separation matters. Its standout traits are:

- explicit split between session state and turn state
- clear layering of tool routing, registry, orchestration, and sandbox policy
- fragment-based prompt assembly instead of one giant prompt builder
- task kinds and delegation paths modeled directly in the runtime

What is important about that uniqueness is not the language or stack. It is the disciplined decomposition. Codex makes the harness feel like infrastructure with well-defined layers.

### 2.2 Claude Code

Claude Code is strongest where safety, memory, and operational maturity matter. Its standout traits are:

- the deepest layered approval and sandbox model in the set
- strong prompt cache-boundary awareness
- file-backed memory plus session-memory extraction
- sidechain-style delegated agents with cleanup and transcript persistence

What is important about that uniqueness is how much work it puts into operational control. Claude Code behaves like a system that expects long sessions, risky tool use, and the need to replay or inspect what happened later.

### 2.3 OpenCode

OpenCode is strongest where durable coding-session state matters. Its standout traits are:

- typed durable message parts rather than a thin transcript
- git-backed snapshots and revert-aware session state
- explicit plan/build mode transitions
- approval rules shaping the model-visible tool set
- artifact-oriented output truncation

What is important about that uniqueness is its emphasis on coding work as a stream of durable artifacts. OpenCode treats session execution as something to persist, inspect, compact, and recover.

### 2.4 OpenDev

OpenDev is strongest where modular runtime design and multi-agent execution matter. Its standout traits are:

- the clearest subsystem decomposition in the comparison
- prompt sections with explicit caching policy
- deferred tool exposure
- background-capable isolated subagents
- file checkpointing integrated into normal runtime flow

What is important about that uniqueness is that it pushes concurrency and role separation into the center of the architecture. OpenDev is not only a ReAct loop with tools. It is a runtime for many coordinated loops.

## 3. Objective View: Good, Situational, and Non-Essential

This section does not mean “good” versus “bad engineering.” “Non-essential” here means “not required for a capable harness core.”

### 3.1 Broadly Important Across Strong Harnesses

These patterns show up repeatedly and look foundational:

- a stateful turn engine that can recurse through tool results
- a tool registry or router with schema validation and execution policy
- explicit approval boundaries for shell, editing, and path escape
- durable session state beyond plain chat text
- prompt layering from base instructions, project docs, and runtime context
- some form of compaction, summary, or large-output management
- at least one isolation mechanism for delegated or nested work
- extension surfaces for tools and instructions

If a harness is missing most of this set, it is usually still in “agent wrapper” territory rather than “harness” territory.

### 3.2 High-Leverage But Not Always Necessary Immediately

These patterns are strong, but whether they are essential depends on scope:

- prompt cache-aware sectioning
- persistent approval memories
- rich transcript artifacts like patch markers and subtask records
- git-backed snapshots or file checkpoints
- automatic session memory extraction
- tool-surface filtering before exposure to the model
- explicit background subagents

These become more important as sessions get longer, tools get riskier, or agent workflows get more autonomous.

### 3.3 Often Non-Essential to the Harness Core

These may be valuable product features, but they are not core harness prerequisites:

- elaborate TUI behavior and terminal rendering
- web dashboards and remote monitoring shells
- highly specialized slash-command ecosystems
- large bundled feature catalogs unrelated to the core loop
- provider-specific polish outside the basic model abstraction
- marketplace-scale plugin distribution before the extension interface itself is stable

They can be useful, but they do not define whether the underlying harness architecture is solid.

## 4. Repo-by-Repo Objective Read

### 4.1 Codex

Clearly strong:

- architecture layering
- separation of state domains
- tool orchestration as a dedicated subsystem
- delegation integrated into runtime tasks

Potentially non-essential unless the harness is large:

- the full degree of prompt fragment infrastructure
- the depth of task-kind specialization
- the breadth of product-facing integration around the core

### 4.2 Claude Code

Clearly strong:

- safety and sandbox layering
- memory architecture
- sidechain delegation
- prompt observability and cache-stable construction

Potentially non-essential unless the harness operates at comparable scale or risk:

- very deep permission classification logic
- extensive product subsystems around the main engine
- large volumes of mode- and feature-specific tooling

### 4.3 OpenCode

Clearly strong:

- durable artifact-oriented session model
- snapshot-aware coding workflow
- clean approval handling with model-surface filtering
- structured plan/build separation

Potentially non-essential unless persistence and recovery are central:

- full richness of part-level transcript taxonomy
- some of the git/snapshot machinery
- broad product packaging beyond the main session engine

### 4.4 OpenDev

Clearly strong:

- modular decomposition
- deferred tool exposure
- prompt cache policies
- file checkpointing and isolated subagents

Potentially non-essential unless multi-agent execution is central:

- full agent-fleet machinery
- the degree of subsystem separation
- some of the surrounding channel and frontend breadth

## 5. How To Think About the Survey

A useful neutral way to read these repos is:

- first identify what is universally required to keep a coding agent coherent across many steps
- then identify what appears when teams optimize for long sessions, risky tools, or delegated work
- then separate product complexity from harness necessity

Across all four, the same core picture keeps appearing:

- a managed turn loop
- a policy-aware tool runtime
- durable operational state
- prompt assembly from many inputs
- mechanisms for context pressure
- some form of isolated delegated execution

That repeated pattern is the main signal from the survey. The interesting differences are mostly in how much each repo invests in safety layering, transcript durability, prompt infrastructure, and multi-agent orchestration.
