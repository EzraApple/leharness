# 007 — Smart Compaction

## Goal

Replace `naive-truncate` with a **pressure-gradient** compaction strategy
that gradually slims the projected prompt as the session grows, instead
of cliff-edging at the budget boundary. Cheap structural transformations
(drop old reasoning, retroactively artifact inline tool results, drop
resolved tool message bodies) kick in at intermediate watermarks; the
expensive transformation (LLM-summarize old turn windows into a
handoff-style brief) only fires under real pressure. Summaries are
cached via `compaction.summary` events keyed to the source event-id
range, so re-running compaction on the same history is free.

The architectural invariant that makes "smart" possible without
compounded loss: every invocation re-projects from the canonical
`events.jsonl`. Compaction is a *projection filter*, not a destructive
rewrite. The event log stays raw forever; cached summaries are derived
metadata that informs future projections.

This plan deliberately does not cover:
- Vector retrieval over old turns (future).
- Multi-level / hierarchical summaries (single level for v1).
- Token-accurate measurement (char counts as proxy in v1).
- Cross-session summary access (per-session, same as artifacts).
- A dedicated cheaper "summarizer model" config (planned follow-up).

## Why this shape

### Compounded loss is the failure mode

Naive compaction takes a prompt P, drops the oldest N messages to fit
budget, and the model sees the truncated P'. Next step: P' has grown
again (new turn appended); compact P' to P''. Each pass is a *new*
lossy decision against an *already-lossy* input. After a few rounds the
model is reasoning over heavily-degraded context — and the loss is
arbitrary (whatever oldest happened to be at each truncation point).

leharness avoids this for free: `buildInput(invocation.events, ...)`
projects from the **full event log** every step. Compaction operates on
the result of that projection. So as long as compaction is implemented
as a transformation of *projected messages from raw events* — not a
mutation of prior compacted output — there is no compounded loss. Each
step's compaction is a fresh decision against the original truth.

This plan keeps that invariant load-bearing. Cached summaries are
keyed by source event-id range (immutable, append-only), never by
position in a prior projection.

### Gradual pressure beats sudden truncation

Today: prompt is fine fine fine, hits budget, cliff. You lose oldest
N turns at once with no warning, and the model's narrative breaks.

Better: each transformation has its own pressure watermark. At 50% of
budget, old reasoning chatter drops (the model produced its answer; the
chain-of-thought isn't load-bearing). At 65%, inline tool results past a
size threshold get retroactively artifacted. At 75%, resolved tool body
contents past the last K turns drop (the assistant's tool-call
narrative stays so threads stay coherent; the body is recoverable via
`read_artifact`). At 85%, the oldest unsummarized turn window gets
LLM-summarized into a handoff brief. At 95%, the next window. At 100%+,
hard truncation as the floor.

The prompt's character *smoothly* slims as the session grows instead of
shattering at the budget boundary. The summarizer call is reserved for
real pressure since it costs tokens.

### Handoff-style summaries, not retrospective

Summaries phrased as *"user is doing X, has touched Y, decided Z, was
about to do W"* read like a continuation brief — the next model call
picks up the thread instead of treating the summary as foreign
reference material. This is the same pattern Claude Code's autocompact
uses. Reframes summarization from compression to handoff.

### Per-step relevance overlay (no regeneration)

The base summary is focus-agnostic (factual, cacheable). When projected
into a prompt, prepend a single framing line derived from the most
recent user message: *"Earlier work — full transcript at artifact_xyz.
Current focus appears to be: <last user message, capped 200 chars>"*.
Adapts the summary's framing to current direction without regenerating;
keeps the cache invariant intact.

## Position vs neighbouring harnesses

- **Claude Code (Anthropic):** runs autocompact ~80% of context. Summarizer
  prompt is framed as continuation handoff. Summary appears as a system-
  level note. Single-tier (no gradient before).
- **OpenDev / OpenCode lineage:** writes old tool results to files
  (inspired plan 006) plus summarization tiers above. Multiple passes,
  recoverable. Closest reference for what this plan ships.
- **Codex / Cursor:** summarize past a watermark. Less public on details.
- **Aider:** manual only (`/clear`, `/forget`) plus a static repo map. No
  automated compaction.
- **Active research direction:** *relevance-aware* summarization where the
  summarizer is given the current goal so it preserves load-bearing
  context and drops tangents. Breaks per-window caching since relevance
  shifts per step. This plan hybridizes: base summaries are cacheable
  and focus-agnostic; relevance is a per-step framing overlay (no
  regeneration).

leharness's shape: closest to OpenDev's "tiered file-backed compaction"
+ Claude Code's handoff framing, with the pressure-gradient layered on
top to smooth the transitions and the cache-via-events to make repeated
projection free.

## Decisions locked in

| Area | Decision |
| ---- | -------- |
| Strategy name | `pressure_gradient` (replaces `naive_truncate` as the default; naive stays exported for the smokes that exercise the floor). |
| Budget basis | **Real tokens from `model.completed.usage.promptTokens`** on the most recent step. The harness already normalizes provider-specific token-count fields (`prompt_tokens`, `input_tokens`, `prompt_eval_count`) into `{ promptTokens, completionTokens }` on `ProviderResponse.usage` (see `provider/openai-compat.ts`); the `model.completed` event carries that payload. Default budget = `0.85 × contextWindowTokensForModel(deps.model, deps.provider.name)`. App can override via `CompactionOptions.maxInputTokens`. |
| Source-of-truth + storage | Token usage flows through the existing event log. On session startup `loadEvents` rehydrates the JSONL; the TUI's transcript reducer walks events and the latest `model.completed.usage.promptTokens` becomes the current `contextUsage.used`. During a running session each new `model.completed` updates it via the same reducer path. **No new state to manage** — the event-sourced architecture handles persistence + in-memory tracking for free. |
| First-step handling | The very first model call has no prior `usage` data. Indicator stays hidden ("—") until the first `model.completed` arrives; compaction is a no-op for that step (history is empty anyway, so compaction wouldn't fire). One-step reactive lag is acceptable since the first step almost never hits budget. |
| Watermarks (% of budget) | 50% drop old reasoning, 65% promote oversized inline tool results to artifacts, 75% drop old tool result bodies, 85% summarize one window, 95% summarize next, 100%+ hard truncate. **Cumulative — once crossed, the transformation applies.** |
| Preserve-recent | Last K=2 turns (one turn = one user message + agent's response chain through to next user message) are exempt from drop/promote/summarize tiers; only hard truncate may touch them. |
| Artifact promotion threshold | Inline tool results > 1KB get promoted when the 65% watermark is crossed. Reuses `writeArtifact` from plan 006. |
| Summarization window | M=4 consecutive turns from the oldest un-summarized event outside the preserve-recent zone. Below 2KB of original content: skip (not worth a call). |
| Parallel summarization | When both T4 (85%) and T5 (95%) trip in the same step, fire both summarizer calls with `Promise.all`. v1 parallelism is within-step across windows; background prefetch is a follow-up (see *Left open*). |
| Summary cache | New event `compaction.summary { coveredEventIds, summaryText, sourceArtifactId, ... }`. Key = exact set of event IDs covered. Append-only event log means cache is monotonic — once cached, valid forever for that range. |
| Summarizer model | Same as the main session's model in v1. `summarizerModel?` config field on `CompactionOptions` for later. |
| Summary failure | Record `compaction.summary.failed { attemptedEventIds, error }`. Falls through to the next tier (hard truncate). Doesn't block the step. |
| Relevance overlay | Per-step framing line prepended to the summary at projection time. Derived from the latest user message (capped 200 chars). No regeneration. |
| Summary message role | `user` (clear semantics: "here's context about what came before"). Header makes it self-identifying. |
| Where summary slots in | Same chronological position as the events it replaces. Multiple summaries stack in order. |
| Compaction event surfacing in TUI | **Cheap tiers (1-3) silent.** **Summarization tier shows an opaque loading state in the footer ("compacting earlier turns…")**, then a transient post-compaction note in transcript: "compacted 12 old turns → 320 chars (saved 8.4k)." Context indicator always visible: `"32k / 435k (7%)"`. |
| Pressure measurement | `pressureRatio = lastInputTokens / budgetTokens` where `lastInputTokens` is the most recent `model.completed.usage.promptTokens` in the event log. Reactive (lagged by one step), but accurate — uses what the provider actually counted, not a char proxy. |
| Post-compaction "saved X tokens" | Reported on the next step's `model.completed` (since that's the first time we see the post-compaction prompt size). Transient cell shows "compacted N old turns" immediately; updates to "saved X tokens" once the follow-up step lands. |

## Watermarks in detail

Pressure ratio is read from the event log at the top of each step:
`pressureRatio = lastInputTokens / budgetTokens` where `lastInputTokens`
is the most recent `model.completed.usage.promptTokens`. Budget defaults
to `0.85 × contextWindowTokensForModel(deps.model, deps.provider.name)`
unless the app supplies `compaction.maxInputTokens`.

If no `model.completed` exists yet (very first step of a session), all
watermarks evaluate false and compaction is a no-op. Compaction is
reactive — it kicks in based on what the *last* prompt actually weighed,
not a prediction of what the *next* one will weigh. The lag is one step;
the worst case is one slightly-over-budget call before compaction
engages.

All transformations whose watermark `pressureRatio >= watermark` is met
get applied in a single pass. **No within-step re-measurement** — we
can't recompute token cost between tiers without a tokenizer dep, and
the tokens-from-usage source only updates when the next provider call
returns. T4 and T5 (the two summarization tiers) fire in parallel via
`Promise.all` when both watermarks are crossed; we don't conditionally
skip T5 based on T4's effect.

**T6 (hard truncate) is the one tier with a char-based fallback
measurement.** Because the provider will reject prompts that exceed
the context window, T6 needs *some* pre-call estimate to act as a
safety net. It uses `JSON.stringify(messages).length` + system + tools
against `contextWindowTokens × 4 × 0.90` as a conservative char
ceiling: if the projection (post-T1-5) still exceeds that, drop oldest
non-preserved messages until it fits. This is an explicit local
inconsistency — T1-5 reason in real tokens, T6 reasons in chars — but
T6's job is provider-rejection prevention, not pressure management, so
the unit mismatch is acceptable and called out.

| Watermark | Tier | Transformation | Cost |
| --------- | ---- | -------------- | ---- |
| 0.50 | T1 — `drop_old_reasoning` | Strip `reasoningText` from `model.completed` projections older than last K turns. | None. |
| 0.65 | T2 — `promote_inline_results` | For each `tool.completed` whose `result` is inline (no `artifactId` yet) and >1KB, write a new artifact and replace the projected `tool` message content with the artifact stub. Records `artifact.created` and `compaction.tool_promoted` events. | Disk I/O. |
| 0.75 | T3 — `drop_old_tool_bodies` | For each `tool.completed` older than last K turns, replace the projected `tool` message content with a short tombstone: `"[tool result dropped — artifact_xxx if needed]"` when an artifact exists, or `"[tool result dropped during compaction]"` if it doesn't. The assistant's `toolCalls` stay intact so the narrative thread doesn't break. | None. |
| 0.85 | T4 — `summarize_one_window` | Find the oldest unsummarized M-turn window outside preserve-recent. If <2KB original, skip. Otherwise: stash full window as an artifact, fire summarizer call, record `compaction.summary`. Replace projected messages in window with the summary message. | One model call (cached after). |
| 0.95 | T5 — `summarize_next_window` | Repeat T4 for the next-oldest unsummarized window. | One model call (cached after). |
| 1.00+ | T6 — `truncate_front` | After all above. Char-based safety net (see *Watermarks in detail*): drop oldest non-preserved messages until projected size fits `contextWindowTokens × 4 × 0.90` chars, or only system + tools + preserve-recent remain. Same shape as today's `naive-truncate`. | None. |

## The summarizer call

### Prompt

```
You are summarizing the early portion of an ongoing agent session so the
session can continue without losing context. The full window of turns will
remain recoverable via an artifact id; your summary is a HANDOFF BRIEF, not
a retrospective. Phrase it as state-of-play.

Source window (M turns):

<event-by-event renderization of user/assistant/tool messages in the window>

Produce a concise brief with this structure:

- **Goal:** what the user appears to be working toward
- **Touched:** files, concepts, or systems already engaged
- **Decisions:** approaches chosen, constraints established
- **Findings:** notable results, errors hit, dead ends
- **Next:** what was about to happen when this window closes

Length scales with source density: aim for roughly 5% of source length
in characters, capped at ~600 chars. A light window (one or two short
turns of trivial work) may need only 1-2 sentences total. Omit any field
that has nothing meaningful to report — don't pad. Do not include exact
quotes or data dumps; the originals are recoverable via the artifact
reference.
```

### Output

Plain markdown matching the bullet structure. Stored as `summaryText`.

### Where the summary appears

At projection time, the events in the covered window are replaced by
a single synthetic message:

```ts
{
  role: "user",
  content:
    "[Earlier work — full transcript at " + sourceArtifactId + ".\n" +
    "Current focus appears to be: " + latestUserMessageHead + "]\n\n" +
    summaryText
}
```

`latestUserMessageHead` = the most recent `invocation.received.text`,
capped at 200 chars. This is the per-step relevance overlay — no
regeneration, just framing.

### Failure handling

If the summarizer call throws or the signal aborts:
- Record `compaction.summary.failed { attemptedEventIds, error }`.
- Skip this window for this step. Next tier (T5 or T6) takes over.
- Next invocation will retry from scratch since no `compaction.summary`
  event landed for the window.

## Event additions

```ts
// New: structural cache for completed summaries.
{
  type: "compaction.summary",
  coveredEventIds: string[],         // exact ids — the cache key
  summaryText: string,
  sourceArtifactId: string,          // full window stashed here
  charsBefore: number,
  charsAfter: number,
  generatedAt: string,
  generatedByModel: string,
}

// New: summarizer call failed; not cached, will retry next step.
{
  type: "compaction.summary.failed",
  attemptedEventIds: string[],
  error: string,
}

// New: T2 retroactive promotion — records that a past tool.completed's
// content now lives at an artifact. Lets future projections find the
// artifact without re-promoting.
{
  type: "compaction.tool_promoted",
  sourceCallId: string,              // the tool.completed.call.id
  artifactId: string,
  promotedAt: string,
}

// Existing compaction.completed extended:
{
  type: "compaction.completed",
  strategy: "pressure_gradient",     // new value (or "naive_truncate" for legacy)
  reason: "input_too_large",
  budgetTokens: number,              // contextWindowTokens × 0.85
  lastInputTokens: number,           // pressure measurement at decision time
  pressureRatio: number,             // lastInputTokens / budgetTokens
  watermarksCrossed: string[],       // ["drop_old_reasoning", "promote_inline_results", ...]
  droppedReasoningCount?: number,
  promotedInlineCount?: number,
  droppedToolBodyCount?: number,
  summarizedWindowCount?: number,
  truncatedFromFrontCount?: number,
  // "saved X tokens" lands on the *next* model.completed, not here —
  // we don't know the post-compaction prompt size in tokens until the
  // next provider call comes back with usage.promptTokens.
}
```

All envelope-versioned `v: 1`. The new event types fall through to the
default no-op reducer in apps that haven't been taught about them, same
as `artifact.created` did in plan 006.

**Single-writer respected:** all three new event types are recorded
through `invocation.recordEvent` from inside the compaction layer
(which already runs inside the loop step). The compaction module
receives `recordEvent` via `PromptInput.recordEvent` — the same channel
the existing `compaction.completed` event already uses. No new writer
seams added.

## Caching invariants

The compounded-loss-prevention story rests on three properties:

1. **Append-only event log.** Events never change; new events only
   appear at the tail. So a cached summary covering events `[E5..E12]`
   is valid forever for that exact set.
2. **Cache key is the set of event IDs, not position.** A summary
   covering `[E5..E12]` stays bound to those ids even as the log grows.
   No off-by-one drift, no window-shift breakage.
3. **Re-projection starts from raw events every step.** `buildInput`
   reads `invocation.events` (the full canonical list) and feeds the
   compaction layer. Compaction consults the summary cache; cache hits
   substitute the summary; cache misses leave events alone. No prior
   compacted output is ever used as input.

A side property worth flagging: because cache lookups are by event-id
set, two sessions that happen to have identical event ID prefixes
*could* in principle share summaries. We do not exploit this — caches
are per-session — but the invariant is clean.

## Internal types

```ts
// packages/harness/src/compaction/pressure-gradient.ts (new)
export async function pressureGradient(input: PromptInput): Promise<PromptInput>

// packages/harness/src/compaction/summarize.ts (new)
export async function summarizeWindow(args: {
  events: Event[]
  windowEvents: Event[]
  provider: Provider
  model: string
  sessionId: string
  signal?: AbortSignal
  recordEvent?: RecordEvent
}): Promise<{ summary: CompactionSummary } | { failed: { error: string } }>

// packages/harness/src/compaction/cache.ts (new)
export interface CompactionSummary {
  coveredEventIds: Set<string>
  summaryText: string
  sourceArtifactId: string
  generatedAt: string
}
export function loadSummaryCache(events: Event[]): CompactionSummary[]
export function findCoveringSummary(
  cache: CompactionSummary[],
  windowEventIds: string[],
): CompactionSummary | undefined
```

```ts
// packages/harness/src/prompt.ts — CompactionOptions extends:
export interface CompactionOptions {
  maxInputTokens?: number            // override the default budget (contextWindow × 0.85)
  maxInputChars?: number             // legacy, only used by naive-truncate and the T6 safety net
  preserveRecentTurns?: number       // renamed from preserveRecentMessages — turn-based is clearer
  summarizerModel?: string           // optional override; defaults to main model
}
```

Watermarks are **module-level constants** in `pressure-gradient.ts`, not
config (same pattern as `AUTO_ARTIFACT_THRESHOLD_BYTES` in plan 006).
No real consumer needs to tune them yet; expose later if a real tuning
need shows up.

```ts
// packages/harness/src/compaction/pressure-gradient.ts
const DROP_OLD_REASONING_WATERMARK = 0.50
const PROMOTE_INLINE_RESULTS_WATERMARK = 0.65
const DROP_OLD_TOOL_BODIES_WATERMARK = 0.75
const SUMMARIZE_FIRST_WINDOW_WATERMARK = 0.85
const SUMMARIZE_SECOND_WINDOW_WATERMARK = 0.95
```

```ts
// packages/harness/src/models.ts — context window joins existing ModelSpec
export interface ModelSpec {
  // existing fields...
  contextWindowTokens?: number       // new, optional — defaults via helper
}

export function contextWindowTokensForModel(
  modelId: string,
  providerName?: string,
): number {
  return findModel(modelId, providerName)?.contextWindowTokens ?? 32_000
}
```

Matches existing pattern (`supportsReasoning` field → `modelSupportsReasoning`
helper). Builtin specs in `BUILTIN_MODELS` get populated with their real
windows (DeepSeek 1M, GPT-4o-mini 128k, Claude models 200k, Ollama
locals as documented per-model).

## Files to modify or add

| File | Change |
| ---- | ------ |
| `packages/harness/src/compaction/pressure-gradient.ts` *(new)* | Strategy implementation: measure, apply tiers, record `compaction.completed`. |
| `packages/harness/src/compaction/summarize.ts` *(new)* | Window selection, summarizer prompt + provider call, artifact stash, record `compaction.summary` / `compaction.summary.failed`. |
| `packages/harness/src/compaction/cache.ts` *(new)* | Read `compaction.summary` events into a lookup; helper to find a covering summary for a candidate window. |
| `packages/harness/src/compaction/index.ts` | Default `compact` dispatches to `pressureGradient`. Keep `naiveTruncate` exported for smokes that test the floor in isolation. |
| `packages/harness/src/prompt.ts` | Extend `CompactionOptions` (add `preserveRecentTurns`, `summarizerModel`; deprecate `preserveRecentMessages`); extend `eventToMessage` to consult the summary cache and emit synthetic summary messages; teach it to drop `reasoningText` per-event when flagged. |
| `packages/harness/src/models.ts` | Add optional `contextWindowTokens` field to `ModelSpec`; add `contextWindowTokensForModel(id, provider)` helper (matches existing `modelSupportsReasoning` shape); populate the field on `BUILTIN_MODELS` entries. |
| `packages/harness/src/core/prepare-prompt.ts` | When app didn't supply `compaction.maxInputTokens`, compute default from `contextWindowTokensForModel(deps.model, deps.provider.name) × 0.85`. |
| `apps/cli/src/cli.ts` | No change required — defaults flow through `prepare-prompt.ts`. |
| `apps/tui/src/state/types.ts` | Add `compactionInProgress: boolean`, `lastCompactionGains?: { savedChars, summarizedCount }`, `contextUsage?: { used, budget }`. |
| `apps/tui/src/state/transcript.ts` | Reduce `model.completed` → set `contextUsage = { used: usage.promptTokens, budget }` when `usage` is present (this is the single source of truth — works on resume from `loadEvents` and during live sessions identically). Reduce `compaction.completed` → set `lastCompactionGains.savedTokens` once the *next* `model.completed` arrives (compare new `promptTokens` to the pre-compaction value). Reduce `compaction.summary` (start) / `compaction.summary.failed` → toggle `compactionInProgress`. Update `cloneTranscript` to copy the new fields. |
| `apps/tui/src/components/prompt.tsx` | Extend the existing `Footer` component (currently lives here, not a separate file) to render `"[compacting...]"` when `compactionInProgress` and `"32k / 850k (4%)"` (real tokens) from `contextUsage`. **Hide the indicator entirely when `contextUsage` is undefined** (first step of a session, no `usage` data yet). Thread state from `app.tsx`'s transcript via props. |
| `apps/tui/src/components/transcript.tsx` | Transient one-line cell after `compaction.completed`: `"compacted X old turns → Y chars saved"`. |
| `packages/harness/scripts/smoke/compaction.mjs` | Rewrite for pressure-gradient: drive each tier individually with a scripted provider that returns canned summaries. Smoke runner auto-discovers `*.mjs` under `scripts/smoke/`, so additional cases land naturally as `compaction-cache.mjs`, `compaction-floor.mjs`, etc. |
| `apps/cli/scripts/smoke-compaction-summary.ts` *(new)* | End-to-end: real `compaction.summary` events land, cache is consulted on second invocation (no second summarizer call), event log retains originals, summary message has the correct framing. Add to `smoke:apps` in root `package.json`. |

No `events.ts` change needed. Events have no type-union — new event
types are valid the moment something calls `recordEvent("compaction.
summary", ...)`. The string literals live at their call sites (the
strategy + summarize module) and read like the rest of the kernel.

## Verification

Smokes (harness-side, `packages/harness/scripts/smoke/compaction.mjs`):

1. **T1 only.** Session at 60% pressure (one prior turn with long
   `reasoningText`). Assert: `compaction.completed` event with
   `watermarksCrossed: ["drop_old_reasoning"]`; reasoning stripped from
   older `model.completed` projections; recent turn's reasoning intact.
2. **T1 + T2.** Session at 70%. Add a prior tool.completed with a 2KB
   inline result. Assert: `artifact.created` and
   `compaction.tool_promoted` events; the projected tool message now
   contains the artifact stub; original event log unchanged.
3. **T1 + T2 + T3.** Session at 80%. Older tool message bodies replaced
   with the tombstone string; assistant `toolCalls` intact.
4. **T1-4 (summarization fires).** Session at 90%. Scripted provider
   returns a canned summary on the summarizer call. Assert:
   `compaction.summary` event landed with `coveredEventIds`,
   `sourceArtifactId`, `summaryText`; projected messages contain the
   synthetic summary message in the correct chronological position;
   `lastUserMessageHead` framing is present.
5. **Cache hit.** Re-run invocation with no new events. Assert: no new
   summarizer call (provider received zero new prompts beyond the main
   call); the same `compaction.summary` event is reused; output prompt
   matches step 4 exactly.
6. **Cache hit with new events.** Append one new turn, run again.
   Assert: old window's summary reused (no extra summarizer call); new
   turn rendered normally; pressure tiers re-evaluated against the new
   total size.
7. **Compounded-loss test.** Run three invocations adding ~30% more
   content each time. Assert: the summary text for the oldest window is
   *identical* across all three runs (since the source events are
   identical) — demonstrates the no-compounded-loss property.
8. **Summary failure fallthrough.** Scripted provider throws on the
   summarizer call. Assert: `compaction.summary.failed` recorded; T6
   truncation engages; main step proceeds.
9. **Hard truncate floor.** Pressure remains >100% even after all
   tiers. Assert: oldest non-system messages dropped; `compaction.
   completed.truncatedFromFrontCount > 0`.

Apps-side smoke (`apps/cli/scripts/smoke-compaction-summary.ts`):

10. **End-to-end with a real shell + fake summarizer provider.** Run
    a session that triggers T4 (summarization) on a window containing
    a real bash tool call (whose output became an artifact via plan
    006's auto-artifact). Assert: the summary message references the
    artifact id; `read_artifact` against either the summary's
    `sourceArtifactId` or the original tool's `artifactId` round-trips
    to the full content.

Manual verification (`lh-dev`, DeepSeek):

- Long session covering ~40 turns of edits + grep + read. As pressure
  crosses 50%, footer context indicator updates. Around 85%, "compacting
  earlier turns…" appears briefly in the footer, then disappears with a
  transient "compacted N turns → ~X chars saved" cell. The session
  continues without thread breakage.

## Removability

The strategy is one module (`pressure-gradient.ts`) plus its helper
(`summarize.ts`, `cache.ts`). To roll back to `naive-truncate`:

- Flip `compact()` in `compaction/index.ts` from `pressureGradient` to
  `naiveTruncate`.
- Delete `pressure-gradient.ts`, `summarize.ts`, `cache.ts`.
- The new event types (`compaction.summary`, `compaction.summary.failed`,
  `compaction.tool_promoted`) are additive — existing reducers ignore
  them via the default no-op path. Old sessions with these events still
  load fine; the events just stop being consulted.
- The new `CompactionOptions` fields are additive; apps that don't set
  them keep working.

~250 lines of net deletion to roll back to the floor strategy. The
event log changes are forward-additive and reverse-tolerant.

## What this rules out, what it leaves open

Ruled out for this plan:

- Vector retrieval / semantic search over old turns. Future plan.
- Hierarchical summaries (summaries of summaries). Single level only.
- Predictive token measurement (would need a tokenizer dep). v1 is
  reactive — reads `usage.promptTokens` from the last `model.completed`.
- A dedicated cheaper summarizer model. v1 reuses the session's main
  model; `summarizerModel?` config exists but defaults to main.
- Per-app watermark overrides as a primary mode. Single config schema;
  apps can override but defaults are owned by the kernel.
- "Smart" current-focus extraction (LLM-derived). v1 uses literal last
  user message head, capped 200 chars.
- Cross-session summary access. Per-session only, same as artifacts.

Left open and additive:

- Smaller/cheaper `summarizerModel` config (DeepSeek-mini, Haiku).
- Client-side tokenizer for **T6's safety-net measurement** so the
  whole pipeline reasons in tokens end-to-end (T1-5 already do; T6
  falls back to chars because it has to estimate post-projection size
  before the next call).
- **Predictive (vs. reactive) pressure measurement** — the same
  tokenizer would let us pre-compute the next prompt's token cost
  instead of relying on the last completed step's `usage.promptTokens`.
  Removes the one-step lag at the cost of a tokenizer dep.
- **Background prefetch summarization** — after a step completes, if
  pressure is approaching 85%, spawn the summarizer as a background
  task (reusing the `MessageQueue` / `TaskExecutor` infrastructure from
  plan 004 / 005) so the cache is warm by the next step's compaction.
  Hides summarizer latency entirely at the cost of occasional wasted
  work if the session ends. Real design work: lifecycle, cancellation,
  whether to use a dedicated executor.
- Hierarchical compaction once windows themselves grow numerous.
- Watermark presets per session length (long-form vs short).
- A `compact_now` model-facing tool so the agent can opportunistically
  trigger compaction when it knows it's at a good break point.
- Slack/Telemetry hook on `compaction.summary` for observability.

## Naming alternatives

| Concept | Proposed | Alternatives |
| ------- | -------- | ------------ |
| Strategy | `pressure_gradient` | `tiered`, `watermark`, `graduated`, `progressive` — `pressure_gradient` reads as "the gradient is keyed to pressure," which is exactly the model |
| Cache event | `compaction.summary` | `summary.created`, `compaction.window_summarized` — `.summary` matches the artifact/event style |
| Promotion event | `compaction.tool_promoted` | `compaction.inline_artifacted`, `artifact.promoted` — `compaction.*` keeps it grouped with related metadata |
| Watermark field | `dropOldReasoning: 0.50` | `dropReasoningPressure`, `t1Threshold` — name matches what the tier does, not its tier number (tier numbers are implementation, not user-facing) |
| Tier identifier | `drop_old_reasoning` (snake) | `dropOldReasoning` (camel) — snake for log/event payloads matches existing `event.type` casing |
| `preserveRecentTurns` (replaces `preserveRecentMessages`) | `keepRecentTurns`, `recentTurnHeadroom` | "Preserve" matches the existing field name; turns are clearer than messages. Migration is trivial — only one smoke (`scripts/smoke/compaction.mjs`) and the strategy file reference `preserveRecentMessages`; no app sets it. |
| Summary message framing prefix | `[Earlier work — full transcript at <id>. Current focus appears to be: ...]` | `[Compacted earlier turns. Current focus: ...]` — chose the longer form because it tells the model the recovery path (`read_artifact <id>`) inline |
| Context indicator format | `32k / 435k (7%)` | `7% (32/435k)`, `32k of 435k`, bar graph — short numeric form fits in a footer column with the prompt status |
