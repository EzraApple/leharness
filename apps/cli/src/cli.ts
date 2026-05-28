import { readFileSync } from "node:fs"
import * as path from "node:path"
import { stdin, stdout } from "node:process"
import * as readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import {
  buildProvider,
  defaultModelFor,
  enableShellRuntime,
  enableSubagentRuntime,
  getOrCreateTaskServices,
  type HarnessDeps,
  loadEvents,
  loadUserSettings,
  type Provider,
  registerSubagentPreset,
  resolveLeharnessHome,
  runInvocation,
  type UserSettings,
} from "@leharness/harness"
import { runTui } from "@leharness/tui"
import { ulid } from "ulid"
import { LiveRenderer } from "./render.js"
import { bashTool } from "./tools/bash.js"
import { builtinTools } from "./tools/index.js"
import { readFileTool } from "./tools/read_file.js"

const cliVersion = readCliVersion()
const CLI_SYSTEM_PROMPT =
  "You are a concise coding assistant running in a terminal harness. Use tools only when needed. Use bash for directory listing, searching (prefer rg), git, tests, builds, and shell work. Use read_file for file contents, edit_file for exact replacements, and create_file for new files. Do not narrate routine tool-use steps. Finish with a concise summary of what changed or what you found."

export interface ParsedArgs {
  mode: "one_shot" | "minimal" | "tui"
  prompt?: string
  sessionId?: string
  provider?: string
  model?: string
  maxSteps?: number
  help?: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: "tui" }
  let prompt: string | undefined
  let sawInteractiveSubcommand = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--session" || arg === "-s") out.sessionId = argv[++i]
    else if (arg === "--provider" || arg === "-p") out.provider = argv[++i]
    else if (arg === "--model" || arg === "-m") out.model = argv[++i]
    else if (arg === "--max-steps") {
      const raw = argv[++i]
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) out.maxSteps = parsed
    } else if (arg === "minimal" || arg === "cli") {
      out.mode = "minimal"
      sawInteractiveSubcommand = true
    } else if (arg === "tui") {
      out.mode = "tui"
      sawInteractiveSubcommand = true
    } else if (!arg.startsWith("-") && prompt === undefined) prompt = arg
  }

  if (prompt !== undefined && !sawInteractiveSubcommand) {
    out.mode = "one_shot"
    out.prompt = prompt
  }
  return out
}

export async function main(argv: string[]): Promise<number> {
  loadDotEnvFiles()
  const args = parseArgs(argv)
  if (args.help) {
    printUsage()
    return 0
  }

  const settings = await loadUserSettings()
  const runtime = resolveRuntime(args, settings)

  let provider: Provider
  try {
    provider = buildProvider(runtime.provider)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const deps: HarnessDeps = {
    systemPrompt: CLI_SYSTEM_PROMPT,
    provider,
    tools: builtinTools,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    maxSteps: resolveMaxSteps(args.maxSteps),
    compaction: resolveCompactionConfig(),
  }
  const sessionId = args.sessionId ?? ulid()
  const services = getOrCreateTaskServices(sessionId)
  enableShellRuntime(services)
  enableSubagentRuntime(
    services,
    {
      provider,
      model: deps.model,
      systemPrompt: deps.systemPrompt,
      tools: deps.tools,
      reasoningEffort: deps.reasoningEffort,
    },
    runInvocation,
  )
  registerSampleSubagents(services)

  if (args.mode === "one_shot") {
    if (args.prompt === undefined) {
      printUsage()
      return 0
    }
    process.stdout.write(`session: ${sessionId}\n`)
    const renderer = new LiveRenderer()
    if (args.sessionId !== undefined) {
      const prior = await loadEvents(sessionId)
      if (prior.length > 0) {
        process.stdout.write(`(resuming with ${prior.length} prior events)\n`)
      }
    }
    renderer.echoUser(args.prompt)
    await runOnce(sessionId, args.prompt, deps, renderer)
    return 0
  }

  if (args.mode === "minimal") {
    await runMinimalInteractive(sessionId, deps, args.sessionId !== undefined)
    return 0
  }

  try {
    await runTui(sessionId, deps, args.sessionId !== undefined)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  return 0
}

// CLI flag wins; falls back to LEHARNESS_MAX_STEPS env; otherwise
// returns undefined so the harness applies DEFAULT_MAX_STEPS.
function resolveMaxSteps(flagValue: number | undefined): number | undefined {
  if (flagValue !== undefined) return flagValue
  const raw = process.env.LEHARNESS_MAX_STEPS
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function registerSampleSubagents(services: ReturnType<typeof getOrCreateTaskServices>): void {
  registerSubagentPreset(services, {
    name: "explore",
    description: "Read-only codebase exploration. Find references, sketch the layout, summarize.",
    systemPrompt:
      "You are a read-only codebase explorer. You have read_file and bash (for ls, grep, rg, git, etc.) — you do not have edit or create tools. Your job is to find things and report what you found concisely. Do not propose changes; the parent agent will decide what to do with your findings.",
    tools: [readFileTool, bashTool],
  })
  registerSubagentPreset(services, {
    name: "plan",
    description: "Design implementation plans for a focused task. Read-only.",
    systemPrompt:
      "You are a planning assistant. You have read_file and bash (for ls, grep, rg, git, etc.) — you do not have edit or create tools. Your job is to read the relevant code and produce a concrete, step-ordered implementation plan. Return the plan as your final message; the parent agent will execute or hand it off.",
    tools: [readFileTool, bashTool],
  })
}

// Tiny CLI-layer hook into compaction config so a user (or smoke
// session) can force smaller budgets for testing without code edits.
// The harness owns the default budget (context-window-aware in
// core/prepare-prompt.ts); this lets the app override.
function resolveCompactionConfig(): HarnessDeps["compaction"] {
  const raw = process.env.LEHARNESS_MAX_INPUT_TOKENS
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return { maxInputTokens: parsed }
}

function resolveRuntime(
  args: Pick<ParsedArgs, "model" | "provider">,
  settings: UserSettings,
): { model: string; provider: string; reasoningEffort?: HarnessDeps["reasoningEffort"] } {
  const provider =
    args.provider ?? process.env.LEHARNESS_PROVIDER ?? settings.runtime?.provider ?? "ollama"
  const model =
    args.model ??
    process.env.LEHARNESS_MODEL ??
    (settings.runtime?.provider === provider ? settings.runtime.model : undefined) ??
    defaultModelFor(provider)
  const reasoningEffort =
    settings.runtime?.provider === provider && settings.runtime.model === model
      ? settings.runtime.reasoningEffort
      : undefined
  return { model, provider, reasoningEffort }
}

async function runOnce(
  sessionId: string,
  prompt: string,
  deps: HarnessDeps,
  renderer: LiveRenderer,
): Promise<void> {
  await runInvocation(sessionId, prompt, deps, {
    onText: (delta) => renderer.onText(delta),
    onEvent: (event) => renderer.onEvent(event),
  })
}

async function runMinimalInteractive(
  sessionId: string,
  deps: HarnessDeps,
  resuming: boolean,
): Promise<void> {
  process.stdout.write(`lh minimal (session: ${sessionId})\n`)
  process.stdout.write(`Provider: ${deps.provider.name}, Model: ${deps.model}\n`)
  process.stdout.write(`/help for commands. Ctrl-C or /exit to quit.\n\n`)
  const renderer = new LiveRenderer()
  if (resuming) {
    const prior = await loadEvents(sessionId)
    renderer.replayHistory(prior)
  }
  const rl = readline.createInterface({ input: stdin, output: stdout })
  const prompt = stdin.isTTY ? "> " : ""
  while (true) {
    let line: string
    try {
      line = await rl.question(prompt)
    } catch {
      break
    }
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed === "/exit" || trimmed === "/quit") break
    if (trimmed === "/help") {
      process.stdout.write(cliHelp())
      continue
    }
    if (trimmed === "/clear") {
      process.stdout.write("\x1b[2J\x1b[H")
      continue
    }
    if (trimmed === "/session") {
      process.stdout.write(`session: ${sessionId}\n`)
      continue
    }
    if (trimmed.startsWith("/")) {
      process.stdout.write(`unknown command: ${trimmed}. Try /help.\n`)
      continue
    }
    if (!stdin.isTTY) renderer.echoUser(trimmed)
    await runOnce(sessionId, trimmed, deps, renderer)
  }
  rl.close()
  process.stdout.write(
    `session saved at ${path.join(resolveLeharnessHome(), "sessions", sessionId)}\n`,
  )
}

function cliHelp(): string {
  return `commands:
  /help        show this help
  /clear       clear the screen
  /session     print the current session id
  /exit        leave the minimal cli (Ctrl-C and Ctrl-D also work)
`
}

function printUsage(): void {
  process.stdout.write(
    `lh ${cliVersion} - launcher for leharness apps

Usage:
  lh                        Start the TUI (default)
  lh tui                    Start the TUI (explicit)
  lh minimal                Start the minimal line-mode CLI
  lh "<prompt>"             Run a single prompt and print the response
  lh --session <id>         Resume an existing session in the TUI

Options:
  -s, --session <id>        Use the given session id (defaults to a new ULID)
  -p, --provider <name>     Provider to use (ollama | openai | deepseek). Defaults to env LEHARNESS_PROVIDER or "ollama".
  -m, --model <name>        Model name to pass to the provider. Defaults to provider's default.
      --max-steps <N>       Max tool-call iterations per invocation. Defaults to 50, override per session.
  -h, --help                Show this help

Environment:
  LEHARNESS_HOME            Override .leharness directory location
  LEHARNESS_PROVIDER        Default provider
  LEHARNESS_MODEL           Default model
  LEHARNESS_MAX_STEPS       Default max tool-call iterations (CLI flag --max-steps wins)
  OPENAI_API_KEY            Required when using --provider openai
  DEEPSEEK_API_KEY          Required when using --provider deepseek
  LEHARNESS_OLLAMA_BASE_URL Override Ollama endpoint (default http://localhost:11434/v1)
  LEHARNESS_DEEPSEEK_BASE_URL Override DeepSeek endpoint (default https://api.deepseek.com)
`,
  )
}

function loadDotEnvFiles(): void {
  for (const filePath of dotEnvPaths()) {
    loadDotEnv(filePath)
  }
}

function dotEnvPaths(): string[] {
  return dedupePaths([
    path.resolve(process.cwd(), ".env"),
    fileURLToPath(new URL("../../../.env", import.meta.url)),
  ])
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const filePath of paths) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    out.push(filePath)
  }
  return out
}

function loadDotEnv(filePath: string): void {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
  } catch {
    return
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const equals = trimmed.indexOf("=")
    if (equals <= 0) continue
    const key = trimmed.slice(0, equals).trim()
    const value = stripEnvQuotes(trimmed.slice(equals + 1).trim())
    if (!isValidEnvKey(key) || process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function isValidEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function readCliVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown }
    if (typeof packageJson.version === "string") return packageJson.version
  } catch {
    // Keep --help available even when running from an unusual build layout.
  }
  return "unknown"
}
