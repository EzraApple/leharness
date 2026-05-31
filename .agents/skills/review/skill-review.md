# Skill Review

Check whether a PR's code changes have made `AGENTS.md`, `.agents/skills`, `.claude/skills`, or runtime skill guidance stale.

## When to Use

- Full PR reviews
- Explicit requests to check skill or agent-guidance drift
- Large refactors that rename files, commands, exports, event shapes, or package boundaries

Skip this for dependency-only, formatting-only, or typo-only PRs unless they touch agent guidance directly.

## What to Scan

- `AGENTS.md`
- `.agents/skills/**`
- `.claude/skills/**` symlink layout
- `.leharness/skills/**` when runtime skill discovery changed

## Process

1. Get the changed files and diff.
2. Extract symbols that agent guidance might reference:
   - File paths and directory names
   - Script names and CLI commands
   - Exported functions, types, classes, and public fields
   - Event names and payload fields
   - Environment variables and package names
   - Skill directory names and symlink targets
3. Grep only those symbols in agent guidance.
4. Read matching candidates and confirm whether the reference is stale.
5. Score only High or Medium findings:
   - **High:** Guidance points to a path, command, symbol, or behavior that no longer exists or is now wrong.
   - **Medium:** Guidance still works but misses a new preferred path introduced by the PR.

## Common Mistakes

- Reading every skill before grepping. Search first, then read candidates.
- Flagging general guidance just because code changed nearby.
- Treating `.leharness/skills` and `.agents/skills` as interchangeable.
- Forgetting that `.claude/skills` should mirror `.agents/skills` by symlink.

## Output

```markdown
**Skill review**

1. **HIGH | MEDIUM** - `<path>`
   Line: <line>
   Reason: <what changed and why this guidance is now stale>
```

If there are no real findings:

```markdown
No skill/config drift findings.
```
