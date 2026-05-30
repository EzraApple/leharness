# 010 — Tool-agnostic kernel

## Goal

Make `@leharness/harness` carry **no opinions about which tools exist**.
Today the kernel both *runs* tools and *ships* the concrete ones —
task-management, subagents, artifacts, skills are baked into its
prompt-prep. Pull each capability into its own package layered over the
kernel, so the core becomes pure mechanism you can run with zero tools
and then bolt capabilities onto.

This is the README's "generic core, thin wrappers" bet made real, and
the foundation for the larger goal: a fully independent, hackable harness
where you can test layers on top to see what makes it more effective.

Not covered: rewriting the async runtime (it's already generic — see
below) or changing any tool's behavior. This is a boundary/ownership
refactor, not a feature change. The standing `pnpm smoke` suite must stay
green at every phase.

## Why this shape — what's already right vs. what's coupled

The async surface is **already generic** and stays in the kernel:

- `Tool.execute()` returns `ok` (inline) **or** `started` (a durable
  `StartedTask` handle) — that *is* "run inline or hand back a handle."
- `ToolContext` already passes every tool the `SessionTaskServices`, and
  `TaskExecutor` is the plug for "how a kind of background work runs."
  Shell and subagents are just two impls. The loop drains completed
  tasks generically each step.

So the coupling is **not** the runtime — it's package boundaries plus
where the kernel names concrete capabilities:

1. `core/prepare-prompt.ts` hard-imports `readArtifactTool`,
   `createLoadSkillTool`, `createSpawnSubagentTool`, `builtInTaskTools`
   and auto-injects them (`applyBuiltIns`). Note: `read_artifact` is
   injected **unconditionally** (no deps flag), unlike task-mgmt tools
   (gated on `tasksEnabled`) and `spawn_subagent` (gated on
   `subagentsEnabled && delegated executor registered`). This asymmetry
   matters in Phase 3 — `@leharness/artifacts` becomes a capability you
   register, so without it `read_artifact` will no longer appear.
2. The same file composes the **skill catalog into the system prompt**,
   re-rendered per invocation (depends on `userText` + recently loaded
   skills from `invocation.events`).
3. `core/task-drain.ts` auto-persists large outputs via the artifacts
   store (`writeArtifact`) inside `renderLarge`.
4. `HarnessDeps` carries `skills` / `tasks` / `subagents` flags, and
   `packages/harness/src/index.ts` re-exports every concrete feature.

Almost all of it concentrates in `prepare-prompt.ts`.

## Target architecture

Three layers, dependencies pointing only inward:

```
@leharness/harness   (kernel — pure mechanism, ships ZERO concrete tools)
  loop · event log · session projection · prompt assembly · compaction
  Tool contract + dispatch · async substrate (Task / TaskExecutor / queue / drain)
  task-management tools (wait/read/cancel — the generic face of the substrate)
        ▲
  capability packages   (opt-in; each owns its tool(s) + executor + hooks)
  @leharness/exec · /subagents · /artifacts · /skills · /mcp (already exists)
        ▲
  product   (apps/cli — composes the kernel + the capabilities it wants;
             also keeps the baseline file tools read/create/edit)
```

| Package | Owns | Avenue |
| ------- | ---- | ------ |
| `@leharness/harness` | loop, log, prompt/compaction, Tool contract, **async substrate**, task-mgmt tools | the kernel |
| `@leharness/exec` | `bash` + the background-capable command executor | running commands, fg/bg |
| `@leharness/subagents` | `spawn_subagent` + executor | delegating to isolated child runs |
| `@leharness/artifacts` | `read_artifact` + store + large-output sink | durable storage of big outputs |
| `@leharness/skills` | `load_skill` + discovery + catalog injection | loadable instruction modules |
| `@leharness/mcp` | (unchanged) | external tool servers |

## The Capability hook (the pivotal change)

The kernel folds over a list of capabilities it knows nothing about. All
methods are **async** — `discoverSkills` and similar must be `await`-able.

```ts
// packages/harness/src/core/capability.ts (new file)
import type { Event } from "../events.js"
import type { SessionTaskServices } from "../tasks.js"
import type { Tool } from "../tools.js"

export interface CapabilityContext {
  sessionId: string
  // Read-only snapshot of the session's events at the start of this step.
  // Used by capabilities that look back (skills uses it for
  // recentLoadedSkillNames).
  events: ReadonlyArray<Event>
  // The user message that opened this invocation, or undefined for
  // auto-triggered invocations. Used by the skill catalog's relevance
  // scoring.
  userText: string | undefined
  // The generic async substrate. Capabilities whose tools return
  // {kind:"started", task} use this. Optional because the kernel can run
  // without a task runtime (e.g. a bare smoke).
  taskServices: SessionTaskServices | undefined
}

export interface Capability {
  // Tools this capability contributes to the model-facing tool list for
  // this invocation. May return [] (a capability with only an executor /
  // sink). Called once per step inside prepare-prompt.
  tools?(ctx: CapabilityContext): Promise<Tool[]>

  // Optionally append/wrap the system prompt (e.g. the skill catalog).
  // Returns the augmented prompt. Capabilities are folded in array order
  // so each sees the previous one's output as `base`.
  augmentSystemPrompt?(base: string, ctx: CapabilityContext): Promise<string>
}
```

`prepare-prompt.ts` becomes (high-level):

```ts
const ctx: CapabilityContext = {
  sessionId: invocation.sessionId,
  events: invocation.events,
  userText,
  taskServices,
}

let tools = [...deps.tools]
let system = deps.systemPrompt
for (const cap of deps.capabilities ?? []) {
  if (cap.tools) {
    const contributed = await cap.tools(ctx)
    // tools the caller passed in deps.tools override same-named
    // contributions (preserves the current "overrides" semantics).
    const overrides = new Set(tools.map((t) => t.name))
    tools.push(...contributed.filter((t) => !overrides.has(t.name)))
  }
  if (cap.augmentSystemPrompt) {
    system = await cap.augmentSystemPrompt(system, ctx)
  }
}
```

This single inversion deletes `applyBuiltIns`, the hard imports, and the
skill-catalog block.

## The `OutputSink` hook (the artifacts reach-in)

```ts
// packages/harness/src/core/output-sink.ts (new file)
export interface OutputSink {
  // Called by the kernel when a tool/task output exceeds the in-prompt
  // threshold. Returns the stub to put in the prompt in place of the raw
  // bytes, plus an optional opaque ref the caller can resolve later
  // (e.g. via read_artifact). If no sink is configured, the kernel falls
  // back to truncateOutput.
  write(args: {
    sessionId: string
    bytes: string
    mime?: string
    sourceTaskId?: string
  }): Promise<{ stub: string; ref?: string }>
}
```

Plug point: `core/task-drain.ts:renderLarge` (today calls
`writeArtifact` directly + records an `artifact.created` event). The
artifacts package's sink produces the same stub and records the same
event, so the rest of the kernel is unaware. With **no** sink registered
(`deps.outputSink === undefined`), `renderLarge` returns
`truncateOutput(bytes)` and skips the artifact event — the existing
fallback path.

## `HarnessDeps` changes

Add:
- `capabilities?: Capability[]` — folded by `prepare-prompt`; defaults to `[]`.
- `outputSink?: OutputSink` — consulted by `task-drain`; absent → truncate.

Remove (in Phase 4):
- `skills?: SkillOptions | false`
- `tasks?: boolean`
- `subagents?: boolean`

Each removed flag's behavior moves into the corresponding capability:
- `tasks: false` was "don't inject wait/read/cancel" — those tools now
  live in `@leharness/harness` as the substrate's public face (see
  "Decisions" below). The CLI passes them via `deps.tools` if it wants
  them; omitting them gives a kernel with no task-mgmt tools.
- `subagents: false` was "don't inject spawn_subagent" — controlled by
  whether `@leharness/subagents` is in `deps.capabilities`.
- `skills: false` — controlled by whether `@leharness/skills` is in
  `deps.capabilities`.

## Dependency direction

- Capabilities depend on `@leharness/harness`; the kernel depends on
  **no** capability.
- Capabilities may depend on each other where real
  (`@leharness/subagents` → `@leharness/exec`, since a child session
  needs a command runtime; this matches the current
  `subagents.ts → shell.ts:enableShellRuntime` import).
- The product (`apps/cli`) is the only place that knows the full set; it
  composes them.

## Package template

Every new capability package mirrors **`packages/mcp/`** — that's the
established template in this repo:

- `package.json` — `private: true`, `type: "module"`, `main`/`types`
  point at `./dist/index.js`, `exports` map for `.`, `files: ["dist"]`,
  `scripts.build: "tsc"`, workspace deps on `@leharness/harness` (and
  any other capability deps).
- `tsconfig.json` — extends the same base as `packages/mcp/tsconfig.json`.
- `src/index.ts` — public surface: the package's `capability()` factory,
  any `enable<X>Runtime`, and the underlying types it wants to expose.
- `src/...` — impl files.
- `scripts/smoke/*.mjs` (or `.ts`) — per-package smoke, modeled on
  `packages/mcp/scripts/smoke/`.
- Root `tsconfig.json` — add the new path mapping.
- Root `knip.json` — add the new workspace entry.
- Root `package.json` — wire the smoke into `smoke:apps` (or its own
  `smoke:<name>` script per `pnpm smoke:mcp`'s pattern).

## Decisions worth pinning

- **Task-management tools (`wait_task`/`read_task`/`cancel_task`) stay in
  `@leharness/harness`**, not in a separate package. They're the public
  face of the async substrate, used by any capability whose tools return
  `{kind:"started"}`. Splitting them off would force every consumer of
  the substrate to take a second package dep for the substrate's own
  interface. They're shipped through `deps.tools` (the caller decides
  whether to expose them) — not through a Capability.
- **Bash tool lives with the executor in `@leharness/exec`.** Today it's
  split (`apps/cli/src/tools/bash.ts` + `packages/harness/src/shell.ts`).
  In the new world both belong to `exec`, since the tool fundamentally
  needs the executor.
- **File I/O tools (`read_file`/`create_file`/`edit_file`) stay in
  `apps/cli`**. They're already decoupled and the product is the right
  owner — no need for a package unless reused elsewhere.

## Migration — per-phase detail

Each phase ends green on `pnpm -r build && pnpm biome check . &&
pnpm knip && pnpm smoke`. Phase commits land via PR.

### Phase 1 — Capability hook in the kernel

**No new packages. Behavior identical.** The concrete capabilities still
live in the kernel but register *through* the hook instead of being
hard-wired.

Files touched:
- `packages/harness/src/core/capability.ts` — **new.** Defines
  `Capability` and `CapabilityContext`.
- `packages/harness/src/core/prepare-prompt.ts` — replace `applyBuiltIns`
  + the skill block with the fold loop shown above. Remove the hard
  imports of `readArtifactTool`/`createLoadSkillTool`/
  `createSpawnSubagentTool`/`builtInTaskTools`. Delete `applyBuiltIns`.
- `packages/harness/src/core/invocation.ts` — add
  `capabilities?: Capability[]` to `HarnessDeps`. Leave the legacy
  `skills/tasks/subagents` flags in place for this phase (Phase 4 removes
  them).
- `packages/harness/src/skills.ts` — add an exported
  `skillsCapability(opts: SkillOptions): Capability` that wraps the
  existing catalog logic.
- `packages/harness/src/subagents.ts` — add an exported
  `subagentsCapability(services: SessionTaskServices): Capability`
  contributing `createSpawnSubagentTool(services)`.
- `packages/harness/src/artifacts.ts` — add an exported
  `artifactsCapability(): Capability` contributing `readArtifactTool`.
- `packages/harness/src/tasks.ts` — `builtInTaskTools` stays a public
  export (the substrate's own tools). The CLI passes them via
  `deps.tools` if it wants them.
- `apps/cli/src/cli.ts` — build the capability list and pass via
  `deps.capabilities`:
  ```ts
  const capabilities = [
    subagentsCapability(services),
    artifactsCapability(),
    skillsCapability(skillOpts),
  ]
  ```
  and add `builtInTaskTools` to `deps.tools` (it was auto-injected
  before).

Verification:
- `pnpm smoke` green — the same tools and the same system prompt should
  reach the model, just via the fold instead of hard injection.
- Spot-check a TUI session: `/mcp`, `/help`, skills load, a bash bg task
  drains — same behavior as before.

### Phase 2 — `OutputSink` hook

Files touched:
- `packages/harness/src/core/output-sink.ts` — **new.** Defines `OutputSink`.
- `packages/harness/src/core/invocation.ts` — add
  `outputSink?: OutputSink` to `HarnessDeps`.
- `packages/harness/src/core/task-drain.ts` — `renderLarge` now calls
  `deps.outputSink?.write(...)` instead of `writeArtifact` directly.
  Without a sink it returns `{ value: truncateOutput(bytes), artifactId:
  undefined }` and skips the `artifact.created` event.
- `packages/harness/src/artifacts.ts` — add an exported
  `defaultOutputSink(): OutputSink` that wraps the existing
  `writeArtifact` + the `artifact.created` event-recording. Update
  `artifactsCapability()` to also let callers pass `outputSink` so the
  CLI can wire both in one place. (Recommended: `artifactsCapability()`
  returns a `Capability` and a `sink`, e.g. `{ capability, sink }`, so
  the CLI does `deps.outputSink = artifacts.sink`.)
- `apps/cli/src/cli.ts` — pass `outputSink: defaultOutputSink()` (or via
  the `artifactsCapability()` bundle).

Verification:
- `smoke-artifacts.ts`, `smoke-compaction-e2e.ts`, `smoke-bash-runtime.ts`
  all pass (these exercise large outputs).

### Phase 3 — Extract packages

One sub-phase per package. **Order matters** (deps point right):

| Sub | Package | Moves out of kernel | New location(s) | Inter-deps |
| --- | ------- | ------------------- | --------------- | ---------- |
| 3a | `@leharness/exec` | `packages/harness/src/shell.ts` + `apps/cli/src/tools/bash.ts` + `apps/cli/scripts/smoke-bash-runtime.ts` | `packages/exec/src/{index.ts, executor.ts, bash-tool.ts, capability.ts}` + `packages/exec/scripts/smoke/` | → `harness` |
| 3b | `@leharness/subagents` | `packages/harness/src/subagents.ts` (the executor + `enableSubagentRuntime` + `createSpawnSubagentTool` + `subagentsCapability`) + `apps/cli/scripts/smoke-subagents.ts` + any sample-subagent registration in `apps/cli` | `packages/subagents/src/{index.ts, executor.ts, spawn-tool.ts, capability.ts}` | → `harness`, → `exec` |
| 3c | `@leharness/artifacts` | `packages/harness/src/artifacts.ts` (store + `readArtifactTool` + `artifactsCapability` + `defaultOutputSink`) + `apps/cli/scripts/smoke-artifacts.ts` | `packages/artifacts/src/{index.ts, store.ts, read-tool.ts, sink.ts, capability.ts}` | → `harness` |
| 3d | `@leharness/skills` | `packages/harness/src/skills.ts` (discovery + catalog + `load_skill` + `skillsCapability` + `registerBuiltinSkill`) + `packages/harness/scripts/smoke/skills.mjs` | `packages/skills/src/{index.ts, discovery.ts, catalog.ts, load-tool.ts, capability.ts}` + `packages/skills/scripts/smoke/` | → `harness` |

Per sub-phase:
1. Create the new package dir mirroring `packages/mcp/` (see "Package
   template" above).
2. Move the files; rewrite imports in the moved code to use
   `@leharness/harness` for kernel types.
3. Update consumers (notably `apps/cli/src/cli.ts` and other capability
   packages — e.g. `subagents` imports `enableShellRuntime` from `exec`
   after 3a).
4. Remove the export from `packages/harness/src/index.ts`.
5. Add the new path to root `tsconfig.json` and the workspace entry to
   `knip.json`.
6. Wire its smoke into root `package.json` (`smoke:<name>` and/or
   `smoke:apps`).

Verification per sub-phase: `pnpm -r build && pnpm biome check . &&
pnpm knip && pnpm smoke` all green.

### Phase 4 — Strip the kernel

Files touched:
- `packages/harness/src/core/invocation.ts` — remove `skills`, `tasks`,
  `subagents` from `HarnessDeps`. Remove their consumers in
  `prepare-prompt` (already gone after Phase 1, but the fields can now
  be deleted from the type).
- `packages/harness/src/index.ts` — barrel no longer re-exports the
  extracted modules (they're gone from the source tree after Phase 3
  anyway, but tidy any lingering refs).
- `apps/cli/src/cli.ts` — assemble its full capability set explicitly,
  with no reliance on kernel defaults.

Verification:
- Existing `pnpm smoke` green.
- New **bare-kernel smoke** — `packages/harness/scripts/smoke/bare-kernel.mjs`:
  - Construct minimal `HarnessDeps` with `capabilities: []`,
    `outputSink: undefined`, `tools: [/* one trivial echo tool */]`.
  - Run a one-step invocation against the existing fake provider used by
    other harness smokes.
  - Assert: no `artifact.created` events; no `skill.loaded` events; no
    auto-injected tools in the model-facing tool list (only the echo
    tool); large outputs (>16KB) come back truncated, not artifacted.
  This is the property — "kernel ships zero opinions" — made executable.

## Standing conventions (the gates each phase must pass)

- `pnpm -r build` clean.
- `pnpm biome check .` clean (use `pnpm biome check --write` for formatting).
- `pnpm knip` clean.
- `pnpm smoke` (full suite) green.
- The standing project rule: rebuild before testing with the lh-dev
  shim or smoke scripts.

## Do not change in this refactor

- **Tool names** (`bash`, `read_file`, `create_file`, `edit_file`,
  `read_artifact`, `wait_task`, `read_task`, `cancel_task`,
  `spawn_subagent`, `load_skill`). They're part of the model contract.
- **Event types or payload field names.** The event log is the canonical
  session state; any change ripples through transcripts, smokes, the TUI.
- **Existing smoke names or assertions.** They're the regression contract.
- **CLI surface** (`lh --help`, `--provider`, `--max-steps`, `--session`,
  the `tui`/`minimal` subcommands).
- **`Tool.execute()` signature** and the `ok | error | started`
  discriminated return.
- **`TaskExecutor` interface** — already generic, leave it alone.
- **`DEFAULT_MAX_STEPS`**, compaction defaults, provider defaults —
  unrelated knobs.
