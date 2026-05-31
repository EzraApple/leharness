---
name: development-workflow
description: Use when changing this repo, preparing or updating a PR, creating branches or commits, choosing verification commands, fixing knip or package checks, summarizing a diff, or deciding whether work belongs in .agents/skills, .claude/skills, or .leharness/skills.
---

# Development Workflow

Use this skill for repo-operation work: planning a change, keeping the branch clean, selecting checks, creating PRs, explaining diffs, and keeping agent-facing docs aligned with code.

## Route the Work

| Task | Follow |
| --- | --- |
| Code or docs change | "Working Loop" and "Verification Matrix" below |
| PR creation or PR update | "PR Flow" and "PR Description" below |
| Skill or agent-guidance edit | `writing-skills` plus `pnpm lint:agent-skills` |
| TypeScript cleanup or lint fix | `typescript-best-practices` |
| Test or smoke change | `writing-and-running-tests` |
| Architecture-sensitive harness change | `harness-architecture` |
| Unused code, stale exports, or dependency cleanup | Run `pnpm knip` and remove the real dead surface |

## Working Loop

1. Inspect branch and dirty state with `git status --short` and `git branch --show-current`.
2. Search with `rg` before editing. Read the codepath that owns the behavior.
3. Identify the contract being touched: public exports, event log shape, provider response, tool result, task lifecycle, MCP transport/auth, TUI transcript state, packaging, or docs only.
4. Make the smallest change that fits the existing ownership boundary.
5. Run the narrowest useful command while iterating, then broaden before handoff.

Do not use `.leharness/skills` for repo workflow guidance. That directory is product/runtime discovery input. Repo developer guidance lives in `.agents/skills` and is mirrored into `.claude/skills`.

## Verification Matrix

| Change surface | Minimum check | Broaden when |
| --- | --- | --- |
| Formatting, lint rules, TypeScript patterns, skills | `pnpm lint` | Always before PR handoff |
| Package TypeScript or public types | `pnpm -r build` | Exports, provider, MCP, CLI, or TUI changed |
| Harness behavior, events, tools, tasks, compaction, skills | `pnpm smoke:harness` or `pnpm smoke` | Behavior crosses package or app boundaries |
| MCP protocol, auth, transport, manager | `pnpm smoke:mcp` | Any MCP package change |
| CLI or TUI behavior | `pnpm smoke:apps` | Transcript, prompt input, slash commands, or app scripts changed |
| Exports, dependencies, unused code | `pnpm knip` | Public exports or package manifests changed |
| NPM package output or launcher | `pnpm package:verify` | Packaging, CLI bundle, exports, or package metadata changed |

If a command has already run recently in this conversation after the relevant change, do not rerun it just for ceremony. If new edits touched that surface, rerun it.

## PR Flow

1. Make sure the worktree contains only intended changes.
2. Run relevant checks from the matrix unless the user explicitly asks for a fast PR.
3. Commit with a concise title that names the system change.
4. Push the current branch.
5. Create the PR against `main`.

For a fast PR request, commit and open the PR first, then run checks and push fixups.

## PR Description

A PR description exists for the reviewer. It should explain why the PR exists, what system idea changed, what the reviewer should scrutinize, and what was verified.

Use this shape by default:

```markdown
<1-4 sentence abstract in plain language. No file inventory.>

## Changes
- <Concept-level change, grouped by ownership boundary.>
- <Another concept-level change, if needed.>

## Verification
- `<command>`
```

Calibrate depth:

- Tiny fix: one sentence plus verification is enough.
- Medium behavior change: abstract, changes grouped by concept, verification.
- Cross-boundary architecture change: add a short design decision or Mermaid diagram only if it makes ownership clearer.
- Agent guidance or lint PR: explain the behavior the future agent or lint rule should enforce, not just which files were added.

Avoid wide tables in PR bodies. Avoid N/A sections. Do not narrate every file changed.
