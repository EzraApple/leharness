---
name: writing-and-running-tests
description: Use when adding, changing, debugging, or choosing tests and smoke checks for leharness code.
---

# Writing And Running Tests

## Choosing Coverage

- For pure helpers, add focused unit-style coverage near the existing smoke or script surface.
- For invocation, tasks, subagents, compaction, MCP, or TUI behavior, prefer smoke tests that exercise the real event flow.
- For exported API changes, run package verification when practical.

## Existing Commands

- `pnpm lint` checks formatting, lint rules, and repo skill layout.
- `pnpm -r build` typechecks every workspace package.
- `pnpm smoke:harness` covers harness core behavior.
- `pnpm smoke:mcp` covers MCP protocol, transport, and manager paths.
- `pnpm smoke:apps` covers CLI and TUI integration paths.
- `pnpm smoke` runs the full smoke sweep.
- `pnpm knip` checks unused exports and dependencies.

## Test Style

- Assert event types and payload fields directly when behavior is event-driven.
- Keep fake providers deterministic and fail loudly when scripted responses are exhausted.
- Prefer one test for the regression and one for the important adjacent success path when the branch is risky.
