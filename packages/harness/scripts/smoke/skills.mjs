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

const originalCwd = process.cwd()
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-smoke-skills-"))
const workspace = path.join(tmp, "workspace")
const home = path.join(tmp, "home")
const skillDir = path.join(workspace, ".agents", "skills", "example")
const skillPath = path.join(skillDir, "SKILL.md")

await fs.mkdir(skillDir, { recursive: true })
await fs.mkdir(home, { recursive: true })
await fs.writeFile(
  skillPath,
  `---
name: example
description: Use when testing initial skill catalog behavior.
---

# Example Skill

Initial skill body.
`,
)

process.env.LEHARNESS_HOME = home
process.chdir(workspace)

try {
  const requests = []
  const responses = [
    {
      text: "loading example skill",
      toolCalls: [{ id: "skill_call_1", name: "load_skill", args: { name: "example" } }],
      stopReason: "tool_calls",
    },
    {
      text: "first skill load complete",
      toolCalls: [],
      stopReason: "stop",
    },
    {
      text: "loading edited example skill",
      toolCalls: [{ id: "skill_call_2", name: "load_skill", args: { name: "example" } }],
      stopReason: "tool_calls",
    },
    {
      text: "second skill load complete",
      toolCalls: [],
      stopReason: "stop",
    },
  ]
  let callIndex = 0

  const fakeProvider = {
    name: "skills-fake",
    async call(req) {
      requests.push(req)
      const response = responses[callIndex]
      callIndex++
      if (!response) throw new Error("skills-fake: out of scripted responses")
      return response
    },
  }

  const sessionId = "smoke-skills-001"
  const deps = {
    provider: fakeProvider,
    tools: [],
    model: "fake-model",
    systemPrompt: "smoke skills",
  }

  await runInvocation(sessionId, "please use the example skill", deps)

  assert(
    requests[0]?.system?.includes("Available skills. Call load_skill({name})") === true,
    "first request should include the skill catalog header",
  )
  assert(
    requests[0]?.system?.includes("- example: Use when testing initial skill catalog behavior.") ===
      true,
    `first request should include the example skill catalog entry; got ${requests[0]?.system}`,
  )
  assert(
    requests[0]?.tools?.some((tool) => tool.name === "load_skill") === true,
    "first request should expose the load_skill tool",
  )
  assert(
    requests[1]?.messages.some(
      (message) => message.role === "tool" && message.content.includes("Initial skill body."),
    ) === true,
    "first load_skill result should include the initial skill body",
  )

  const firstEvents = await loadEvents(sessionId)
  const firstSkillEvents = firstEvents.filter((event) => event.type === "skill.loaded")
  assert(
    firstSkillEvents.length === 1,
    `expected 1 skill.loaded event, got ${firstSkillEvents.length}`,
  )
  assert(
    firstSkillEvents[0].name === "example" &&
      firstSkillEvents[0].path === ".agents/skills/example/SKILL.md" &&
      typeof firstSkillEvents[0].contentHash === "string",
    `unexpected first skill.loaded payload: ${JSON.stringify(firstSkillEvents[0])}`,
  )
  const firstHash = firstSkillEvents[0].contentHash

  await fs.writeFile(
    skillPath,
    `---
name: example
description: Use when testing edited skill hot reload behavior.
---

# Example Skill

Edited skill body.
`,
  )

  await runInvocation(sessionId, "please use the example skill again", deps)

  assert(
    requests[2]?.system?.includes("Use when testing edited skill hot reload behavior.") === true,
    `second invocation should see the edited description in the catalog; got ${requests[2]?.system}`,
  )
  assert(
    requests[3]?.messages.some(
      (message) => message.role === "tool" && message.content.includes("Edited skill body."),
    ) === true,
    "second load_skill result should include the edited skill body without restarting",
  )

  const events = await loadEvents(sessionId)
  const skillEvents = events.filter((event) => event.type === "skill.loaded")
  assert(skillEvents.length === 2, `expected 2 skill.loaded events, got ${skillEvents.length}`)
  assert(
    skillEvents[1].contentHash !== firstHash,
    "edited skill should produce a different content hash",
  )

  console.log(`smoke-skills: events = ${JSON.stringify(events.map((event) => event.type))}`)
  console.log("\nsmoke-skills: SUCCESS")
} finally {
  process.chdir(originalCwd)
}
