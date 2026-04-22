import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Event } from "./events.js"
import { initialSessionState, projectSession, reduce, type SessionState } from "./session.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, "__fixtures__")

const FIXTURES = [
  "empty",
  "single_user_message",
  "simple_no_tools",
  "single_tool_round_trip",
  "tool_failure_recovery",
  "multi_tool_in_one_step",
] as const

async function loadFixture(name: string): Promise<{ events: Event[]; expected: SessionState }> {
  const eventsPath = path.join(FIXTURES_DIR, `${name}.events.jsonl`)
  const expectedPath = path.join(FIXTURES_DIR, `${name}.expected.json`)
  const [eventsRaw, expectedRaw] = await Promise.all([
    fs.readFile(eventsPath, "utf8"),
    fs.readFile(expectedPath, "utf8"),
  ])
  const events: Event[] = eventsRaw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Event)
  const expected = JSON.parse(expectedRaw) as SessionState
  return { events, expected }
}

describe("projectSession (golden fixtures)", () => {
  for (const name of FIXTURES) {
    it(`projects ${name} to the expected state`, async () => {
      const { events, expected } = await loadFixture(name)
      const actual = projectSession(events)
      expect(actual).toEqual(expected)
    })
  }
})

describe("reduce", () => {
  it("does not mutate the input state", () => {
    const state: SessionState = {
      transcript: [{ kind: "user", text: "hi" }],
    }
    const snapshot = structuredClone(state)
    const event: Event = {
      v: 1,
      id: "01JTESTNOMUT0000000000000001",
      ts: "2026-04-22T00:00:00.000Z",
      type: "model.completed",
      text: "hello back",
      toolCalls: [],
    }
    const next = reduce(state, event)
    expect(state).toEqual(snapshot)
    expect(next).not.toBe(state)
    expect(next.transcript).not.toBe(state.transcript)
  })

  it("throws on an unknown event type", () => {
    const state = initialSessionState()
    const bogus = {
      type: "unknown.event",
      v: 1,
      id: "x",
      ts: "y",
    } as unknown as Event
    expect(() => reduce(state, bogus)).toThrow(/unreachable event type/)
  })

  it("treats step.started, model.requested, model.failed, tool.started, and agent.finished as no-ops", () => {
    const state: SessionState = {
      transcript: [{ kind: "user", text: "hi" }],
    }
    const noopEvents: Event[] = [
      {
        v: 1,
        id: "01JNOOP000000000000000STEP01",
        ts: "2026-04-22T00:00:00.000Z",
        type: "step.started",
        stepNumber: 1,
      },
      {
        v: 1,
        id: "01JNOOP000000000000000MREQ01",
        ts: "2026-04-22T00:00:00.001Z",
        type: "model.requested",
        request: {},
      },
      {
        v: 1,
        id: "01JNOOP000000000000000MFLD01",
        ts: "2026-04-22T00:00:00.002Z",
        type: "model.failed",
        error: "boom",
      },
      {
        v: 1,
        id: "01JNOOP000000000000000TST001",
        ts: "2026-04-22T00:00:00.003Z",
        type: "tool.started",
        call: { id: "c1", name: "noop", args: {} },
      },
      {
        v: 1,
        id: "01JNOOP000000000000000FIN001",
        ts: "2026-04-22T00:00:00.004Z",
        type: "agent.finished",
        reason: "no_tool_calls",
      },
    ]
    for (const event of noopEvents) {
      const next = reduce(state, event)
      expect(next).toEqual(state)
    }
  })
})

describe("projectSession", () => {
  it("returns initialSessionState() for an empty array", () => {
    expect(projectSession([])).toEqual(initialSessionState())
  })

  it("is deterministic across repeated invocations on the same events", async () => {
    const { events } = await loadFixture("single_tool_round_trip")
    const a = projectSession(events)
    const b = projectSession(events)
    expect(a).toEqual(b)
  })
})
