// summarize.ts
// The expensive compaction tier. Picks an old M-turn window of events,
// renders the window into a transcript-style brief for a model call,
// fires the call against the session's provider, stashes the rendered
// window as an artifact so the original is recoverable, and returns a
// CompactionSummary payload the orchestrator records as a
// `compaction.summary` event.
//
// One model call per summarize attempt. Cached by the orchestrator via
// the cache.ts module — once a `compaction.summary` event lands for a
// given event-id set, this module is never called again for that
// window for the session's lifetime.

import { writeArtifact } from "../artifacts.js"
import type { Event } from "../events.js"
import type { Provider } from "../provider/index.js"
import type { CompactionSummary } from "./cache.js"
import {
  type CompactionTurn,
  type EventTurnIndex,
  groupEventsIntoTurns,
  renderTurnsForSummarizer,
} from "./turns.js"

// Summary target is 400-900 chars (~150-300 tokens), but for reasoning
// models the budget also covers thinking tokens, so we ask for headroom.
// At 1500 we comfortably fit a ~900-char visible output plus any
// reasoning the model emits.
const SUMMARIZER_MAX_OUTPUT_TOKENS = 1500
// Don't summarize windows smaller than this — the summary costs more than
// the original would.
const SUMMARIZE_MIN_WINDOW_CHARS = 2 * 1024
// Per-turn rendering cap; the summarizer doesn't need full tool bodies
// to extract intent, and capping keeps the prompt under control.
const SUMMARIZER_RENDER_CHUNK_CAP = 500

interface SummarizeArgs {
  sessionId: string
  windowTurns: CompactionTurn[]
  windowEventIds: string[]
  provider: Provider
  model: string
  summarizerModel?: string
  signal?: AbortSignal
}

type SummarizeOutcome =
  | { kind: "ok"; summary: CompactionSummary }
  | { kind: "skipped"; reason: "too_small"; chars: number }
  | { kind: "failed"; error: string }

export async function summarizeWindow(args: SummarizeArgs): Promise<SummarizeOutcome> {
  const rendered = renderTurnsForSummarizer(args.windowTurns, SUMMARIZER_RENDER_CHUNK_CAP)
  if (rendered.length < SUMMARIZE_MIN_WINDOW_CHARS) {
    return { kind: "skipped", reason: "too_small", chars: rendered.length }
  }

  const artifact = await writeArtifact(args.sessionId, rendered, {
    mime: "text/plain",
  })

  const summarizerModel = args.summarizerModel ?? args.model
  const prompt = buildSummarizerPrompt(rendered)

  try {
    const response = await args.provider.call({
      model: summarizerModel,
      system: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: SUMMARIZER_MAX_OUTPUT_TOKENS,
      // Summarization is structured low-ambiguity work; reasoning
      // tokens eat into maxOutputTokens and cause mid-sentence
      // truncation. Force reasoning off so the full visible budget
      // goes to the brief itself.
      reasoningEffort: "off",
      signal: args.signal,
    })
    const summaryText = response.text.trim()
    if (summaryText.length === 0) {
      return { kind: "failed", error: "summarizer returned empty text" }
    }
    const summary: CompactionSummary = {
      coveredEventIds: args.windowEventIds,
      summaryText,
      sourceArtifactId: artifact.id,
      generatedAt: new Date().toISOString(),
      generatedByModel: summarizerModel,
      charsBefore: rendered.length,
      charsAfter: summaryText.length,
    }
    return { kind: "ok", summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: "failed", error: message }
  }
}

// Walk the event log into turn groupings and pick the oldest window of
// `windowSize` consecutive turns outside the preserve-recent zone whose
// events are not already covered by an existing summary. Returns the
// candidate turns + their event IDs, or undefined when no eligible
// window exists.
interface PickWindowArgs {
  events: Event[]
  preserveRecentTurns: number
  windowSize: number
  isAlreadyCovered: (eventIds: string[]) => boolean
}

interface PickedWindow {
  turns: CompactionTurn[]
  eventIds: string[]
  index: EventTurnIndex
}

export function pickOldestUnsummarizedWindow(args: PickWindowArgs): PickedWindow | undefined {
  const allTurns = groupEventsIntoTurns(args.events)
  const eligibleEnd = allTurns.length - args.preserveRecentTurns
  if (eligibleEnd <= 0) return undefined
  for (let start = 0; start + args.windowSize <= eligibleEnd; start++) {
    const turns = allTurns.slice(start, start + args.windowSize)
    const eventIds = turns.flatMap((turn) => turn.events.map((e) => e.id))
    if (eventIds.length === 0) continue
    if (args.isAlreadyCovered(eventIds)) continue
    const index: EventTurnIndex = {
      firstEventId: eventIds[0] ?? "",
      lastEventId: eventIds[eventIds.length - 1] ?? "",
    }
    return { turns, eventIds, index }
  }
  return undefined
}

const SUMMARIZER_SYSTEM =
  "You produce concise handoff briefs for an ongoing agent coding session. " +
  "Your output replaces the early turns of the session so the agent can continue " +
  "without losing context. The original turns remain recoverable via an artifact " +
  "reference — your job is to capture intent and outcomes, not preserve data."

function buildSummarizerPrompt(renderedWindow: string): string {
  return [
    "You are summarizing the early portion of an ongoing agent session so the session",
    "can continue without losing context. The full window of turns will remain",
    "recoverable via an artifact id; your summary is a HANDOFF BRIEF, not a",
    "retrospective. Phrase it as state-of-play.",
    "",
    "Source window:",
    "",
    renderedWindow,
    "",
    "Produce a brief with this structure:",
    "",
    "- **Goal:** what the user appears to be working toward",
    "- **Touched:** files, concepts, or systems already engaged",
    "- **Decisions:** approaches chosen, constraints established",
    "- **Findings:** notable results, errors hit, dead ends",
    "",
    "Rules:",
    "- **Goal** is required. Omit any of the others only when the window genuinely",
    "  has nothing to report for them.",
    "- Aim for 400–900 characters total. A light window (one or two short turns of",
    "  trivial work) may need only 1–2 sentences. **Always finish the sentence you are",
    "  writing** — never stop mid-clause or mid-list. Do not begin a field you cannot",
    "  finish within the length budget.",
    "- Do NOT speculate about what comes next or what the user might do — you only",
    "  see the window itself, not the future. Stay in past/present tense.",
    "- Do not include exact quotes or data dumps; originals are recoverable via the",
    "  artifact reference.",
  ].join("\n")
}
