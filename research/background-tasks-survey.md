# Background Tasks Survey

## Scope

This note looks only at core runtime behavior for work that does not finish immediately:

- long-running bash or process execution
- detached or background tool execution
- queued work and lane-based serialization
- subagents or child sessions that resolve later
- compaction work that may retry or complete asynchronously

The focus is on how the harness tracks in-flight work, how callers rejoin it, and how results come back into the session. UI surfaces are only relevant when they reveal runtime behavior.

## What Counts As Background Work

For this survey, "background async work" means work that:

- starts now but may complete later
- has an ID, handle, session, task record, or queue entry
- lets the caller continue doing other things
- can be joined, polled, resumed, or observed through events
- may fail, time out, be cancelled, or be compacted into a summary

If a harness only blocks until completion, that is not background work. If it creates a second session, a queued process, or a delayed completion path, that is.

```text
Invocation
   |
   v
Foreground loop -----> background handle / child session / queue entry
   |                                      |
   | continue work                        | complete later
   v                                      v
more model/tool work                result event / transcript update
   |                                      |
   +--------------------<-----------------+
                join / wait / poll / inject
```

## Codex

Codex is very protocol-heavy. Background behavior shows up in several places:

- thread and review operations can be detached onto new threads
- the protocol includes `spawnAgent`, `wait`, `resumeAgent`, and `closeAgent`
- thread state tracks loaded sessions and spawned descendants

The important thing is that Codex treats background work as part of the thread model, not as an ad hoc side process.

The caller can continue working while a spawned thread or background command runs, then later rejoin through the thread/task protocol or inspect the thread state. That gives it a real wait/join model, even though the exact primitive varies by surface.

```ts
async function runCodexTask(task) {
  const thread = await spawnThread(task)

  while (thread.hasPendingWork()) {
    const turn = await thread.runTurn()
    await thread.routeToolCalls(turn)
    if (turn.spawnedChild) await thread.trackChild(turn.spawnedChild)
  }

  return await thread.wait()
}
```

Good ideas to adapt:

- explicit thread IDs for detached work
- a real `wait` primitive instead of only polling
- child thread lifecycle bookkeeping

Shortcomings or heavier parts:

- a lot of the machinery is protocol-shaped, which is powerful but broad
- the task/thread/review distinction is more complex than a small harness needs at first
- some background concepts are tied to Codex-specific product and protocol layers

## Claude Code

Claude Code has a clear "background but notify me later" shell story.

- `Bash` can be explicitly run in background mode
- long-running commands can be auto-backgrounded
- subagents are separate forked runs with isolated context and their own lifecycle
- permission and abort logic are separate from the task lifetime

The runtime pattern here is: start work, mark it backgrounded, then surface completion through notifications or tool follow-up rather than busy polling.

Claude Code also has more than one async mechanism:

- background shell tasks
- async agent forks
- queued permission/UI work
- background analytics and telemetry flushes

That makes it operationally strong, but also less uniform than a single background-job model.

```ts
async function runClaudeInvocation(input) {
  const agent = createAgent(input)
  const response = await agent.query()

  if (response.backgroundedShell) {
    return {
      status: "running",
      taskId: response.taskId,
      note: "completion will arrive later",
    }
  }

  if (response.spawnedSubagent) {
    return await waitForForkResult(response.subagentId)
  }

  return response.final
}
```

Good ideas to adapt:

- explicit background shell semantics
- completion-by-notification rather than sleep/poll loops
- aggressive separation between running work and permission UX
- forked subagents with isolated context

Shortcomings or heavier parts:

- the background model is scattered across shell, agent, MCP, and telemetry code
- a lot of the behavior is optimized for a large product runtime, not a compact kernel
- some semantics are embedded in prompt guidance, which is useful but easy to drift from implementation

## OpenCode

OpenCode is highly transcript-oriented. Its background work is less about detached jobs and more about durable nested session state.

- tasks can spawn child sessions
- `TaskTool` creates a child session, runs it, then summarizes the nested output back into the parent
- `message-v2` stores `subtask`, `compaction`, `snapshot`, and other durable parts
- the session loop can notice pending subtask or compaction parts and process them later
- long outputs are truncated to files or stored artifacts, then reintroduced through the session model

The caller usually does not poll for a low-level job handle. Instead, the session model itself records a pending task, and later turns pick it up or ingest the result.

That makes OpenCode good at resumability, but less like a generic background-job runtime.

```ts
async function runOpenCodeSession(sessionID) {
  const session = await loadSession(sessionID)

  while (true) {
    const prompt = await buildPrompt(session)
    const result = await streamModel(prompt)
    await persistMessageParts(session, result)

    if (session.hasSubtaskPart()) {
      const child = await runTaskTool(session)
      await appendSubtaskSummary(session, child)
    }

    if (session.needsCompaction()) {
      await compactSession(session)
    }

    if (session.isDone()) break
  }
}
```

Good ideas to adapt:

- durable message-part records for pending and completed work
- subtask results summarized back into the parent transcript
- compact and snapshot as first-class session artifacts
- file-backed transcript state rather than ephemeral job state

Shortcomings or heavier parts:

- it is weaker as a generic wait/join system than Codex or Claude Code
- the transcript taxonomy can become a lot to carry if overused
- background work is strongly tied to the session abstraction

## OpenDev

OpenDev is the cleanest example of a modular runtime with true background-capable subsystems.

- background runtimes share expensive services but get a fresh session, loop, and cost tracker
- process handling can auto-promote server-like commands to background
- hook execution has an explicit async fire-and-forget path
- subagent events are tracked and surfaced through event channels
- memory consolidation runs as a claimed job and spawns a dedicated agent
- compaction is explicit and can be run manually or from the loop

The key strength is that background work is a runtime concern, not a UI trick. There are owned resources, shared resources, and clear lifecycle ownership.

OpenDev is also the cleanest about separating:

- background agent runs
- background shell/process commands
- background hooks
- background maintenance jobs

```ts
async function runOpenDevInvocation(invocation) {
  const runtime = agentRuntime.from(invocation)

  while (true) {
    const state = runtime.collectLoopState()
    const prompt = runtime.composePrompt(state)
    const response = await runtime.callModel(prompt)

    await runtime.dispatchToolCalls(response)
    await runtime.persistState()

    if (runtime.shouldSpawnBackgroundAgent(response)) {
      runtime.spawnBackgroundRuntime(response)
    }

    if (!runtime.shouldContinue(response)) break
  }
}
```

Good ideas to adapt:

- fresh owned background runtimes with shared expensive dependencies
- async hook execution for non-blocking lifecycle events
- explicit background promotion for long-running commands
- separate compaction and maintenance jobs

Shortcomings or heavier parts:

- there are many subsystems, so the architecture can still feel broad
- the clean separation is excellent, but easy to over-parameterize if copied too literally
- background work is strong, but some of the behavior is split across runtime, REPL, hooks, and maintenance paths

## OpenClaw

OpenClaw is the most event-and-lane oriented of the group.

- `enqueueCommandInLane` serializes work through named lanes
- session and global lanes prevent overlapping execution
- `sessions_spawn` creates isolated child session keys and announces the result back to the requester
- embedded Pi runs can background shell/process work with `background` or `yieldMs`
- completion is surfaced through system events and process-tool follow-ups
- compaction retries are waited on explicitly through `waitForCompactionRetry`

This is a practical model for a platform runtime: one channel can keep moving while background work finishes, and the runtime decides how completion gets injected back.

OpenClaw also makes the background boundary explicit in process tools:

- backgrounded shell work keeps running
- the caller is told to use process commands later
- session events and queue lanes keep the state observable

```ts
async function runOpenClawInvocation(invocation) {
  return enqueueCommandInLane(resolveSessionLane(invocation), async () => {
    const run = await startEmbeddedPiRun(invocation)

    if (run.backgrounded) {
      return {
        status: "running",
        sessionKey: run.sessionKey,
        taskId: run.taskId,
      }
    }

    const result = await run.promise
    await maybeInjectBackgroundResult(result)
    return result
  })
}
```

Good ideas to adapt:

- lane-based serialization for background and foreground work
- child session keys for isolated delegated work
- completion injected back as events or synthetic tool results
- explicit wait-on-compaction behavior

Shortcomings or heavier parts:

- there are several overlapping background mechanisms, which is powerful but easy to confuse
- some of the runtime is clearly product/control-plane specific rather than harness-core specific
- the model is more distributed across lanes, sessions, and gateway events than a minimal kernel would be

## Synthesis

For `leharness`, the useful takeaways are:

- give every background job a durable ID and a clear parent session
- prefer explicit completion events over hidden polling
- let the caller continue while work runs, but make it easy to rejoin
- keep background shell, background agents, and background maintenance as separate concepts
- persist enough state to replay or inspect without the live process
- use session/lane isolation when concurrent work would otherwise interleave badly

What to avoid carrying over:

- UI-specific waiting flows that do not belong in the kernel
- multiple overlapping background abstractions that solve the same problem in different ways
- protocol-heavy lifecycle objects unless they buy real clarity
- transcript or product complexity that exists only because the surrounding app is large

The cleanest synthesis is:

- one durable session record
- one or more explicit background handles per session
- one event stream that records start, progress, completion, failure, and cancellation
- one join/wait path for the caller
- one file-backed artifact path for large output
- one compaction path that can also wait or retry when needed

That is enough to cover the core runtime problem without inheriting the full product surface of any one harness.
