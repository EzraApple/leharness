---
name: review
description: Use when reviewing leharness changes for bugs, regressions, missing tests, API drift, or maintainability risk.
---

# Review

## Review Order

1. Identify the changed contract: public API, event shape, task lifecycle, provider behavior, MCP transport/auth, TUI state, or docs only.
2. Read the implementation and the closest smoke coverage.
3. Look for behavioral regressions, missing validation, unhandled async errors, stale replay/resume behavior, and packaging drift.
4. Report findings first, ordered by severity, with file and line references.

## What To Prioritize

- Event replay/resume compatibility.
- Promise ownership and cancellation paths.
- Dynamic payload parsing at JSON, MCP, provider, and event boundaries.
- TUI state/render mismatches.
- Public package exports and package verification.
- Tests that exercise the real path rather than only local helpers.

## Output Shape

For review requests, lead with findings. If there are no findings, say that directly and note the remaining test or verification gap.
