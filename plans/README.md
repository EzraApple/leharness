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
- `007-smart-compaction.md` — plan for a pressure-gradient compaction
  strategy that replaces `naive-truncate`. Cheap structural tiers (drop
  old reasoning, retroactively artifact inline tool results, drop old
  tool message bodies) kick in at intermediate watermarks (50% / 65% /
  75% of budget); LLM-summarized turn windows fire above 85% / 95% with
  handoff-style "state of play" briefs cached as `compaction.summary`
  events keyed to source event-id ranges. Re-projection from raw
  `events.jsonl` every step means no compounded loss. Plan-008 hooks
  for cheaper summarizer models and token-accurate budgets.
- `008-terminal-bench.md` — evaluation integration. Adds an in-repo
  `evals/terminal_bench/` adapter (Python, ~100 lines extending Harbor's
  `BaseInstalledAgent`) that drives `lh` against the published npm
  package inside Harbor-managed Docker/Daytona sandboxes. First 89-task
  baseline (leharness 0.3.0 + DeepSeek-v4-flash) landed 31% pass rate /
  $0.64 / 1h27m on local Docker — and identified the kernel's
  `DEFAULT_MAX_STEPS = 25` ceiling as the single biggest bottleneck (44
  of 51 failures hit it mid-productive-work).
- `009-mcp-integration.md` — MCP client as a self-contained
  `@leharness/mcp` package the products bundle (kernel stays untouched
  except one additive `Tool.jsonSchema` field). Vendors the small,
  stable client surface (jsonrpc + stdio/HTTP transports + OAuth flow)
  rather than the full official SDK, leaning on 3 focused deps
  (`eventsource-parser`, `pkce-challenge`, `jose`) for the dangerous
  crypto bits. v1 = tools only, all three auth tiers (stdio / HTTP
  bearer / OAuth+PKCE), config in `.leharness/mcp.json` matching the
  Claude Code / Cursor / Cline format.
- `010-tool-agnostic-kernel.md` — make the kernel auto-inject no
  model-facing capability tools. The async surface is already generic
  (`Tool.execute` returns inline-or-handle; `TaskExecutor` /
  `SessionTaskServices`); the coupling is package boundaries,
  `prepare-prompt` hard-importing built-ins, and artifact storage reaching
  into execution/compaction. Invert via a `Capability` hook plus a
  `LargeOutputStore` interface, then extract each capability into its own
  package (`@leharness/exec`, `/subagents`, `/artifacts`, `/skills`)
  layered over the kernel.
