import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  allowAllPermissions,
  executeToolCall,
  type ToolContext,
  ToolRegistry,
} from "@leharness/harness"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readFileTool } from "./read_file.js"

const ctx: ToolContext = {
  sessionId: "test-session",
  permission: allowAllPermissions,
}

describe("readFileTool", () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-file-test-"))
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("reads an existing file via absolute path", async () => {
    const filePath = path.join(tmpDir, "hello.txt")
    const content = "hello, world\nline two\n"
    await fs.writeFile(filePath, content, "utf8")

    const result = await readFileTool.execute({ path: filePath }, ctx)

    expect(result).toEqual({ kind: "ok", output: content })
  })

  it("reads an existing file via relative path resolved against cwd", async () => {
    const fileName = "relative.txt"
    const content = "relative content"
    await fs.writeFile(path.join(tmpDir, fileName), content, "utf8")
    process.chdir(tmpDir)

    const result = await readFileTool.execute({ path: fileName }, ctx)

    expect(result).toEqual({ kind: "ok", output: content })
  })

  it("returns an error result for a missing file", async () => {
    const missing = path.join(tmpDir, "does-not-exist.txt")

    const result = await readFileTool.execute({ path: missing }, ctx)

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toMatch(/ENOENT|no such file/)
    }
  })

  it("returns an error result when reading a directory", async () => {
    const result = await readFileTool.execute({ path: tmpDir }, ctx)

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toMatch(/EISDIR|illegal operation on a directory/i)
    }
  })

  it("roundtrips UTF-8 content with multi-byte characters", async () => {
    const filePath = path.join(tmpDir, "utf8.txt")
    const content = "héllo 🦀\nまた明日\n"
    await fs.writeFile(filePath, content, "utf8")

    const result = await readFileTool.execute({ path: filePath }, ctx)

    expect(result).toEqual({ kind: "ok", output: content })
  })

  it("returns an empty string for a 0-byte file", async () => {
    const filePath = path.join(tmpDir, "empty.txt")
    await fs.writeFile(filePath, "", "utf8")

    const result = await readFileTool.execute({ path: filePath }, ctx)

    expect(result).toEqual({ kind: "ok", output: "" })
  })

  it("rejects invalid args via executeToolCall schema validation", async () => {
    const registry = new ToolRegistry()
    registry.register(readFileTool)

    const result = await executeToolCall(
      { id: "call-1", name: "read_file", args: {} },
      registry,
      ctx,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/invalid args for read_file/)
      expect(result.error).toMatch(/path/)
    }
  })
})
