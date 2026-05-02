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
import { renderEvent } from "./render.js"
import { builtinTools } from "./tools/index.js"

export interface ParsedArgs {
  mode: "one_shot" | "repl"
  prompt?: string
  sessionId?: string
  provider?: string
  model?: string
  help?: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: "repl" }
  let prompt: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--session" || arg === "-s") out.sessionId = argv[++i]
    else if (arg === "--provider" || arg === "-p") out.provider = argv[++i]
    else if (arg === "--model" || arg === "-m") out.model = argv[++i]
    else if (arg === "repl") out.mode = "repl"
    else if (!arg.startsWith("-") && prompt === undefined) prompt = arg
  }

  if (prompt !== undefined && !argv.includes("repl")) {
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
    process.stdout.write(`> ${args.prompt}\n`)
    await runAndRender(sessionId, args.prompt, deps)
    return 0
  }

  await runRepl(sessionId, deps)
  return 0
}

async function runAndRender(sessionId: string, prompt: string, deps: HarnessDeps): Promise<void> {
  const before = (await loadEvents(sessionId)).length
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on("SIGINT", onSigint)
  try {
    await runInvocation(sessionId, prompt, deps, { signal: controller.signal })
  } finally {
    process.off("SIGINT", onSigint)
  }
  const after = await loadEvents(sessionId)
  for (const event of after.slice(before)) {
    const line = renderEvent(event)
    if (line !== null) process.stdout.write(`${line}\n`)
  }
}

async function runRepl(sessionId: string, deps: HarnessDeps): Promise<void> {
  process.stdout.write(`leharness REPL (session: ${sessionId})\n`)
  process.stdout.write(`Provider: ${deps.provider.name}, Model: ${deps.model}\n`)
  process.stdout.write(`Type your message and press Enter. Ctrl-C or Ctrl-D to exit.\n`)
  const rl = readline.createInterface({ input: stdin, output: stdout })
  while (true) {
    let line: string
    try {
      line = await rl.question("> ")
    } catch {
      break
    }
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed === "/exit" || trimmed === "/quit") break
    await runAndRender(sessionId, trimmed, deps)
  }
  rl.close()
  process.stdout.write(
    `session saved at ${path.join(resolveLeharnessHome(), "sessions", sessionId)}\n`,
  )
}

function printUsage(): void {
  process.stdout.write(
    `leharness - minimal CLI for the leharness agent

Usage:
  leharness "<prompt>"           Run a single prompt and print the response
  leharness repl                 Enter an interactive REPL
  leharness --session <id> ...   Resume an existing session

Options:
  -s, --session <id>             Use the given session id (defaults to a new ULID)
  -p, --provider <name>          Provider to use (ollama | openai). Defaults to env LEHARNESS_PROVIDER or "ollama".
  -m, --model <name>             Model name to pass to the provider. Defaults to provider's default.
  -h, --help                     Show this help

Environment:
  LEHARNESS_HOME                 Override .leharness directory location
  LEHARNESS_PROVIDER             Default provider
  LEHARNESS_MODEL                Default model
  OPENAI_API_KEY                 Required when using --provider openai
  LEHARNESS_OLLAMA_BASE_URL      Override Ollama endpoint (default http://localhost:11434/v1)
`,
  )
}
