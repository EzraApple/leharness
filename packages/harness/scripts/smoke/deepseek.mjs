import { DeepSeekProvider } from "../../dist/index.js"

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const provider = new DeepSeekProvider({
  apiKey: "test-key",
  defaultModel: "deepseek-v4-flash",
})

const bodies = []
provider.client = {
  chat: {
    completions: {
      async create(body) {
        bodies.push(body)
        return {
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "ok",
                reasoning_content: "reasoned",
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }
      },
    },
  },
}

const high = await provider.call({
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: "hello" }],
  reasoningEffort: "high",
})

const off = await provider.call({
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "hello" }],
  reasoningEffort: "off",
})

await provider.call({
  model: "deepseek-v4-flash",
  messages: [
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: "I need a tool.",
      reasoningText: "must inspect files",
      toolCalls: [{ id: "call_1", name: "bash", args: { command: "ls" } }],
    },
    { role: "tool", toolCallId: "call_1", content: "README.md" },
    { role: "user", content: "continue" },
  ],
  reasoningEffort: "high",
})

assert(high.reasoningText === "reasoned", "provider should expose reasoning_content")
assert(bodies[0]?.model === "deepseek-v4-flash", "flash request should use flash model id")
assert(
  JSON.stringify(bodies[0]?.thinking) ===
    JSON.stringify({ type: "enabled", reasoning_effort: "high" }),
  `flash request should enable high thinking; got ${JSON.stringify(bodies[0]?.thinking)}`,
)
assert(off.text === "ok", "provider should return final content")
assert(bodies[1]?.model === "deepseek-v4-pro", "pro request should use pro model id")
assert(
  JSON.stringify(bodies[1]?.thinking) === JSON.stringify({ type: "disabled" }),
  `off request should disable thinking; got ${JSON.stringify(bodies[1]?.thinking)}`,
)
assert(
  bodies[2]?.messages?.[1]?.reasoning_content === "must inspect files",
  "deepseek history should replay assistant reasoning_content",
)

console.log("\nsmoke-deepseek: SUCCESS")
