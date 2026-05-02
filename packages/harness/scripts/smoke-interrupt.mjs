import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadEvents, runInvocation } from "../dist/index.js"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-int-"))
process.env.LEHARNESS_HOME = tmp
console.log(`smoke-interrupt: LEHARNESS_HOME = ${tmp}`)

const slowProvider = {
  name: "slow-fake",
  async call(req) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000)
      req.signal?.addEventListener("abort", () => {
        clearTimeout(t)
        const err = new Error("aborted")
        err.name = "AbortError"
        reject(err)
      })
    })
    return { text: "should never get here", toolCalls: [], stopReason: "stop" }
  },
}

const tools = []
const sessionId = "smoke-int-001"
const deps = { provider: slowProvider, tools, model: "fake", systemPrompt: "test" }

const controller = new AbortController()
setTimeout(() => {
  console.log("smoke-interrupt: firing abort")
  controller.abort()
}, 50)

const transcript = await runInvocation(sessionId, "wait forever", deps, {
  signal: controller.signal,
})

console.log(`smoke-interrupt: returned with ${transcript.length} transcript entries`)

const events = await loadEvents(sessionId)
console.log(`smoke-interrupt: ${events.length} events`)
for (const event of events) {
  console.log(`  ${event.type}`)
}

const hasInterrupted = events.some((e) => e.type === "agent.interrupted")
const hasFinished = events.some((e) => e.type === "agent.finished")
if (!hasInterrupted) {
  console.error("smoke-interrupt: FAIL — no agent.interrupted event")
  process.exit(1)
}
if (hasFinished) {
  console.error("smoke-interrupt: FAIL — agent.finished should not appear after interrupt")
  process.exit(1)
}
console.log("\nsmoke-interrupt: SUCCESS")
