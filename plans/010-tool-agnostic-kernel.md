# 010 — Tool-agnostic kernel

## Goal

Make `@leharness/harness` **auto-inject no model-facing capability
tools**. Today the kernel both *runs* tools and *ships* concrete ones:
task-management, subagents, artifacts, and skills are baked into its
prompt-prep and output paths. Pull each capability into its own package
layered over the kernel, so the core becomes pure mechanism you can run
with zero exposed tools and then bolt capabilities onto.

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
3. `core/execute-tools.ts` and `core/task-drain.ts` auto-persist large
   outputs via the artifacts store (`writeArtifact`), then record
   `artifact.created` and `artifactId` fields.
4. `compaction/pressure-gradient.ts` and `compaction/summarize.ts` also
   hard-import the artifact store for T2 inline-result promotion and
   T4/T5 source-window recovery.
5. `HarnessDeps` carries `skills` / `tasks` / `subagents` flags, and
   `packages/harness/src/index.ts` re-exports every concrete feature.

The biggest concentration is still `prepare-prompt.ts`, but artifacts
also reach into execution and compaction. The extraction must remove all
of those imports, not only the prompt-prep ones.

## Target architecture

Three layers, dependencies pointing only inward:

```
@leharness/harness   (kernel — pure mechanism, auto-injects ZERO tools)
  loop · event log · session projection · prompt assembly · compaction
  Tool contract + dispatch · async substrate (Task / TaskExecutor / queue / drain)
  optional task-management tool exports (wait/read/cancel — caller chooses)
  LargeOutputStore interface, but no concrete filesystem artifact store
        ▲
  capability packages   (opt-in; each owns its tool(s) + executor + hooks)
  @leharness/exec · /subagents · /artifacts · /skills · /mcp (already exists)
        ▲
  product   (apps/cli — composes the kernel + the capabilities it wants;
             also keeps the baseline file tools read/create/edit)
```

| Package | Owns | Avenue |
| ------- | ---- | ------ |
| `@leharness/harness` | loop, log, prompt/compaction, Tool contract, **async substrate**, optional task-mgmt tool exports, `LargeOutputStore` interface | the kernel |
| `@leharness/exec` | `bash` + the background-capable command executor | running commands, fg/bg |
| `@leharness/subagents` | `spawn_subagent` + executor | delegating to isolated child runs |
| `@leharness/artifacts` | `read_artifact` + filesystem store + `LargeOutputStore` implementation | durable recovery of big outputs |
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
  // {kind:"started", task} use this. Present in the final architecture;
  // optional only during the Phase 1 compatibility window while the legacy
  // tasks flag still exists.
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
const capabilities = resolveCapabilities(deps, taskServices)
for (const cap of capabilities) {
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

This single inversion deletes `applyBuiltIns`, the direct hard imports,
and the skill-catalog block from `prepare-prompt.ts`. During the
compatibility phases, `resolveCapabilities` delegates to a temporary
legacy adapter when `deps.capabilities === undefined`; in the final
architecture it is just `deps.capabilities ?? []`.

## The `LargeOutputStore` hook (the artifacts reach-in)

```ts
// packages/harness/src/core/large-output-store.ts (new file)
export type LargeOutputPurpose =
  | "tool_output"
  | "task_output"
  | "compaction_promotion"
  | "compaction_summary_source"

export interface LargeOutputStore {
  // Called by the kernel when it needs recoverable storage for bytes that
  // should not remain inline in the next prompt. The store writes bytes and
  // returns an opaque ref plus the exact stub that should replace the raw
  // value in prompt context. The store does NOT record events; the kernel
  // records the existing event types through invocation.recordEvent so the
  // single-writer rule stays intact.
  write(args: {
    sessionId: string
    bytes: string
    mime?: string
    purpose: LargeOutputPurpose
    sourceCallId?: string
    sourceTaskId?: string
  }): Promise<{
    ref: string
    byteCount: number
    mime?: string
    stub: string
  }>
}
```

Plug points:

- `core/execute-tools.ts:sizeForContext` — large direct tool outputs.
  Kernel records the same `artifact.created` event with `sourceCallId`
  and the same `tool.completed.artifactId` field.
- `core/task-drain.ts:renderLarge` — large background task result/error
  payloads. Kernel records `artifact.created` with `sourceTaskId` and
  the same terminal task event `artifactId` field.
- `compaction/pressure-gradient.ts` T2 — inline tool-result promotion.
  Kernel records the same `artifact.created` + `compaction.tool_promoted`
  events and projects the returned stub.
- `compaction/summarize.ts` T4/T5 — source-window recovery. The summary
  payload keeps the existing `sourceArtifactId` field, populated from
  `ref`.

With **no** store registered (`deps.largeOutputStore === undefined`):

- large direct tool/task outputs fall back to `truncateOutput(bytes)` and
  skip `artifact.created`;
- compaction T2 promotion is skipped because there is no recoverable
  place to put the original inline result;
- compaction T4/T5 summarization is skipped because
  `compaction.summary.sourceArtifactId` would otherwise point nowhere;
- T1, T3, and T6 still run. T6 remains the hard safety net.

The CLI wires `@leharness/artifacts` so user-facing behavior remains
identical. Bare-kernel consumers can omit it and get truncation-only
behavior.

## `HarnessDeps` changes

Add:
- `capabilities?: Capability[]` — folded by `prepare-prompt`. During
  Phases 1-3, `undefined` means "use the legacy default capability
  adapters" so existing `runInvocation` callers keep behavior; an
  explicit `[]` opts into no capabilities. In Phase 4, after the legacy
  flags are removed, `undefined` and `[]` both mean no capabilities.
- `largeOutputStore?: LargeOutputStore` — consulted by tool execution,
  task drain, and compaction; absent → truncate/skip recoverability
  tiers.

Remove (in Phase 4):
- `skills?: SkillOptions | false`
- `tasks?: boolean`
- `subagents?: boolean`

Each removed flag's behavior moves into the corresponding capability:
- `tasks: false` did two things: hide wait/read/cancel and disable the
  task runtime. Split those concepts. The runtime becomes always-on
  kernel mechanism (`getOrCreateTaskServices` is cheap and no-op until a
  tool starts work). Tool exposure is explicit: the CLI passes
  `builtInTaskTools` via `deps.tools` when it wants the model to manage
  background tasks. Omitting them gives a kernel with no task-management
  tools in the model-facing list.
- `subagents: false` was "don't inject spawn_subagent" — controlled by
  whether `@leharness/subagents` is in `deps.capabilities`.
- `skills: false` — controlled by whether `@leharness/skills` is in
  `deps.capabilities`.

## Dependency direction

- Capabilities depend on `@leharness/harness`; the kernel depends on
  **no** capability.
- Capabilities should not depend on each other unless there is no
  composition alternative. In particular, `@leharness/subagents` should
  not import `@leharness/exec`; child sessions receive explicit child
  deps/capabilities from the product. The CLI can choose to include exec
  in those child defaults, but the subagent package stays generic.
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
- **Task services are runtime mechanism, not tool opinion.** After Phase
  4, `runInvocation` creates/drains/reaps `SessionTaskServices`
  unconditionally. Without `builtInTaskTools` in `deps.tools`, the model
  cannot call wait/read/cancel, but a product-owned tool can still start
  background work.
- **Artifact events stay stable even though storage moves out.**
  `artifact.created`, `tool.completed.artifactId`,
  terminal task-event `artifactId`, `compaction.tool_promoted.artifactId`,
  and `compaction.summary.sourceArtifactId` remain the event-log
  contract. The kernel records those events/fields from the
  `LargeOutputStore` result; the filesystem implementation lives in
  `@leharness/artifacts`.
- **Bash tool lives with the executor in `@leharness/exec`.** Today it's
  split (`apps/cli/src/tools/bash.ts` + `packages/harness/src/shell.ts`).
  In the new world both belong to `exec`, since the tool fundamentally
  needs the executor.
- **Subagents receive child deps from the product.** The current
  subagent runtime auto-enables shell in child sessions. Replace that
  with explicit `SubagentDefaults`/preset fields for child tools,
  capabilities, large-output store, and task-management tools. The CLI's
  default "copy of me" behavior can still include exec; the package
  should not assume it.
- **File I/O tools (`read_file`/`create_file`/`edit_file`) stay in
  `apps/cli`**. They're already decoupled and the product is the right
  owner — no need for a package unless reused elsewhere.
- **TUI skill search is product-layer behavior.** When skills move out
  of the kernel, `apps/tui` must stop importing `discoverSkills` and
  `Skill` from `@leharness/harness`. The CLI should pass the TUI a small
  skill discovery adapter from `@leharness/skills`, while the harness
  only sees the skills capability in `deps.capabilities`.

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
- `packages/harness/src/core/legacy-capabilities.ts` — **new,
  temporary.** Converts the existing `skills/tasks/subagents` flags into
  capability objects while Phases 1-3 preserve compatibility. This is
  where the temporary imports of `readArtifactTool`,
  `createLoadSkillTool`, `createSpawnSubagentTool`, and
  `builtInTaskTools` live after they leave `prepare-prompt.ts`.
- `packages/harness/src/core/prepare-prompt.ts` — replace `applyBuiltIns`
  + the skill block with the fold loop shown above. Remove the direct
  hard imports of `readArtifactTool`/`createLoadSkillTool`/
  `createSpawnSubagentTool`/`builtInTaskTools`. Delete `applyBuiltIns`.
  If `deps.capabilities === undefined`, call the temporary
  `legacyCapabilities(...)`; if it is an array, fold exactly that array.
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
- Add/adjust one prompt-prep smoke that calls `runInvocation` without
  `deps.capabilities` and asserts legacy defaults still appear, then with
  `deps.capabilities: []` and asserts only caller-provided tools appear.
- Spot-check a TUI session: `/mcp`, `/help`, skills load, a bash bg task
  drains — same behavior as before.

### Phase 2 — `LargeOutputStore` hook

Files touched:
- `packages/harness/src/core/large-output-store.ts` — **new.** Defines
  `LargeOutputStore` and `LargeOutputPurpose`.
- `packages/harness/src/core/invocation.ts` — add
  `largeOutputStore?: LargeOutputStore` to `HarnessDeps`, pass it to
  `executeTools`, and pass it to `drainTaskQueue`.
- `packages/harness/src/prompt.ts` — add `largeOutputStore` to
  `PromptInput` / `buildInput` options so compaction can use the same
  store the execution path uses.
- `packages/harness/src/core/prepare-prompt.ts` — pass
  `deps.largeOutputStore` through to `buildInput`.
- `packages/harness/src/core/execute-tools.ts` — `sizeForContext` now
  calls `ctx.largeOutputStore?.write(...)` for large direct tool output
  instead of `writeArtifact` directly. The kernel records
  `artifact.created` and `tool.completed.artifactId` exactly as before.
- `packages/harness/src/tools.ts` — add `largeOutputStore?` to
  `ToolContext` so `execute-tools.ts` can pass it through without a
  parallel context object.
- `packages/harness/src/core/task-drain.ts` — `renderLarge` receives the
  store and calls it for large background task output/error instead of
  `writeArtifact` directly. Without a store it returns `{ value:
  truncateOutput(bytes), artifactId: undefined }` and skips
  `artifact.created`.
- `packages/harness/src/compaction/pressure-gradient.ts` — replace the
  direct `writeArtifact` T2 promotion with `input.largeOutputStore`.
  Without a store, skip T2 promotion and leave the existing inline-result
  body for later T3/T6 handling.
- `packages/harness/src/compaction/summarize.ts` — accept a
  `largeOutputStore` argument and use it to persist the rendered source
  window. If absent, return a skipped outcome like
  `{ kind: "skipped", reason: "no_large_output_store" }`; do not record a
  `compaction.summary` event with a fake source artifact id.
- `packages/harness/src/artifacts.ts` — add an exported
  `defaultLargeOutputStore(): LargeOutputStore` that wraps the existing
  `writeArtifact` + `formatArtifactStub` behavior. Update
  `artifactsCapability()` to return both pieces:
  ```ts
  const artifacts = artifactsCapability()
  // artifacts.capability contributes read_artifact
  // artifacts.store implements LargeOutputStore
  ```
- `apps/cli/src/cli.ts` — pass `largeOutputStore: artifacts.store` and
  include `artifacts.capability` in `deps.capabilities`.

Verification:
- `smoke-artifacts.ts`, `smoke-compaction-e2e.ts`, `smoke-bash-runtime.ts`
  all pass (these exercise direct tool output, task-drain output, and
  compaction).
- `packages/harness/scripts/smoke/compaction-t2-promote.mjs` still
  observes `artifact.created` + `compaction.tool_promoted`.
- Add a no-store smoke that runs a large direct tool output and a
  high-pressure compaction pass with `largeOutputStore: undefined`;
  expected: no `artifact.created`, no `compaction.tool_promoted`, no
  `compaction.summary`, and final prompt remains under the T6 char cap.

### Phase 3 — Extract packages

One sub-phase per package. **Order matters** (deps point right):

| Sub | Package | Moves out of kernel | New location(s) | Inter-deps |
| --- | ------- | ------------------- | --------------- | ---------- |
| 3a | `@leharness/exec` | `packages/harness/src/shell.ts` + `apps/cli/src/tools/bash.ts` + `apps/cli/scripts/smoke-bash-runtime.ts` | `packages/exec/src/{index.ts, executor.ts, bash-tool.ts, capability.ts}` + `packages/exec/scripts/smoke/` | → `harness` |
| 3b | `@leharness/subagents` | `packages/harness/src/subagents.ts` (the executor + `enableSubagentRuntime` + `createSpawnSubagentTool` + `subagentsCapability`) + `apps/cli/scripts/smoke-subagents.ts` + any sample-subagent registration in `apps/cli` | `packages/subagents/src/{index.ts, executor.ts, spawn-tool.ts, capability.ts}` | → `harness` |
| 3c | `@leharness/artifacts` | `packages/harness/src/artifacts.ts` (filesystem store + `readArtifactTool` + `artifactsCapability` + `defaultLargeOutputStore`) + `apps/cli/scripts/smoke-artifacts.ts` | `packages/artifacts/src/{index.ts, store.ts, read-tool.ts, large-output-store.ts, capability.ts}` | → `harness` |
| 3d | `@leharness/skills` | `packages/harness/src/skills.ts` (discovery + catalog + `load_skill` + `skillsCapability` + `registerBuiltinSkill`) + `packages/harness/scripts/smoke/skills.mjs` | `packages/skills/src/{index.ts, discovery.ts, catalog.ts, load-tool.ts, capability.ts}` + `packages/skills/scripts/smoke/` | → `harness` |

Per sub-phase:
1. Create the new package dir mirroring `packages/mcp/` (see "Package
   template" above).
2. Move the files; rewrite imports in the moved code to use
   `@leharness/harness` for kernel types.
3. Update consumers (notably `apps/cli/src/cli.ts`, `apps/tui/src/app.tsx`,
   and package smokes). Do not make `subagents` import `exec`; pass child
   tools/capabilities from the CLI instead.
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
  `subagents` from `HarnessDeps`. `runInvocation` now creates
  `taskServices` unconditionally and passes them to `preparePrompt` /
  `executeTools`; the model only sees task-management tools when the
  caller explicitly includes `builtInTaskTools` in `deps.tools`.
- `packages/harness/src/core/prepare-prompt.ts` — remove remaining
  legacy-flag branches from the compatibility phase.
- `packages/harness/src/index.ts` — barrel no longer re-exports the
  extracted modules (they're gone from the source tree after Phase 3
  anyway, but tidy any lingering refs).
- `apps/cli/src/cli.ts` — assemble its full capability set explicitly,
  with no reliance on kernel defaults.
- `apps/tui/src/app.tsx` / `apps/tui/src/index.tsx` — stop checking
  `deps.tasks` for background-update subscriptions and stop reading
  `deps.skills` for slash search. Receive explicit product-layer adapters
  for background updates and skill discovery.

Verification:
- Existing `pnpm smoke` green.
- New **bare-kernel smoke** — `packages/harness/scripts/smoke/bare-kernel.mjs`:
  - Construct minimal `HarnessDeps` with `capabilities: []`,
    `largeOutputStore: undefined`, `tools: [/* one trivial echo tool */]`.
  - Run a one-step invocation against the existing fake provider used by
    other harness smokes.
  - Assert: no `artifact.created` events; no `skill.loaded` events; no
    auto-injected tools in the model-facing tool list (only the echo
    tool); large outputs (>16KB) come back truncated, not artifacted;
    no task-management tools are visible unless explicitly passed.
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
