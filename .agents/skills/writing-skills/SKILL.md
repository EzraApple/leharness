---
name: writing-skills
description: Use when creating or editing repo skills, agent instructions, or agent-facing workflow docs for leharness.
---

# Writing Skills

## Layout

- Put shared repo skills in `.agents/skills/<skill-name>/SKILL.md`.
- Mirror each skill into `.claude/skills/<skill-name>` with a symlink to `../../.agents/skills/<skill-name>`.
- Do not put agent workflow guidance in `.leharness/skills`; that directory is for runtime behavior the harness product should load.

## Content

- Keep `SKILL.md` concise and procedural.
- Frontmatter must include `name` and `description`.
- Make the description broad enough to trigger at the right time, but not so broad that it fires on unrelated tasks.
- Prefer current repo commands and paths over generic advice.
- Split large reference material into direct child files only when the skill would otherwise become noisy.

## Validation

Run `pnpm lint:agent-skills` after adding, removing, renaming, or symlinking skills.
