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
import { bashTool } from "./bash.js"

const ctx: ToolContext = {
  sessionId: "test-session",
  permission: allowAllPermissions,
}

describe("bashTool", () => {
  let originalCwd: string
  let tmpDir: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-test-"))
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("captures stdout and reports exit 0 for echo", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain("hello")
      expect(result.output).toContain("[exit: 0]")
    }
  })

  it("captures non-zero exit codes", async () => {
    const result = await bashTool.execute({ command: "exit 42" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain("[exit: 42]")
    }
  })

  it("captures stderr", async () => {
    const result = await bashTool.execute({ command: "echo oops 1>&2" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain("oops")
      expect(result.output).toContain("[exit: 0]")
    }
  })

  it("includes both stdout and stderr in combined output", async () => {
    const result = await bashTool.execute({ command: "echo out; echo err 1>&2" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain("out")
      expect(result.output).toContain("err")
      expect(result.output).toContain("[exit: 0]")
    }
  })

  it("supports shell pipes", async () => {
    const result = await bashTool.execute({ command: "echo -e 'a\\nb\\nc' | wc -l" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toMatch(/\b3\b/)
      expect(result.output).toContain("[exit: 0]")
    }
  })

  it("runs in process.cwd()", async () => {
    const realTmp = await fs.realpath(tmpDir)
    process.chdir(realTmp)

    const result = await bashTool.execute({ command: "pwd" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain(realTmp)
      expect(result.output).toContain("[exit: 0]")
    }
  })

  it("captures signal when process is killed", async () => {
    const result = await bashTool.execute({ command: "kill -TERM $$" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      // Note (Ezra, 2026-04-22): some shells exit with a non-zero code instead of reporting a signal when the process self-terminates; accept either.
      const hasSignal = result.output.includes("[signal:")
      const hasNonZeroExit = /\[exit: (?!0\])\d+\]/.test(result.output)
      expect(hasSignal || hasNonZeroExit).toBe(true)
    }
  })

  it("treats empty command as a no-op with exit 0", async () => {
    const result = await bashTool.execute({ command: "" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain("[exit: 0]")
    }
  })

  it("rejects invalid args via executeToolCall schema validation", async () => {
    const registry = new ToolRegistry()
    registry.register(bashTool)

    const result = await executeToolCall({ id: "call-1", name: "bash", args: {} }, registry, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/invalid args for bash/)
      expect(result.error).toMatch(/command/)
    }
  })

  it("handles long output without dropping lines", async () => {
    const result = await bashTool.execute({ command: "seq 1 1000" }, ctx)

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.output).toContain("1000")
      expect(result.output).toContain("[exit: 0]")
    }
  })
})
