import { readFileSync } from "node:fs"
import * as path from "node:path"
import { stdin, stdout } from "node:process"
import * as readline from "node:readline/promises"
import {
  type HarnessDeps,
  loadEvents,
  OllamaProvider,
  OpenAIProvider,
  type Provider,
  resolveLeharnessHome,
  runInvocation,
} from "@leharness/harness"
import { ulid } from "ulid"
import { LiveRenderer } from "./render.js"
import { builtinTools } from "./tools/index.js"

const cliVersion = readCliVersion()

export interface ParsedArgs {
  mode: "one_shot" | "interactive"
  prompt?: string
  sessionId?: string
  provider?: string
  model?: string
  help?: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: "interactive" }
  let prompt: string | undefined
  let sawAppSubcommand = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--session" || arg === "-s") out.sessionId = argv[++i]
    else if (arg === "--provider" || arg === "-p") out.provider = argv[++i]
    else if (arg === "--model" || arg === "-m") out.model = argv[++i]
    else if (arg === "cli") sawAppSubcommand = true
    else if (!arg.startsWith("-") && prompt === undefined) prompt = arg
  }

  if (prompt !== undefined && !sawAppSubcommand) {
    out.mode = "one_shot"
    out.prompt = prompt
  }
  return out
}

export function buildProvider(name: string): Provider {
  switch (name) {
    case "ollama":
      return new OllamaProvider()
    case "openai":
      return new OpenAIProvider()
    default:
      throw new Error(`unknown provider: ${name}. Supported: ollama, openai.`)
  }
}

export function defaultModelFor(providerName: string): string {
  if (providerName === "ollama") return "gemma4:26b"
  if (providerName === "openai") return "gpt-4o-mini"
  throw new Error(`no default model for provider: ${providerName}`)
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    printUsage()
    return 0
  }

  const providerName = args.provider ?? process.env.LEHARNESS_PROVIDER ?? "ollama"
  const modelName = args.model ?? process.env.LEHARNESS_MODEL ?? defaultModelFor(providerName)

  let provider: Provider
  try {
    provider = buildProvider(providerName)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const deps: HarnessDeps = { provider, tools: builtinTools, model: modelName }
  const sessionId = args.sessionId ?? ulid()

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

  await runInteractive(sessionId, deps, args.sessionId !== undefined)
  return 0
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

async function runInteractive(
  sessionId: string,
  deps: HarnessDeps,
  resuming: boolean,
): Promise<void> {
  process.stdout.write(`lh cli (session: ${sessionId})\n`)
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
  /exit        leave the cli (Ctrl-C and Ctrl-D also work)
`
}

function printUsage(): void {
  process.stdout.write(
    `lh ${cliVersion} - launcher for leharness apps

Usage:
  lh                        Start the interactive cli (default)
  lh cli                    Start the interactive cli (explicit)
  lh "<prompt>"             Run a single prompt and print the response
  lh --session <id> ...     Resume an existing session

Options:
  -s, --session <id>        Use the given session id (defaults to a new ULID)
  -p, --provider <name>     Provider to use (ollama | openai). Defaults to env LEHARNESS_PROVIDER or "ollama".
  -m, --model <name>        Model name to pass to the provider. Defaults to provider's default.
  -h, --help                Show this help

Environment:
  LEHARNESS_HOME            Override .leharness directory location
  LEHARNESS_PROVIDER        Default provider
  LEHARNESS_MODEL           Default model
  OPENAI_API_KEY            Required when using --provider openai
  LEHARNESS_OLLAMA_BASE_URL Override Ollama endpoint (default http://localhost:11434/v1)
`,
  )
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
