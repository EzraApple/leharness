import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, runInvocation } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-invocation-control-"))
process.env.LEHARNESS_HOME = tmp

await smokeMaxSteps()
await smokeModelFailure()
await smokePreCancelled()
await smokeCancelDuringProvider()

console.log("\nsmoke-invocation-control: SUCCESS")

async function smokeMaxSteps() {
  let callCount = 0
  const loopingProvider = {
    name: "looping-fake",
    async call() {
      callCount++
      return {
        text: "still looping",
        toolCalls: [{ id: `missing_${callCount}`, name: "missing_tool", args: {} }],
        stopReason: "tool_calls",
      }
    },
  }

  const events = await runInvocation("smoke-max-steps", "loop forever", {
    provider: loopingProvider,
    tools: [],
    model: "fake",
    maxSteps: 2,
  })

  const eventTypes = events.map((event) => event.type)
  console.log(`smoke-invocation-control max-steps events = ${JSON.stringify(eventTypes)}`)

  assert(callCount === 2, `expected exactly 2 provider calls, got ${callCount}`)
  assert(
    events.filter((event) => event.type === "step.started").length === 2,
    "maxSteps should allow exactly the configured number of steps",
  )
  const final = events.at(-1)
  assert(final?.type === "agent.finished", "maxSteps should finish the invocation")
  assert(final.reason === "max_steps", `expected max_steps reason, got ${final?.reason}`)
  assert(final.maxSteps === 2, `expected maxSteps payload to be 2, got ${final.maxSteps}`)
}

async function smokeModelFailure() {
  const failingProvider = {
    name: "failing-fake",
    async call() {
      throw new Error("provider blew up")
    },
  }

  const events = await runInvocation("smoke-model-failed", "please fail", {
    provider: failingProvider,
    tools: [],
    model: "fake",
  })

  const failed = events.find((event) => event.type === "model.failed")
  const final = events.at(-1)
  assert(failed !== undefined, "provider errors should persist model.failed")
  assert(
    typeof failed.error === "string" && failed.error.includes("provider blew up"),
    `model.failed should include provider error text, got ${JSON.stringify(failed?.error)}`,
  )
  assert(final?.type === "agent.finished", "model failure should finish the invocation")
  assert(final.reason === "model_failed", `expected model_failed reason, got ${final?.reason}`)
}

async function smokePreCancelled() {
  const controller = new AbortController()
  controller.abort()

  let callCount = 0
  const provider = {
    name: "pre-cancel-fake",
    async call() {
      callCount++
      return { text: "should not happen", toolCalls: [], stopReason: "stop" }
    },
  }

  const events = await runInvocation(
    "smoke-pre-cancelled",
    "cancelled before first step",
    { provider, tools: [], model: "fake" },
    { signal: controller.signal },
  )

  const eventTypes = events.map((event) => event.type)
  assert(callCount === 0, `pre-cancelled invocation should not call provider, got ${callCount}`)
  assert(
    JSON.stringify(eventTypes) === JSON.stringify(["invocation.received", "agent.finished"]),
    `pre-cancelled event types mismatch: ${JSON.stringify(eventTypes)}`,
  )
  assert(events.at(-1)?.reason === "cancelled", "pre-cancelled invocation should finish cancelled")
}

async function smokeCancelDuringProvider() {
  const controller = new AbortController()
  let providerSawSignal = false
  let providerStarted
  const started = new Promise((resolve) => {
    providerStarted = resolve
  })
  const provider = {
    name: "in-flight-cancel-fake",
    async call(req) {
      providerSawSignal = req.signal === controller.signal
      providerStarted()
      return new Promise(() => {})
    },
  }

  const run = runInvocation(
    "smoke-in-flight-cancelled",
    "cancel while provider is running",
    { provider, tools: [], model: "fake" },
    { signal: controller.signal },
  )
  await started
  controller.abort()

  const events = await run
  const persisted = await loadEvents("smoke-in-flight-cancelled")
  const eventTypes = persisted.map((event) => event.type)
  console.log(`smoke-invocation-control cancel events = ${JSON.stringify(eventTypes)}`)

  assert(providerSawSignal, "provider request should carry the invocation AbortSignal")
  assert(events.at(-1)?.reason === "cancelled", "in-flight cancellation should finish cancelled")
  assert(
    !persisted.some((event) => event.type === "model.completed"),
    "in-flight cancellation should not append model.completed",
  )
}
