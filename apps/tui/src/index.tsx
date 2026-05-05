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

export async function runTui(
  sessionId: string,
  deps: HarnessDeps,
  resuming: boolean,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tui mode requires an interactive TTY")
  }

  const priorEvents = resuming ? await loadEvents(sessionId) : []
  const sessionPath = path.join(resolveLeharnessHome(), "sessions", sessionId)
  const app = render(
    <TuiApp
      deps={deps}
      priorEvents={priorEvents}
      runPrompt={(text, options) => runPrompt(sessionId, text, deps, options)}
      sessionId={sessionId}
    />,
    { exitOnCtrlC: false },
  )
  await app.waitUntilExit()
  process.stdout.write(`session saved at ${sessionPath}\n`)
}

async function runPrompt(
  sessionId: string,
  text: string,
  deps: HarnessDeps,
  options: {
    onEvent: (event: Event) => void
    onText: (delta: string) => void
    signal: AbortSignal
  },
): Promise<void> {
  await runInvocation(sessionId, text, deps, options)
}
