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
  inspector, multi-agent fleets, mid-flight user steering.

Each must be addable later without changing the loop, reducer, or event log.
If we hit something here that requires changing those, we stop and revisit.

## Decisions Locked In

| Area | Decision |
|---|---|
| Language / runtime | TypeScript + Node, pnpm workspaces, vitest |
| Repo layout | `packages/harness` (kernel only) + `apps/minimal-cli` (concrete tools + REPL wiring) |
| Source of truth | Append-only JSONL event log per session, one writer per session |
| Projection | Pure reducer (events → session state), fold-from-scratch every iteration; no memoization in MVP |
| Loop shape | Straight-line `while (true)` matching the README pseudocode; no session state machine, no `Action` dispatch, no channel |
| Step continuation | `shouldContinue` is a function of the most recent model output and a max-step limit; not a state field |
| Tool execution | Sequential only, auto-approve all (approval seam exists, no policy yet) |
| Tool ownership | Harness ships the tool *runtime* (interface, registry, executor); concrete tools (`read_file`, `list_dir`, `bash`) live in the consumer (`minimal-cli`) |
| Large tool output | Truncated inline for MVP with a `[truncated: N bytes]` marker; filesystem-backed artifacts deferred to feature work |
| Providers | Provider-agnostic interface from day one; Ollama first, then OpenAI; both implementations live inside `packages/harness` for MVP |
| Initial Ollama model | `gemma4:26b` (Gemma 4 MoE) |
| Streaming | Non-streaming for MVP (streaming is a TUI concern, not a loop concern) |
| Schema versioning | Every event carries `v: 1`; reducer doesn't dispatch on version yet |
| Storage | JSONL only; no SQLite index |
| Project state directory | `.leharness/` at the project root (hidden), holds all harness-managed state. MVP only writes `.leharness/sessions/{ulid}/events.jsonl`; `config.json`, `artifacts/`, locks, etc. are reserved seams added when needed |
| Provider config | Env vars only for MVP (`LEHARNESS_PROVIDER`, `OPENAI_API_KEY`, `OLLAMA_HOST`, `LEHARNESS_MODEL`). `~/.leharness/config.json` for user-global config and `.leharness/config.json` for project-level overrides are deferred |

## Repository Layout

```
leharness/
├── packages/
│   └── harness/
│       ├── src/
│       │   ├── events.ts        # Event union, appendEvent, loadEvents
│       │   ├── session.ts       # SessionState, reduce, projectSession
│       │   ├── prompt.ts        # buildPrompt
│       │   ├── tools.ts         # Tool interface, ToolRegistry, executor (no concrete tools)
│       │   ├── provider/
│       │   │   ├── index.ts     # Provider interface, callModel
│       │   │   ├── ollama.ts
│       │   │   └── openai.ts
│       │   ├── harness.ts       # runSession, shouldContinue, compaction stub
│       │   └── index.ts         # public exports
│       └── package.json
├── apps/
│   └── minimal-cli/             # Basic stdin/argv parsing only, no UI/UX
│       ├── src/
│       │   ├── tools/
│       │   │   ├── read_file.ts
│       │   │   ├── list_dir.ts
│       │   │   ├── bash.ts
│       │   │   └── index.ts     # buildToolRegistry()
│       │   ├── cli.ts           # arg parsing, REPL, wires provider + registry into runSession
│       │   ├── render.ts        # plain-text output
│       │   └── index.ts         # entry point
│       └── package.json
├── plans/
├── research/
├── .leharness/                  # auto-created on first run, hidden, gitignored
│   └── sessions/
│       └── {ulid}/
│           └── events.jsonl     # the single source of truth per session
└── pnpm-workspace.yaml
```

The TUI ships as its own app (`apps/tui`) added in Phase 8 — a separate
process that tails session JSONL and projects independently.

### Why `.leharness/` from day one

Even though the MVP only writes `sessions/` inside it, the harness creates
and uses a hidden `.leharness/` directory at the project root rather than a
visible top-level `sessions/`. Three reasons:

1. **Single namespace for everything the harness owns.** Future additions
   (artifacts, locks, project config, caches, branch snapshots) all land
   under `.leharness/` without polluting the project root.
2. **Hidden by default.** Dotfile convention — invisible to `ls`, finder,
   tree, etc. — keeps the user's project view clean.
3. **One gitignore line.** `.leharness/` covers everything the harness ever
   writes to the project, forever.

The directory is created lazily on first `appendEvent` call (`mkdir -p`),
not by an explicit init command. Resolution rules:

- Default project state root: `<cwd>/.leharness/`
- Override: `LEHARNESS_HOME` env var (absolute path)
- Sessions root within it: `{root}/sessions/`

## Phase 0 — Scaffolding

**Goal:** repo builds, tests run, nothing else.

Steps:

1. `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json` (strict).
2. `packages/harness` and `apps/minimal-cli` package skeletons with their own
   `tsconfig.json` extending root.
3. `vitest` configured at the root with workspace test discovery.
4. `biome` (or prettier+eslint, dealer's choice) for formatting and linting.
5. `.gitignore` adds `.leharness/`, `node_modules/`, `dist/`.
6. One placeholder test in `packages/harness` that asserts `1 === 1` so CI
   has something to run.

**Done when:** `pnpm install && pnpm test && pnpm build` all pass from the
repo root with no errors.

## Phase 1 — Event Log Primitives

**Goal:** `appendEvent` and `loadEvents` work, in isolation.

Steps:

1. Define `Event` as a discriminated union. MVP set:
   - `invocation.received` — user message ingress
   - `step.started` — brackets each loop iteration (carries `stepNumber`)
   - `model.requested` / `model.completed` / `model.failed`
   - `tool.started` / `tool.completed` / `tool.failed`
   - `agent.finished` — terminal event for the current invocation
2. Every event has: `type`, `v: 1`, `id` (ulid), `ts` (ISO timestamp), plus
   type-specific fields.
3. `appendEvent(sessionId, event)`: resolves project state root
   (`LEHARNESS_HOME` or `<cwd>/.leharness`), `mkdir -p {root}/sessions/{id}/`,
   `fs.appendFile` to `{root}/sessions/{id}/events.jsonl`, line-terminated,
   sync writes for now.
4. `loadEvents(sessionId)`: read whole file at `{root}/sessions/{id}/events.jsonl`,
   split on newlines, parse each.
5. Path resolution lives in one helper (`resolveSessionPath(sessionId)`)
   used by both `appendEvent` and `loadEvents` — single source of truth for
   where state lives.
6. Discipline: `appendEvent` is exported from one module and the loop is the
   only thing that imports it. A simple grep check in CI later, not now.
7. Unit tests:
   - Round-trip: append N events, read back, deep-equal.
   - Malformed line tolerance: corrupt the file, ensure we surface a clear
     error (don't silently drop events).

**Done when:** `pnpm test` passes the events module suite, and
`cat .leharness/sessions/test/events.jsonl | jq` shows pretty events.

## Phase 2 — Session Projection

**Goal:** pure function from events to session state, exhaustively tested.
The reducer *is* the projection — there's no separate "session" layer.

Steps:

1. Define `SessionState`:
   - `transcript`: array of typed turns (user message, assistant text,
     assistant tool calls, tool results, tool errors)
   - `metadata`: provider, model, session start time
   - That's it. No state-machine field, no `pendingToolCalls`. The loop
     decides what to do next from the most recent model output, not from
     a state enum.
2. `reduce(state, event): SessionState` — exhaustive switch on `event.type`,
   no I/O, no `Date.now()` (timestamps come from events).
3. `projectSession(events): SessionState` — folds reducer over events from
   a fresh initial state.
4. Golden-fixture tests: each fixture is an input JSONL + an expected
   `SessionState` JSON. Start with ~6 fixtures:
   - empty session (just initial state)
   - single user message, no tools
   - user → model → finish (no tool calls)
   - user → model → tool call → tool result → model → finish
   - tool failure path (tool error in transcript, model recovers)
   - model that calls two tools in one response

**Done when:** all golden fixtures pass and `projectSession` is the only
place in the codebase that builds a `SessionState`.

## Phase 3 — Loop Skeleton (No Real Model, No Real Tools)

**Goal:** the loop runs end-to-end against a fake provider and fake tools.
**This is the architecture validation phase — spend time here.**

The loop is the README pseudocode. Roughly:

```ts
async function runSession(sessionId, deps) {
  const append = (e) => appendEvent(sessionId, e)
  let stepNumber = 0

  while (true) {
    const session = projectSession(await loadEvents(sessionId))

    if (shouldCompact(session)) {
      await compact(session, append)         // stub: no-op for MVP
      continue
    }

    stepNumber++
    await append({ type: "step.started", v: 1, stepNumber })

    const request = buildPrompt(session, deps.tools.list())
    await append({ type: "model.requested", v: 1, request })
    const modelOutput = await callModel(deps.provider, request)
    await append({ type: "model.completed", v: 1, ...modelOutput })

    const toolResults = await executeToolCalls(modelOutput.toolCalls, deps.tools, append)

    if (!shouldContinue(modelOutput, toolResults, stepNumber)) {
      await append({ type: "agent.finished", v: 1, reason: terminalReason(modelOutput, stepNumber) })
      return
    }
  }
}
```

Steps:

1. Implement `runSession`, `shouldContinue`, and a no-op `shouldCompact`/`compact`.
2. `runInvocation(sessionId, userText, deps)`: appends `invocation.received`,
   then calls `runSession`. This is what the CLI will call per user message.
3. `FakeProvider` implementing the `Provider` interface (defined in Phase 5
   ahead of schedule, just enough to compile): returns canned responses.
4. `FakeToolRegistry`: dummy tools the fake provider can "call".
5. Integration test 1: fake provider returns "I'm done" on first call (no
   tool calls), assert one step happens, `agent.finished` is emitted, JSONL
   matches expected fixture.
6. Integration test 2: fake provider requests a fake tool on first call and
   a final response on second call. Validate the tool round-trip happens
   correctly, two `step.started` events are emitted, transcript projects
   correctly.
7. Integration test 3: fake provider returns two tool calls in one response.
   Validate they execute sequentially and both results appear in the next
   prompt.

**Done when:** integration tests pass against the fake provider, and the
JSONL files they produce are legible end-to-end traces of what the loop did.

If anything about event shapes, the loop structure, or the `Provider` /
`Tool` interfaces feels wrong here, fix it now. Every later phase assumes
this is right.

## Phase 4 — Tool Runtime (Kernel-Side)

**Goal:** the harness package ships the tool *runtime* — interface, registry,
executor. **No concrete tools live in `packages/harness`.**

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
3. `executeToolCall(call, registry, ctx)`:
   - Validate args against schema; on failure, return a structured error
     captured as `tool.failed`.
   - Run `tool.execute`.
   - If output exceeds a hard cap (start with 16kb), truncate inline and
     append a `[truncated: N bytes]` marker. Filesystem artifacts come
     later as feature work.
4. `executeToolCalls(calls, registry, append)`: sequential loop, emits
   `tool.started` and `tool.completed`/`tool.failed` events per call.
5. `ToolContext` carries session ID. (Permission handle is a stub returning
   `allow` — real seam, no policy yet.)
6. Tests: drive the runtime with fake `Tool` implementations (one that
   succeeds, one that throws, one that produces oversized output, one with
   bad args). No real fs or process access in these tests — that's the
   consumer's territory.

**Done when:** the loop in Phase 3 runs against the real `executeToolCalls`
with fake `Tool`s registered in a real `ToolRegistry`, and the kernel test
suite exercises every branch of the executor without touching the
filesystem.

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
   providers, swapping config only. Concrete tools still mocked here — real
   tools land in Phase 6.

**Ollama-specific gotchas to expect (not block on):**

- Tool calls on smaller models can be malformed; the `tool.failed` parse-
  error path will get exercised. Good — that path needs to work anyway.
- Context windows are smaller than cloud models. Don't assume Claude-sized
  context in the prompt builder.
- `gemma4:26b` is MoE, so memory needs are different from dense models of
  the same nominal size; document the recommended host requirements in the
  minimal-cli README.

**Done when:** an internal scenario runner exercises the loop against both
providers (Ollama with `gemma4:26b`, OpenAI with `gpt-4o-mini` or similar)
by swapping one env var, with a fake tool registry. Both produce legible
JSONL traces.

## Phase 6 — Minimal CLI + Builtin Tools

**Goal:** human-usable entry point. Bare minimum — no animation, no fancy
rendering, no UI/UX. Just stdin/argv → loop → stdout. This is also where
real tools land, in the consumer layer.

Steps:

1. Implement the three builtin tools in `apps/minimal-cli/src/tools/`:
   - `read_file(path)` — read file contents, large files surfaced via the
     kernel's truncation cap.
   - `list_dir(path)` — list directory entries.
   - `bash(command)` — exec via `child_process`, capture stdout+stderr,
     blocking, no timeout for MVP.
2. `tools/index.ts` exports `buildToolRegistry(): ToolRegistry` that
   constructs a registry with the three tools registered. The harness
   doesn't know any of them by name.
3. `apps/minimal-cli/src/cli.ts` parses args:
   - `leharness "<prompt>"` — one-shot, runs `runInvocation` once, prints
     final assistant message.
   - `leharness repl` — REPL: `while (input = await readLine()) await runInvocation(sessionId, input, deps)`.
   - `leharness --session <id>` — resume an existing session.
   - `--provider`, `--model` flag overrides.
4. Wires it all together: builds the provider per config, builds the tool
   registry via `buildToolRegistry()`, generates a session ID (ULID, stored
   under `.leharness/sessions/{id}/`), passes both into `runSession` via deps.
5. `apps/minimal-cli/src/render.ts` — plain-text output, one line per event:
   assistant text in full, tool calls as `> tool_name(args)`, tool results
   as `< 42 lines`. No colors, no spinners, no progress bars.
6. Subscribe to events via a simple file-watcher or by reading the log after
   each loop iteration. (TUI does this properly in Phase 8; minimal-cli
   stays dumb on purpose.)
7. Per-tool unit tests live in `apps/minimal-cli` (fixture filesystems for
   read/list, mocked exec for bash). These don't need to touch the harness.

**Done when:** you can run real tasks from the terminal end-to-end against
either provider, the CLI is the only thing that knows what tools exist,
and the JSONL log is the primary debug surface.

## Phase 7 — Debug + Tighten

**Goal:** fix everything we got wrong before adding the TUI.

Pass list:

- Run the canonical acceptance test (below) against both providers.
- Re-read several JSONL logs by hand. Are field names ones you'll be happy
  with in six months? Now is the cheapest moment to rename.
- Grep for every call site of `appendEvent`. Confirm they are all in
  `harness.ts` and `tools.ts` (the kernel's executor). If not, push them
  back.
- Verify the reducer is pure: no `Date.now()`, no `Math.random()`, no I/O.
- Confirm `packages/harness` has zero references to `read_file`, `list_dir`,
  or `bash` by name. The kernel must not know these exist.
- Add hostile golden fixtures:
  - tool that throws
  - model that returns malformed tool-call JSON (Ollama will produce these
    naturally)
  - invocation that ends without any tool calls
  - model that calls two tools in one response
  - long run that hits the max-step safety limit
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
2. `chokidar` or `fs.watch` tails `.leharness/sessions/{id}/events.jsonl`.
3. Reuses `projectSession` from the harness package to project events to UI
   state. **Do not** duplicate reducer logic in the TUI.
4. Views:
   - Live transcript with assistant text, tool calls collapsible, tool
     results with line counts.
   - Activity indicator derived from the most recent events (running a tool,
     waiting on the model, idle since last `agent.finished`).
   - Session selector (lists sessions in `.leharness/sessions/`).
5. Zero coupling to the loop. minimal-cli runs the loop in one terminal, TUI
   in another, they communicate only through the JSONL file on disk.

**Done when:** `leharness-tui` opens, you can pick a session, and as the
minimal-cli loop appends events the TUI updates live. The TUI can be killed
and restarted mid-session with no loss.

## Workflow

For the MVP we deliberately collapse the per-phase PR cadence into a single
end-to-end implementation pass. Rationale: the phases are tightly coupled
(an interface change in Phase 1 ripples through Phase 2/3), the surface
area is small enough that one large PR is reviewable, and parallelizing
phase work via subagents is only safe if everyone's working on the same
branch. After the MVP merges and the architecture has been validated end-
to-end, we'll resume the per-phase PR cadence for feature work.

- Plan branch (`plan/mvp-core-harness`) merges to `main` first, with this
  document as the contract.
- Implementation branch: `feat/mvp-implementation` off `main`.
- One PR for the full MVP (Phases 0–7). Phase 8 (TUI) follows as its own
  PR since it's independent.
- Within the implementation branch, commits should follow phase boundaries
  so that we *can* split into per-phase PRs after the fact if review wants
  it.
- Audit subagents review boundary discipline (kernel ↔ tools, kernel ↔
  providers, reducer purity) before the PR opens.
- Once the MVP is in, we revert to one branch + one PR per phase for all
  subsequent feature work.

## Open Questions

Resolved:

- **Sessions directory location:** `<cwd>/.leharness/sessions/{ulid}/`,
  with `LEHARNESS_HOME` as override. Hidden, gitignored, single
  harness-owned namespace.

Defaults assumed (call them out if you want different):

1. **Linter:** biome (single binary, fast).
2. **Schema validation library:** zod (most popular, good DX).
3. **HTTP client for providers:** `openai` npm SDK with custom `baseURL`
   for both Ollama and OpenAI.
4. **ULID library:** `ulid` package.
