# 004 — Background Tasks

## Goal

Add background-capable tool execution to the harness in a way that:

1. Matches the channel-ingress + single-writer discipline laid out in
   `research/event-log-design.md`.
2. Survives across invocations on the same session — a task started in one
   turn can complete into the next.
3. Lands on names and shapes that generalize to subagents and compaction
   later, without forcing a refactor of the core loop when those arrive.
4. Stays small enough to be re-read months later and understood by someone
   who has only read the README and the event-log design doc.

This plan deliberately does not cover subagents or compaction-as-task. They
are mentioned only where they would constrain the names or shapes chosen
here. Each is its own future plan.

## Why background tasks belong in the kernel

Three of the kernel's "core bets" from the README — background-as-first-class,
isolated subagents, and filesystem artifacts — all share the same runtime
question: *how does work that started in one place finish in another, and
how does that completion get back into the session log?*

`research/event-log-design.md` already answers this:

- Events are truth.
- One writer per session — the loop.
- Anything outside the loop that wants to influence the session sends a
  *message*; the loop drains messages and decides which events to append.

The kernel does not yet have any messages, any draining, or any concept of
work that started in one step and finishes in another. This plan introduces
those primitives, exercises them with background shell as the first
concrete user, and stops there.

## Position vs. neighbouring harnesses

Three reference shapes exist in `research/`:

- **Claude Code** ships a polling model: `Bash(run_in_background: true)` returns
  a `shell_id`; the model polls `BashOutput(shell_id)`. The runtime never
  wakes the loop — the model decides when to check. State lives in a
  per-process shell registry, *outside the event log*. Smallest change, but
  not the design doc's pattern.
- **Codex** treats everything as a typed `Task` (invocation, review,
  delegation, compaction). One runner, one lifecycle, one set of events.
  A `pending_input` queue per task absorbs steering messages while a task
  runs. Cleanest long-term shape, but the largest refactor for this codebase.
- **Event-log-design.md** lands between the two: keep the named
  `runInvocation` as the top-level loop, but introduce a per-session message
  channel that the loop drains. Background completion, subagent completion,
  and user steering all reduce to the same channel ingress.

This plan picks the event-log-design path, with one explicit affordance:
the `Task` record is shaped to cover any background work, not just shells.
That keeps the migration to a Codex-style "tasks all the way down"
architecture cheap if we decide to make it later — see *What this rules
out / leaves open*.

## Decisions locked in

| Area | Decision |
| ---- | -------- |
| Background opt-in | Per-call, time-based. The tool takes `inline_ms: number` (default 5000, cap 60000). It runs inline until either it finishes (returns `kind: "ok"`) or `inline_ms` elapses (returns `kind: "started"` with a `Task` handle). Model sets `inline_ms: 0` to background immediately. No model-set up-front "is this long" toggle. |
| Top-level concept | `runInvocation` stays as the named loop. `Task` is a kind-tagged record for background work. |
| First task kind | `shell`. Subagent / compaction kinds are deferred but reserved. |
| Channel shape | Per-session, in-memory, async queue. Producer = any executor; consumer = the loop. |
| Persistence | The channel is in-memory only. `task.started` is durable in the event log; outstanding tasks at process start are reaped by the loop and appended as `task.cancelled(reason: "process_exited")`. |
| Single-writer | Only the loop calls `recordEvent`. Executors call `queue.send(message)`. |
| Drain timing | The loop drains the queue at the top of every step, before building the prompt. |
| Model-facing tools | `wait_task`, `read_task`, `cancel_task`. Implemented in `packages/harness` so they ship with the kernel. |
| Tool output budget | Background tasks' output is buffered in memory with the same `MAX_TOOL_OUTPUT_BYTES` cap as foreground tools. Artifacts are a separate future plan. |
| Cancellation | Aborting an invocation cancels the *invocation's* AbortSignal but does not cancel outstanding background tasks. Background tasks survive invocation end. `cancel_task` is the only way to kill one. |

## Event additions

Five new event types, all `v: 1`, all kind-agnostic at the envelope level:

```ts
// Loop appends after a tool returns { kind: "started", task }.
{ type: "task.started",   task: { id, kind, sessionId, payload, display } }

// Loop appends after draining a queue completion message.
{ type: "task.completed", taskId, result: string, summary?: string }

// Loop appends after draining a queue failure message.
{ type: "task.failed",    taskId, error: string, summary?: string }

// Loop appends after draining a queue cancellation message, or on resume
// when a `task.started` has no terminal event yet (process_exited reason).
{ type: "task.cancelled", taskId, reason: "user" | "process_exited" }
```

The kind-agnostic envelope means the projection layer (`eventToMessage`,
TUI transcript reducer) can handle all four event types once. Subagent
events later become the same shapes with `task.kind === "delegated"`.

## Internal types

Locked shapes — these are the load-bearing ones for future generalization.

```ts
export type TaskKind = "shell" // | "delegated" | "compaction" — reserved

export type TaskState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export interface Task {
  id: string
  kind: TaskKind
  sessionId: string
  state: TaskState
  startedAt: string
  // kind-specific; ShellPayload for kind === "shell"
  payload: unknown
  // for the TUI / transcript — same shape as ToolDisplaySnapshot
  display: ToolDisplaySnapshot
}

export interface ShellPayload {
  command: string
  cwd: string
}

export type Message =
  | {
      kind: "task.completed"
      taskId: string
      occurredAt: string  // ISO timestamp of actual completion; used as event ts
      result: string
      summary?: string
    }
  | {
      kind: "task.failed"
      taskId: string
      occurredAt: string
      error: string
      summary?: string
    }
  | {
      kind: "task.cancelled"
      taskId: string
      occurredAt: string
      reason: "user"
    }

export interface MessageQueue {
  send(message: Message): void
  drain(): Message[]
  // Blocks until at least one message is available OR the signal aborts.
  waitForMessage(signal?: AbortSignal): Promise<void>
}

export interface TaskExecutor {
  readonly kind: TaskKind
  start(task: Task, ctx: TaskExecutorContext): void
  cancel(taskId: string): Promise<void>
  // Used by read_task. Returns whatever output has accumulated so far.
  // For shell: stdout+stderr buffer. For future kinds: free to define.
  snapshot(taskId: string): TaskSnapshot | undefined
}

export interface TaskExecutorContext {
  sessionId: string
  queue: MessageQueue
}

export interface TaskRegistry {
  register(task: Task, executor: TaskExecutor): void
  get(taskId: string): Task | undefined
  list(sessionId: string): Task[]
  setState(taskId: string, state: TaskState): void
  // For wait_task — promise resolves when the task reaches a terminal state.
  whenTerminal(taskId: string, signal?: AbortSignal): Promise<TaskState>
}
```

The shape rules that make future generalization cheap:

- `Task` carries `kind` + opaque `payload`. Never push kind-specific fields
  to the top of the record.
- `Message` is referenced by `taskId`, never by shell id or subagent id.
- `TaskExecutor` is an interface; `ShellExecutor` is the only impl in this
  plan. Adding `SubagentExecutor` later is a new file, not a refactor.
- `TaskRegistry` is keyed by `TaskId`; never `Map<ShellId, ChildProcess>`.

## Model-facing tools

Three built-in tools ship from `packages/harness`. They are kind-agnostic
— they operate on tasks, not on shells.

### `wait_task`

```text
wait_task({ task_id: string, timeout_ms?: number })
```

Blocks until the task reaches a terminal state or the timeout elapses.
Returns the terminal state and a one-line summary. Does not return the
full output — model calls `read_task` for that.

Bounded by an internal max timeout (e.g. 300_000ms) so the loop can't be
held indefinitely. If the wait times out, the task stays running and the
tool returns `{ state: "running", note: "timeout" }`.

### `read_task`

```text
read_task({ task_id: string, since_byte?: number })
```

Returns the task's current output buffer. `since_byte` lets the model read
incrementally — the call returns `{ output, next_byte_cursor }`. Output
follows the existing 16KB cap; the cursor lets the model paginate.

For terminal tasks (`completed`, `failed`, `cancelled`), the buffer is
final. For running tasks, the buffer is whatever has accumulated; calling
again later may return more.

### `cancel_task`

```text
cancel_task({ task_id: string })
```

Asks the executor to cancel. Executor decides what cancellation means
(`SIGTERM` then `SIGKILL` for shell). Loop appends `task.cancelled` when
the executor confirms via the queue.

## Tool return contract changes

`ToolExecuteResult` gains a third kind:

```ts
export type ToolExecuteResult =
  | { kind: "ok"; output: string; summary?: string }
  | { kind: "error"; message: string; summary?: string }
  | { kind: "started"; task: StartedTask }
```

`StartedTask` is what the tool hands back to the harness — minimal info
the loop needs to register the task and announce it to the model:

```ts
export interface StartedTask {
  id: string
  kind: TaskKind
  payload: unknown
  display: ToolDisplaySnapshot
  summary?: string
}
```

The harness owns task registration, executor lookup, and queue wiring.
The tool just decides whether to background and hands back the descriptor.

## Background opt-in ergonomics (`inline_ms`)

The model does not predict latency. Every background-capable tool
accepts an `inline_ms` arg (default 5000, hard cap 60000). The tool
runs inline for up to that many milliseconds; if the work hasn't
finished by then, the tool returns `kind: "started"` and the work
keeps running under the executor.

```ts
bash({ command: "ls -la" })
// inline_ms defaults to 5000. Returns in ~50ms.
// -> { kind: "ok", output: "...", summary: "exit 0 · 12 lines" }

bash({ command: "pnpm test" })
// inline_ms still 5000. After 5s the test is still running.
// -> { kind: "started", task: { id: "task_01J...", kind: "shell", ... } }

bash({ command: "pnpm run dev", inline_ms: 0 })
// Model knows it's long-lived. Skip the inline window.
// -> { kind: "started", task: { id, ... } } immediately.
```

Inside the tool, the implementation races the child's completion
against a timer:

```ts
const child = spawn("/bin/bash", ["-c", args.command], ...)
const result = await Promise.race([
  collectInlineResult(child),
  delay(args.inline_ms ?? 5000).then(() => "still_running" as const),
])

if (result === "still_running") {
  return { kind: "started", task: shellExecutor.adopt(child, args) }
}
return { kind: "ok", output: result.output, summary: result.summary }
```

Bounds:

- **Default `inline_ms`**: 5000ms. Short enough that `pnpm test` doesn't
  block the loop noticeably, long enough that small typechecks / `git
  status` / `ls` finish inline.
- **Cap**: 60000ms. Larger values are silently clamped so the loop is
  never held by a runaway model setting.
- **`inline_ms: 0`**: skip the inline window entirely; always background.

## Loop changes

The change to `runInvocation` is small and localized. Two additions:

1. **Drain phase at the top of each step.** Before building the prompt,
   pull pending queue messages and append them as `task.*` events. The
   model sees those completions in the next prompt.
2. **Idle wait when needed.** If the model returns no tool calls but
   there are outstanding tasks, the loop can optionally wait for one to
   complete instead of finishing the invocation. MVP behavior: do not
   wait. The invocation finishes; tasks keep running. The model knew it
   could call `wait_task` and chose not to.

Pseudocode for the modified loop (changes marked):

```ts
for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
  // NEW: drain every pending message in FIFO order, append each as one
  // event using message.occurredAt for ts. The model's next prompt sees
  // every completion that landed since the last step.
  for (const message of queue.drain()) {
    await invocation.recordEvent(message.kind, {
      taskId: message.taskId,
      ts: message.occurredAt,
      ...messagePayload(message),
    })
  }

  await invocation.recordEvent("step.started", { stepNumber })

  const prompt = await buildPrompt(invocation, ...)
  const promptResult = await sendPrompt(prompt)
  ...

  // NEW: tool execution may return started-tasks alongside inline results.
  const toolRun = await executeTools(toolCalls, tools, ctx)
  registerStartedTasks(toolRun.startedTasks, registry, queue)
}
```

`executeTools` becomes responsible for routing each tool result:

- `kind: "ok"` → append `tool.completed`, return value to model
- `kind: "error"` → append `tool.failed`, return error to model
- `kind: "started"` → append `task.started`, return `{ task_id }` to the
  model as the tool's *inline* result so it knows what id to wait on

### Drain semantics

- **Drain all, FIFO, every step**, before building the prompt. Multiple
  completions land in one prompt in real order. No artificial
  serialization.
- **Messages arriving during the same step's model call or tool
  execution wait** until the next step's drain. The loop does not
  preempt itself.
- **`occurredAt` carries the truth.** The event's `ts` field is set
  from `message.occurredAt`, not from when the drain happens. A task
  that completed at 12:00 and was drained at 12:30 still logs `ts:
  12:00`.
- **No tool calls + no pending messages = invocation ends.** No tool
  calls + pending messages = invocation still ends (MVP). The model
  had its chance; if it wanted to react to completions it would have
  called `wait_task`. Messages persist in the queue for the next
  invocation, which drains them on its first step.

## Session queue lifetime

The queue is in-memory and **scoped to the process running the loop**.
There is one queue per session, lazily created when the first invocation
on that session starts. The queue stays alive as long as the process
runs, even across invocations on the same session.

When a new process starts an invocation on a session whose log contains
`task.started` events without terminal counterparts, the loop on first
step (after the existing event load) writes a `task.cancelled(reason:
"process_exited")` for each orphan. That keeps the log internally
consistent without needing cross-process recovery.

## Phases

Each phase ends with a passing smoke run and a PR-sized diff.

### Phase 1 — Types and events, no behavior

Add the new event types to the projection, the `Task` / `TaskKind` /
`TaskState` types, and the `MessageQueue` / `TaskRegistry` / `TaskExecutor`
interfaces. No tool changes yet. No executor yet. The kernel compiles and
existing smoke tests still pass.

**Done when:** typecheck + smoke pass; the new types are exported from
`@leharness/harness`; nothing else changed.

### Phase 2 — Queue, drain phase, foreground unchanged

Wire the `MessageQueue` and the drain phase into the loop. Drain produces
zero events because no producer exists yet. Foreground behavior is byte-
identical to today.

**Done when:** smoke pass; manual `lh` session behaves exactly as before;
event log of a foreground-only session is unchanged.

### Phase 3 — ShellExecutor + bash background via `inline_ms`

Add `ShellExecutor` (the only `TaskExecutor` impl in this plan). Extend
`bash` with the `inline_ms` arg (default 5000, cap 60000). The tool
races inline completion against `inline_ms`. If the command finishes
within the window, the tool returns `{ kind: "ok", ... }` as today. If
not, the tool calls `shellExecutor.adopt(child, args)` to hand the
still-running child over and returns `{ kind: "started", task }`. The
loop appends `task.started` and the model sees the `task_id` as the
inline tool result.

The executor:
- owns adopted child processes and buffers stdout+stderr per task
- sends `task.completed` / `task.failed` / `task.cancelled` messages on
  exit / non-zero / signal, stamping `occurredAt` with the actual time

**Done when:** smoke tests fire (a) a short `echo hi` and assert it
stays inline, (b) a `sleep 0.05` with `inline_ms: 10` and assert it
promotes to background and produces a `task.started` + later
`task.completed`.

### Phase 4 — `wait_task`, `read_task`, `cancel_task`

Built-in tools in `packages/harness`. They consult the registry by
session id; the harness wires the registry into `ToolContext`.

**Done when:** smoke test exercises the full cycle — model starts a
background task, calls `wait_task`, reads `read_task`, then asserts the
log shape.

### Phase 5 — Cross-invocation survival + orphan reaping

The queue + registry live on the process, not the invocation. On the
first step of any invocation, the loop scans the loaded events for
`task.started` without a terminal event and appends
`task.cancelled(reason: "process_exited")` for each orphan.

**Done when:** smoke test starts a background task, ends the invocation
without waiting, then starts a new invocation in the same process and
sees the completion drain into the new invocation's log.

### Phase 6 — TUI rendering

Extend the TUI transcript reducer to handle `task.started` /
`task.completed` / `task.failed` / `task.cancelled` events. Render them
distinctly from inline tool cells — a small running pill while pending,
a green/red rail when terminal. Reuse the existing tool-cell display.

**Done when:** running `lh-dev` with a background bash shows the running
pill, then transitions to green on completion. Visual check; no smoke
test for ANSI output.

## Smoke coverage

Each phase adds a smoke script under
`packages/harness/scripts/smoke/background-tasks.mjs`. The script:

- builds an in-process harness
- registers a fake `TaskExecutor` for `kind: "shell"` (no real shell —
  it controls timing deterministically)
- drives a sequence of events: start, drain progress, complete, fail,
  cancel, orphan-on-resume
- asserts the resulting event log shape and the projection output

The CLI smoke (`apps/cli/scripts/smoke-edit-file.ts`) gains a background
case that runs a real `sleep 0.2` via the real `ShellExecutor`.

## What this rules out, what it leaves open

Ruled out for this plan:

- Auto-promotion of long-running shells to background.
- Persisting in-flight task state across processes (would require a
  side-table or a separate executor process; not worth it for MVP).
- Streaming partial output back to the model (the model reads via
  `read_task` instead — close enough).
- Subagents. Mentioned only where they constrain naming.
- Compaction-as-task. Same.
- Cross-session task visibility (a session only sees its own tasks).

Left open for future plans, addable without restructuring this one:

- Subagents as `TaskKind === "delegated"`, executor calls
  `runInvocation` on a child session, completion message carries a
  reference to the child's session id (per `event-log-design.md`'s
  reference-event model).
- Compaction-as-task: same shape, different executor.
- Filesystem-backed task output (artifacts): the queue messages carry
  output strings today; later they can carry artifact refs.
- A Codex-style migration to "tasks all the way down" — wrap
  `runInvocation` in `runTask({ kind: "invocation", ... })`. The
  current naming has been chosen so this is a refactor of one file, not
  the whole kernel.

## Naming alternatives (treat names in this plan as provisional)

Names below are the proposal in the body of the plan. The right column
captures alternatives worth considering before committing. The intent is
that we settle these together once before phase 1 starts.

| Concept | Proposed | Alternatives |
| ------- | -------- | ------------ |
| Per-session message queue | `MessageQueue` *(locked)* | `TaskQueue` (narrower), `SessionIngress` (matches the doc), `PendingMessages` (least metaphor) |
| Queue message type | `Message` *(locked)* | `TaskMessage` (narrower — fine since today only tasks produce messages) |
| Per-call inline budget arg | `inline_ms` *(locked)* | `yield_ms` (Codex), `block_ms` (Cursor), `max_inline_ms` (verbose) |
| Background work record | `Task` | `BackgroundTask` (more specific but verbose), `Job` (overloaded), `AsyncWork` (unusual in JS), `TaskRecord` |
| Background work kind | `TaskKind` | `TaskType`, `JobKind` |
| Background work lifecycle state | `TaskState` | `TaskStatus`, `LifecycleState` |
| The thing that runs background work | `TaskExecutor` (interface) + `ShellExecutor` (impl) | `TaskRunner` / `ShellRunner`, `BackgroundExecutor` / `ShellBackend` |
| The registry that holds active tasks | `TaskRegistry` | `TaskStore`, `TaskBook`, `ActiveTasks` |
| Tool result kind for "I started a task" | `{ kind: "started", task }` | `{ kind: "task", task }`, `{ kind: "deferred", task }`, `{ kind: "async", task }` |
| Model-facing wait tool | `wait_task` | `await_task`, `join_task` |
| Model-facing read tool | `read_task` | `task_output`, `get_task_output`, `peek_task` |
| Model-facing cancel tool | `cancel_task` | `abort_task`, `kill_task` |
| Event types | `task.started` / `task.completed` / `task.failed` / `task.cancelled` | unchanged — keeping `task.*` matches the README and event-log-design.md verbatim |

A note on `MessageQueue`: locked over `TaskQueue` because non-task
producers (steering messages, file-watcher hooks) are expected next and
would force a rename otherwise. The `Message` discriminated union keeps
this open without changing the queue or its drain.

A note on `inline_ms`: locked over Codex's `yield_ms` because the name
maps directly to the result kind — under `inline_ms` you get
`kind: "ok"` (inline), over it you get `kind: "started"`. The number
is a *budget for staying inline*, not a "yield deadline" abstraction.
