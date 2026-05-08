import assert from "node:assert/strict"
import { OllamaProvider } from "../../dist/index.js"

await smokeNonStreamingThinkTags()
await smokeStreamingThinkTags()
await smokeStreamingToolCallDeltas()

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

async function smokeStreamingToolCallDeltas() {
  const provider = new OllamaProvider()
  provider.client = {
    chat: {
      completions: {
        create: async function* () {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [{ id: "call_1", index: 0, function: { name: "create_" } }],
                },
                finish_reason: null,
              },
            ],
          }
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { name: "file", arguments: '{"path":"README.md","content":"' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'hello"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          }
        },
      },
    },
  }

  const deltas = []
  const result = await provider.call({
    messages: [{ role: "user", content: "create a readme" }],
    model: "fake",
    onToolCallDelta: (delta) => {
      deltas.push(delta)
    },
  })

  assert.equal(result.stopReason, "tool_calls")
  assert.equal(result.toolCalls[0]?.id, "call_1")
  assert.equal(result.toolCalls[0]?.name, "create_file")
  assert.deepEqual(result.toolCalls[0]?.args, { content: "hello", path: "README.md" })
  assert.equal(deltas.at(-1)?.name, "create_file")
  assert.equal(deltas.at(-1)?.argumentsText, '{"path":"README.md","content":"hello"}')
}
