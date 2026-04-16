# OpenCode Harness Architecture

## Scope

This note focuses on the runtime core under `opencode/packages/opencode/src`, not the terminal UI, desktop wrapper, website, or enterprise surface.

## High-Level Shape

OpenCode keeps its harness in one main package, but the core is still fairly well segmented:

- project/worktree instance management
- sessions, messages, and prompt loop
- tool registry and concrete tool definitions
- permissions and approvals
- agents and task/subtask execution
- plugins, skills, and MCP
- snapshots, storage, and compaction

The important entry boundary is `project/instance.ts`, which binds the runtime to a concrete directory and trusted project root.

## Core Turn Lifecycle

OpenCode’s execution flow is centered on sessions:

- `SessionPrompt.prompt()` accepts a prompt, expands referenced files and agents, updates permissions, and starts or resumes loop execution
- `SessionPrompt.loop()` is the stateful per-session control loop
- `SessionProcessor.process()` is the streaming turn engine that consumes model events and persists them as durable message parts

OpenCode’s runtime stores much richer turn artifacts than a plain chat history:

- reasoning blocks
- text
- step markers
- tool input
- tool running/completed/error states
- patch records
- snapshot markers
- compaction records
- subtask records

That artifact-oriented transcript model is one of its defining traits.

## Tool System

OpenCode’s tool layer is explicit but relatively compact:

- `tool/tool.ts` defines tools with schema validation and output truncation support
- `tool/registry.ts` assembles built-ins, local custom tools, and plugin tools
- `SessionPrompt.resolveTools()` wraps tools into AI SDK tool objects and runs plugin hooks around execution
- `session/llm.ts` passes the prepared tool set into the AI SDK stream path
- `mcp/index.ts` converts MCP tool schemas into runtime tools dynamically

The design is pragmatic. Rather than building a very custom tool protocol, OpenCode leans on the AI SDK and spends its engineering effort on state, permissions, and artifacts.

## Approval and Boundary Model

OpenCode separates several related concerns:

- session and persistent tool permissions in `permission/next.ts`
- trusted project-root containment in `project/instance.ts`
- explicit external-directory approval for paths outside the worktree
- direct `ctx.ask()` checks inside sensitive tools such as read, edit, apply_patch, bash, skill, task, and plan tools
- model-facing tool filtering so disabled tools are not exposed to the model

This is a notable design choice. Approval is not only enforced at execution time; it also shapes the model-visible tool surface ahead of execution.

## State, Storage, and Compaction

State is one of OpenCode’s strongest areas:

- sessions, messages, and message parts are persisted as JSON via `storage/storage.ts`
- `message-v2.ts` defines a typed durable transcript schema
- `MessageV2.toModelMessages()` adapts that durable transcript back into model-facing messages
- `summary.ts` and `compaction.ts` manage title generation, summarization, and transcript pruning
- `snapshot/index.ts` uses git tree hashes to capture and restore file state

This gives OpenCode a durable, inspectable event log of the agent’s work rather than only ephemeral in-memory chat state.

## Prompt and Instruction Layering

Prompt layering in OpenCode pulls from several places:

- provider/system headers in `session/system.ts`
- project and external instructions via `session/instruction.ts`
- per-agent prompts via the agent catalog
- plan/build reminders and constraints inserted during prompt expansion
- config-provided commands, skill paths, and agent overrides

The result is less fragment-heavy than Codex, but still structured. It is not just a static system prompt plus user text.

## Delegation

Delegation is built into the runtime model:

- built-in agents include `build`, `plan`, `general`, and `explore`, plus helper agents for compaction and summaries
- `TaskTool` creates child sessions, forwards the prompt, and summarizes nested output back into the parent
- plan mode is implemented as concrete runtime behavior through `plan_enter` and `plan_exit`
- commands can synthesize explicit `subtask` message parts that feed the nested task path

This makes OpenCode more structured than a single-agent harness even though the implementation is smaller than Claude Code or Codex.

## Extensibility

OpenCode exposes several extension surfaces:

- plugins with a broad hook surface
- local and configured skills
- local workspace tools from `.opencode/tool` and `.opencode/tools`
- MCP tools, prompts, and resources integrated through the runtime

The interesting part is how uniform the extension path is. Extensions show up inside the same session and tool abstractions as built-in capabilities.

## Testing and Debugging Hooks

The core package has a meaningful test suite for permissions, tool loading, truncation, LLM tool plumbing, and session compaction. There are also debug commands that exercise agent behavior, snapshots, skills, and other harness subsystems directly.

## What Is Distinctive

The distinctive parts of OpenCode are:

- durable message-part transcripts instead of lightweight chat logs
- strong git-backed snapshotting and revert support
- explicit plan/build mode transitions
- approval shaping both execution and model-visible tool availability
- output truncation that writes large artifacts to disk and teaches the model how to inspect them later

OpenCode feels optimized for a stateful coding session where artifacts, diffs, and resumability matter as much as the live model loop.

## Agent Loop Semantics

OpenCode’s outer loop is triggered by a session prompt or task-style invocation, not just a raw chat turn. One iteration typically compiles the current prompt state, streams the model response, records any tool calls or transcript parts, persists artifacts, and then decides whether to continue, compact, or stop. The distinctive part is that the loop is tightly coupled to durable session state: the transcript, snapshots, summaries, and nested task results are all first-class runtime artifacts rather than incidental byproducts.

```ts
async function runOpenCodeInvocation(invocation) {
  const session = await SessionPrompt.prompt(invocation)

  while (true) {
    const state = session.loadState()
    const prompt = session.resolvePrompt(state)
    const response = await llm.stream(prompt)

    await SessionProcessor.process(response, session)
    await session.persistArtifactsAndSnapshots()

    const nextAction = session.decideContinueCompactOrStop()
    if (nextAction === "stop") {
      return session.finish()
    }

    if (nextAction === "compact") {
      await session.compact()
    }
  }
}
```

## Agent Loop Diagram

```text
User Prompt
    |
    v
+-----------------------------+
| SessionPrompt.prompt()      |
| expand files / agent refs   |
| update permissions          |
+-----------------------------+
    |
    v
+-----------------------------+
| SessionPrompt.loop()        |
| load session state          |
| inspect latest messages     |
| handle subtask/compaction   |
+-----------------------------+
    |
    v
+-----------------------------+
| Prompt + Tool Resolution    |
| agent prompt                |
| system / instruction layers |
| registry + MCP tools        |
+-----------------------------+
    |
    v
+-----------------------------+
| LLM.stream / AI SDK         |
| model emits text/reasoning  |
| model emits tool calls      |
+-----------------------------+
    |
    v
+-----------------------------+
| PermissionNext              |
| tool visibility filter      |
| ask/allow/deny              |
| external directory checks   |
+-----------------------------+
    |
  +-+----------------------+
  |                        |
  v                        v
blocked / ask         approved
  |                        |
  +-----------+------------+
              |
              v
+-----------------------------+
| SessionProcessor.process()  |
| execute tools               |
| persist message parts       |
| snapshots / patches         |
+-----------------------------+
              |
              v
+-----------------------------+
| Update durable transcript   |
| JSON storage                |
| summaries / compaction      |
| git snapshot state          |
+-----------------------------+
              |
              v
+-----------------------------+
| Continue?                   |
| continue / compact / stop   |
| task or plan mode changes   |
+-----------------------------+
   | continue/compact    | stop
   v                     v
(loop back through      finish turn /
 SessionPrompt.loop)    return result
```
