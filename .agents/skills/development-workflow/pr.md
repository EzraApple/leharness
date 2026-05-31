# PR Flow

Use this doc when committing, pushing, creating a PR, or writing/updating a PR description.

## Standard Flow

1. Confirm the worktree contains only intended changes:

   ```bash
   git status --short
   git branch --show-current
   ```

2. Run relevant checks from `.agents/skills/development-workflow/verification.md` unless they already ran after the latest relevant edit.
3. Stage and commit the intended changes. Use a concise title that names the system change.
4. Push the branch with upstream tracking when needed.
5. Create the PR against `main`.

For a fast PR request, commit and open the PR first, then run checks and push fixups.

## PR Description

A PR description exists for the reviewer. Explain why the PR exists, what system idea changed, what the reviewer should scrutinize, and what was verified.

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
