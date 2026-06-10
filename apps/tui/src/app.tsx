import {
  buildProvider,
  defaultReasoningEffortForModel,
  discoverSkills,
  type Event,
  type HarnessDeps,
  type ModelSpec,
  modelSupportsReasoning,
  qualifiedModelId,
  type ReasoningEffort,
  type RuntimeSettings,
  type Skill,
  type Tool,
  updateUserSettings,
} from "@leharness/harness"
import type { McpServerDetail } from "@leharness/mcp"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import { useCallback, useEffect, useMemo, useState } from "react"
import { commandMenuItems, findCommand, helpEntries } from "./commands/registry.js"
import type { CommandContext, McpCommandControls } from "./commands/types.js"
import { ActiveTasks } from "./components/active-tasks.js"
import { Footer, Prompt } from "./components/prompt.js"
import { QueuedMessages } from "./components/queued-messages.js"
import { SlashMenu } from "./components/slash-menu.js"
import { Transcript } from "./components/transcript.js"
import { type Invocation, type RunPrompt, useInvocation } from "./hooks/useInvocation.js"
import type { McpControls } from "./mcp/types.js"
import {
  allModelChoices,
  type PickerItem,
  type PickerKind,
  type PickerState,
  pickerPlaceholder,
  searchPickerItems,
} from "./picker/search.js"
import {
  expandSkillTokens,
  findSlashToken,
  replaceSlashToken,
  searchSlashItems,
} from "./slash/search.js"
import type { SlashItem, SlashToken } from "./slash/types.js"
import {
  appendCell,
  initialTranscript,
  reduceEvent,
  setLatestToolDetailExpanded,
} from "./state/transcript.js"
import type { TranscriptState } from "./state/types.js"
import { color } from "./theme.js"

export function TuiApp({
  deps,
  mcp,
  priorEvents,
  runPrompt,
  sessionId,
}: {
  deps: HarnessDeps
  mcp?: McpControls
  priorEvents: Event[]
  runPrompt: RunPrompt
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
  const [status, setStatus] = useState("idle")
  const [selectedProvider, setSelectedProvider] = useState(deps.provider)
  const [selectedModel, setSelectedModel] = useState(deps.model)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | undefined>(
    () => deps.reasoningEffort ?? defaultReasoningEffortForModel(deps.model, deps.provider.name),
  )
  const [mcpServers, setMcpServers] = useState<Map<string, McpServerDetail>>(
    () => mcp?.manager?.details() ?? new Map(),
  )
  const [mcpTools, setMcpTools] = useState<Tool[]>(() => mcp?.initialTools ?? [])
  const [transcript, setTranscript] = useState<TranscriptState>(() => {
    let state = initialTranscript()
    for (const event of priorEvents) state = reduceEvent(state, event)
    return state
  })
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
      // deps.tools is builtins-only for the TUI; fold in the live MCP
      // tools so reconnect/auth changes take effect on the next prompt.
      tools: [...deps.tools, ...mcpTools],
    }),
    [
      currentModelSupportsReasoning,
      deps,
      mcpTools,
      reasoningEffort,
      selectedModel,
      selectedProvider,
    ],
  )
  const menuCommands = useMemo(
    () => commandMenuItems({ supportsReasoning: currentModelSupportsReasoning }),
    [currentModelSupportsReasoning],
  )
  const slashNames = useMemo(
    () =>
      new Set([
        ...menuCommands.map((command) => command.name),
        ...skills.map((skill) => skill.name),
      ]),
    [menuCommands, skills],
  )
  const pickerItems = useMemo<PickerItem[]>(
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

  // Track MCP server status + keep the tool set current. A server going
  // ready/exited changes which tools are available, so re-adapt on any
  // transition; the next invocation's activeDeps picks them up.
  useEffect(() => {
    if (mcp === undefined) return
    const manager = mcp.manager
    const sync = () => {
      setMcpServers(manager.details())
      setMcpTools(mcp.refreshTools())
    }
    const unsubscribe = manager.onStatusChange(sync)
    sync()
    return unsubscribe
  }, [mcp])

  const refreshSkills = useCallback(() => {
    let cancelled = false
    void discoverSkills()
      .then((discovered) => {
        if (!cancelled) setSkills(discovered)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })

    return () => {
      cancelled = true
    }
  }, [])

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
    return searchSlashItems(menuCommands, skills, slashToken.query)
  }, [input, menuCommands, skills, slashDismissedInput, slashToken])
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

  function clearComposer() {
    setInput("")
    setInputVersion((version) => version + 1)
    setSlashDismissedInput(undefined)
    setHistoryIndex(undefined)
  }

  function closePicker() {
    setPicker(undefined)
    setInput("")
    setInputVersion((version) => version + 1)
    setStatus("idle")
  }

  function openPicker(kind: PickerKind, query: string) {
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

  function rememberSubmittedMessage(text: string) {
    setHistory((prev) => [...prev, text])
    setHistoryIndex(undefined)
  }

  // Expand any `/skill` tokens into load hints. A `/word` that's neither a
  // known command (those dispatch before we get here) nor a skill is just sent
  // as-is — the agent treats it as ordinary text rather than an error.
  function prepareInvocationText(text: string): string {
    return expandSkillTokens(text, skills)
  }

  const invocation: Invocation = useInvocation({
    activeDeps,
    onSettled: refreshSkills,
    prepareText: prepareInvocationText,
    runPrompt,
    sessionId,
    setStatus,
    setTranscript,
  })

  useInput(
    (rawInput, key) => {
      if (key.ctrl && rawInput === "c") {
        invocation.abort()
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
        if (invocation.interruptForQueued()) return
      }
      if (invocation.runningRef.current && (key.escape || rawInput === "\u001b")) {
        invocation.abort()
        setStatus("cancelling")
        invocation.clearQueue()
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
        clearComposer()
        setSlashSelectedIndex(0)
        return
      }
      // Toggle the most recent tool's detail: collapse one if open, otherwise
      // expand the latest expandable one. The reducer reads the open/closed
      // state straight from the cells, so this needs no extra React state.
      if (key.ctrl && rawInput === "r") {
        setTranscript((prev) => {
          const collapsed = setLatestToolDetailExpanded(prev, false)
          return collapsed.changed ? collapsed.state : setLatestToolDetailExpanded(prev, true).state
        })
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

  function persistRuntimeSettings(runtime: RuntimeSettings) {
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

  const appendSystemCell = (title: string, text: string) => {
    setTranscript((prev) => appendCell(prev, { kind: "system", title, text }))
  }

  // The MCP user-ops the /mcp command runs against — a slice of the injected
  // manager plus a "push the change back into React" callback. The agent-led
  // config edits (.leharness/mcp.json) are handled elsewhere; this is the
  // user-led surface only.
  const mcpCommandControls = useMemo<McpCommandControls | undefined>(() => {
    if (mcp === undefined) return undefined
    const manager = mcp.manager
    return {
      authorizeServer: (server) => manager.authorizeServer(server),
      details: () => manager.details(),
      logout: (server) => manager.logout(server),
      reconnect: (server) => manager.reconnect(server),
      reload: () => mcp.reload(),
      syncAfterChange: () => {
        setMcpServers(manager.details())
        setMcpTools(mcp.refreshTools())
      },
    }
  }, [mcp])

  // The capability surface a command runs against. Built fresh per submit so
  // it always closes over the current render's state setters.
  const buildCommandContext = (): CommandContext => ({
    clearTranscript: () => {
      setTranscript(initialTranscript())
      setHelpVisible(false)
      clearComposer()
    },
    exit,
    mcp: mcpCommandControls,
    note: appendSystemCell,
    noteError: (title, text) =>
      setTranscript((prev) => appendCell(prev, { kind: "error", title, text })),
    openPicker,
    sessionId,
    showHelp: () => setHelpVisible(true),
  })

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
      if (invocation.interruptForQueued()) return
      invocation.startNextQueued()
      return
    }

    // Slash commands all dispatch through the registry: clear the composer,
    // then hand the command its raw args. (Model/effort open a picker, which
    // re-seeds the input, so clearing first is harmless.)
    const command = findCommand(text)
    if (command !== undefined) {
      clearComposer()
      await command.command.run(buildCommandContext(), command.args)
      return
    }

    rememberSubmittedMessage(text)
    clearComposer()
    if (invocation.runningRef.current) {
      invocation.enqueue(text)
      return
    }
    void invocation.start(text)
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
    const items = searchSlashItems(menuCommands, skills, token.query)
    if (items.length === 0) return undefined
    const item = items[Math.min(slashSelectedIndex, items.length - 1)] ?? items[0]
    if (item === undefined) return undefined
    return { exact: token.token === `/${item.name}`, item, token }
  }

  const changeInput = (value: string) => {
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
        mcpServers={mcpServers}
        priorEventCount={priorEvents.length}
        running={invocation.running}
        sessionId={sessionId}
        transcript={transcript}
        width={columns}
      />
      <QueuedMessages messages={invocation.queuedMessages} width={columns} />
      <ActiveTasks tasks={transcript.activeTasks} width={columns} />
      <Prompt
        input={input}
        inputVersion={inputVersion}
        placeholder={pickerPlaceholder(picker)}
        running={invocation.running}
        setInput={changeInput}
        slashNames={slashNames}
        submit={(value) => {
          void submit(value)
        }}
      />
      {helpVisible ? (
        <HelpPanel supportsReasoning={currentModelSupportsReasoning} width={columns} />
      ) : null}
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
          queuedCount={invocation.queuedMessages.length}
          running={invocation.running}
          status={status}
        />
      )}
    </Box>
  )
}

// The command rows derive from the registry (helpEntries) so they can't drift
// from what actually dispatches; the shortcut rows below document the keymap.
const HELP_SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "enter", description: "send when idle · queue while running" },
  { keys: "empty enter", description: "send the next queued message, interrupting the run" },
  { keys: "option+enter", description: "insert a newline (shift+enter where supported; or paste)" },
  { keys: "ctrl-r", description: "expand / collapse the latest tool detail" },
  { keys: "ctrl-u", description: "clear the input line" },
  { keys: "↑ / ↓", description: "walk prompt history" },
  { keys: "esc", description: "dismiss a menu · interrupt a run" },
  { keys: "ctrl-c", description: "quit" },
]

function HelpPanel({ supportsReasoning, width }: { supportsReasoning: boolean; width: number }) {
  const panelWidth = Math.max(44, width - 2)
  return (
    <Box
      borderColor={color.meta}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
      width={panelWidth}
    >
      <Box justifyContent="space-between">
        <Text bold>help</Text>
        <Text color={color.meta}>esc close</Text>
      </Box>
      <Text color={color.meta}>commands</Text>
      {helpEntries({ supportsReasoning }).map((entry) => (
        <HelpRow command={entry.command} description={entry.description} key={entry.command} />
      ))}
      <Text> </Text>
      <Text color={color.meta}>shortcuts</Text>
      {HELP_SHORTCUTS.map((shortcut) => (
        <HelpRow command={shortcut.keys} description={shortcut.description} key={shortcut.keys} />
      ))}
    </Box>
  )
}

function HelpRow({ command, description }: { command: string; description: string }) {
  return (
    <Box>
      <Box width={14}>
        <Text color={color.accent}>{command}</Text>
      </Box>
      <Text color={color.meta}>{description}</Text>
    </Box>
  )
}

function qualifiedRuntime(providerName: string, modelId: string): string {
  return `${providerName}/${modelId}`
}
