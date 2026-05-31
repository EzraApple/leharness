// pressure-gradient.ts
// Smart compaction. Six tiers, each gated by its own pressure watermark
// against the configured token budget. Pressure is *reactive*: it's read
// from the most recent model.completed.usage.promptTokens in the event
// log. We can't predict the next prompt's token cost without a tokenizer
// dep, and the goal of compaction is to react before the next call —
// which means we react based on what the last call actually cost.
//
//   T1 (≥50%) — drop_old_reasoning      : free, near-lossless
//   T2 (≥65%) — promote_inline_results  : disk I/O, recoverable
//   T3 (≥75%) — drop_old_tool_bodies    : free, tombstones with artifact ref
//   T4 (≥85%) — summarize_first_window  : one LLM call, cached
//   T5 (≥95%) — summarize_second_window : one LLM call, cached
//   T6 (≥100%) — truncate_front         : char-based safety net
//
// All transformations whose watermark is crossed apply in a single pass.
// T4+T5 fire via Promise.all when both watermarks are crossed.
// T6 falls back to a char-based ceiling because it needs a pre-call
// estimate to prevent provider rejection.
//
// Idempotency: summaries cache via compaction.summary events (cache.ts);
// inline-promotions cache via compaction.tool_promoted events; both are
// keyed to source event IDs so re-running compaction on the same history
// reuses prior work and produces identical projections.

import { formatArtifactStub, resolveArtifactPath, writeArtifact } from "../artifacts.js"
import type { Event } from "../events.js"
import { eventToMessage, type PromptInput } from "../prompt.js"
import type { HarnessMessage } from "../provider/index.js"
import { readNumberField, readRecordField } from "../readers.js"
import { readToolCall, readToolCalls } from "../tools.js"
import { type CompactionSummary, loadSummaryCache } from "./cache.js"
import { pickOldestUnsummarizedWindow, summarizeWindow } from "./summarize.js"
import { groupEventsIntoTurns } from "./turns.js"

// Watermarks are module constants — see plan 007 "Decisions locked in".
// Surface as config only when a real tuning need shows up.
const DROP_OLD_REASONING_WATERMARK = 0.5
const PROMOTE_INLINE_RESULTS_WATERMARK = 0.65
const DROP_OLD_TOOL_BODIES_WATERMARK = 0.75
const SUMMARIZE_FIRST_WINDOW_WATERMARK = 0.85
const SUMMARIZE_SECOND_WINDOW_WATERMARK = 0.95

// T2 only promotes tool results above this size (smaller bodies don't
// pay back the artifact I/O cost). Matches plan 007 §"Artifact
// promotion threshold".
const PROMOTE_INLINE_MIN_BYTES = 1024

// Each summarization window covers M consecutive turns.
const SUMMARIZE_WINDOW_TURNS = 4

// Default preserve-recent turns when CompactionOptions doesn't set one.
const DEFAULT_PRESERVE_RECENT_TURNS = 2

interface ProjectionContext {
  dropReasoningForEventIds: Set<string>
  toolReplacementByCallId: Map<string, string>
  // Summary substitutions: key = the first event ID of the covered
  // window, so we emit the summary message exactly where the window
  // starts in chronological order and skip subsequent covered events.
  summaryByFirstEventId: Map<string, AppliedSummary>
  // All event IDs that are covered by ANY applied summary — skipped
  // during projection regardless of where they appear.
  coveredEventIds: Set<string>
}

interface AppliedSummary {
  summary: CompactionSummary
}

export async function pressureGradient(input: PromptInput): Promise<PromptInput> {
  const ctx: ProjectionContext = {
    dropReasoningForEventIds: new Set(),
    toolReplacementByCallId: new Map(),
    summaryByFirstEventId: new Map(),
    coveredEventIds: new Set(),
  }

  // Apply every cached summary unconditionally. Once a
  // `compaction.summary` event lands in the log, that summary is the
  // canonical projection of its covered events for the rest of the
  // session — the model already saw it on the step that wrote it.
  // Cache application is not a "compaction decision," so it doesn't
  // count toward watermarksCrossed and doesn't record an event.
  const cache = loadSummaryCache(input.events)
  for (const summary of cache.list()) {
    applySummary(ctx, summary)
  }
  const hadCachedSummaries = ctx.summaryByFirstEventId.size > 0

  const budgetTokens = input.compaction?.maxInputTokens
  const lastInputTokens = budgetTokens !== undefined ? findLastInputTokens(input.events) : undefined
  const pressureRatio =
    budgetTokens !== undefined && lastInputTokens !== undefined ? lastInputTokens / budgetTokens : 0

  const preserveRecentTurns = Math.max(
    0,
    input.compaction?.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS,
  )
  const allTurns = groupEventsIntoTurns(input.events)
  const eligibleTurnCount = Math.max(0, allTurns.length - preserveRecentTurns)
  const eligibleEventIds = new Set<string>()
  for (let i = 0; i < eligibleTurnCount; i++) {
    for (const event of allTurns[i]?.events ?? []) eligibleEventIds.add(event.id)
  }

  const watermarksCrossed: string[] = []
  let droppedReasoningCount = 0
  let promotedInlineCount = 0
  let droppedToolBodyCount = 0
  let summarizedWindowCount = 0

  // Below the T1 watermark we don't run any active tiers. If we have
  // cached summaries we still need to return the projected messages
  // (with summaries applied) so the model sees them, but no new
  // compaction event is recorded.
  if (pressureRatio < DROP_OLD_REASONING_WATERMARK) {
    if (!hadCachedSummaries) return input
    const latestUserMessageHead = findLatestUserMessageHead(input.events, 200)
    const messages = projectEventsWithContext(input.events, ctx, latestUserMessageHead)
    return { ...input, messages }
  }

  // T1 — drop old reasoning text
  if (pressureRatio >= DROP_OLD_REASONING_WATERMARK) {
    for (const event of input.events) {
      if (!eligibleEventIds.has(event.id)) continue
      if (ctx.coveredEventIds.has(event.id)) continue // already inside an applied summary
      if (event.type !== "model.completed") continue
      const reasoningText = event.reasoningText
      if (typeof reasoningText !== "string" || reasoningText.length === 0) continue
      ctx.dropReasoningForEventIds.add(event.id)
      droppedReasoningCount++
    }
    if (droppedReasoningCount > 0) watermarksCrossed.push("drop_old_reasoning")
  }

  // T2 — promote oversized inline tool results to artifacts
  if (
    pressureRatio >= PROMOTE_INLINE_RESULTS_WATERMARK &&
    input.sessionId !== undefined &&
    input.recordEvent !== undefined
  ) {
    const priorPromotions = collectPriorPromotions(input.events, input.sessionId)
    for (const event of input.events) {
      if (!eligibleEventIds.has(event.id)) continue
      if (ctx.coveredEventIds.has(event.id)) continue
      if (event.type !== "tool.completed") continue
      if (typeof event.artifactId === "string") continue // already an artifact at write time
      const callId = readToolCall(event.call)?.id
      if (callId === undefined) continue
      const result = typeof event.result === "string" ? event.result : ""
      if (Buffer.byteLength(result, "utf8") < PROMOTE_INLINE_MIN_BYTES) continue

      const existing = priorPromotions.get(callId)
      if (existing !== undefined) {
        // Cache hit — reuse the previously-promoted artifact stub.
        ctx.toolReplacementByCallId.set(callId, existing.stub)
        continue
      }

      const artifact = await writeArtifact(input.sessionId, result, {
        mime: "text/plain",
        sourceCallId: callId,
      })
      await input.recordEvent("artifact.created", {
        id: artifact.id,
        sessionId: artifact.sessionId,
        byteCount: artifact.byteCount,
        mime: artifact.mime,
        sourceCallId: callId,
      })
      await input.recordEvent("compaction.tool_promoted", {
        sourceCallId: callId,
        artifactId: artifact.id,
        promotedAt: new Date().toISOString(),
      })
      ctx.toolReplacementByCallId.set(callId, formatArtifactStub(artifact, result))
      promotedInlineCount++
    }
    if (promotedInlineCount > 0) watermarksCrossed.push("promote_inline_results")
  }

  // T3 — drop old tool result bodies (tombstones)
  if (pressureRatio >= DROP_OLD_TOOL_BODIES_WATERMARK) {
    for (const event of input.events) {
      if (!eligibleEventIds.has(event.id)) continue
      if (ctx.coveredEventIds.has(event.id)) continue
      if (event.type !== "tool.completed") continue
      const callId = readToolCall(event.call)?.id
      if (callId === undefined) continue
      if (ctx.toolReplacementByCallId.has(callId)) continue // T2 already handled
      const existingArtifactId = typeof event.artifactId === "string" ? event.artifactId : undefined
      const tombstone =
        existingArtifactId !== undefined
          ? `[tool result dropped during compaction — use read_file with path="${formatArtifactPath(input.sessionId, existingArtifactId)}", offset=1, limit=400 for full content]`
          : "[tool result dropped during compaction]"
      ctx.toolReplacementByCallId.set(callId, tombstone)
      droppedToolBodyCount++
    }
    if (droppedToolBodyCount > 0) watermarksCrossed.push("drop_old_tool_bodies")
  }

  // T4 + T5 — summarize NEW unsummarized windows in parallel. Cached
  // summaries were already applied above; this only picks fresh
  // windows of currently-uncovered eligible turns.
  if (
    pressureRatio >= SUMMARIZE_FIRST_WINDOW_WATERMARK &&
    input.sessionId !== undefined &&
    input.provider !== undefined &&
    input.recordEvent !== undefined
  ) {
    const desiredWindows = pressureRatio >= SUMMARIZE_SECOND_WINDOW_WATERMARK ? 2 : 1

    // The exclude set starts with every event already covered by a
    // cached summary (those events are projected as summary
    // substitutions, so they're "off limits" for new picking).
    const picked: { eventIds: string[]; windowTurns: typeof allTurns }[] = []
    const excludeEventIds = new Set<string>(ctx.coveredEventIds)
    while (picked.length < desiredWindows) {
      const window = pickOldestUnsummarizedWindow({
        events: input.events,
        preserveRecentTurns,
        windowSize: SUMMARIZE_WINDOW_TURNS,
        isAlreadyCovered: (ids) => ids.some((id) => excludeEventIds.has(id)),
      })
      if (window === undefined) break
      picked.push({ eventIds: window.eventIds, windowTurns: window.turns })
      for (const id of window.eventIds) excludeEventIds.add(id)
    }

    if (picked.length > 0) {
      // Emit a `started` event before the parallel summarizer calls so
      // consumers (TUI) can flip to a "compacting…" indicator while the
      // calls are in flight. Cheap tiers stay silent — only summarization
      // takes long enough to be worth surfacing.
      await input.recordEvent("compaction.started", {
        phase: "summarizing",
        windowCount: picked.length,
        budgetTokens,
        lastInputTokens,
        pressureRatio,
      })
      const sessionId = input.sessionId
      const provider = input.provider
      const results = await Promise.all(
        picked.map(async (window) => {
          const outcome = await summarizeWindow({
            sessionId,
            windowTurns: window.windowTurns,
            windowEventIds: window.eventIds,
            provider,
            model: input.model,
            summarizerModel: input.compaction?.summarizerModel,
            signal: input.signal,
          })
          return { eventIds: window.eventIds, outcome }
        }),
      )

      for (const { eventIds, outcome } of results) {
        if (outcome.kind === "ok") {
          await input.recordEvent("compaction.summary", {
            coveredEventIds: outcome.summary.coveredEventIds,
            summaryText: outcome.summary.summaryText,
            sourceArtifactId: outcome.summary.sourceArtifactId,
            generatedAt: outcome.summary.generatedAt,
            generatedByModel: outcome.summary.generatedByModel,
            charsBefore: outcome.summary.charsBefore,
            charsAfter: outcome.summary.charsAfter,
          })
          applySummary(ctx, outcome.summary)
          summarizedWindowCount++
        } else if (outcome.kind === "skipped") {
          // Window too small to summarize. Don't record; next step
          // can attempt a different window if pressure persists.
        } else {
          await input.recordEvent("compaction.summary.failed", {
            attemptedEventIds: eventIds,
            error: outcome.error,
          })
        }
      }
      if (summarizedWindowCount > 0) {
        watermarksCrossed.push(
          summarizedWindowCount > 1 ? "summarize_two_windows" : "summarize_one_window",
        )
      }
    }
  }

  // Project events to messages with all the tier transformations applied.
  const latestUserMessageHead = findLatestUserMessageHead(input.events, 200)
  const messages = projectEventsWithContext(input.events, ctx, latestUserMessageHead)

  // T6 — char-based hard truncate safety net.
  let truncatedFromFrontCount = 0
  const maxInputChars = input.compaction?.maxInputChars
  if (maxInputChars !== undefined && maxInputChars > 0) {
    const preserveMessageFloor = countPreservedRecentMessages(allTurns, preserveRecentTurns)
    while (
      messages.length > preserveMessageFloor &&
      messageCharCount(messages, input) > maxInputChars
    ) {
      messages.shift()
      truncatedFromFrontCount++
    }
    // Drop any leading tool messages (orphaned without their assistant) so we
    // don't desync with provider expectations.
    while (
      messages.length > preserveMessageFloor &&
      messages[0]?.role === "tool" &&
      messageCharCount(messages, input) > maxInputChars
    ) {
      messages.shift()
      truncatedFromFrontCount++
    }
    if (truncatedFromFrontCount > 0) watermarksCrossed.push("truncate_front")
  }

  // If no active tier fired but we did apply cached summaries, return
  // the new projection silently (no compaction.completed event — that's
  // reserved for new decisions, not for re-application of prior ones).
  if (watermarksCrossed.length === 0) {
    return hadCachedSummaries ? { ...input, messages } : input
  }

  await input.recordEvent?.("compaction.completed", {
    strategy: "pressure_gradient",
    reason: "input_too_large",
    budgetTokens: budgetTokens ?? 0,
    lastInputTokens: lastInputTokens ?? 0,
    pressureRatio,
    watermarksCrossed,
    droppedReasoningCount,
    promotedInlineCount,
    droppedToolBodyCount,
    summarizedWindowCount,
    truncatedFromFrontCount,
  })

  return { ...input, messages }
}

function applySummary(ctx: ProjectionContext, summary: CompactionSummary) {
  const first = summary.coveredEventIds[0]
  if (first === undefined) return
  ctx.summaryByFirstEventId.set(first, { summary })
  for (const id of summary.coveredEventIds) ctx.coveredEventIds.add(id)
}

function projectEventsWithContext(
  events: Event[],
  ctx: ProjectionContext,
  latestUserMessageHead: string,
): HarnessMessage[] {
  const result: HarnessMessage[] = []
  for (const event of events) {
    // Summary substitution lands at the first event of the covered
    // window; subsequent covered events are skipped.
    const summary = ctx.summaryByFirstEventId.get(event.id)
    if (summary !== undefined) {
      result.push(buildSummaryMessage(summary.summary, latestUserMessageHead))
      continue
    }
    if (ctx.coveredEventIds.has(event.id)) continue

    const message = projectSingleEventWithTransforms(event, ctx)
    if (message !== null) result.push(message)
  }
  return result
}

function projectSingleEventWithTransforms(
  event: Event,
  ctx: ProjectionContext,
): HarnessMessage | null {
  // T2/T3 tool-result replacement
  if (event.type === "tool.completed") {
    const call = readToolCall(event.call)
    if (call?.id !== undefined) {
      const replacement = ctx.toolReplacementByCallId.get(call.id)
      if (replacement !== undefined) {
        return { role: "tool", toolCallId: call.id, content: replacement }
      }
    }
  }
  // T1 reasoning drop
  if (event.type === "model.completed" && ctx.dropReasoningForEventIds.has(event.id)) {
    return {
      role: "assistant",
      content: typeof event.text === "string" ? event.text : "",
      toolCalls: readToolCalls(event.toolCalls),
    }
  }
  return eventToMessage(event)
}

function buildSummaryMessage(
  summary: CompactionSummary,
  latestUserMessageHead: string,
): HarnessMessage {
  const focusLine =
    latestUserMessageHead.length > 0
      ? `\nCurrent focus appears to be: ${latestUserMessageHead}`
      : ""
  const header = `[Earlier work — full transcript at ${summary.sourceArtifactId}.${focusLine}]`
  return { role: "user", content: `${header}\n\n${summary.summaryText}` }
}

function findLastInputTokens(events: Event[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== "model.completed") continue
    const promptTokens = readNumberField(readRecordField(event, "usage"), "promptTokens")
    if (promptTokens !== undefined) return promptTokens
  }
  return undefined
}

function findLatestUserMessageHead(events: Event[], cap: number): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== "invocation.received") continue
    const text = typeof event.text === "string" ? event.text : ""
    if (text.length <= cap) return text
    return `${text.slice(0, cap)}…`
  }
  return ""
}

interface PriorPromotion {
  artifactId: string
  stub: string
}

function collectPriorPromotions(
  events: Event[],
  sessionId: string | undefined,
): Map<string, PriorPromotion> {
  const promotions = new Map<string, PriorPromotion>()
  for (const event of events) {
    if (event.type !== "compaction.tool_promoted") continue
    const sourceCallId = typeof event.sourceCallId === "string" ? event.sourceCallId : undefined
    const artifactId = typeof event.artifactId === "string" ? event.artifactId : undefined
    if (sourceCallId === undefined || artifactId === undefined) continue
    // Build a stub from minimal info — we don't have byteCount on the
    // promotion event, but the model just needs the file path to inspect.
    const filePath = formatArtifactPath(sessionId, artifactId)
    promotions.set(sourceCallId, {
      artifactId,
      stub: `[artifact: ${filePath} · promoted during compaction · use read_file with path="${filePath}", offset=1, limit=400 for full content]`,
    })
  }
  return promotions
}

function formatArtifactPath(sessionId: string | undefined, artifactId: string): string {
  return sessionId === undefined ? artifactId : resolveArtifactPath(sessionId, artifactId)
}

function countPreservedRecentMessages(
  turns: ReturnType<typeof groupEventsIntoTurns>,
  preserveRecentTurns: number,
): number {
  if (preserveRecentTurns <= 0) return 0
  const recent = turns.slice(turns.length - preserveRecentTurns)
  let count = 0
  for (const turn of recent) {
    for (const event of turn.events) {
      if (eventToMessage(event) !== null) count++
    }
  }
  return count
}

function messageCharCount(messages: HarnessMessage[], input: PromptInput): number {
  return (
    JSON.stringify(messages).length +
    (input.system?.length ?? 0) +
    JSON.stringify(input.tools ?? []).length +
    input.model.length
  )
}
