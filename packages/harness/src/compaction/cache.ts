// cache.ts
// The compaction.summary event IS the cache. On every step we re-scan
// the in-memory events array (already loaded by invocation startup) and
// build a Map<sortedEventIdKey, CompactionSummary>. Cache keys are the
// exact set of event IDs the summary covers — since events are
// append-only the same window always hashes to the same key and the
// cache is monotonically valid for the session's lifetime.
//
// No separate persistence layer: events.jsonl is the storage; this
// module is the live projection of that storage into a lookup.

import type { Event } from "../events.js"

export interface CompactionSummary {
  coveredEventIds: string[] // canonical order preserved from the event
  summaryText: string
  sourceArtifactId: string
  generatedAt: string
  generatedByModel: string
  charsBefore: number
  charsAfter: number
}

export interface SummaryCache {
  // Lookup by the exact set of covered event IDs. The strategy asks
  // "do I have a summary for these N events?" and we return one if it
  // matches.
  findCovering(windowEventIds: string[]): CompactionSummary | undefined
  // All cached summaries in event-log order; lets the strategy walk
  // them when deciding which windows are *already* covered.
  list(): CompactionSummary[]
}

export function loadSummaryCache(events: Event[]): SummaryCache {
  const byKey = new Map<string, CompactionSummary>()
  const ordered: CompactionSummary[] = []
  for (const event of events) {
    if (event.type !== "compaction.summary") continue
    const summary = readSummaryEvent(event)
    if (summary === undefined) continue
    byKey.set(keyOf(summary.coveredEventIds), summary)
    ordered.push(summary)
  }
  return {
    findCovering(windowEventIds) {
      return byKey.get(keyOf(windowEventIds))
    },
    list() {
      return ordered
    },
  }
}

// Order-insensitive but stable: sort then join with a separator that
// can't appear in a ULID.
function keyOf(eventIds: readonly string[]): string {
  return [...eventIds].sort().join("|")
}

function readSummaryEvent(event: Event): CompactionSummary | undefined {
  const coveredEventIds = event.coveredEventIds
  const summaryText = event.summaryText
  const sourceArtifactId = event.sourceArtifactId
  const generatedAt = event.generatedAt
  const generatedByModel = event.generatedByModel
  const charsBefore = event.charsBefore
  const charsAfter = event.charsAfter
  if (!Array.isArray(coveredEventIds)) return undefined
  if (typeof summaryText !== "string") return undefined
  if (typeof sourceArtifactId !== "string") return undefined
  if (typeof generatedAt !== "string") return undefined
  if (typeof generatedByModel !== "string") return undefined
  if (typeof charsBefore !== "number") return undefined
  if (typeof charsAfter !== "number") return undefined
  if (!coveredEventIds.every((id): id is string => typeof id === "string")) return undefined
  return {
    coveredEventIds: [...coveredEventIds],
    summaryText,
    sourceArtifactId,
    generatedAt,
    generatedByModel,
    charsBefore,
    charsAfter,
  }
}
