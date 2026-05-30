// hooks/useInvocation.ts
// The agent run lifecycle, lifted out of app.tsx: starting an invocation,
// streaming its events into the transcript, aborting, and the queue of
// messages typed while a run is in flight (plus the auto-react that drains
// background-task updates). app.tsx keeps the composer; this owns "is a run
// happening and what's queued behind it".

import {
  type Event,
  type HarnessDeps,
  hasPendingBackgroundUpdates,
  subscribeToBackgroundUpdates,
} from "@leharness/harness"
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react"
import { appendCell, reduceEvent, reduceText } from "../state/transcript.js"
import type { QueuedMessage, TranscriptState } from "../state/types.js"

export type RunPrompt = (
  text: string | undefined,
  deps: HarnessDeps,
  options: {
    onEvent: (event: Event) => void
    onText: (delta: string) => void
    signal: AbortSignal
  },
) => Promise<void>

export interface Invocation {
  running: boolean
  // The keymap reads this synchronously to decide queue-vs-send.
  runningRef: React.MutableRefObject<boolean>
  queuedMessages: QueuedMessage[]
  // Start a run, or pass undefined to auto-react to background updates.
  start: (text: string | undefined) => Promise<void>
  // Queue a message to run after the current one (sets the "queued N" status).
  enqueue: (text: string) => void
  // If running with something queued, interrupt so the queue drains next.
  interruptForQueued: () => boolean
  // Pull the next queued message and run it when idle.
  startNextQueued: () => boolean
  // Abort the in-flight run (does not touch the queue).
  abort: () => void
  // Drop every queued message.
  clearQueue: () => void
}

export function useInvocation(opts: {
  runPrompt: RunPrompt
  activeDeps: HarnessDeps
  sessionId: string
  // Expand typed text before it runs.
  prepareText: (text: string) => string | undefined
  setTranscript: Dispatch<SetStateAction<TranscriptState>>
  setStatus: (status: string) => void
  // Run after a settled invocation (re-discover skills).
  onSettled: () => void
}): Invocation {
  const { activeDeps, prepareText, runPrompt, sessionId, setStatus, setTranscript } = opts
  const onSettled = opts.onSettled

  const [running, setRunning] = useState(false)
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const runningRef = useRef(false)
  const queuedMessagesRef = useRef<QueuedMessage[]>([])
  const queuedMessageIdRef = useRef(0)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const forceDrainAfterAbortRef = useRef(false)
  const invocationIdRef = useRef(0)
  const autoInvocationScheduledRef = useRef(false)
  const startRef = useRef<(text: string | undefined) => Promise<void>>(async () => {})

  // Abort any in-flight run on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Background tasks completing while idle schedule a fresh auto-react so the
  // agent can observe their results without the user prompting again.
  useEffect(() => {
    const scheduleAutoInvocation = () => {
      if (autoInvocationScheduledRef.current) return
      autoInvocationScheduledRef.current = true
      setTimeout(() => {
        autoInvocationScheduledRef.current = false
        if (runningRef.current) return
        if (!hasPendingBackgroundUpdates(sessionId)) return
        void startRef.current(undefined)
      }, 50)
    }
    return subscribeToBackgroundUpdates(sessionId, scheduleAutoInvocation)
  }, [sessionId])

  function replaceQueue(messages: QueuedMessage[]): void {
    queuedMessagesRef.current = messages
    setQueuedMessages(messages)
  }

  function enqueue(text: string): void {
    const id = `queued-${queuedMessageIdRef.current}`
    queuedMessageIdRef.current += 1
    replaceQueue([...queuedMessagesRef.current, { id, text }])
    setStatus(`queued ${queuedMessagesRef.current.length}`)
  }

  function shiftQueue(): QueuedMessage | undefined {
    const [next, ...remaining] = queuedMessagesRef.current
    replaceQueue(remaining)
    return next
  }

  function interruptForQueued(): boolean {
    if (!runningRef.current || queuedMessagesRef.current.length === 0) return false
    forceDrainAfterAbortRef.current = true
    abortRef.current?.abort()
    setStatus("interrupting")
    return true
  }

  function startNextQueued(): boolean {
    if (runningRef.current) return false
    const next = shiftQueue()
    if (next === undefined) return false
    void start(next.text)
    return true
  }

  async function start(text: string | undefined): Promise<void> {
    if (runningRef.current) return
    const invocationText = text === undefined ? undefined : prepareText(text)
    if (text !== undefined && invocationText === undefined) {
      void startNextQueued()
      return
    }

    runningRef.current = true
    setRunning(true)
    setStatus(invocationText === undefined ? "auto-react" : "running")
    const controller = new AbortController()
    const invocationStartedAt = Date.now()
    const invocationId = invocationIdRef.current + 1
    invocationIdRef.current = invocationId
    abortRef.current = controller
    try {
      await runPrompt(invocationText, activeDeps, {
        signal: controller.signal,
        onText: (delta) => {
          if (controller.signal.aborted || invocationIdRef.current !== invocationId) return
          setTranscript((prev) => reduceText(prev, delta))
        },
        onEvent: (event) => {
          if (controller.signal.aborted && event.type !== "agent.finished") return
          if (invocationIdRef.current !== invocationId) return
          if (event.type === "step.started") setStatus(`step ${String(event.stepNumber ?? "?")}`)
          if (event.type === "agent.finished") setStatus("idle")
          setTranscript((prev) => {
            const next = reduceEvent(prev, event)
            if (event.type !== "agent.finished") return next
            return appendCell(next, {
              kind: "system",
              text: `worked for ${formatElapsed(Date.now() - invocationStartedAt)}`,
            })
          })
        },
      })
    } catch (err) {
      if (!controller.signal.aborted) {
        setTranscript((prev) =>
          appendCell(prev, {
            kind: "error",
            title: "run",
            text: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    } finally {
      const shouldDrain = forceDrainAfterAbortRef.current || !controller.signal.aborted
      forceDrainAfterAbortRef.current = false
      if (abortRef.current === controller) abortRef.current = undefined
      runningRef.current = false
      setRunning(false)
      setStatus("idle")
      onSettled()
      if (shouldDrain) void startNextQueued()
      // If background messages arrived during the loop tail without tripping
      // the queue listener (or arrived just after this finally started), drain
      // them in a fresh auto-invocation.
      if (hasPendingBackgroundUpdates(sessionId) && !runningRef.current) {
        setTimeout(() => {
          if (!runningRef.current && hasPendingBackgroundUpdates(sessionId)) {
            void start(undefined)
          }
        }, 50)
      }
    }
  }

  // Keep the ref pointed at the latest closure so the auto-react effect always
  // starts with the current activeDeps.
  startRef.current = start

  return {
    abort: () => abortRef.current?.abort(),
    clearQueue: () => replaceQueue([]),
    enqueue,
    interruptForQueued,
    queuedMessages,
    running,
    runningRef,
    start,
    startNextQueued,
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
}
