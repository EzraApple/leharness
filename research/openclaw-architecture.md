# OpenClaw Harness Architecture

## Scope

This note focuses on the TypeScript runtime under `openclaw/src`, especially routing, the embedded Pi agent runner, tool composition, skills, session persistence, memory indexing, and subagent orchestration. It deliberately de-emphasizes the product surfaces unless they materially shape the harness core.

## High-Level Shape

OpenClaw is not primarily a coding harness in the same sense as Codex, OpenCode, or OpenDev. It is a broader local-first assistant platform with many channels and devices, and it embeds a coding-agent runtime inside that platform.

The important split is:

- gateway and routing layer decide which agent and session should handle an inbound event
- an embedded Pi-based agent runner executes the actual model and tool loop
- OpenClaw-specific tools expose browser, nodes, canvas, messaging, cron, sessions, and gateway control
- transcript files and memory indexes make prior work searchable across sessions

This means OpenClaw’s harness architecture is best read as a control plane wrapped around an embedded agent loop rather than a bespoke coding loop built entirely from scratch.

## Core Turn Lifecycle

The core runner entrypoint is `runEmbeddedPiAgent()`. At a high level, the lifecycle is:

- resolve the session lane and global lane so work is serialized correctly
- resolve workspace, model, provider, auth profile order, and fallback policy
- evaluate context-window safety before running
- build tools, skills prompt, sandbox info, and the system prompt override
- execute a Pi-agent attempt against the session transcript file
- handle provider quirks, failover, compaction, and retries
- persist transcript changes and any tool-result side effects back into session storage

The key architectural point is that OpenClaw’s outer execution path starts before the model call. Route resolution, channel metadata, session key construction, and lane assignment are all first-class steps.

## Tool System

OpenClaw’s tool registry is unusually platform-oriented. The default runtime surface includes:

- browser automation
- canvas actions
- node/device actions
- cron scheduling
- cross-channel messaging
- TTS
- gateway control
- session listing, history, send, spawn, and status
- web search and fetch
- image handling
- plugin-provided tools

Compared with the other harnesses, this is much less “editor + shell only” and much more “assistant control plane.” The runtime still supports coding workflows, but the exposed capabilities are shaped by OpenClaw’s multi-channel assistant model.

## Approval, Sandbox, and Routing Boundaries

OpenClaw’s boundaries are split across several layers:

- routing chooses the concrete `agentId` and `sessionKey` from channel, account, peer, guild, or team context
- queue lanes ensure session-local and global concurrency control
- subagent restrictions prevent `sessions_spawn` from being called from child sessions and can limit cross-agent spawning
- sandbox policy can change by session type, especially between `main` and non-main sessions
- channel context affects how tool outputs are formatted and how replies are delivered

This is different from the other harnesses because “what environment am I in?” is not just filesystem state or worktree trust. It is also channel identity, delivery target, group/thread routing, and assistant ownership boundaries.

## State, Sessions, and Memory

Session persistence is file-centric:

- transcripts are stored as per-agent JSONL files under the state directory
- transcript updates can emit notifications to interested subsystems
- session identity is encoded into stable session keys, including subagent and thread variants

On top of that, OpenClaw has a stronger memory/search subsystem than the other surveyed harnesses:

- a memory index manager can index both memory notes and session transcripts
- it uses SQLite-backed vector and FTS search
- transcript updates can trigger incremental memory sync
- warm-session behavior lets the system prepare memory context around active sessions

The result is a runtime where session history is not just replayable chat state. It is also an indexed retrieval source for later work.

## Prompt and Skill Layering

Prompt construction is highly contextual. The embedded system prompt can incorporate:

- workspace path and notes
- think/reasoning level
- extra system prompt sections
- heartbeat prompt
- skill prompt
- docs path
- runtime info such as host, OS, architecture, provider, model, and channel
- sandbox info
- tool summaries
- timezone and time formatting
- context files

Skills are also more integrated than in many harnesses:

- skills can be loaded from bundled, managed, workspace, extra, and plugin directories
- entries are filtered through eligibility and config policy
- precedence is explicit: extra < bundled < managed < workspace
- the final skill snapshot becomes a generated prompt section for the run

This is closer to a “skill-aware prompt compiler” than a simple `load_skill` command model.

## Compaction and Context Management

OpenClaw has explicit compaction helpers and an embedded-session compaction path:

- token estimates drive chunk sizing and safety margins
- summaries can fall back progressively when message history is too large
- embedded compaction uses the same session, skill, sandbox, and prompt environment as ordinary runs
- provider-specific recovery logic exists for context or compaction failures

Architecturally, this is important because compaction is not treated as an afterthought. It is part of the same session-management substrate as the normal run path.

## Delegation

Delegation exists as session-native subagent spawning:

- `sessions_spawn` creates an isolated child session key
- child runs can inherit routing and reply-back context from the requester
- cross-agent spawning can be restricted by config
- subagent completion is announced back to the parent/requester path
- subagent runs are tracked as first-class runtime work, not just ad hoc recursion

This makes OpenClaw closer to OpenDev than to a single-agent CLI harness, but the emphasis is different. The subagent path is designed around background assistant workflows across sessions and channels, not only coding subtasks.

## Extensibility and Channels

OpenClaw is the most channel-centric system in the surveyed set:

- inbound routing can bind different agents to different accounts, peers, guilds, teams, or channels
- the same core agent runtime can deliver through many chat surfaces and companion apps
- plugin tools and plugin skill directories extend the runtime without changing the loop
- session tools let one session coordinate with others through the same gateway model

This is the clearest example of a harness that was designed from the start to survive outside a single CLI or TUI.

## Testing and Diagnostics

The codebase includes several notable diagnostics surfaces:

- route-resolution tests make session-key behavior explicit
- cache tracing writes JSONL records for prompt/session/cache analysis
- session transcript update hooks make downstream indexing observable
- failover and provider-specific sanitization logic are separated enough to inspect independently

The most distinctive diagnostic trait is that OpenClaw logs and traces the runtime as an operational platform, not just as a local coding REPL.

## What Is Distinctive

The distinctive parts of OpenClaw are:

- channel-first routing before the agent loop even begins
- an embedded Pi coding-agent runtime rather than a wholly bespoke loop
- a tool surface centered on assistant control-plane actions as much as coding
- prompt assembly that incorporates device, channel, runtime, and skill state
- session transcripts as JSONL files that also feed a searchable memory system
- background-capable subagents implemented as isolated sessions announced back through the gateway

OpenClaw reads less like “a coding assistant in a terminal” and more like “an always-on personal assistant platform that happens to contain a serious agent runtime.”

## Agent Loop Diagram

```text
Inbound Event / Trigger
  chat / webhook / cron / gateway request
                 |
                 v
+---------------------------------------+
| Route Resolution                      |
| channel / account / peer / guild      |
| choose agentId + sessionKey           |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| Lane Assignment                       |
| session lane                          |
| global lane                           |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| Embedded Run Setup                    |
| workspace                             |
| provider/model/auth profile           |
| context-window guard                  |
| sandbox + delivery metadata           |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| Prompt Assembly                       |
| runtime info                          |
| skills snapshot                       |
| tool summaries                        |
| docs/context files                    |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| Pi Agent Attempt                      |
| stream model output                   |
| parse tool calls                      |
| handle provider quirks/failover       |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| OpenClaw Tool Layer                   |
| browser / nodes / canvas / gateway    |
| sessions_* / messaging / cron         |
| plugin tools                          |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| Session Persistence                   |
| JSONL transcript file                 |
| transcript notifications              |
| subagent/session state                |
+---------------------------------------+
                 |
                 v
+---------------------------------------+
| Memory + Diagnostics                  |
| transcript indexing                   |
| cache trace                           |
| replay / searchability                |
+---------------------------------------+
       | more work / compact      | done
       v                          v
 (another embedded attempt)    deliver result
                               to channel/session
```

## Agent Loop Semantics

Conceptually, OpenClaw’s outer loop starts when any routed trigger lands on an agent session, not only when a human sends a chat message. One iteration resolves the current session environment, compiles the prompt from runtime and skill state, executes the embedded Pi-agent attempt, routes tool calls through OpenClaw’s platform tools, persists transcript updates, and decides whether the session should continue, compact, fail over, or stop. The main difference from the other harnesses is that the loop is embedded inside a larger assistant platform, so routing, delivery, and session identity are part of the harness semantics rather than outside infrastructure.

```ts
async function runOpenClawInvocation(trigger) {
  const route = routing.resolveAgentRoute(trigger)

  return lanes.inSession(route.sessionKey, async () => {
    const runState = embeddedRunner.prepare(route, trigger)

    while (true) {
      const prompt = prompting.buildEmbeddedPrompt(runState)
      const attempt = await piAgent.runAttempt(prompt, runState)

      await platformTools.handle(attempt.toolCalls, runState)
      await sessions.persistTranscript(route.sessionKey, attempt)
      await memory.notifyTranscriptUpdate(route.sessionKey)

      if (!embeddedRunner.shouldContinue(attempt, runState)) {
        return delivery.emitResult(route, attempt)
      }

      runState = await embeddedRunner.advance(runState, attempt)
    }
  })
}
```
