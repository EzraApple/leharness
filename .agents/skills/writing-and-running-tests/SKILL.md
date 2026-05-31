---
name: writing-and-running-tests
description: Use when adding, changing, debugging, running, or reviewing tests and smoke checks for leharness, including harness event-flow smoke tests, MCP transport tests, CLI/TUI smoke scripts, fake providers, async assertions, and package verification.
---

# Writing And Running Tests

Tests in this repo should exercise the real contract whenever behavior crosses a package boundary. Prefer narrow helper checks for pure logic, but use smoke scripts for invocation flow, event logs, MCP, CLI, TUI, tasks, subagents, skills, artifacts, and compaction.

## Choose the Right Check

| Scenario | Preferred coverage | Command |
| --- | --- | --- |
| Pure parser/helper with no runtime flow | Focused unit-style assertion near existing script coverage | `pnpm -r build` plus targeted script if one exists |
| Harness invocation, events, tools, tasks, subagents, skills, artifacts, compaction | Harness smoke script | `pnpm smoke:harness` |
| MCP protocol, config, stdio/http transport, auth, manager lifecycle | MCP smoke script | `pnpm smoke:mcp` |
| CLI built-ins, runtime setup, TUI transcript/prompt/picker behavior | App smoke script | `pnpm smoke:apps` |
| Public exports, dependencies, package metadata | Export and package checks | `pnpm knip`, `pnpm package:verify` |
| Broad cross-boundary change | Full sweep | `pnpm smoke` |

Run the specific relevant command immediately after changing a test or smoke script. Do not defer all feedback to the final full sweep.

## Smoke Test Style

- Test the durable contract: event types, payload fields, prompt projection, task terminal states, artifact IDs, MCP message shape, or transcript cells.
- Keep fake providers deterministic. If a scripted response is missing, throw a useful error instead of returning a default.
- Prefer one regression assertion plus the adjacent success path when the branch is risky.
- Use temporary `LEHARNESS_HOME` directories for session-state tests.
- Keep smoke scripts independent. A script should not depend on state produced by another script.
- When asserting dynamic `unknown` event fields, narrow them before template-string output so type-aware lint can check the script.
- Do not add sleeps as synchronization unless the behavior under test is timing itself. Prefer observable events, promises, or explicit drains.

## Event-Driven Assertions

For harness behavior, assert the event log and the projected behavior.

Good checks:

- `events.map((event) => event.type)` includes the expected lifecycle.
- A `tool.completed`, `task.completed`, `compaction.completed`, or `artifact.created` event carries the expected payload.
- The next prompt projection includes or omits the expected tool body, summary, reasoning, or artifact stub.
- The TUI transcript reducer converts the same event into the expected cell state.

Weak checks:

- Only asserting a helper return value when the real path records events.
- Only checking console output when the durable state is in `events.jsonl`.
- Only testing the happy path for cancellation, background tasks, or streams.

## Async and Cancellation Tests

- Exercise cancellation paths for providers, shell tasks, subagents, and MCP transports when changing ownership or cleanup.
- Assert that background output drains into events across invocation boundaries.
- If a promise is intentionally detached, test the eventual event or side effect that makes it safe.
- For streams, test both normal completion and early close/error when practical.

## Test Hygiene

- Keep tests readable over clever. Smoke scripts double as executable examples for future agents.
- Use descriptive variable names in callbacks and assertions.
- Avoid `as` casts in tests for the same reason as production code: they hide malformed fixtures.
- Do not ignore test scripts from lint. Correctness lint catches exactly the loose boundaries agents often introduce in tests.

## Verification Before Handoff

- Test-only or skill-only edit: `pnpm lint`
- Harness behavior: `pnpm lint && pnpm smoke:harness`
- MCP behavior: `pnpm lint && pnpm smoke:mcp`
- CLI/TUI behavior: `pnpm lint && pnpm smoke:apps`
- Cross-boundary behavior: `pnpm lint && pnpm smoke`
- Export/package change: add `pnpm knip` and `pnpm package:verify`
