import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runInvocation, taskManagementCapability } from "../../dist/index.js"

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

const emptyRequests = []
const emptyProvider = {
  name: "capabilities-empty",
  async call(req) {
    emptyRequests.push(req)
    return { text: "done", toolCalls: [], stopReason: "stop" }
  },
}

await runInvocation("smoke-capabilities-empty", "check empty capabilities", {
  provider: emptyProvider,
  tools: [makeTool("base_tool")],
  model: "fake-model",
  systemPrompt: "smoke capabilities",
})

const emptyToolNames = toolNames(emptyRequests[0])
assert(
  JSON.stringify(emptyToolNames) === JSON.stringify(["base_tool"]),
  `omitted capabilities should expose only caller tools; got ${JSON.stringify(emptyToolNames)}`,
)

const taskRequests = []
const taskProvider = {
  name: "capabilities-task",
  async call(req) {
    taskRequests.push(req)
    return { text: "done", toolCalls: [], stopReason: "stop" }
  },
}

await runInvocation("smoke-capabilities-task", "check task capability", {
  provider: taskProvider,
  tools: [makeTool("base_tool")],
  model: "fake-model",
  systemPrompt: "smoke capabilities",
  capabilities: [taskManagementCapability()],
})

const taskToolNames = toolNames(taskRequests[0])
assert(
  JSON.stringify(taskToolNames) ===
    JSON.stringify(["base_tool", "wait_task", "read_task", "cancel_task"]),
  `task capability should expose only caller + task tools; got ${JSON.stringify(taskToolNames)}`,
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
  `custom capability tools should append missing tools and de-dupe; got ${JSON.stringify(customToolNames)}`,
)
assert(
  customRequests[0]?.system?.includes(
    "capability session=smoke-capabilities-custom text=check custom capabilities",
  ) === true,
  "custom capability should augment the system prompt",
)

console.log("\nsmoke-capabilities: SUCCESS")
