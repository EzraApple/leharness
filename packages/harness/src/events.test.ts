import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  appendEvent,
  type Event,
  loadEvents,
  newEventId,
  nowIso,
  resolveLeharnessHome,
  resolveSessionPath,
} from "./events.js"

type TestContext = {
  home: string
  sessionId: string
  cleanup: () => Promise<void>
}

async function createContext(): Promise<TestContext> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "leharness-events-"))
  const previous = process.env.LEHARNESS_HOME
  process.env.LEHARNESS_HOME = home
  const sessionId = newEventId()
  return {
    home,
    sessionId,
    cleanup: async () => {
      if (previous === undefined) {
        delete process.env.LEHARNESS_HOME
      } else {
        process.env.LEHARNESS_HOME = previous
      }
      try {
        await fs.rm(home, { recursive: true, force: true })
      } catch {}
    },
  }
}

describe("events", () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createContext()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  it("round-trips a sequence of varied events", async () => {
    const events: Event[] = [
      { type: "invocation.received", v: 1, id: newEventId(), ts: nowIso(), text: "hi" },
      { type: "step.started", v: 1, id: newEventId(), ts: nowIso(), stepNumber: 1 },
      {
        type: "model.completed",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        text: "thinking",
        toolCalls: [{ id: "tc_1", name: "read_file", args: { path: "a.txt" } }],
        usage: { promptTokens: 10, completionTokens: 5 },
      },
      {
        type: "tool.completed",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        call: { id: "tc_1", name: "read_file", args: { path: "a.txt" } },
        result: "file contents",
      },
      {
        type: "agent.finished",
        v: 1,
        id: newEventId(),
        ts: nowIso(),
        reason: "model_returned_no_tool_calls",
      },
    ]

    for (const event of events) {
      await appendEvent(ctx.sessionId, event)
    }

    const loaded = await loadEvents(ctx.sessionId)
    expect(loaded).toEqual(events)
  })

  it("returns an empty array for a session that has never been written", async () => {
    const result = await loadEvents(newEventId())
    expect(result).toEqual([])
  })

  it("creates the session directory lazily on first append", async () => {
    const sessionDir = path.dirname(resolveSessionPath(ctx.sessionId))
    await expect(fs.access(sessionDir)).rejects.toThrow()

    await appendEvent(ctx.sessionId, {
      type: "step.started",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      stepNumber: 1,
    })

    await expect(fs.access(sessionDir)).resolves.toBeUndefined()
  })

  it("isolates events between sessions", async () => {
    const sessionA = newEventId()
    const sessionB = newEventId()
    const event: Event = {
      type: "invocation.received",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      text: "session A",
    }
    await appendEvent(sessionA, event)

    expect(await loadEvents(sessionB)).toEqual([])
    expect(await loadEvents(sessionA)).toEqual([event])
  })

  it("throws a clear error when a line cannot be parsed", async () => {
    const validEvent: Event = {
      type: "step.started",
      v: 1,
      id: newEventId(),
      ts: nowIso(),
      stepNumber: 1,
    }
    await appendEvent(ctx.sessionId, validEvent)

    const filePath = resolveSessionPath(ctx.sessionId)
    await fs.appendFile(filePath, "this is not json\n")

    await expect(loadEvents(ctx.sessionId)).rejects.toThrow(
      new RegExp(`line 2.*sessionId=${ctx.sessionId}`),
    )
  })

  it("honors LEHARNESS_HOME for path resolution", () => {
    const override = path.join(os.tmpdir(), "leharness-override-test")
    process.env.LEHARNESS_HOME = override
    expect(resolveLeharnessHome()).toBe(path.resolve(override))
    expect(resolveSessionPath("abc")).toBe(
      path.join(path.resolve(override), "sessions", "abc", "events.jsonl"),
    )
  })

  it("defaults to <cwd>/.leharness when LEHARNESS_HOME is unset", () => {
    delete process.env.LEHARNESS_HOME
    expect(resolveLeharnessHome()).toBe(path.resolve(process.cwd(), ".leharness"))
    expect(resolveSessionPath("xyz")).toBe(
      path.join(path.resolve(process.cwd(), ".leharness"), "sessions", "xyz", "events.jsonl"),
    )
  })

  it("uses an absolute LEHARNESS_HOME as-is rather than re-resolving against cwd", () => {
    const absolute = path.join(os.tmpdir(), "leharness-absolute-test")
    expect(path.isAbsolute(absolute)).toBe(true)
    process.env.LEHARNESS_HOME = absolute
    expect(resolveLeharnessHome()).toBe(absolute)
    expect(resolveSessionPath("sid")).toBe(path.join(absolute, "sessions", "sid", "events.jsonl"))
  })
})
