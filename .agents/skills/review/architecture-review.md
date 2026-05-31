# Architecture Review

Architecture review asks whether the chosen shape is the simplest maintainable one for this repo. The goal is not to invent a different design; it is to surface unacknowledged complexity and boundary drift.

## What to Look For

- A new abstraction, file, or path where a small extension of the existing owner would work.
- Parallel event, tool, task, provider, MCP, or TUI paths that could share one contract.
- Stateful or async machinery where a synchronous or pure function would do.
- A public export added for a single app-local caller.
- File growth that makes ownership less clear and has an obvious local extraction.
- PR description missing the tradeoff for a meaningful new structure.

## Leharness-Specific Questions

- Does this keep event log compatibility and replay behavior clear?
- Does this normalize external quirks at the provider or MCP adapter boundary?
- Does this preserve one tool/task result shape across local tools, MCP, shell, and subagents?
- Does this let CLI and TUI project from the same events?
- Does compaction still project from canonical history rather than mutating history?
- Is `.leharness/skills` being used only for runtime product behavior, not repo workflow guidance?

## Process

1. Read the PR description before the diff. Note whether it explains the chosen approach and verification.
2. Read the changed files and identify new ownership boundaries.
3. For each meaningful boundary, ask: what existing path could have owned this, and did the PR rule that out?
4. Raise at most three architecture findings. If none are concrete, say there are no architecture findings.

## Output

Ask concrete questions rather than issuing vague redesign demands:

```markdown
**Architecture review**

1. `<file/function>` adds <new shape>. Did you consider <specific existing path> instead? I am asking because <repo-specific cost>.
```

Avoid comments like "this could be cleaner" or "consider abstraction." Name the current shape, the alternative, and why the question matters.
