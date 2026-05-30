import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runInvocation } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-capabilities-"))
process.env.LEHARNESS_HOME = tmp

function makeTool(name) {
  return {
    name,
    description: `${name} test tool`,
    async execute() {
      return { kind: "ok", output: name }
    },
  }
}

function toolNames(request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

const defaultRequests = []
const defaultProvider = {
  name: "capabilities-default",
  async call(req) {
    defaultRequests.push(req)
    return { text: "done", toolCalls: [], stopReason: "stop" }
  },
}

await runInvocation("smoke-capabilities-default", "check defaults", {
  provider: defaultProvider,
  tools: [makeTool("base_tool")],
  model: "fake-model",
  systemPrompt: "smoke capabilities",
})

const defaultToolNames = toolNames(defaultRequests[0])
assert(defaultToolNames.includes("base_tool"), "default request should keep caller tools")
assert(defaultToolNames.includes("wait_task"), "default request should include task tools")
assert(
  !defaultToolNames.includes("read_artifact"),
  "default request should not expose read_artifact",
)

const customRequests = []
const customProvider = {
  name: "capabilities-custom",
  async call(req) {
    customRequests.push(req)
    return { text: "done", toolCalls: [], stopReason: "stop" }
  },
}

await runInvocation("smoke-capabilities-custom", "check custom capabilities", {
  provider: customProvider,
  tools: [makeTool("cap_tool")],
  model: "fake-model",
  systemPrompt: "smoke capabilities",
  capabilities: [
    {
      async tools() {
        return [makeTool("cap_tool"), makeTool("extra_tool"), makeTool("extra_tool")]
      },
      async augmentSystemPrompt(base, ctx) {
        return `${base}\ncapability session=${ctx.sessionId} text=${ctx.userText}`
      },
    },
  ],
})

const customToolNames = toolNames(customRequests[0])
assert(
  JSON.stringify(customToolNames) === JSON.stringify(["cap_tool", "extra_tool"]),
  `custom capability tools should replace legacy defaults and de-dupe; got ${JSON.stringify(customToolNames)}`,
)
assert(
  customRequests[0]?.system?.includes(
    "capability session=smoke-capabilities-custom text=check custom capabilities",
  ) === true,
  "custom capability should augment the system prompt",
)

console.log("\nsmoke-capabilities: SUCCESS")
