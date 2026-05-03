# Plans

Numbered implementation plans for `leharness`. Each plan is a working
document that captures decisions, scope, and execution order for one
coherent piece of work.

Convention:

- Filenames are `NNN-short-slug.md`, with `NNN` zero-padded and monotonically
  increasing. The number is the plan's identity; the slug is for humans.
- Plans get a branch named `plan/short-slug` while in review. Once approved,
  implementation happens on per-phase branches like `feat/<slug>-phase-N` or
  similar, each merged via PR.
- Plans are not retroactively edited after implementation begins. If the plan
  changes meaningfully, supersede it with a new numbered plan that references
  the old one.

Index:

- `001-mvp-core-harness.md` — initial CLI-first kernel: event log, reducer,
  loop, tool runtime, provider abstraction (OpenAI + Ollama), and a TUI on top.
- `002-npm-cli-distribution.md` — npm package/name plan for publishing
  `leharness` with the `lh` CLI command, first-run setup, and update story.
