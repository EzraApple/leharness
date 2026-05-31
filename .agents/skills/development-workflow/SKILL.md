---
name: development-workflow
description: Use when changing this repo, preparing a PR, choosing verification commands, or summarizing the implementation and review surface for leharness work.
---

# Development Workflow

## Before Editing

- Inspect the current branch and dirty state with `git status --short`.
- Use `rg` for searches and read the local codepath before proposing a fix.
- Treat `.agents/skills` as repo agent guidance. Treat `.leharness/skills` as product-facing runtime fixtures unless the task is explicitly about harness skill discovery.

## Implementation

- Keep changes scoped to the package that owns the behavior.
- Preserve event log shapes, exported package APIs, and smoke-test contracts unless the task asks to change them.
- Prefer typed helpers at dynamic boundaries over repeated casts.
- Add tests or smoke coverage when behavior crosses package, CLI, TUI, MCP, task, provider, or compaction boundaries.

## Verification

Use the smallest loop that proves the change, then broaden before handoff:

- Formatting and lint: `pnpm lint`
- Typecheck: `pnpm -r build`
- Behavioral sweep: `pnpm smoke`
- Dead-code and export hygiene: `pnpm knip`
- Packaging: `pnpm package:verify`

## PR Notes

Write the PR around why the change exists, the behavioral surface that changed, and what was verified. Avoid long implementation inventories unless reviewers need them to evaluate risk.
