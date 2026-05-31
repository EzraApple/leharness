---
name: development-workflow
description: Use when changing this repo, preparing or updating a PR, creating branches or commits, choosing verification commands, fixing knip or package checks, summarizing a diff, or deciding whether work belongs in .agents/skills, .claude/skills, or .leharness/skills.
---

# Development Workflow

Use this skill for repo-operation work: planning a change, keeping the branch clean, selecting checks, creating PRs, explaining diffs, and keeping agent-facing docs aligned with code. This root owns routing; read only the nested doc that matches the current task.

## Route the Work

| Task | Read |
| --- | --- |
| Make a repo change, understand ownership, or keep the worktree clean | `.agents/skills/development-workflow/workflow.md` |
| Choose checks, fix `knip`, or decide whether package verification is needed | `.agents/skills/development-workflow/verification.md` |
| Create a branch, commit, push, open a PR, or write/update a PR description | `.agents/skills/development-workflow/pr.md` |
| Add, edit, rename, consolidate, or place skills and agent guidance | `writing-skills`, then `.agents/skills/development-workflow/verification.md` |
| TypeScript cleanup or lint-rule fix | `typescript-best-practices` |
| Test or smoke script change | `writing-and-running-tests` |
| Architecture-sensitive harness change | `harness-architecture` |

## Boundaries

- Use `.agents/skills` for repo developer-agent guidance and mirror it through `.claude/skills` symlinks.
- Use `.leharness/skills` only for runtime behavior the harness product should discover.
- Use `harness-architecture` for event, provider, tool, task, MCP, compaction, CLI, and TUI ownership decisions.
- Use `review` when the task is evaluating a PR rather than changing it.
