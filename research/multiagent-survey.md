# Multi-Agent Survey

## Framing

In this survey, `multi-agent` means the harness can coordinate more than one active agent as part of the runtime, with at least partial peer-to-peer or fleet semantics. `Subagent` means a child run created by a parent run for a bounded task, usually with inherited state and a one-way result handoff.

The practical distinction matters:

- multi-agent systems have explicit coordination, lifecycle, and conflict resolution between agents
- subagent systems mostly create isolated child sessions and reintegrate a final summary or artifact
- a harness can support both, but many systems only look multi-agent in the UI while behaving like subagent delegation in the core

The axis that matters most here is not UI. It is where state lives, how child runs are spawned, and how results return.

## Shared Pattern

Most of the surveyed harnesses follow some variant of this shape:

```ts
async function runParent(invocation) {
  const session = await loadSession(invocation)
  const prompt = await buildPrompt(session)
  const response = await callModel(prompt)

  const childRuns = await maybeSpawnChildren(response, session)
  const joined = await collectChildResults(childRuns)

  await mergeResults(session, response, joined)
  return await maybeContinue(session)
}
```

The differences are in the bolded parts: who can spawn children, whether children are isolated, whether they can run in background, and whether the join is explicit or implicit.

## Codex

Codex is closer to a task runner with delegated subprocesses than a true multi-agent fleet.

What it does:

- Codex exposes delegated thread/agent lifecycle APIs such as `spawnAgent`, `resumeAgent`, `wait`, and `closeAgent`
- delegated runs can be treated as task-shaped work rather than ordinary chat turns
- delegated runs can receive initial history and parent context
- subagent events are bridged back to the parent via async channels
- approvals remain parent-controlled in the interactive subagent path

This makes Codex good at structured delegation, but not especially peer-like. The parent remains the source of truth, and the child is usually a managed worker with a narrow job.

Background tasks:

- Codex has explicit background/event handling and follow-on idle turns
- task completion can trigger more work later, but this is still session-managed rather than free-floating
- background terminal or process handling exists, but it is not the main multi-agent story

Resolution and join:

- child runs forward events back to the parent
- completion is drained through session/task state
- the join is more like task completion than shared negotiation

Good ideas to take:

- separate task lifecycle from the model loop
- keep parent/child event forwarding explicit
- inherit services, not arbitrary mutable state
- use typed task kinds so delegation is not ad hoc

Shortcomings:

- delegation is strong, but true peer-agent coordination is limited
- the architecture is task-centric, so it can feel like recursive execution rather than a fleet
- background work exists, but the background model is not the cleanest reference for long-lived detached jobs

```ts
async function runCodexTask(task) {
  const child = await spawnDelegatedRun(task, { inheritServices: true })
  const result = await child.awaitCompletion()
  parent.merge(result.events, result.output)
}
```

## Claude Code

Claude Code has a very developed delegated-agent story, but it is still mostly a sidechain model rather than a symmetric multi-agent runtime.

What it does:

- `AgentTool` can spawn teammate or subagent execution
- `runAgent.ts` runs the child agent in an isolated sidechain
- child sessions inherit the forked history and controlled tool set
- sidechain transcripts are persisted and cleaned up after completion
- the parent engine keeps ownership of the main conversation

This is a real subagent system with strong lifecycle handling. It is not just a prompt trick. But the design is still parent-centric: the child exists to solve a bounded assignment, then returns a result.

Background tasks:

- background memory extraction exists through `sessionMemory.ts`
- the product also has background shell and task behavior, including in-process teammates and background session controls
- operationally, Claude Code is comfortable with long-lived background work, but that work is still managed by one large engine

Resolution and join:

- the child result is generally a final report or final output
- parent and child do not share a single mutable session state
- join is explicit through sidechain completion, not through continuous shared coordination

Good ideas to take:

- isolate child runs hard
- persist sidechain transcripts for later inspection
- keep permissions and tool gating separate from the child task body
- treat background memory extraction as a separate job class

Shortcomings:

- the runtime is dense, so the multi-agent pattern is harder to learn than it should be
- a lot of behavior is productized around the main engine, which makes the subagent model less reusable as a clean kernel concept
- it feels powerful, but not minimal

```ts
async function runClaudeChild(parent, request) {
  const child = await forkSidechain(parent, request)
  const summary = await child.waitForFinalOutput()
  return parent.recordChildResult(summary)
}
```

## OpenCode

OpenCode is a strong single-session harness that supports child tasks well, but does not try very hard to be a general multi-agent system.

What it does:

- `TaskTool` creates child sessions for subtasks
- the child session gets its own prompt, permissions, and model selection
- nested output is summarized back into the parent
- task results are stored as durable message parts and session artifacts
- plan/build/explore modes act like structured task delegates rather than peer agents

This is mostly subagent delegation. The child is isolated enough to be useful, but the parent still owns orchestration and reintegration.

Background tasks:

- OpenCode has little dedicated detached-task infrastructure in the core harness compared with OpenDev or OpenClaw
- the real “async” behavior is more about streaming session persistence and child task completion than about general background jobs
- long-running shell work is possible, but that is not the core multi-agent abstraction

Resolution and join:

- child session results are summarized into the parent
- the join is usually a final text result plus durable nested artifacts
- there is not much evidence of peer negotiation or shared state between parent and child

Good ideas to take:

- keep child tasks session-scoped and durable
- make the parent receive a compact summary plus an inspectable nested transcript
- use the same session model for built-in agents and task delegates

Shortcomings:

- limited true multi-agent behavior
- background completion is not a first-class runtime concept
- the architecture is strong for nested tasks, weaker for live parallel coordination

```ts
async function runOpenCodeTask(parentSession, task) {
  const childSession = await createChildSession(task)
  const childResult = await SessionPrompt.prompt(childSession)
  parentSession.appendSummary(childResult.summary)
  parentSession.attachArtifact(childSession.id)
}
```

## OpenDev

OpenDev is the closest thing here to a genuine multi-agent runtime with explicit child-agent lifecycle semantics.

What it does:

- `SpawnSubagentTool` creates isolated child ReAct loops
- child agents can be background-capable
- subagents can have different tools, models, working directories, and permissions
- the runtime has built-in parallel execution paths for multiple subagent tool calls
- `LoopState` tracks background-task counts and subagent-related runtime state

This is materially more multi-agent than the others. OpenDev treats child agents as part of the core runtime model, not as a narrow task trick.

Background tasks:

- backgrounding is a first-class runtime concept
- the runtime can request background mode and keep working on other things
- tool execution can be deferred, parallelized, or promoted to background
- there is also a synthetic `get_background_result` style path for completion notifications

Resolution and join:

- background completion is signaled back through the runtime
- tool and task bridges make subagent progress visible
- join can be explicit, or can happen via background completion notifications that the parent later consumes

Good ideas to take:

- make backgrounding a runtime primitive, not just a shell trick
- give child agents their own tool surface and policy set
- support parallel child creation when all tasks are subagent-like
- keep join semantics observable instead of magical

Shortcomings:

- the system is more complex than a simple harness needs
- if copied literally, it can tempt you into over-modularizing before you know the required seams
- some of the richness exists because OpenDev is also trying to be a full product

```ts
async function runOpenDevLoop(invocation) {
  const state = runtime.collectLoopState(invocation)
  const childRequests = await maybeSpawnSubagents(state)
  const childResults = await Promise.all(childRequests.map((x) => x.await()))
  runtime.mergeChildResults(childResults)
}
```

## OpenClaw

OpenClaw is the most platform-oriented system in this survey. It has real subagent behavior, but the surrounding runtime is broader than a harness kernel.

What it does:

- `sessions_spawn` creates isolated child session keys
- child sessions are announced back to the requester chat or channel
- cross-agent spawning can be restricted by policy
- subagent runs are routed through gateway and lane machinery
- a subagent can inherit prompt context, model defaults, and session metadata

OpenClaw is closer to a control plane with embedded agent execution than a pure coding harness. It does support subagents, but its main distinction is that the subagent sits inside a routed, channel-aware assistant platform.

Background tasks:

- background work is natural in OpenClaw because the platform is already event-driven
- queue lanes, gateway calls, and session routing let work complete asynchronously
- the runtime is built to notify other layers when sessions or transcripts change

Resolution and join:

- the subagent returns through the gateway path
- completion is announced back to the requester route
- transcript and memory updates make results durable after the fact

Good ideas to take:

- explicit child session keys
- channel-independent subagent completion
- isolated child permissions and spawn restrictions
- durable transcript and memory handoff

Shortcomings:

- the runtime is entangled with platform concerns
- it is not the cleanest reference for a minimal core harness
- some of the multi-agent semantics only make sense inside the larger assistant product

```ts
async function spawnOpenClawChild(trigger) {
  const route = resolveRoute(trigger)
  const childKey = createChildSessionKey(route)
  const result = await callGatewayAgent(childKey, trigger)
  await deliverResultToRequester(route, result)
}
```

## Synthesis

The useful split for `leharness` is:

- `subagent` for isolated child work with a parent-owned join
- `multi-agent` for cases where several active agents coordinate as peers or concurrent workers

The surveyed harnesses suggest the following reference split:

- `OpenDev` is the most direct reference here for a multi-agent/runtime-centered design
- `OpenClaw` is the most direct reference for platform-and-routing concerns
- `Codex` is a strong reference for task/delegation lifecycles
- `Claude Code` is a strong reference for isolated sidechains and background-memory behavior
- `OpenCode` is a strong reference for durable nested-session design

Adopt:

- isolated child sessions with durable transcripts
- explicit parent/child event bridging
- background completion as a runtime primitive
- a join step that is visible in logs and artifacts
- child-specific tool and permission surfaces
- summaries that preserve inspectability, not just final text

Avoid:

- treating every delegated action as a peer agent
- hiding join behavior inside opaque callbacks
- letting UI/task product behavior define the core runtime shape
- assuming background work is only a shell/process problem
- making child agents share too much mutable parent state

The best synthesis is not to choose one model. It is to make the core runtime support:

- a small parent loop
- isolated child runs
- background completion
- explicit join and artifact handoff
- enough structure to allow future multi-agent coordination without forcing it on day one

### `leharness` Position

The surveys above describe the design space. For the `leharness`-specific choice on subagent log topology — child events streaming into the parent log vs. child sessions with their own logs and reference events in the parent — see `event-log-design.md`. The short version is that the choice is forced by the event-log design rather than picked from the menu: under "one writer per session," only the child-as-its-own-session topology is consistent, which incidentally also makes resumable subagents (the Cursor `resume` pattern) and ephemeral subagents (the Claude / Codex pattern) supported by the same primitives without distinguishing between them.

## Quick Compare

```text
Codex      -> task runner with delegated child runs
Claude     -> dense parent engine + isolated sidechains
OpenCode   -> durable child sessions and summarized task handoff
OpenDev    -> explicit multi-agent runtime with background-capable subagents
OpenClaw   -> routed assistant platform with child sessions and gateway join
```
