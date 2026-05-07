import assert from "node:assert/strict"
import { OllamaProvider } from "../../dist/index.js"

await smokeNonStreamingThinkTags()
await smokeStreamingThinkTags()

console.log("smoke-reasoning-normalization: ok")

async function smokeNonStreamingThinkTags() {
  const provider = new OllamaProvider()
  provider.client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "<think>private scratch</think>final answer",
              },
            },
          ],
        }),
      },
    },
  }

  const result = await provider.call({
    messages: [{ role: "user", content: "hello" }],
    model: "fake",
  })

  assert.equal(result.text, "final answer")
  assert.equal(result.reasoningText, "private scratch")
}

async function smokeStreamingThinkTags() {
  const provider = new OllamaProvider()
  provider.client = {
    chat: {
      completions: {
        create: async function* () {
          yield { choices: [{ delta: { content: "<thi" }, finish_reason: null }] }
          yield { choices: [{ delta: { content: "nk>step" }, finish_reason: null }] }
          yield { choices: [{ delta: { content: "</thi" }, finish_reason: null }] }
          yield { choices: [{ delta: { content: "nk>done" }, finish_reason: "stop" }] }
        },
      },
    },
  }

  let streamedText = ""
  let streamedReasoning = ""
  const result = await provider.call({
    messages: [{ role: "user", content: "hello" }],
    model: "fake",
    onText: (delta) => {
      streamedText += delta
    },
    onReasoningText: (delta) => {
      streamedReasoning += delta
    },
  })

  assert.equal(streamedText, "done")
  assert.equal(streamedReasoning, "step")
  assert.equal(result.text, "done")
  assert.equal(result.reasoningText, "step")
}
