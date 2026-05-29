import * as path from "node:path"
import {
  type Event,
  type HarnessDeps,
  loadEvents,
  resolveLeharnessHome,
  runInvocation,
} from "@leharness/harness"
import { render } from "ink"
import { TuiApp } from "./app.js"
import type { McpControls } from "./mcp/types.js"

export async function runTui(
  sessionId: string,
  deps: HarnessDeps,
  resuming: boolean,
  mcp?: McpControls,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tui mode requires an interactive TTY")
  }

  const priorEvents = resuming ? await loadEvents(sessionId) : []
  const sessionPath = path.join(resolveLeharnessHome(), "sessions", sessionId)
  const app = render(
    <TuiApp
      deps={deps}
      mcp={mcp}
      priorEvents={priorEvents}
      runPrompt={(text, invocationDeps, options) =>
        runPrompt(sessionId, text, invocationDeps, options)
      }
      sessionId={sessionId}
    />,
    { exitOnCtrlC: false },
  )
  await app.waitUntilExit()
  process.stdout.write(`session saved at ${sessionPath}\n`)
}

async function runPrompt(
  sessionId: string,
  text: string | undefined,
  deps: HarnessDeps,
  options: {
    onEvent: (event: Event) => void
    onText: (delta: string) => void
    signal: AbortSignal
  },
): Promise<void> {
  await runInvocation(sessionId, text, deps, options)
}
