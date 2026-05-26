import {
  BUILTIN_MODELS,
  buildProvider,
  defaultReasoningEffortForModel,
  discoverSkills,
  type Event,
  findModel,
  type HarnessDeps,
  hasPendingBackgroundUpdates,
  type ModelSpec,
  modelSupportsReasoning,
  qualifiedModelId,
  type ReasoningEffort,
  type RuntimeSettings,
  type Skill,
  subscribeToBackgroundUpdates,
  updateUserSettings,
} from "@leharness/harness"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActiveTasks } from "./components/active-tasks.js"
import { Footer, Prompt } from "./components/prompt.js"
import { QueuedMessages } from "./components/queued-messages.js"
import { type MenuItem, SlashMenu } from "./components/slash-menu.js"
import { Transcript } from "./components/transcript.js"
import { isSlashCommand, SLASH_COMMANDS } from "./slash/commands.js"
import {
  expandSkillTokens,
  findSlashToken,
  replaceSlashToken,
  searchSlashItems,
} from "./slash/search.js"
import type { SlashItem, SlashToken } from "./slash/types.js"
import { appendCell, initialTranscript, reduceEvent, reduceText } from "./state/transcript.js"
import type { QueuedMessage, TranscriptState } from "./state/types.js"

type PickerKind = "effort" | "model"

interface PickerState {
  kind: PickerKind
  selectedIndex: number
}

type PickerItem =
  | (MenuItem & { kind: "model"; model: ModelSpec })
  | (MenuItem & { effort: ReasoningEffort; kind: "effort" })

export function TuiApp({
  deps,
  priorEvents,
  runPrompt,
  sessionId,
}: {
  deps: HarnessDeps
  priorEvents: Event[]
  runPrompt: (
    text: string | undefined,
    deps: HarnessDeps,
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
  const [picker, setPicker] = useState<PickerState | undefined>()
  const [helpVisible, setHelpVisible] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState("idle")
  const [selectedProvider, setSelectedProvider] = useState(deps.provider)
  const [selectedModel, setSelectedModel] = useState(deps.model)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | undefined>(
    () => deps.reasoningEffort ?? defaultReasoningEffortForModel(deps.model, deps.provider.name),
  )
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
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
  const allModels = useMemo(
    () => allModelChoices(selectedProvider.name, selectedModel),
    [selectedProvider.name, selectedModel],
  )
  const currentModelSupportsReasoning = modelSupportsReasoning(selectedModel, selectedProvider.name)
  const activeDeps = useMemo<HarnessDeps>(
    () => ({
      ...deps,
      provider: selectedProvider,
      model: selectedModel,
      reasoningEffort: currentModelSupportsReasoning ? reasoningEffort : undefined,
      systemPrompt: deps.systemPrompt,
    }),
    [currentModelSupportsReasoning, deps, reasoningEffort, selectedModel, selectedProvider],
  )
  const activeSlashCommands = useMemo(
    () =>
      SLASH_COMMANDS.filter(
        (command) => command.name !== "effort" || currentModelSupportsReasoning,
      ),
    [currentModelSupportsReasoning],
  )
  const slashNames = useMemo(
    () =>
      new Set([
        ...activeSlashCommands.map((command) => command.name),
        ...skills.map((skill) => skill.name),
      ]),
    [activeSlashCommands, skills],
  )
  const pickerItems = useMemo(
    () =>
      picker === undefined
        ? []
        : searchPickerItems({
            currentEffort: reasoningEffort,
            currentModel: selectedModel,
            currentProvider: selectedProvider.name,
            kind: picker.kind,
            models: allModels,
            query: input,
          }),
    [allModels, input, picker, reasoningEffort, selectedModel, selectedProvider.name],
  )
  const pickerActive = picker !== undefined

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

  const autoInvocationScheduledRef = useRef(false)
  const startInvocationRef = useRef<(text: string | undefined) => Promise<void>>(async () => {})

  useEffect(() => {
    if (deps.tasks === false) return
    const scheduleAutoInvocation = () => {
      if (autoInvocationScheduledRef.current) return
      autoInvocationScheduledRef.current = true
      setTimeout(() => {
        autoInvocationScheduledRef.current = false
        if (runningRef.current) return
        if (!hasPendingBackgroundUpdates(sessionId)) return
        void startInvocationRef.current(undefined)
      }, 50)
    }
    return subscribeToBackgroundUpdates(sessionId, scheduleAutoInvocation)
  }, [deps.tasks, sessionId])

  const refreshSkills = useCallback(() => {
    if (deps.skills === false) {
      setSkills([])
      return () => {}
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

  useEffect(() => refreshSkills(), [refreshSkills])

  const slashToken = useMemo(
    () => (pickerActive ? undefined : findSlashToken(input)),
    [input, pickerActive],
  )
  const slashOpen = slashToken !== undefined

  useEffect(() => {
    if (!slashOpen) return
    return refreshSkills()
  }, [refreshSkills, slashOpen])

  const slashItems = useMemo(() => {
    if (slashToken === undefined || slashDismissedInput === input) return []
    return searchSlashItems(activeSlashCommands, skills, slashToken.query)
  }, [activeSlashCommands, input, skills, slashDismissedInput, slashToken])
  const slashActive = slashToken !== undefined && slashItems.length > 0

  useEffect(() => {
    setSlashSelectedIndex((current) => Math.min(current, Math.max(0, slashItems.length - 1)))
  }, [slashItems.length])

  useEffect(() => {
    setPicker((current) =>
      current === undefined
        ? undefined
        : {
            ...current,
            selectedIndex: Math.min(current.selectedIndex, Math.max(0, pickerItems.length - 1)),
          },
    )
  }, [pickerItems.length])

  const acceptSlashSelection = () => {
    if (slashToken === undefined || slashItems.length === 0) return false
    const item = slashItems[slashSelectedIndex] ?? slashItems[0]
    if (item === undefined) return false
    const nextInput = replaceSlashToken(input, slashToken, item)
    setInput(nextInput)
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

  function closePicker(): void {
    setPicker(undefined)
    setInput("")
    setInputVersion((version) => version + 1)
    setStatus("idle")
  }

  function openPicker(kind: PickerKind, query: string): void {
    if (kind === "effort" && !currentModelSupportsReasoning) {
      setTranscript((prev) =>
        appendCell(prev, {
          kind: "error",
          title: "effort",
          text: `${qualifiedRuntime(selectedProvider.name, selectedModel)} does not expose controllable reasoning effort.`,
        }),
      )
      clearComposer()
      return
    }

    setPicker({ kind, selectedIndex: 0 })
    setInput(query)
    setInputVersion((version) => version + 1)
    setSlashDismissedInput(undefined)
    setSlashSelectedIndex(0)
    setHistoryIndex(undefined)
    setHelpVisible(false)
    setStatus(`select ${kind}`)
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
    if (
      invocationText === text &&
      text.startsWith("/") &&
      !isSlashCommand(text, activeSlashCommands)
    ) {
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

  async function startInvocation(text: string | undefined): Promise<void> {
    if (runningRef.current) return
    const invocationText = text === undefined ? undefined : prepareInvocationText(text)
    if (text !== undefined && invocationText === undefined) {
      void startNextQueuedMessage()
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
      refreshSkills()
      if (shouldDrain) void startNextQueuedMessage()
      // If background messages arrived during the loop tail without
      // tripping the queue listener (or arrived just after this finally
      // started), drain them in a fresh auto-invocation.
      if (deps.tasks !== false && hasPendingBackgroundUpdates(sessionId) && !runningRef.current) {
        setTimeout(() => {
          if (!runningRef.current && hasPendingBackgroundUpdates(sessionId)) {
            void startInvocation(undefined)
          }
        }, 50)
      }
    }
  }

  startInvocationRef.current = startInvocation

  useInput(
    (rawInput, key) => {
      if (key.ctrl && rawInput === "c") {
        abortRef.current?.abort()
        exit()
        return
      }
      if (picker !== undefined) {
        if (key.escape || rawInput === "\u001b") {
          closePicker()
          return
        }
        if (rawInput === "\t" || key.tab) {
          selectPickerItem()
          return
        }
        if (key.upArrow) {
          setPicker((current) =>
            current === undefined
              ? undefined
              : { ...current, selectedIndex: Math.max(0, current.selectedIndex - 1) },
          )
          return
        }
        if (key.downArrow) {
          setPicker((current) =>
            current === undefined
              ? undefined
              : {
                  ...current,
                  selectedIndex: Math.max(
                    0,
                    Math.min(pickerItems.length - 1, current.selectedIndex + 1),
                  ),
                },
          )
          return
        }
        if (key.ctrl && rawInput === "u") {
          setInput("")
          setInputVersion((version) => version + 1)
          setPicker((current) =>
            current === undefined ? undefined : { ...current, selectedIndex: 0 },
          )
          return
        }
        return
      }
      if (helpVisible && (key.escape || rawInput === "\u001b")) {
        setHelpVisible(false)
        return
      }
      if ((key.return || rawInput === "\r" || rawInput === "\n") && input.trim().length === 0) {
        if (interruptForQueuedMessage()) return
      }
      if (runningRef.current && (key.escape || rawInput === "\u001b")) {
        abortRef.current?.abort()
        setStatus("cancelling")
        replaceQueuedMessages([])
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

  const switchModel = (model: ModelSpec) => {
    let nextProvider = selectedProvider
    if (model.provider !== selectedProvider.name) {
      try {
        nextProvider = buildProvider(model.provider)
      } catch (err) {
        setTranscript((prev) =>
          appendCell(prev, {
            kind: "error",
            title: "models",
            text: err instanceof Error ? err.message : String(err),
          }),
        )
        return
      }
    }

    setSelectedProvider(nextProvider)
    setSelectedModel(model.id)
    const nextEffort = defaultReasoningEffortForModel(model.id, model.provider)
    setReasoningEffort(nextEffort)
    persistRuntimeSettings({
      model: model.id,
      provider: model.provider,
      reasoningEffort: model.supportsReasoning ? nextEffort : undefined,
    })
    setStatus("idle")
    setTranscript((prev) =>
      appendCell(prev, {
        kind: "system",
        title: "model",
        text: `Switched to ${qualifiedModelId(model)}${model.supportsReasoning ? ` (effort ${nextEffort ?? "high"})` : ""}.`,
      }),
    )
  }

  const setEffort = (effort: ReasoningEffort) => {
    setReasoningEffort(effort)
    persistRuntimeSettings({
      model: selectedModel,
      provider: selectedProvider.name,
      reasoningEffort: effort,
    })
    setTranscript((prev) =>
      appendCell(prev, {
        kind: "system",
        title: "effort",
        text: `Set ${qualifiedRuntime(selectedProvider.name, selectedModel)} effort to ${effort}.`,
      }),
    )
  }

  function persistRuntimeSettings(runtime: RuntimeSettings): void {
    void updateUserSettings({ runtime }).catch((err: unknown) => {
      setTranscript((prev) =>
        appendCell(prev, {
          kind: "error",
          title: "settings",
          text: err instanceof Error ? err.message : String(err),
        }),
      )
    })
  }

  const selectPickerItem = () => {
    if (picker === undefined) return
    const item = pickerItems[picker.selectedIndex] ?? pickerItems[0]
    if (item === undefined) {
      setTranscript((prev) =>
        appendCell(prev, {
          kind: "error",
          title: picker.kind,
          text: `No ${picker.kind} matches ${JSON.stringify(input)}.`,
        }),
      )
      closePicker()
      return
    }

    if (item.kind === "model") switchModel(item.model)
    else setEffort(item.effort)
    closePicker()
  }

  const submit = async (value: string) => {
    if (picker !== undefined) {
      selectPickerItem()
      return
    }
    const submittedSlash = slashSelectionFor(value)
    if (submittedSlash !== undefined) {
      const { exact, item, token } = submittedSlash
      if (item.kind === "skill" && !exact) {
        const selected = replaceSlashToken(value, token, item)
        setInput(selected)
        setInputVersion((version) => version + 1)
        setSlashDismissedInput(undefined)
        setHistoryIndex(undefined)
        return
      }
      if (item.kind === "command" && !exact) {
        const selected = replaceSlashToken(value, token, item)
        setSlashDismissedInput(undefined)
        setHistoryIndex(undefined)
        setInput(selected)
        setInputVersion((version) => version + 1)
        await submit(selected)
        return
      }
    }

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
      setHelpVisible(false)
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
    const modelArgs = parseCommandArgs(text, "model")
    if (modelArgs !== undefined) {
      openPicker("model", modelArgs.join(" "))
      return
    }
    const effortArgs = parseCommandArgs(text, "effort")
    if (effortArgs !== undefined) {
      openPicker("effort", effortArgs.join(" "))
      return
    }
    if (text === "/help") {
      setHelpVisible(true)
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

  function slashSelectionFor(value: string):
    | {
        exact: boolean
        item: SlashItem
        token: SlashToken
      }
    | undefined {
    const token = pickerActive ? undefined : findSlashToken(value)
    if (token === undefined || slashDismissedInput === value) return undefined
    const items = searchSlashItems(activeSlashCommands, skills, token.query)
    if (items.length === 0) return undefined
    const item = items[Math.min(slashSelectedIndex, items.length - 1)] ?? items[0]
    if (item === undefined) return undefined
    return { exact: token.token === `/${item.name}`, item, token }
  }

  const changeInput = (value: string) => {
    if (clearInputRef.current) {
      clearInputRef.current = false
      setInput("")
      return
    }
    if (value.length > 0) setHelpVisible(false)
    setInput(value)
    if (picker !== undefined) {
      setPicker((current) => (current === undefined ? undefined : { ...current, selectedIndex: 0 }))
    }
    setSlashDismissedInput(undefined)
    setSlashSelectedIndex(0)
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Transcript
        deps={activeDeps}
        priorEventCount={priorEvents.length}
        running={running}
        sessionId={sessionId}
        transcript={transcript}
        width={columns}
      />
      <QueuedMessages messages={queuedMessages} width={columns} />
      <ActiveTasks tasks={transcript.activeTasks} width={columns} />
      <Prompt
        input={input}
        inputVersion={inputVersion}
        placeholder={pickerPlaceholder(picker)}
        running={running}
        setInput={changeInput}
        slashNames={slashNames}
        submit={submit}
      />
      {helpVisible ? <HelpPanel width={columns} /> : null}
      {helpVisible ? null : picker === undefined ? (
        <SlashMenu items={slashItems} selectedIndex={slashSelectedIndex} width={columns} />
      ) : (
        <SlashMenu
          items={pickerItems}
          prefix=""
          selectedIndex={picker.selectedIndex}
          width={columns}
        />
      )}
      {slashActive || pickerActive || helpVisible ? null : (
        <Footer
          compactionInProgress={transcript.compactionInProgress}
          contextUsage={transcript.contextUsage}
          queuedCount={queuedMessages.length}
          running={running}
          status={status}
        />
      )}
    </Box>
  )
}

function HelpPanel({ width }: { width: number }) {
  const panelWidth = Math.max(44, width - 2)
  return (
    <Box
      borderColor="gray"
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
      width={panelWidth}
    >
      <Box justifyContent="space-between">
        <Text bold>help</Text>
        <Text color="gray">esc close</Text>
      </Box>
      <Text color="gray">enter sends when idle; while running, enter queues next message</Text>
      <Text color="gray">empty enter sends queued message and interrupts the current run</Text>
      <Text color="gray">slash search includes commands and discovered skills as you type</Text>
      <Text> </Text>
      <HelpRow command="/model" description="switch model" />
      <HelpRow command="/effort" description="switch reasoning effort when supported" />
      <HelpRow command="/session" description="print current session id" />
      <HelpRow command="/clear" description="clear visible transcript" />
      <HelpRow command="/exit" description="quit the TUI" />
      <HelpRow command="/quit" description="quit alias" />
    </Box>
  )
}

function HelpRow({ command, description }: { command: string; description: string }) {
  return (
    <Box>
      <Box width={12}>
        <Text color="cyan">{command}</Text>
      </Box>
      <Text color="gray">{description}</Text>
    </Box>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
}

function allModelChoices(currentProviderName: string, currentModel: string): ModelSpec[] {
  if (findModel(currentModel, currentProviderName) !== undefined) return BUILTIN_MODELS
  return [
    {
      id: currentModel,
      provider: currentProviderName,
      label: currentModel,
      description: "Current model from CLI/env.",
      supportsReasoning: false,
    },
    ...BUILTIN_MODELS,
  ]
}

function qualifiedRuntime(providerName: string, modelId: string): string {
  return `${providerName}/${modelId}`
}

function parseCommandArgs(text: string, command: string): string[] | undefined {
  if (text === `/${command}`) return []
  if (!text.startsWith(`/${command} `)) return undefined
  return text
    .slice(command.length + 2)
    .trim()
    .split(/\s+/g)
    .filter((part) => part.length > 0)
}

function searchPickerItems({
  currentEffort,
  currentModel,
  currentProvider,
  kind,
  models,
  query,
}: {
  currentEffort: ReasoningEffort | undefined
  currentModel: string
  currentProvider: string
  kind: PickerKind
  models: ModelSpec[]
  query: string
}): PickerItem[] {
  const items = kind === "model" ? modelPickerItems(models) : effortPickerItems()
  return items
    .map((item, index) => ({
      index,
      item: withCurrentDescription(item, {
        currentEffort,
        currentModel,
        currentProvider,
      }),
      score: scorePickerItem(item, query),
    }))
    .filter((entry) => query.trim().length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 7)
    .map((entry) => entry.item)
}

function modelPickerItems(models: ModelSpec[]): PickerItem[] {
  return models.map((model) => ({
    description: model.description,
    kind: "model",
    model,
    name: qualifiedModelId(model),
  }))
}

function effortPickerItems(): PickerItem[] {
  return [
    {
      description: "Disable provider-controlled thinking for future turns.",
      effort: "off",
      kind: "effort",
      name: "off",
    },
    {
      description: "Use the provider's stronger default thinking path.",
      effort: "high",
      kind: "effort",
      name: "high",
    },
    {
      description: "Use maximum provider-controlled thinking for harder tasks.",
      effort: "max",
      kind: "effort",
      name: "max",
    },
  ]
}

function withCurrentDescription(
  item: PickerItem,
  current: {
    currentEffort: ReasoningEffort | undefined
    currentModel: string
    currentProvider: string
  },
): PickerItem {
  if (
    item.kind === "model" &&
    item.model.id === current.currentModel &&
    item.model.provider === current.currentProvider
  ) {
    return { ...item, description: `Current. ${item.description}` }
  }
  if (item.kind === "effort" && item.effort === (current.currentEffort ?? "high")) {
    return { ...item, description: `Current. ${item.description}` }
  }
  return item
}

function scorePickerItem(item: PickerItem, query: string): number {
  const normalizedQuery = normalize(query)
  if (normalizedQuery.length === 0) {
    if (item.kind === "effort") return 120
    return item.kind === "model" ? 100 : 90
  }

  const haystack =
    item.kind === "model"
      ? normalize(
          [
            item.name,
            item.model.id,
            item.model.provider,
            item.model.label,
            item.model.description,
          ].join(" "),
        )
      : normalize(`${item.name} ${item.description}`)
  let score = 0
  if (normalize(item.name) === normalizedQuery) score += 1000
  if (normalize(item.name).startsWith(normalizedQuery)) score += 700
  if (haystack.includes(normalizedQuery)) score += 400
  for (const token of normalizedQuery.split(/\s+/g)) {
    if (token.length > 0 && haystack.includes(token)) score += 120
  }
  return score
}

function pickerPlaceholder(picker: PickerState | undefined): string | undefined {
  if (picker?.kind === "model") return "Search models..."
  if (picker?.kind === "effort") return "Search effort..."
  return undefined
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/^\/+/, "").trim()
}
