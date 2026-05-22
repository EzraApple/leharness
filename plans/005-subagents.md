# 005 — Subagents

## Goal

Add isolated subagents as a first-class harness primitive: the model can
spawn a child invocation with its own session log, its own tools, its
own system prompt — and the parent's loop reacts to the child's completion
through the same channel that already carries background-task completions.

The bet from `research/event-log-design.md` is that "subagents fall out of
the channel primitive." Plan 004 built that channel and the `TaskExecutor`
interface specifically so this plan would be a new kind of executor plus a
spawn tool, not a kernel rewrite. This plan tests that bet.

This plan deliberately does not cover filesystem-discovered presets, agent
teams, shared task queues, or other higher-level orchestration. Those are
patterns products build on top of this primitive.

## Why subagents belong in the kernel

Three things the parent loop's straight-line shape cannot do today:

1. **Isolated tool sets.** A code-reviewer should see a different tool list
   than a coding agent. Currently every step in an invocation gets the same
   tools.
2. **Bounded context.** A long-running exploration subtask shouldn't bloat
   the parent's prompt with its turn-by-turn transcript. The parent should
   see a single result, not the child's whole conversation.
3. **Recursive control.** Once one loop can spawn another loop with its own
   prompt and tools, products on top of the harness can build arbitrary
   orchestration patterns (review, plan, fan-out) without the kernel
   needing to know about them.

`event-log-design.md` settles the architectural choice: **child sessions
are full sessions, with their own log and their own loop, and the parent's
log holds only references.** This plan is that decision in code.

## Position vs neighbouring harnesses

- **Claude Code** ships an `Agent` tool with a `subagent_type` arg that
  selects from a registered catalog (Explore, Plan, code-reviewer, etc.).
  Sidechain transcripts are persisted; agent-scoped state is cleaned up
  after the run.
- **Codex** treats subagents as a typed `Task` with `kind: "delegated"`
  through `codex_delegate.rs`. Same shape we already use for shell tasks.
- **OpenCode** has a `TaskTool` that creates a child session, runs it,
  then summarizes the nested output back into the parent transcript.
- **OpenDev** spawns "background runtimes" — fresh sessions sharing
  expensive services but with their own loop and cost tracker.

The shape they share: **child is a separate session; parent log holds a
reference event; completion comes back through some channel.** That's what
this plan ships.

## Decisions locked in

| Area | Decision |
| ---- | -------- |
| Task kind | `"delegated"`. Already reserved in the `TaskKind` union; this plan flips it on. |
| Spawn surface | Single model-facing tool `spawn_subagent` with a `type` arg. Built per-session so its description dynamically lists registered presets (mirrors `createLoadSkillTool`). |
| Preset registration | Programmatic via `registerSubagentPreset(services, preset)`. Filesystem discovery deferred. |
| No-type fallback | If `type` is omitted, clone the parent's `HarnessDeps` (systemPrompt, tools, model, reasoningEffort). "Spawn a copy of me." |
| Nested subagents | Off by default. `spawn_subagent` is auto-injected only at the top level. A preset can include `spawn_subagent` in its `tools` list explicitly to permit nesting; no hard depth limit. |
| Cancellation | Cancelling a delegated task aborts the child's `runInvocation` via its `AbortSignal`. Child's own background tasks (shell, etc.) keep running unless the child cancelled them itself — they become orphans in the child's log, reaped on next resume per existing rules. |
| Result | The child's final `model.completed` text is the `task.completed.result`. Empty if the child ended in `max_steps` or `model_failed`. |
| Session lifecycle | Child session id is a fresh ulid: `child_<ulid>` for easy log discovery. Child log is a normal JSONL at `.leharness/sessions/<id>/events.jsonl` — completely self-contained. |
| Parent → child link | `task.started.task.payload` carries `childSessionId` + `presetName` + `prompt`. Replay tools follow the reference to load the child log. |
| Child → parent link | The child's first event is `invocation.received` with an extra `parentSessionId` field. Audit-only; loop ignores it. |

## Event additions

No new event types. Reuses the existing `task.*` envelope from plan 004
with `kind: "delegated"` payload. Same drain phase, same projection in
`eventToMessage`, same `wait_task` / `read_task` / `cancel_task` tools.

`task.started.task.payload` for a delegated task:

```ts
{
  kind: "delegated"
  childSessionId: string
  presetName: string | undefined
  prompt: string
}
```

`task.completed.result` is the child's final assistant text:

```
{ taskId, result: "I found three places that register executors: ...", summary?: "..." }
```

## Internal types

```ts
// packages/harness/src/subagents.ts (new)

export interface SubagentPreset {
  name: string
  description: string                  // one-line, shown in spawn_subagent's catalog
  systemPrompt: string
  tools: Tool[]
  model?: string
  reasoningEffort?: ReasoningEffort
  maxSteps?: number
}

export type SubagentPayload = {
  kind: "delegated"
  childSessionId: string
  presetName: string | undefined
  prompt: string
}

export interface SubagentExecutor extends TaskExecutor {
  readonly kind: "delegated"
  // The executor needs the things to build a child HarnessDeps from a preset.
  // Provider + defaultModel come from the parent's deps via enableSubagentRuntime.
}

export function createSubagentExecutor(deps: {
  queue: MessageQueue
  registry: TaskRegistry
  defaults: SubagentDefaults
}): SubagentExecutor

export interface SubagentDefaults {
  provider: Provider        // child uses the same provider unless the preset says otherwise
  model: string             // child default model
  systemPrompt: string      // fallback when neither preset nor parent-clone applies
  reasoningEffort?: ReasoningEffort
}

export function enableSubagentRuntime(
  services: SessionTaskServices,
  defaults: SubagentDefaults,
): SubagentExecutor

export function registerSubagentPreset(
  services: SessionTaskServices,
  preset: SubagentPreset,
): void

export function listSubagentPresets(services: SessionTaskServices): SubagentPreset[]
```

The `enableSubagentRuntime` shape parallels `enableShellRuntime`. Both are
"one-call setup the consumer does at session start, registers an executor
under a `TaskKind`."

## Model-facing tool

A new built-in tool, built per-session at `preparePrompt` time:

```ts
spawn_subagent({
  type?: string         // preset name; omit to clone parent config
  prompt: string        // user-text for the child invocation
  description?: string  // optional short label the UI can use
  inline_ms?: number    // same ergonomics as bash: 0 = always background,
                        // default 5000 (subagents almost always exceed this)
})
```

The tool's description is composed dynamically from the registered presets:

```
Spawn an isolated subagent to handle one focused subtask. The subagent
has its own session log and its own conversation; you'll receive its
final answer as the result when it completes.

Available subagent types:
  explore         — read-only codebase exploration, no edit tools
  plan            — design implementation plans, no edit tools
  code-reviewer   — review diffs, post inline notes

Omit `type` to spawn a copy of yourself with the same tools and system
prompt. Set inline_ms: 0 to background immediately; otherwise behaves
like bash — returns inline if the subagent finishes within the budget.
```

Built via `createSpawnSubagentTool(services)` and auto-injected by
`preparePrompt` when `enableSubagentRuntime` has been called for the
session (mirrors how the task tools are auto-injected when tasks are
enabled). Auto-injection happens only when *the current invocation is not
itself a subagent*; nested-subagent invocations get the preset's `tools`
verbatim and must explicitly include `spawn_subagent` if they want recursion.

How the loop knows "this invocation is a subagent": a new private flag
on `HarnessDeps` (`internal_isSubagent?: boolean`) that the
`SubagentExecutor` sets when constructing child deps. Apps don't touch it.

## Subagent lifecycle in the executor

```
SubagentExecutor.start(task, ctx):
  1. Pull preset from services (or null → parent-clone).
  2. Build child HarnessDeps:
       - provider = preset.model present ? preset-resolved : parent provider
       - tools    = preset.tools  ?? parent.tools
       - system   = preset.systemPrompt ?? parent.systemPrompt
       - reasoningEffort = preset.reasoningEffort ?? parent.reasoningEffort
       - maxSteps = preset.maxSteps ?? parent.maxSteps
       - tasks    = true  (children can run shell tasks)
       - internal_isSubagent = true  (suppresses spawn_subagent auto-inject)
  3. Allocate a child AbortController; store it so cancel() can abort.
  4. Fire runInvocation(childSessionId, prompt, childDeps, { signal: child.signal }) IN THE BACKGROUND.
  5. When the child invocation returns:
       - read the last model.completed event's text → result
       - send task.completed to PARENT's queue with that result
     If it threw or returned cancelled:
       - send task.failed / task.cancelled accordingly

SubagentExecutor.cancel(taskId):
  - abort the child's AbortController
  - the child's runInvocation finishes with reason "cancelled"
  - that triggers task.cancelled posting in the .start() chain above

SubagentExecutor.snapshot(taskId):
  - read the child's events from disk
  - return the last assistant text + step count as a snapshot
  - this is what read_task on a delegated task returns
```

The child runs in the same process. Each child gets its own
`SessionTaskServices` via `getOrCreateTaskServices(childSessionId)`; if
the child uses shell tools the parent enabled the shell runtime on, the
child needs its own `enableShellRuntime` call. The `SubagentExecutor`
does this automatically when constructing child deps (consistent default;
opt-out via preset later if a use case appears).

## Loop changes

Minimal:

- `preparePrompt` learns about subagents: when `subagentsEnabled` and
  `!internal_isSubagent`, prepend the `createSpawnSubagentTool(services)`
  to the tool list before built-in task tools.
- `HarnessDeps` gains `subagents?: boolean` (default true if
  `enableSubagentRuntime` was called for the session; can be set false to
  opt out). And `internal_isSubagent?: boolean` (private, set by the
  executor).

That's it. The rest of the loop doesn't know about subagents.

## Files to modify or add

| File | Change |
| ---- | ------ |
| `packages/harness/src/subagents.ts` *(new)* | `SubagentPreset` / `SubagentDefaults` / `SubagentExecutor`, `createSubagentExecutor`, `enableSubagentRuntime`, `registerSubagentPreset`, `listSubagentPresets`, `createSpawnSubagentTool` |
| `packages/harness/src/tasks.ts` | Add `"delegated"` to `TaskKind` union (drop the `// reserved` comment) |
| `packages/harness/src/harness/prepare-prompt.ts` | Auto-inject `spawn_subagent` when subagents are enabled + caller isn't itself a subagent |
| `packages/harness/src/harness/invocation.ts` | Add `subagents?: boolean` and `internal_isSubagent?: boolean` to `HarnessDeps` |
| `packages/harness/src/index.ts` | Re-export new symbols |
| `apps/cli/src/cli.ts` | Optional: register a couple of sample presets (explore, plan) and call `enableSubagentRuntime` |
| `apps/cli/scripts/smoke-subagents.ts` *(new)* | End-to-end tests against a scripted fake provider (see Verification) |
| `package.json` | Add the new smoke to `smoke:apps` |

The TUI display registry should also learn about `spawn_subagent` so its
verbs read naturally ("spawning", "spawned", "spawn failed") — small
addition to `apps/tui/src/display/tools.ts`.

## Verification

Five end-to-end smoke cases in `apps/cli/scripts/smoke-subagents.ts`,
using a scripted fake provider so they're deterministic and don't need a
real model. All paths exercised through `runInvocation`.

1. **Spawn with explicit preset.** Register an "explore" preset with a
   different system prompt + tool list. Parent calls
   `spawn_subagent({ type: "explore", prompt: "find foo" })`. Assert: a
   delegated task starts, the child session log exists at the expected
   path, the child's `invocation.received` carries the parent's session
   id, child's `model.completed` had only the preset's tools available.
2. **Spawn without type — parent clone.** Same as 1 but no `type`.
   Assert: child's deps match the parent's deps.
3. **Cross-invocation result drain.** Spawn with `inline_ms: 0`, end the
   parent invocation, start a new parent invocation with `userText:
   undefined`. Assert: `task.completed` from the subagent drained into
   the new parent invocation's log, with `result` matching the child's
   final assistant text.
4. **Cancellation.** Spawn, then `cancel_task`. Assert: child's events
   end with `agent.finished(reason: "cancelled")` and parent's log gets
   `task.cancelled(reason: "user")`.
5. **Nested-subagent opt-out.** Register a preset that does NOT include
   `spawn_subagent` in its tools. Have the child try to call
   `spawn_subagent`. Assert: tool-not-found error (the preset's tool
   list didn't include it; the parent's auto-injection was suppressed).

Plus a manual `lh-dev` verification per the existing pattern, deferred
to its own pass before merge.

## What this rules out, what it leaves open

Ruled out for this plan:

- Filesystem-discovered presets (e.g., `.leharness/agents/<name>/AGENT.md`).
  A natural extension parallel to skills; deferred to a future plan when
  there's appetite.
- Agent teams / shared task queues / inter-agent messaging. Higher-level
  orchestration that products can build on top of this primitive.
- Per-preset provider overrides (different model than the parent's
  provider). Deferred — `model` + `reasoningEffort` overrides are
  available; if a preset needs a totally different provider, that's a
  follow-up.
- Streaming child progress to the parent. The parent sees one
  `task.completed` event with the final result, not turn-by-turn updates.
  Streaming would need a new `task.progress` event type; not worth it
  yet.
- A `read_task` snapshot that shows the child's full transcript. v1
  returns just the last assistant text. A future read_task could format
  the child's recent turns.
- TUI rendering of the child's transcript inline. The TUI shows the
  delegated task cell like any other background task. Drilling into the
  child's log is a future inspector feature.

Left open and additive:

- Filesystem presets — drop in next to skills discovery.
- Per-preset providers — `SubagentPreset.provider?: Provider`.
- Progress streaming — add a `task.progress` event type and have the
  child periodically post to its parent's queue.
- Subagent forking / branching — child shares the parent's history up to
  some point and diverges. Different semantic; would need a new event
  shape.

## Naming alternatives

| Concept | Proposed | Alternatives |
| ------- | -------- | ------------ |
| Preset record | `SubagentPreset` | `SubagentSpec`, `SubagentTemplate`, `AgentDefinition` |
| Spawn tool | `spawn_subagent` | `delegate`, `agent`, `subagent` |
| Spawn tool arg for type | `type` | `kind`, `preset`, `subagent_type` (Claude Code's) |
| Child kind | `"delegated"` *(locked, already reserved)* | — |
| Setup helper | `enableSubagentRuntime` | `setupSubagents`, `registerSubagentRuntime` |
| Defaults | `SubagentDefaults` | `SubagentConfig`, `SubagentRuntimeOptions` |

Locking `"delegated"` and `enableSubagentRuntime` (parallels
`enableShellRuntime`). The rest are reviewable; I'd default to
`SubagentPreset` because the term is widely understood and reads
descriptively, and `type` as the tool arg because it's the shortest
clearly-named option.
