<p align="center">
  <img src="./assets/banner.jpg" alt="leharness banner" width="900" />
</p>

# leharness

`leharness` is me trying to understand harness engineering by building one myself.

I mostly want to understand the parts that actually matter underneath modern harnesses:

- the loop
- the event log
- the tool runtime
- the task model
- background vs blocking execution
- subagents
- compaction
- and the products that can grow on top of that core

Also, the name exists because I dreamt up the project while I was in Paris.

## Why

Most of the interesting agent repos mix together:

- a harness kernel
- product surfaces
- UI/TUI
- routing and integrations
- a lot of operational scar tissue

That is useful if you want the whole product, but it makes it harder to study the lower-level harness decisions cleanly.

So this repo is basically me taking notes, doing comparative research, and hopefully ending up with a core I can improve one feature at a time without having to keep rewriting the foundation.

## High-Level Goals

- Build a small, explicit agent loop that stays easy to reason about.
- Use append-only event logs as the canonical session state.
- Persist important state and large outputs to the filesystem whenever possible.
- Treat long-running work as a first-class concept instead of a shell-only hack.
- Support isolated subagents and background work without turning the core into spaghetti.
- Keep the harness channel-agnostic so CLI, web, TUI, bots, or VM runners can all sit on top of the same engine.
- Make the system easy to revisit and improve in bursts instead of requiring rewrites every time a new feature appears.

## Core Bets

These are the main architectural bets I want the base layer to rest on:

At the boundary, the flow should look like:

```ts
ingress -> invocation -> append invocation events -> run session loop
```

- `Simple parent loop`
  One clear control loop that stays small, readable, and focused on orchestration.

  ```ts
  while (true) {
    const events = loadEvents(sessionId)
    const session = projectSession(events)

    if (shouldCompact(session)) {
      compact(session)
      continue
    }

    const prompt = buildPrompt(session)
    const modelOutput = await callModel(prompt)
    const toolResults = await executeToolCalls(session, modelOutput.toolCalls)

    if (!shouldContinue(session, modelOutput, toolResults)) break
  }
  ```

- `Event-sourced sessions`
  The event log should be the source of truth for what happened in a session.

  ```json
  {"type":"invocation.received","kind":"message","text":"fix the failing test"}
  {"type":"step.started","step_id":"step_1"}
  {"type":"model.completed","tool_calls":[{"tool":"bash","execution":"auto"}]}
  {"type":"task.started","task_id":"task_42","kind":"bash"}
  {"type":"task.completed","task_id":"task_42","summary":"2 tests still failing"}
  ```

- `Session derived from events`
  The session should be rebuilt from events, and everything else should be derived from that session.

  ```ts
  const session = projectSession(events)
  const prompt = buildPrompt(session)
  const notifications = projectTaskNotifications(session)
  const artifacts = projectArtifacts(session)
  ```

- `Background as a first-class runtime feature`
  The agent should be able to send work off, keep moving, and react when completions come back. That means task-like operations should be able to finish inline or return a durable handle when they need to keep running.

  ```ts
  const testRun = await bash({
    command: "npm test",
    execution: "auto",
  })

  // inline:
  // { status: "completed", output: "..." }

  // background:
  // { status: "started", task_id: "task_42" }

  onTaskCompleted(task) {
    appendEvent({
      type: "task.completed",
      task_id: task.id,
      session_id: task.sessionId,
    })

    markSessionRunnable(task.sessionId)
  }
  ```

- `Isolated subagents`
  Child runs should have bounded scope, inspectable state, and a clear handoff back to the parent.

  ```ts
  const child = await spawnSubagent({
    session_id: session.id,
    prompt: "investigate the lint failures",
    execution: "background",
  })

  // later:
  // waitTask(child.task_id)
  // or react when completion is projected back into the parent session
  ```

- `Filesystem-backed artifacts`
  Big outputs should live on disk with stable references so they can be revisited later without bloating active context.

  ```ts
  const artifact = await persistArtifact({
    kind: "tool_output",
    content: stdout,
  })

  appendEvent({
    type: "artifact.created",
    artifact_id: artifact.id,
    path: artifact.path,
  })
  ```

## MVP Shape

The first version should prove the kernel, not the product:

- CLI-first
- one provider
- append-only session log
- artifact persistence
- a few core tools
- one compaction path
- task handles for background-capable work
- isolated subagent execution
- synthetic completion notifications projected back into session state

If that part is solid, the rest should mostly be feature work instead of surgery.

## What Can Grow On Top

Once the core is stable, these should be things I can add independently:

- web inspector
- richer CLI UX
- TUI
- MCP integration
- skills
- more tools
- better compaction strategies
- evals and replay tooling
- VM runners
- Telegram or other bot adapters
- more opinionated agent products built on top of the same harness

## Direct Inspiration

These are the repos I've been reading against while trying to figure out what I actually want the core of `leharness` to be:

- [OpenAI Codex](https://github.com/openai/codex) for strong tool/runtime layering and task-oriented execution. Notes: [research/codex-architecture.md](./research/codex-architecture.md)
- [Claude Code leak coverage](https://www.bleepingcomputer.com/news/artificial-intelligence/claude-code-source-code-accidentally-leaked-in-npm-package/amp/) because I ended up studying a research copy for prompt caching, long-running task behavior, and subagent patterns. Notes: [research/claude-code-architecture.md](./research/claude-code-architecture.md)
- [OpenCode](https://github.com/EzraApple/opencode) for durable session state, artifacts, and a TypeScript codebase that is easier to read than most. Notes: [research/opencode-architecture.md](./research/opencode-architecture.md)
- [OpenDev](https://github.com/opendev-to/opendev) for the cleanest staged loop and the best "this code was built to be explained" architecture of the bunch. Notes: [research/opendev-architecture.md](./research/opendev-architecture.md)
- [OpenClaw](https://github.com/EzraApple/openclaw) mostly as an adjacent reference for what starts growing around a harness once it turns into more of an agent product. Notes: [research/openclaw-architecture.md](./research/openclaw-architecture.md)

## North Star

I want a harness core that is:

- simple enough to explain
- modular enough to evolve
- durable enough to resume
- and strong enough that future work feels like adding a feature, not rebuilding the foundation

## AI Tools Used

These were the main AI tools I used while doing the research and writing in this repo:

- [OpenAI Codex](https://github.com/openai/codex)
- [Claude Code leak coverage](https://www.bleepingcomputer.com/news/artificial-intelligence/claude-code-source-code-accidentally-leaked-in-npm-package/amp/)

## Links

<div>
  <a href="https://github.com/ezraapple">
    <img alt="GitHub" src="https://img.shields.io/badge/GitHub-ezraapple-161616?style=for-the-badge&logo=github&logoColor=F7F2E8">
  </a>
  <a href="https://x.com/ezra_sf">
    <img alt="X" src="https://img.shields.io/badge/X-@ezra__sf-161616?style=for-the-badge&logo=x&logoColor=F7F2E8">
  </a>
</div>
