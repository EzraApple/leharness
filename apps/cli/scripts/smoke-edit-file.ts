import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runInvocation } from "@leharness/harness"
import { createFileTool } from "../src/tools/create_file.js"
import { editFileTool } from "../src/tools/edit_file.js"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-edit-file-"))
process.env.LEHARNESS_HOME = path.join(tmp, ".leharness")
const originalCwd = process.cwd()
process.chdir(tmp)

try {
  await smokeSuccessfulCreate()
  await smokeExistingCreateFailure()
  await smokeSuccessfulEdit()
  await smokeNoMatchFailure()
  await smokeMultipleMatchFailure()
  await smokeInvocationDisplay()
} finally {
  process.chdir(originalCwd)
}

console.log("smoke-edit-file: ok")

async function smokeSuccessfulCreate(): Promise<void> {
  const result = await createFileTool.execute(
    { content: "hello\nworld\n", path: "created/note.txt" },
    { sessionId: "edit-smoke" },
  )

  assert.equal(result.kind, "ok")
  assert.equal(await fs.readFile("created/note.txt", "utf8"), "hello\nworld\n")
  assert.equal(result.summary, "Added 3 lines")
}

async function smokeExistingCreateFailure(): Promise<void> {
  await fs.writeFile("exists.txt", "already here\n", "utf8")
  const result = await createFileTool.execute(
    { content: "new\n", path: "exists.txt" },
    { sessionId: "edit-smoke" },
  )

  assert.equal(result.kind, "error")
  assert.equal(result.summary, "file already exists")
  assert.equal(await fs.readFile("exists.txt", "utf8"), "already here\n")
}

async function smokeSuccessfulEdit(): Promise<void> {
  await fs.writeFile("one.txt", "alpha\nold\nomega\n", "utf8")
  const result = await editFileTool.execute(
    { new_string: "new", old_string: "old", path: "one.txt" },
    { sessionId: "edit-smoke" },
  )

  assert.equal(result.kind, "ok")
  assert.equal(await fs.readFile("one.txt", "utf8"), "alpha\nnew\nomega\n")
  assert.match(result.summary ?? "", /Changed \+1 -1 lines/)
}

async function smokeNoMatchFailure(): Promise<void> {
  await fs.writeFile("missing.txt", "alpha\n", "utf8")
  const result = await editFileTool.execute(
    { new_string: "new", old_string: "old", path: "missing.txt" },
    { sessionId: "edit-smoke" },
  )

  assert.equal(result.kind, "error")
  assert.match(result.message, /matched 0 times/)
}

async function smokeMultipleMatchFailure(): Promise<void> {
  await fs.writeFile("duplicate.txt", "old\nold\n", "utf8")
  const result = await editFileTool.execute(
    { new_string: "new", old_string: "old", path: "duplicate.txt" },
    { sessionId: "edit-smoke" },
  )

  assert.equal(result.kind, "error")
  assert.match(result.message, /matched 2 times/)
}

async function smokeInvocationDisplay(): Promise<void> {
  let calls = 0
  const provider = {
    name: "fake",
    async call() {
      calls += 1
      if (calls === 1) {
        return {
          stopReason: "tool_calls",
          text: "editing",
          toolCalls: [
            {
              args: { content: "before\n", path: "invoke.txt" },
              id: "call_create",
              name: "create_file",
            },
          ],
        }
      }
      if (calls === 2) {
        return {
          stopReason: "tool_calls",
          text: "now editing",
          toolCalls: [
            {
              args: { new_string: "after\n", old_string: "before\n", path: "invoke.txt" },
              id: "call_edit",
              name: "edit_file",
            },
          ],
        }
      }
      return { stopReason: "stop", text: "done", toolCalls: [] }
    },
  }

  const events = await runInvocation("edit-display-smoke", "edit invoke.txt", {
    model: "fake",
    provider,
    systemPrompt: "smoke edit display",
    tools: [createFileTool, editFileTool],
  })

  assert.equal(await fs.readFile("invoke.txt", "utf8"), "after\n")
  const completed = events.filter((event) => event.type === "tool.completed")
  assert.equal(completed[0]?.display?.completed, "created")
  assert.equal(completed[0]?.display?.target, "invoke.txt")
  assert.equal(completed[1]?.display?.completed, "edited")
  assert.equal(completed[1]?.display?.target, "invoke.txt")
  assert.match(String(completed[1]?.display?.summary ?? ""), /Changed \+1 -1 lines/)
}
