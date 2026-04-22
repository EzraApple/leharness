# Event Log Design

## Scope

This is the only doc in this folder that takes a position rather than describing one. The other surveys are descriptive: "this is how Codex / Claude Code / OpenCode / OpenDev / OpenClaw / Pi-mono handle X." This one states the `leharness` design choice for session state, justifies it against the obvious alternatives, and works through the implications.

The bet, restated from the README: the event log is the source of truth for a session. Everything else — transcript, prompt, permissions, mode, pending tasks, projections of any kind — is derived from events by a pure function. State is never stored independently of events.

The rest of this doc is what falls out of taking that bet seriously.

## Position

Three rules, in priority order:

1. **Events are truth.** Anything durable about a session lives in its event log. State that isn't in the log doesn't exist.
2. **One writer per session.** Each session has exactly one loop that appends to its log. Everything else that wants to influence the session sends a message; the loop drains messages and decides what events to write.
3. **Projection is a pure function.** Session state at any point is `reduce(events, initialState)`. No mutable state lives outside the projection's output.

Most "event sourcing is complicated" complaints come from systems that violate rule 2 (multiple writers racing for the log) or rule 3 (state mutated independently of events, then drifting from the log). If the three rules hold, the rest is small.

## What this is not

A few traps worth naming explicitly because they're easy to slide into:

- **Not "events as audit trail with state as truth."** That's the inverse architecture. You'd end up doing two-phase writes — mutate state, then emit event — and reasoning about partial failure between them. State and events drift the moment one write succeeds and the other doesn't. This path leads to consistency bugs that are hard to reproduce and harder to fix.
- **Not "events as transport, state as cache."** If the projection is ever treated as authoritative — if any code path reads from it without acknowledging it's a derivative — you've created a second source of truth. The cache must always be visibly a cache, even if it's the only thing the loop ever actually reads.
- **Not write-through.** No "update state and mirror to events" pattern. Writes are events. State updates are reductions over events. One direction.

## Cost model: why this is fine in practice

The intuitive worry is "won't I be replaying the entire log every loop iteration?" In practice no, because realistic sessions are small enough that it doesn't matter:

- A typical short session: 20–200 events, a few hundred bytes each
- A long autonomous session: a few thousand events
- Reducer is `O(n)` over events but each step is a tiny dispatch
- Full projection at session end: sub-millisecond
- Model call: 1–30 seconds

The reducer cost is four to five orders of magnitude below the model call. For MVP, fold from scratch every iteration; you will not notice.

When does it actually start to matter?

- Sessions exceeding ~10k events (long autonomous work)
- Cold-start latency on session resume becomes user-visible
- Many concurrent observers re-projecting the same log

The fix for all three is the same and is purely additive: memoize the projection on the log's tip, persist a snapshot every K events, on cold-start load snapshot plus tail. Callers don't change. The reducer doesn't change. The log doesn't change. It's a cache layer between `loadEvents` and `projectSession` that can be added or removed without disturbing anything else.

```ts
const session = projectSession(events)

const session = memoizedProject(sessionId, events, snapshot)
```

The interface is the same. The second form is an optimization. There is never a code path that reads `session` and assumes it's the source of truth.

## Concurrency: single writer plus channel ingress

The single-writer rule is the load-bearing one. With it:

- No locks on the log file
- No sequence-number reconciliation
- No "what if two writers append at the same offset" reasoning
- Append is just `fs.appendFile` (or its equivalent)

The price is that anything else that wants to influence the session has to go through the session's loop. This sounds restrictive but it's actually the right shape, because there are only a handful of "anything elses," and they all have the same shape:

- User steering (CLI / web / bot / MCP — channel-agnostic ingress)
- Background task completion (long-running shell, network, etc.)
- Subagent completion (a child session finishes)
- Hooks and scheduled events (cron, file watchers)

All four are "external thing wants the session to do something." The pattern is uniform:

```ts
sessionChannel.send({ kind: "task_completed", taskId, result })

for await (const message of sessionChannel) {
  const event = translateMessageToEvent(message)
  appendEvent(sessionId, event)
}
```

The session loop is the only thing that ever calls `appendEvent`. Background runners, subagent runners, and ingress adapters all communicate through channels. This means there's exactly one place to reason about ordering, exactly one place to reason about durability, and exactly one place where "the session decided to do something" is recorded.

This also gives a clean answer to one of the questions raised in `background-tasks-survey.md`: who appends `task.completed`? The session loop does. Always. The background runner sends a completion message to the channel; the loop is the writer.

## Subagent topology as a corollary

This is where the architecture pays for itself, because subagent design is forced rather than chosen.

If subagent events flowed into the parent's log, you'd have to either:

- Let the child write directly to the parent's log (violates single-writer)
- Have the child send events for the parent loop to forward (parent log gets noisy with child transcript content; parent compaction has to reason about which events are "really" the child's; parent's `shouldContinue` predicate has to filter child events out of its decisions)

Both paths break the rules. The only consistent option is that **child sessions are full sessions, with their own log and their own loop, and the parent's log holds only references**:

```text
parent log (sess_main):
  ...
  { type: "subagent.spawned",   child_session_id: "sess_42", prompt: "..." }
  ...
  { type: "subagent.completed", child_session_id: "sess_42", summary: "...", artifact_refs: [...] }
  ...

child log (sess_42):
  { type: "agent.started", parent_session_id: "sess_main", initial_prompt: "..." }
  ... full child transcript ...
  { type: "agent.finished", final_output: "..." }
```

Mechanisms compose against the same primitives the rest of the system uses:

- **Spawn.** Parent loop appends `subagent.spawned`, kicks off the child loop, continues.
- **Completion.** Child loop, on finish, sends a completion message to the parent's session channel. Parent drains, appends `subagent.completed`. Same primitive as background-task completion — subagent completion is just a special case.
- **Steering.** Steering events go to the channel of whichever session you want to influence. Steering a child means sending to the child's channel. Channel-agnostic ingress works identically for any session, parent or child.
- **Resumption.** The child has its own session ID and its own log. Sending a new ingress event to the child's channel wakes its loop back up. "Resumable subagents" is free — no special primitive needed. Whether subagents are fork-and-discard (Claude / Codex pattern) or long-lived (the Cursor `resume` pattern) is just a question of whether the parent's logic chooses to send another message. Both are supported by default.
- **Compaction.** Each session compacts its own log independently. Parent compacting doesn't touch the child. The reference events in the parent's log are tiny and survive compaction trivially.
- **Recursion.** Grandchildren fall out automatically. A child spawning its own subagent is the same operation, one level deeper. The reference graph is a tree.

The shape is a tree of independent session logs connected by reference events, not a single merged log. A multi-log inspection tool (eval, replay, web inspector) reads the parent log, follows references to child logs, and composes a unified view at read time. The truth stays separated; the view is constructed.

This decision is described in `multiagent-survey.md` as one of the open axes (parent-merged vs. child-separated). For `leharness` it's not really an axis — it's the only choice consistent with rule 2.

## Schema versioning

Events are immutable in the log. Reducers are code. When you change what an event means, change the reducer.

- Every event carries a `v` field with its schema version
- The reducer dispatches on `(type, v)`
- Old events keep working as long as the reducer knows how to interpret their version
- "Migration" only happens when you want to *drop* support for a version, and it's a one-shot offline transform that produces a new log file from the old one

```ts
function reduce(state: SessionState, event: Event): SessionState {
  switch (event.type) {
    case "task.completed":
      switch (event.v) {
        case 1: return reduceTaskCompletedV1(state, event)
        case 2: return reduceTaskCompletedV2(state, event)
      }
  }
}
```

This is closer to "Postgres with explicit migrations" than to schemaless evolution. The schema is the union of all versions the reducer currently understands. Adding a new event type is a no-op for old logs. Removing one is the only operation that needs migration.

The discipline: **the reducer is the schema.** If the reducer can't interpret an event, the log is broken. This is a stronger guarantee than "the file parses."

OpenCode's move from `message` to `message-v2` is an example of what this looks like in practice — it didn't migrate old data, it taught the runtime to read both shapes. That pattern generalizes.

## Storage backend

JSONL per session, on disk. One file per session, named by session ID. Append is `fs.appendFile`. Read is `fs.readFile` followed by a line-split-and-parse.

Why JSONL and not SQLite for the log itself:

- Append is genuinely atomic at the OS level (a single write of a line ending in `\n`)
- Inspection works with `cat`, `jq`, `tail -f`
- File watchers / change feeds work for free (any FS subscription mechanism)
- No schema to migrate at the storage layer; versioning lives in events, not tables
- No process to run; the truth is the file

Why SQLite is the right *secondary* index, not the truth:

- Cross-session queries (evals, replay, "find all sessions where the model called tool X")
- Fast lookup by event type, task ID, artifact reference
- Joins between session, subagent, and artifact tables

The pattern: a separate process (or background worker) tails session logs and writes derived rows into SQLite. SQLite is a materialized view, not a source of truth. If it's lost, rebuild it by replaying the logs. The truth stays in one place (the JSONL files); the indexes live in another (SQLite); the relationship is one-directional.

For MVP: JSONL only. SQLite is a "what can grow on top" item, added when a use case (evals, web inspector with cross-session search) demands it.

## Session as a small state machine

Projection produces *data*. The session also has a small *state-machine* aspect that the loop's `shouldContinue` predicate consumes. These are the same projection, but it's worth being explicit about the discrete states because they're what the loop actually branches on:

- `idle` — no pending work, no follow-up queue, waiting for ingress
- `running` — model call or tool execution in progress
- `awaiting-tool` — waiting for a tool result that should arrive inline
- `awaiting-background` — one or more background tasks outstanding, loop can sleep
- `awaiting-user-input` — model asked a question or requested approval
- `compacting` — compaction in progress, normal flow paused
- `failed` — terminal error, loop will not continue without intervention

`shouldContinue` is just a function over this state. The states aren't separate metadata — they're derived from events the same way the transcript is. `task.started` increments the outstanding-background count; `task.completed` decrements it; `compaction.started` enters `compacting`; and so on. The state machine is a view over the event log, not a parallel mutable register.

This is the orthogonal axis to "session as projection" — projection gives you the data, the state machine gives you the predicate.

## What this rules out, what it leaves open

Ruled out:

- Multi-process or multi-loop writers to the same session log
- Mutable state outside the projection
- "Events as audit trail" / write-through patterns
- Subagent events flowing into the parent's log
- Treating the projection as authoritative anywhere

Left open and additive:

- Projection memoization and periodic snapshots
- SQLite indexes for cross-session queries
- `parentId` on events for branchable history (the Pi-mono pattern)
- Vector clocks or stronger causal ordering across sibling sessions
- Multi-agent fleets — would require a shared-state session that peers subscribe to, which is additive and doesn't disturb the per-session model
- File-backed memory or skill systems — orthogonal to the event log; they're inputs to projections, not events themselves

## Synthesis

Three rules, applied recursively:

1. Events are truth.
2. One writer per session.
3. Projection is a pure function.

Everything else is downstream:

- Background tasks → channel ingress → loop appends event
- Subagents → independent session with reference events in the parent log
- Steering → channel ingress → loop appends event
- Compaction → per-session operation over the log
- Replay and inspection → fold the log
- Cross-session queries → async-built secondary index

The most important property is that there are no exceptions to the three rules. Every place where the system "needs to update state" is the same operation: send a message to a session channel; the session loop appends an event; the projection updates on the next iteration. If a feature seems to require a new pattern, the answer is almost always to express it as channel-input plus event-output rather than to add a new state-update path.
