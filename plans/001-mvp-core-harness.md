# 001 — MVP Core Harness

## Goal

Get the `leharness` kernel running end-to-end with a CLI entry point that can
execute simple multi-turn coding tasks against either a cloud (OpenAI) or
local (Ollama) model. Then put a small TUI on top so future feature work has
a real surface to test against.

The kernel must be debuggable, the architecture must hold the bets in the
README and `research/event-log-design.md`, and every phase must produce
something testable on its own before moving forward.

## Non-Goals

These exist as recognized seams but are explicitly out of scope for this plan:

- Background tasks, subagents, compaction, approvals, schema versioning,
  snapshots, SQLite indexes, MCP, plugins, skills, branchable history, web
  inspector, multi-agent fleets.

Each must be addable later without changing the loop, reducer, or event log.
If we hit something here that requires changing those, we stop and revisit.

## Decisions Locked In

| Area | Decision |
|---|---|
| Language / runtime | TypeScript + Node, pnpm workspaces, vitest |
| Repo layout | `packages/harness` (generic core) + `apps/minimal-cli` (thin wrapper, no UI/UX) |
| Source of truth | Append-only JSONL event log per session, one writer per session |
| Projection | Pure reducer (events → session state), fold-from-scratch every iteration; no memoization in MVP |
| Tool execution | Sequential only, auto-approve all (approval seam exists, no policy yet) |
| Large tool output | Truncated inline for MVP with a `[truncated: N bytes]` marker; filesystem-backed artifacts deferred to feature work |
| Providers | Provider-agnostic interface from day one; Ollama first, then OpenAI |
| Initial Ollama model | `gemma4:26b` (Gemma 4 MoE) |
| Streaming | Non-streaming for MVP (streaming is a TUI concern, not a loop concern) |
| Schema versioning | Every event carries `v: 1`; reducer doesn't dispatch on version yet |
| Storage | JSONL only; no SQLite index |
| Provider config | Env vars + `~/.leharness/config.json`; no per-session override yet |

## Repository Layout

```
leharness/
├── packages/
│   └── harness/
│       ├── src/               # NOTE: structure is being brainstormed separately
│       │                      # (reducer + session combined; provider in place of model;
│       │                      #  artifacts deferred). Final breakdown captured before
│       │                      #  Phase 0 starts.
│       └── package.json
├── apps/
│   └── minimal-cli/           # Basic stdin/argv parsing only, no UI/UX
│       ├── src/
│       │   ├── index.ts       # Entry point + arg parsing
│       │   ├── repl.ts        # REPL mode (line-in/line-out, no animation)
│       │   └── render.ts      # Plain-text output
│       └── package.json
├── plans/
├── research/
└── pnpm-workspace.yaml
```

The TUI ships as its own app (`apps/tui`) added in Phase 8 — a separate
process that tails session JSONL and projects independently.

## Phase 0 — Scaffolding

**Goal:** repo builds, tests run, nothing else.

Steps:

1. `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json` (strict).
2. `packages/harness` and `apps/minimal-cli` package skeletons with their own
   `tsconfig.json` extending root.
3. `vitest` configured at the root with workspace test discovery.
4. `biome` (or prettier+eslint, dealer's choice) for formatting and linting.
5. `.gitignore` adds `sessions/`, `.leharness/`, `node_modules/`, `dist/`.
6. One placeholder test in `packages/harness` that asserts `1 === 1` so CI
   has something to run.

**Done when:** `pnpm install && pnpm test && pnpm build` all pass from the
repo root with no errors.

## Phase 1 — Event Log Primitives

**Goal:** `appendEvent` and `loadEvents` work, in isolation.

Steps:

1. Define `Event` as a discriminated union. MVP set:
   - `invocation.received` — user message ingress
   - `step.started` / `step.completed` — bracket each loop iteration
   - `model.requested` / `model.completed` / `model.failed`
   - `tool.requested` (model asked) / `tool.started` / `tool.completed` / `tool.failed`
   - `agent.finished` — terminal state for the session
2. Every event has: `type`, `v: 1`, `id` (ulid), `ts` (ISO timestamp), plus
   type-specific fields.
3. `appendEvent(sessionId, event)`: `fs.appendFile` to
   `sessions/{id}/events.jsonl`, line-terminated, sync writes for now.
4. `loadEvents(sessionId)`: read whole file, split on newlines, parse each.
5. Discipline: `appendEvent` is exported from one module and the loop is the
   only thing that imports it. A simple grep check in CI later, not now.
6. Unit tests:
   - Round-trip: append N events, read back, deep-equal.
   - Malformed line tolerance: corrupt the file, ensure we surface a clear
     error (don't silently drop events).

**Done when:** `pnpm test` passes the events module suite, and
`cat sessions/test/events.jsonl | jq` shows pretty events.

## Phase 2 — Session Projection

**Goal:** pure function from events to session state, exhaustively tested.
The reducer *is* the projection — there's no separate "session" layer.

Steps:

1. Define `SessionState`:
   - `transcript`: array of typed turns (user message, assistant text,
     assistant tool calls, tool results)
   - `machine`: `idle | running | awaiting-tool | awaiting-user | failed`
   - `pendingToolCalls`: tool calls requested but not yet completed
   - `metadata`: provider, model, session start time
2. `reduce(state, event): SessionState` — exhaustive switch on `event.type`,
   no I/O, no `Date.now()` (timestamps come from events).
3. `projectSession(events): SessionState` — folds reducer over events from
   a fresh initial state.
4. Golden-fixture tests: each fixture is an input JSONL + an expected
   `SessionState` JSON. Start with ~6 fixtures:
   - empty session (just initial state)
   - single user message, no tools
   - user → model → finish
   - user → model → tool call → tool result → model → finish
   - tool failure path
   - malformed model response (parse error → `failed` state)

**Done when:** all golden fixtures pass and `projectSession` is the only
place in the codebase that builds a `SessionState`.

## Phase 3 — Channel + Loop Skeleton (No Real Model)

**Goal:** the loop runs end-to-end against a fake model. **This is the
architecture validation phase — spend time here.**

Steps:

1. `SessionChannel`: an async queue with `send(message)` and
   `async *drain()`. In-memory for MVP. One channel per session.
2. Channel message types:
   - `user.input` — text prompt from CLI/REPL
   - (placeholders for future) `task.completed`, `subagent.completed`
3. `runSession(sessionId, deps)` — the orchestrator:
   - Load events, project state.
   - Drain any waiting channel messages; for each, append the corresponding
     event (`user.input` → `invocation.received`).
   - Inspect `state.machine`:
     - `idle` with no pending input → wait on channel
     - `running` → call provider, append `model.requested` then `model.completed`
     - `awaiting-tool` → execute tool, append `tool.started` then
       `tool.completed`/`tool.failed`
     - `awaiting-user` → wait on channel
     - `failed` → append `agent.finished` and break
   - Loop until `machine === "failed"` or session is finished and channel is empty.
4. `FakeProvider` implementing the `Provider` interface (defined in Phase 5
   ahead of schedule, just enough to compile): returns canned responses.
5. Integration test: harness a fake provider that returns "I'm done" on first
   call, feed `user.input` to the channel, run loop, assert the JSONL trace
   matches an expected fixture.
6. Second integration test: fake provider that requests a (mock) tool on
   first call and a final response on second call. Validate the tool round-
   trip happens correctly even though we don't have real tools yet.

**Done when:** integration tests pass against the fake provider, and the
JSONL files they produce are legible end-to-end traces of what the loop did.

If anything about event shapes, state machine states, or the channel feels
wrong here, fix it now. Every later phase assumes this is right.

## Phase 4 — Tool Runtime

**Goal:** tools register, validate, and execute. Loop can do real tool calls.

Steps:

1. `Tool` interface:
   ```ts
   interface Tool {
     name: string
     description: string
     schema: ZodSchema
     execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
   }
   ```
2. `ToolRegistry`: register, lookup by name, list all (for prompt builder).
3. `executeTool(call, registry, ctx)`:
   - Validate args against schema; on failure, return `tool.failed` with
     parse error.
   - Run `tool.execute`.
   - If output exceeds a hard cap (start with 16kb), truncate inline and
     append a `[truncated: N bytes]` marker. Filesystem artifacts come
     later as feature work.
4. `ToolContext` carries session ID. (Permission handle is a stub returning
   `allow` — real seam, no policy yet.)
5. Three builtin tools to start:
   - `read_file(path)` — read file contents, truncate if large
   - `list_dir(path)` — list directory entries
   - `bash(command)` — exec via `child_process`, capture stdout+stderr,
     blocking, no timeout for MVP
6. Wire into the loop: when state machine is `awaiting-tool`, the loop pulls
   the pending tool call, executes it, appends the result event.
7. Tests:
   - Unit tests per tool (fixture filesystems for read/list, mocked exec for
     bash).
   - Integration test: fake provider requests `bash("echo hi")`, loop runs
     it, assistant sees the result, replies, finishes.

**Done when:** the fake-provider integration test exercises a real tool
call end-to-end.

## Phase 5 — Provider Abstraction + Two Implementations

**Goal:** the loop calls real models against either Ollama or OpenAI, chosen
by config.

Steps:

1. `Provider` interface:
   ```ts
   interface Provider {
     name: string
     call(req: ProviderRequest): Promise<ProviderResponse>
   }
   ```
   Plus `ProviderRequest` (system prompt, harness-internal messages, harness
   tools, model name, optional temperature) and `ProviderResponse` (content
   blocks, tool calls, usage, stop reason).
2. **Harness-internal types** for messages, content blocks, and tool calls.
   These are what the reducer and prompt builder deal with. Provider impls
   translate to/from native shapes.
3. `buildPrompt(state, tools): ProviderRequest`:
   - Static system prompt for now (can be templated later).
   - Convert `transcript` to `HarnessMessage[]`.
   - Pass registered tools as `HarnessTool[]`.
   - Resolve provider+model from config.
4. **Ollama implementation first** (`OllamaProvider`):
   - HTTP to `http://localhost:11434/v1/chat/completions` (Ollama's
     OpenAI-compat endpoint).
   - Use `openai` npm SDK with custom `baseURL` to keep the HTTP client
     simple, or hand-roll a `fetch` if we want fewer deps.
   - Translate `ProviderRequest` → OpenAI-style messages and tools.
   - Translate response back to `ProviderResponse`.
   - Default model: `gemma4:26b`.
5. **OpenAI implementation second** (`OpenAIProvider`):
   - Same SDK, real `api.openai.com` `baseURL`, `OPENAI_API_KEY`.
   - Validate the abstraction generalized — if you find yourself adding
     fields to `ProviderRequest` to make OpenAI work, the interface was wrong
     and Ollama needs the same treatment.
6. Provider selection: `LEHARNESS_PROVIDER=ollama|openai` env var, or
   `~/.leharness/config.json`. Provider name + model recorded in
   `step.started` so logs are reproducible.
7. Integration test: same canonical scenario runs end-to-end against both
   providers, swapping config only.

**Ollama-specific gotchas to expect (not block on):**

- Tool calls on smaller models can be malformed; the `tool.failed` parse-
  error path will get exercised. Good — that path needs to work anyway.
- Context windows are smaller than cloud models. Don't assume Claude-sized
  context in the prompt builder.
- `gemma4:26b` is MoE, so memory needs are different from dense models of
  the same nominal size; document the recommended host requirements in the
  minimal-cli README.

**Done when:** `leharness "what files are in this directory?"` works against
both Ollama (`gemma4:26b`) and OpenAI (`gpt-4o-mini` or similar) by changing
one env var. Both produce legible JSONL traces.

## Phase 6 — Minimal CLI Wrapper

**Goal:** human-usable entry point. Bare minimum — no animation, no fancy
rendering, no UI/UX. Just stdin/argv → loop → stdout.

Steps:

1. `apps/minimal-cli/src/index.ts` parses args:
   - `leharness "<prompt>"` — one-shot, prints final assistant message
   - `leharness repl` — REPL, each input is a new turn in the same session
   - `leharness --session <id>` — resume an existing session
   - `--provider`, `--model` flag overrides
2. Session ID generation: ULIDs, stored under `sessions/{id}/`.
3. `apps/minimal-cli/src/render.ts` — plain-text output, one line per event:
   assistant text in full, tool calls as `> tool_name(args)`, tool results
   as `< 42 lines`. No colors, no spinners, no progress bars.
4. Subscribe to events via a simple file-watcher or by reading the log after
   each loop iteration. (TUI does this properly in Phase 8; minimal-cli
   stays dumb on purpose.)

**Done when:** you can run real tasks from the terminal end-to-end against
either provider, and the JSONL log is the primary debug surface.

## Phase 7 — Debug + Tighten

**Goal:** fix everything we got wrong before adding the TUI.

Pass list:

- Run the canonical acceptance test (below) against both providers.
- Re-read several JSONL logs by hand. Are field names ones you'll be happy
  with in six months? Now is the cheapest moment to rename.
- Grep for every call site of `appendEvent`. Confirm they are all in the
  loop module. If not, push them back.
- Verify the reducer is pure: no `Date.now()`, no `Math.random()`, no I/O.
- Add hostile golden fixtures:
  - tool that throws
  - model that returns malformed tool-call JSON (Ollama will produce these
    naturally)
  - invocation that ends without any tool calls
  - model that calls two tools in one response
- Document the canonical event shapes somewhere in `packages/harness/README.md`.

**Acceptance test for MVP:**

> User: "Run `pnpm test` in this project. If anything fails, tell me which
> tests and what the errors were."

Should produce a JSONL log that tells the full story: invocation → model
call → bash tool call → tool result (truncated if large) → model responds
→ session finishes. If that works against `gemma4:26b` *and* against
OpenAI, the kernel is done.

## Phase 8 — TUI

**Goal:** a separate process that renders sessions live by reading the event
log. The architectural payoff phase — UI is purely a reader, never touches
the loop.

Steps:

1. `apps/tui` package using Ink (React for terminals).
2. `chokidar` or `fs.watch` tails `sessions/{id}/events.jsonl`.
3. Reuses `projectSession` from the harness package to project events to UI
   state. **Do not** duplicate reducer logic in the TUI.
4. Views:
   - Live transcript with assistant text, tool calls collapsible, tool
     results with line counts.
   - State indicator: `running | awaiting-tool: bash | awaiting-user`.
   - Session selector (lists sessions in `sessions/`).
5. Zero coupling to the loop. minimal-cli runs the loop in one terminal, TUI
   in another, they communicate only through the JSONL file on disk.

**Done when:** `leharness-tui` opens, you can pick a session, and as the
minimal-cli loop appends events the TUI updates live. The TUI can be killed
and restarted mid-session with no loss.

## Workflow

- Each phase is its own branch off `main`: `feat/mvp-phase-N-short-name`.
- One PR per phase, reviewed and merged before the next phase starts.
- Within a phase, commits can be incremental and "wip"-style — squash on
  merge if they're noisy.
- `main` is always the latest reviewed-good state.
- This plan branch (`plan/mvp-core-harness`) merges first; phase branches
  follow.

## Open Questions

Things I'd like a call on before Phase 0 starts:

1. **Linter:** biome (single tool, fast) or prettier + eslint (more
   standard, more configurable)?
2. **Schema validation library:** zod (most popular, good DX) or
   typebox/valibot (smaller, faster)?
3. **HTTP client for providers:** use the `openai` npm SDK with custom
   `baseURL` for both providers, or hand-roll `fetch` to avoid the
   dependency? SDK is faster to write; `fetch` is more "build to learn."
4. **ULID library** or hand-rolled? `ulid` package is fine; we just need
   sortable unique IDs.
5. **Sessions directory location:** `./sessions/` (per-project) or
   `~/.leharness/sessions/` (per-user)? CLI use case probably wants
   per-project for context, but could be config.

Defaults I'll assume if no answer: biome, zod, `openai` SDK with custom
`baseURL`, `ulid` package, `./sessions/`.
