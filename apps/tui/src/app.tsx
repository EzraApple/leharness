import { discoverSkills, type Event, type HarnessDeps, type Skill } from "@leharness/harness"
import { Box, useApp, useInput, useStdout } from "ink"
import { useEffect, useMemo, useRef, useState } from "react"
import { Footer, Prompt } from "./components/prompt.js"
import { QueuedMessages } from "./components/queued-messages.js"
import { SlashMenu } from "./components/slash-menu.js"
import { Transcript } from "./components/transcript.js"
import { isSlashCommand } from "./slash/commands.js"
import {
  expandSkillTokens,
  findSlashToken,
  replaceSlashToken,
  searchSlashItems,
} from "./slash/search.js"
import { appendCell, initialTranscript, reduceEvent, reduceText } from "./state/transcript.js"
import type { QueuedMessage, TranscriptState } from "./state/types.js"

export function TuiApp({
  deps,
  priorEvents,
  runPrompt,
  sessionId,
}: {
  deps: HarnessDeps
  priorEvents: Event[]
  runPrompt: (
    text: string,
    options: {
      onEvent: (event: Event) => void
      onText: (delta: string) => void
      signal: AbortSignal
    },
  ) => Promise<void>
  sessionId: string
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [columns, setColumns] = useState(() => stdout.columns ?? 80)
  const [input, setInput] = useState("")
  const [inputVersion, setInputVersion] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>()
  const [skills, setSkills] = useState<Skill[]>([])
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashDismissedInput, setSlashDismissedInput] = useState<string | undefined>()
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState("idle")
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [transcriptResetKey, setTranscriptResetKey] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptState>(() => {
    let state = initialTranscript()
    for (const event of priorEvents) state = reduceEvent(state, event)
    return state
  })
  const abortRef = useRef<AbortController | undefined>(undefined)
  const clearInputRef = useRef(false)
  const forceDrainAfterAbortRef = useRef(false)
  const queuedMessagesRef = useRef<QueuedMessage[]>([])
  const queuedMessageIdRef = useRef(0)
  const runningRef = useRef(false)
  const invocationIdRef = useRef(0)

  useEffect(() => {
    const resize = () => {
      setColumns(stdout.columns ?? 80)
    }
    stdout.on("resize", resize)
    return () => {
      stdout.off("resize", resize)
    }
  }, [stdout])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (deps.skills === false) {
      setSkills([])
      return
    }

    let cancelled = false
    void discoverSkills(deps.skills?.root)
      .then((discovered) => {
        if (!cancelled) setSkills(discovered)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })

    return () => {
      cancelled = true
    }
  }, [deps.skills])

  const slashToken = useMemo(() => findSlashToken(input), [input])
  const slashItems = useMemo(() => {
    if (slashToken === undefined || slashDismissedInput === input) return []
    return searchSlashItems(skills, slashToken.query)
  }, [input, skills, slashDismissedInput, slashToken])
  const slashActive = slashToken !== undefined && slashItems.length > 0

  useEffect(() => {
    setSlashSelectedIndex((current) => Math.min(current, Math.max(0, slashItems.length - 1)))
  }, [slashItems.length])

  const acceptSlashSelection = () => {
    if (slashToken === undefined || slashItems.length === 0) return false
    const item = slashItems[slashSelectedIndex] ?? slashItems[0]
    if (item === undefined) return false
    setInput(replaceSlashToken(input, slashToken, item))
    setInputVersion((version) => version + 1)
    setSlashDismissedInput(undefined)
    setHistoryIndex(undefined)
    return true
  }

  function replaceQueuedMessages(messages: QueuedMessage[]): void {
    queuedMessagesRef.current = messages
    setQueuedMessages(messages)
  }

  function enqueueMessage(text: string): void {
    const id = `queued-${queuedMessageIdRef.current}`
    queuedMessageIdRef.current += 1
    replaceQueuedMessages([...queuedMessagesRef.current, { id, text }])
  }

  function shiftQueuedMessage(): QueuedMessage | undefined {
    const [next, ...remaining] = queuedMessagesRef.current
    replaceQueuedMessages(remaining)
    return next
  }

  function clearComposer(): void {
    setInput("")
    setSlashDismissedInput(undefined)
    setHistoryIndex(undefined)
  }

  function rememberSubmittedMessage(text: string): void {
    setHistory((prev) => [...prev, text])
    setHistoryIndex(undefined)
  }

  function interruptForQueuedMessage(): boolean {
    if (!runningRef.current || queuedMessagesRef.current.length === 0) return false
    forceDrainAfterAbortRef.current = true
    abortRef.current?.abort()
    setStatus("interrupting")
    return true
  }

  function prepareInvocationText(text: string): string | undefined {
    const invocationText = expandSkillTokens(text, skills)
    if (invocationText === text && text.startsWith("/") && !isSlashCommand(text)) {
      setTranscript((prev) =>
        appendCell(prev, { kind: "error", title: "command", text: `Unknown command: ${text}` }),
      )
      return undefined
    }
    return invocationText
  }

  function startNextQueuedMessage(): boolean {
    if (runningRef.current) return false
    const next = shiftQueuedMessage()
    if (next === undefined) return false
    void startInvocation(next.text)
    return true
  }

  async function startInvocation(text: string): Promise<void> {
    if (runningRef.current) return
    const invocationText = prepareInvocationText(text)
    if (invocationText === undefined) {
      void startNextQueuedMessage()
      return
    }

    runningRef.current = true
    setRunning(true)
    setStatus("running")
    const controller = new AbortController()
    const invocationId = invocationIdRef.current + 1
    invocationIdRef.current = invocationId
    abortRef.current = controller
    try {
      await runPrompt(invocationText, {
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
          setTranscript((prev) => reduceEvent(prev, event))
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
      if (shouldDrain) void startNextQueuedMessage()
    }
  }

  useInput(
    (rawInput, key) => {
      if (key.ctrl && rawInput === "c") {
        abortRef.current?.abort()
        exit()
        return
      }
      if ((key.return || rawInput === "\r" || rawInput === "\n") && input.trim().length === 0) {
        if (interruptForQueuedMessage()) return
      }
      if (runningRef.current && (key.escape || rawInput === "\u001b")) {
        abortRef.current?.abort()
        setStatus("cancelling")
        return
      }
      if (key.escape && slashToken !== undefined) {
        setSlashDismissedInput(input)
        return
      }
      if (slashActive && (rawInput === "\t" || key.tab)) {
        acceptSlashSelection()
        return
      }
      if (slashActive && key.upArrow) {
        setSlashSelectedIndex((current) => Math.max(0, current - 1))
        return
      }
      if (slashActive && key.downArrow) {
        setSlashSelectedIndex((current) => Math.min(slashItems.length - 1, current + 1))
        return
      }
      if (key.ctrl && rawInput === "u") {
        clearInputRef.current = true
        setInput("")
        setSlashDismissedInput(undefined)
        setSlashSelectedIndex(0)
        setHistoryIndex(undefined)
        return
      }
      if (key.upArrow) {
        if (history.length === 0) return
        const next = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(next)
        setInput(history[next] ?? "")
        setInputVersion((version) => version + 1)
        return
      }
      if (key.downArrow) {
        if (historyIndex === undefined) return
        const next = historyIndex + 1
        if (next >= history.length) {
          setHistoryIndex(undefined)
          setInput("")
          setInputVersion((version) => version + 1)
          return
        }
        setHistoryIndex(next)
        setInput(history[next] ?? "")
        setInputVersion((version) => version + 1)
      }
    },
    { isActive: true },
  )

  const submit = async (value: string) => {
    if (slashActive && acceptSlashSelection()) return

    const text = value.trim()
    if (text.length === 0) {
      if (interruptForQueuedMessage()) return
      startNextQueuedMessage()
      return
    }

    if (text === "/exit" || text === "/quit") {
      exit()
      return
    }
    if (text === "/clear") {
      setTranscript(initialTranscript())
      setTranscriptResetKey((key) => key + 1)
      clearComposer()
      return
    }
    if (text === "/session") {
      setTranscript((prev) =>
        appendCell(prev, { kind: "system", title: "session", text: sessionId }),
      )
      clearComposer()
      return
    }
    if (text === "/help") {
      setTranscript((prev) =>
        appendCell(prev, {
          kind: "system",
          title: "help",
          text: [
            "Enter sends when idle and queues while running.",
            "With queued messages and an empty input, Enter interrupts the current run and sends the queue.",
            "Esc aborts the current run. Ctrl-C exits.",
            "Use your terminal scrollback to review previous transcript output.",
            "/session prints the current session id. /clear starts a fresh transcript. /exit quits.",
          ].join("\n"),
        }),
      )
      clearComposer()
      return
    }
    if (prepareInvocationText(text) === undefined) {
      clearComposer()
      return
    }

    rememberSubmittedMessage(text)
    clearComposer()
    if (runningRef.current) {
      enqueueMessage(text)
      setStatus(`queued ${queuedMessagesRef.current.length}`)
      return
    }
    void startInvocation(text)
  }

  const changeInput = (value: string) => {
    if (clearInputRef.current) {
      clearInputRef.current = false
      setInput("")
      return
    }
    setInput(value)
    setSlashDismissedInput(undefined)
    setSlashSelectedIndex(0)
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Transcript
        deps={deps}
        priorEventCount={priorEvents.length}
        resetKey={transcriptResetKey}
        running={running}
        sessionId={sessionId}
        transcript={transcript}
        width={columns}
      />
      <QueuedMessages messages={queuedMessages} width={columns} />
      <Prompt
        input={input}
        inputVersion={inputVersion}
        running={running}
        setInput={changeInput}
        submit={submit}
      />
      <SlashMenu items={slashItems} selectedIndex={slashSelectedIndex} width={columns} />
      {slashActive ? null : (
        <Footer queuedCount={queuedMessages.length} running={running} status={status} />
      )}
    </Box>
  )
}
