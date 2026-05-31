---
name: review
description: Use when reviewing a pull request, reviewing code changes, checking architecture, checking API or event boundaries, finding simplification opportunities, checking tests, or checking whether AGENTS.md and .agents/skills guidance is stale.
---

# Review

Entry point for review work. Route to the smallest review mode that matches the user's request.

## Routing

- **Full PR review:** If the user asks to review a PR, run code review, architecture review, and skill/config drift review.
- **Code review only:** If the user asks for bugs, regressions, standards, tests, or changed-code review, follow `.agents/skills/review/code-review.md`.
- **Architecture review only:** If the user asks for architecture, maintainability, simplicity, alternatives-considered, ownership, or boundary review, follow `.agents/skills/review/architecture-review.md`.
- **Skill/config drift review only:** If the user explicitly asks whether skills, `AGENTS.md`, `.claude/skills`, or agent guidance is stale, follow `.agents/skills/review/skill-review.md`.

Do not run skill/config drift review for ordinary code-only requests. It is part of full PR review because code changes can make agent guidance stale.

## Full PR Review Process

1. Resolve PR context:
   - `gh pr view --json number,headRefOid,body,files`
   - `gh pr diff`
2. Read `AGENTS.md`.
3. Run the relevant passes:
   - Code review: `.agents/skills/review/code-review.md`
   - Architecture review: `.agents/skills/review/architecture-review.md`
   - Skill review: `.agents/skills/review/skill-review.md`
4. Combine findings. Use inline comments only for concrete, line-specific issues. Put architecture and skill-drift findings in the summary unless they have an exact line target.

## Output Shape

Lead with findings. If there are no findings, say so directly and mention any residual verification gap.

For full PR reviews, use this order:

1. Bugs and standards
2. Architecture review
3. Skill review
