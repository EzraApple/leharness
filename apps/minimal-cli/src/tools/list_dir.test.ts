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
import { listDirTool } from "./list_dir.js"

const ctx: ToolContext = {
  sessionId: "test-session",
  permission: allowAllPermissions,
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-list-dir-"))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("listDirTool", () => {
  it("returns an empty string for an empty directory", async () => {
    const result = await listDirTool.execute({ path: tmpRoot }, ctx)
    expect(result).toEqual({ kind: "ok", output: "" })
  })

  it("returns a sorted listing with mixed entries (file, dir, dotfile)", async () => {
    await fs.writeFile(path.join(tmpRoot, "alpha.txt"), "a")
    await fs.mkdir(path.join(tmpRoot, "subdir"))
    await fs.writeFile(path.join(tmpRoot, ".hidden"), "h")

    const result = await listDirTool.execute({ path: tmpRoot }, ctx)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.output).toBe([".hidden", "alpha.txt", "subdir/"].join("\n"))
  })

  it("returns just the filename for a single-file directory", async () => {
    await fs.writeFile(path.join(tmpRoot, "only.txt"), "data")
    const result = await listDirTool.execute({ path: tmpRoot }, ctx)
    expect(result).toEqual({ kind: "ok", output: "only.txt" })
  })

  it("marks symlinks with a trailing @", async () => {
    const targetFile = path.join(tmpRoot, "real.txt")
    await fs.writeFile(targetFile, "real")
    try {
      await fs.symlink(targetFile, path.join(tmpRoot, "link"))
    } catch (err) {
      // Note (Ezra, 2026-04-22): some platforms (notably Windows without dev mode)
      // refuse symlink creation; skip rather than fail the suite.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`skipping symlink test: ${message}`)
      return
    }

    const result = await listDirTool.execute({ path: tmpRoot }, ctx)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.output).toBe(["link@", "real.txt"].join("\n"))
  })

  it("returns an error when the directory does not exist", async () => {
    const missing = path.join(tmpRoot, "does-not-exist")
    const result = await listDirTool.execute({ path: missing }, ctx)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.message).toMatch(/list_dir failed:/)
    expect(result.message).toMatch(/ENOENT|no such/i)
  })

  it("returns an error when the path is a file, not a directory", async () => {
    const filePath = path.join(tmpRoot, "file.txt")
    await fs.writeFile(filePath, "x")
    const result = await listDirTool.execute({ path: filePath }, ctx)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.message).toMatch(/list_dir failed:/)
    expect(result.message).toMatch(/ENOTDIR|not a directory/i)
  })

  it("sorts entries case-insensitively and locks the order", async () => {
    await fs.writeFile(path.join(tmpRoot, "z"), "")
    await fs.writeFile(path.join(tmpRoot, "a"), "")
    await fs.writeFile(path.join(tmpRoot, "M"), "")

    const result = await listDirTool.execute({ path: tmpRoot }, ctx)
    expect(result).toEqual({ kind: "ok", output: ["a", "M", "z"].join("\n") })
  })

  it("surfaces schema validation errors when invoked through executeToolCall", async () => {
    const registry = new ToolRegistry()
    registry.register(listDirTool)

    const result = await executeToolCall(
      { id: "call-1", name: "list_dir", args: {} },
      registry,
      ctx,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/invalid args for list_dir/)
    expect(result.error).toMatch(/path/)
  })
})
