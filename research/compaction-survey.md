# Compaction Survey

## Scope

In this survey, compaction means any mechanism that reduces the active context window while preserving enough recoverable state to continue the same work. That can include summaries, boundary markers, pruned tool outputs, persisted artifacts, snapshots, or a replacement transcript built from a prior one.

The goal here is not to pick a winner. The goal is to compare how each harness handles the pressure point where a session gets too large, too noisy, or too expensive to keep whole.

```text
trigger (limit/manual/overflow)
        |
        v
prune / summarize / snapshot / persist artifacts
        |
        v
replace active context with summary + refs + boundary markers
        |
        v
resume with a smaller model-visible state
```

## Codex

Codex treats compaction as a first-class turn shape, not a side effect. The main entry points are `run_inline_auto_compact_task()` for local compaction and `run_inline_remote_auto_compact_task()` for the remote Responses-based path. Auto compaction is driven by total token usage versus the model's configured limit; manual `/compact` runs as its own compact turn; and model downshifts can trigger pre-turn compaction before the next normal turn starts.

```ts
if (totalUsageTokens >= autoCompactLimit) {
  await runAutoCompact({
    trigger: "auto",
    phase: "mid-turn" | "pre-turn",
    initialContextInjection,
  })
}
```

What gets compacted depends on the path, but the pattern is consistent: Codex compacted history, then reinserted a compacted replacement history plus a `ContextCompactionItem`. In the remote path, it trims function-call history to fit, preserves ghost snapshots for `/undo`, and uses a `CompactedItem` with `replacement_history`. In the local path, it retries by stripping the oldest history item when compaction itself hits a context-window error, which is the main failure escape hatch I found.

The interesting architectural choice is that Codex distinguishes pre-turn and mid-turn compaction with different initial-context injection rules. Mid-turn compaction reinjects initial context above the last real user message; pre-turn and manual compaction do not. That keeps the model-facing history shape aligned with how the model expects to continue.

Good ideas to take:

- explicit compact turns with analytics and phase tracking
- separate local and remote compaction implementations behind one logical action
- retention of undoable snapshots and model-visible replacement history
- retry-on-overflow behavior that removes the oldest material first

Shortcomings or non-essential parts:

- the compaction path is deeply tied to Codex's task/run model and protocol types
- the local and remote implementations are both substantial, so the logic surface is wide
- the model-switch and collaboration-mode branching is useful, but not core if the harness is narrower

## Claude Code

Claude Code has the most layered compaction story in the set. It combines proactive auto-compaction, manual `/compact`, session-memory compaction, a microcompact pass, and a reactive compaction fallback when the request itself is too large. The trigger is usually token pressure relative to an effective context window, but the code also suppresses auto-compaction in special modes like session-memory or context-collapse flows.

```ts
if (await shouldAutoCompact(messages, model, querySource, snipTokensFreed)) {
  const sessionMemory = await trySessionMemoryCompaction(messages, agentId)
  if (sessionMemory) return sessionMemory

  const micro = await microcompactMessages(messages, context)
  return await compactConversation(micro.messages, context, cacheSafeParams, false)
}
```

The compaction logic is not one thing. `trySessionMemoryCompaction()` is a targeted path that pulls from session memory. `microcompactMessages()` prunes and summarizes tool outputs, collapses compactable tool uses, and preserves cache-safe edits. `compactConversation()` does the heavier summary-driven compaction. If the model returns prompt-too-long, the reactive path can retry with head-truncation or smaller chunks. After any successful compaction, `runPostCompactCleanup()` clears caches and module state but deliberately preserves invoked skill content.

Representation is explicit. Claude Code uses `compact_boundary` system messages with `compactMetadata`, including preserved segment identifiers, and its session storage layer can reconstruct both compact boundaries and snip boundaries when loading. It also keeps commit-like context-collapse metadata in session storage, which makes the compaction lineage more observable than just a single summary blob.

Large outputs are preserved in multiple ways:

- full tool output can be truncated to disk with a pointer path
- file history and snapshot state survive compaction
- memory files and session transcripts are reloaded separately
- compact boundaries and snip boundaries provide recovery anchors

The main failure logic is pragmatic rather than elegant. Auto-compaction has a small consecutive-failure circuit breaker, and the prompt-too-long retry path peels old context from the head when necessary. That makes it resilient, but also fairly complex to reason about because multiple compaction subsystems overlap.

Good ideas to take:

- strong cache-boundary awareness
- a pre-compaction pruning step before the expensive summary call
- compact-boundary metadata with preserved segments
- cleanup hooks that reset cache state after compaction

Shortcomings or non-essential parts:

- too many overlapping compaction modes if you only need one kernel
- session-memory and context-collapse are useful, but easy to overbuild
- the interaction between prompt cache behavior and compaction is powerful but cognitively heavy

## OpenCode

OpenCode is the clearest example of session-centric compaction. The session processor tracks whether compaction is needed, and `SessionCompaction` handles the actual work. The trigger is usually token pressure or a session-level compaction setting, but there is also an explicit pruning stage that marks old tool outputs as compacted before the full summary path runs.

```ts
const needsCompaction = await SessionCompaction.isOverflow({ tokens, model })
if (needsCompaction) {
  return "compact"
}
```

The actual compaction path is staged. `prune()` walks backward through the transcript and marks old tool outputs as compacted, while protecting a small recent window and certain tool types. Then `process()` creates a synthetic assistant compaction message, builds a prompt from the full session, and runs a `SessionProcessor` in `mode: "compaction"` with `summary: true`. Plugins can inject context or replace the prompt text, so the compaction prompt itself is extensible.

What is compacted is broader than the text summary alone. OpenCode can compact tool outputs, snapshots, message parts, and transcript state. Compacted tool output is not deleted outright; the message schema keeps `time.compacted` and the projected view replaces old output with a placeholder like `[Old tool result content cleared]`. That makes compaction reversible enough for inspection even when the active state is smaller.

OpenCode also has explicit snapshot and revert support around compaction. `Snapshot.track()`, `Snapshot.patch()`, and the session summary/revert modules all sit close to the compaction pipeline, which makes the harness feel like it cares about durable coding artifacts rather than just dialogue.

Good ideas to take:

- staged pruning before full summarization
- compacted output placeholders instead of blind deletion
- snapshot/revert integration around the compaction flow
- plugin-injectable compaction prompt context

Shortcomings or non-essential parts:

- the message-part taxonomy can get heavy
- the compaction pipeline is tied closely to OpenCode's session model
- it is very artifact-aware, which is useful, but not all of that structure is necessary for a smaller kernel

## OpenDev

OpenDev has the cleanest staged compaction architecture. `ContextCompactor` computes an `OptimizationLevel` from token usage, and that level decides whether to warn, mask, prune, aggressively compress, or fully compact. The trigger is therefore not a single threshold; it is a ladder of optimization modes.

```ts
switch (compactor.check_usage(messages, systemPrompt)) {
  case "warning":
  case "mask":
  case "prune":
  case "aggressive":
  case "compact":
}
```

The staged logic is split cleanly:

- `mask_old_observations()` replaces older tool results with references
- `prune_old_tool_outputs()` strips old, large tool outputs
- `summarize_verbose_tool_outputs()` compresses long tool output into a short summary
- `compact()` and `apply_llm_compaction()` build a summarized replacement transcript
- `sliding_window_compact()` gives long conversations a middle-preserving fallback

Representation is explicit and lineage-friendly. The compactor carries an `ArtifactIndex`, which records files touched during the session and survives compaction via session metadata. `as_summary()` injects that index back into the summary so the model still knows what files matter after history is trimmed. That is a strong pattern if file awareness is central to the harness.

OpenDev also separates calibration from compaction. It can update from API usage counts, invalidate the calibration after content changes, and recompute usage against the actual reduced message set. That makes staged compaction much easier to reason about than a one-shot summarizer because the harness knows whether its own estimate is stale.

Good ideas to take:

- multi-level optimization instead of a single compact-or-not binary
- old tool-output masking before full summary
- artifact indexes as compacted context, not just logs
- calibration invalidation after context-shaping operations

Shortcomings or non-essential parts:

- the staged ladder is excellent, but can be more than a small harness needs initially
- file-touch history is valuable, yet not all compaction systems need a dedicated artifact index
- the full LLM compaction path still sits alongside several fallback heuristics, so the system is powerful but not simple

## OpenClaw

OpenClaw is the least pure compaction model in the set because it is a platform wrapper around an embedded Pi-based agent runtime. Compaction still matters, but it is integrated into a larger routing and execution substrate rather than being the harness's core identity. The main trigger is a context overflow or compaction failure path inside the embedded run loop; there is also explicit session-lane and global-lane queueing so compaction work does not deadlock the wider platform.

```ts
if (isContextOverflowError(errorText) && !isCompactionFailure && !overflowCompactionAttempted) {
  const compactResult = await compactEmbeddedPiSessionDirect(params)
  if (compactResult.compacted) continue
}
```

The actual compaction helper, `compactEmbeddedPiSessionDirect()`, runs inside the same workspace, sandbox, skill, and prompt environment as a normal embedded run. It resolves the model, auth profile, sandbox, skills prompt, bootstrap context files, and tool surface before attempting compaction. That is important: OpenClaw compaction is not a separate summary-only utility, it is a session-aware embedded run that reuses the same runtime substrate.

Lifecycle integration is explicit. `handleAutoCompactionStart()` and `handleAutoCompactionEnd()` toggle `compactionInFlight`, emit lifecycle events, and either resolve or retry the wait promise. The runtime can then resume or fail over based on the result. In other words, compaction is treated as a stream event in the platform, not as a hidden in-memory mutation.

OpenClaw also has a notable operational angle: auth-profile failover, context-window guards, transcript repair, and session file repair all sit near the compaction path. That makes the system robust, but also less clean as a model for the inner harness kernel than OpenDev or OpenCode.

Good ideas to take:

- compaction as a routed event in a broader runtime
- explicit wait/retry state around compaction in flight
- reusing the same workspace, skills, sandbox, and prompt environment for compaction
- clear separation between compaction failure and ordinary model failure

Shortcomings or non-essential parts:

- it is more of a control plane plus embedded agent than a minimal harness
- the compaction path is entangled with routing, auth failover, and channel delivery
- useful if you want a platform, but heavier than you need for a clean core harness

## Synthesis

The best compaction patterns across the survey are:

- threshold staging from OpenDev
- explicit compact turns and lineage from Codex
- boundary markers, snapshot awareness, and cache cleanup from Claude Code
- artifact/snapshot preservation from OpenCode
- evented retry/wait behavior from OpenClaw

The most important thing to avoid is building compaction as one giant hidden function. Every strong harness here keeps at least one of these seams visible:

- a trigger boundary
- a summary or pruning boundary
- a reinsertion boundary
- an artifact or snapshot boundary
- a failure/retry boundary

For `leharness`, the main takeaways are not implementation details so much as shape:

- keep compaction explicit in the runtime, not embedded in UI code
- preserve old material as files, references, snapshots, or boundary markers instead of only deleting it
- make the reinjected compacted state distinguishable from normal transcript content
- keep failure handling visible enough that compaction can be tested, replayed, and compared

What seems non-essential unless the harness grows into it:

- multiple overlapping compaction systems at once
- very rich transcript part taxonomies
- platform-level routing coupled to compaction internals
- provider-specific compaction logic leaking into the kernel

