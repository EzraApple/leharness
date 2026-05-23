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

- `001-mvp-core-harness.md` — historical MVP implementation plan. The final
  PR kept the CLI-first kernel, event log, tool runtime, and provider
  abstraction, but simplified away the reducer/session/transcript layer and
  deferred TUI/product polish.
- `002-npm-cli-distribution.md` — npm package/name plan for publishing
  `leharness` with the `lh` CLI command, first-run setup, and update story.
- `003-first-class-skills.md` — plan for workspace skill discovery, compact
  skill catalogs, `load_skill`, hot reload, and smoke coverage.
- `005-subagents.md` — plan for isolated subagents as a new `TaskKind ===
  "delegated"`. Ships a `SubagentExecutor`, a per-session `spawn_subagent`
  tool, and programmatic `SubagentPreset` registration. Reuses the
  `MessageQueue` + `wait_task` / `read_task` / `cancel_task` primitives
  from the background-tasks work merged in #18. Plan 004 (background
  tasks) was implemented directly in that PR's commits rather than
  landing as a separate plans/ file — see #18 for the design history.
- `006-artifacts.md` — plan for a session-scoped artifact storage primitive
  in `.leharness/sessions/<id>/artifacts/`. The harness auto-artifacts any
  tool result (or background task completion) over 8KB, writes the content
  to disk, and replaces the in-context value with a short stub + the
  `artifact_id`. A built-in `read_artifact` tool fetches full content or a
  paginated slice. Foundation for the next plan (smart compaction). The
  same PR also renames `packages/harness/src/harness/` →
  `packages/harness/src/core/`.
