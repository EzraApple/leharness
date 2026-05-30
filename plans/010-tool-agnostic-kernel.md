# 010 — Tool-agnostic kernel

## Goal

Make `@leharness/harness` **auto-inject no model-facing capability
tools**. Today the kernel both *runs* tools and *ships* concrete ones:
task-management, subagents, skills, and `read_artifact` are baked into
prompt-prep. Pull product-level capabilities into packages layered over
the kernel, so the core becomes pure mechanism you can run with zero
exposed tools and then bolt capabilities onto.

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
   matters because artifact storage is core, but the artifact read tool
   should not be a special always-on model tool.
2. The same file composes the **skill catalog into the system prompt**,
   re-rendered per invocation (depends on `userText` + recently loaded
   skills from `invocation.events`).
3. `apps/cli/src/tools/read_file.ts` returns whole files. That is why
   `read_artifact` exists: without pagination, reading a large artifact
   through `read_file` can dump too much content back into context and
   get artifacted/truncated again.
4. `core/execute-tools.ts`, `core/task-drain.ts`, and compaction all use
   the artifacts module for durable overflow storage. That part is
   correct kernel behavior and should stay core.
5. `HarnessDeps` carries `skills` / `tasks` / `subagents` flags, and
   `packages/harness/src/index.ts` re-exports every concrete feature.

The boundary is therefore: keep artifact **storage** in the kernel, but
remove the special `read_artifact` tool by making `read_file` safe to use
on large text files.

## Target architecture

Three layers, dependencies pointing only inward:

```
@leharness/harness   (kernel — pure mechanism, auto-injects ZERO tools)
  loop · event log · session projection · prompt assembly · compaction
  Tool contract + dispatch · async substrate (Task / TaskExecutor / queue / drain)
  core artifact storage for large outputs + compaction recovery
  optional task-management tool exports (wait/read/cancel — caller chooses)
        ▲
  capability packages   (opt-in; each owns its tool(s) + executor + hooks)
  @leharness/exec · /subagents · /skills · /mcp (already exists)
        ▲
  product   (apps/cli — composes the kernel + the capabilities it wants;
             also keeps bounded file tools read/create/edit)
```

| Package | Owns | Avenue |
| ------- | ---- | ------ |
| `@leharness/harness` | loop, log, prompt/compaction, Tool contract, **async substrate**, core artifact storage, optional task-mgmt tool exports | the kernel |
| `@leharness/exec` | `bash` + the background-capable command executor | running commands, fg/bg |
| `@leharness/subagents` | `spawn_subagent` + executor | delegating to isolated child runs |
| `@leharness/skills` | `load_skill` + discovery + catalog injection | loadable instruction modules |
| `@leharness/mcp` | (unchanged) | external tool servers |
| `apps/cli` file tools | bounded `read_file`, `create_file`, `edit_file` | product-facing file access |

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
  // {kind:"started", task} use this.
  taskServices: SessionTaskServices
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
const capabilities = deps.capabilities ?? []
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
and the skill-catalog block from `prepare-prompt.ts`. There is no
default adapter: omitted `deps.capabilities` and explicit `[]` both mean
"no product capabilities." The CLI passes the capability list it wants.

## Bounded `read_file` replaces `read_artifact`

Artifacts remain a kernel storage primitive. The kernel still writes
large tool outputs, background task results, promoted inline results, and
compaction summary source windows under:

```text
.leharness/sessions/<sessionId>/artifacts/<artifactId>
```

The simplification: do **not** keep a separate `read_artifact` tool as
the model-facing recovery path. Instead, make the product's normal
`read_file` tool safe for large text files:

```ts
read_file({
  path: string
  // 1-based line number. Defaults to 1.
  offset?: number
  // Number of lines to read. Defaults below the artifact threshold and is
  // capped so a single read does not immediately become another artifact.
  limit?: number
})
```

Recommended constants:

```ts
const READ_FILE_DEFAULT_LIMIT_LINES = 400
const READ_FILE_MAX_LIMIT_LINES = 2000
```

Behavior:

- `offset` is 1-based and defaults to `1`.
- `limit` defaults to `READ_FILE_DEFAULT_LIMIT_LINES` and clamps to
  `READ_FILE_MAX_LIMIT_LINES`.
- Output is line-numbered (`cat -n` style or equivalent).
- The footer reports the line range, total lines, and next offset when
  more content remains.
- Small files shorter than the default cap still return in one call.
- Large artifact files are just normal files, so the model reads them in
  chunks with the same `read_file` tool it already uses for source/docs.

Artifact stubs change from a pathless handle to a readable path:

```text
[artifact: .leharness/sessions/<sessionId>/artifacts/<artifactId> · 124288 bytes · head:
...
Use read_file with offset/limit to inspect more.]
```

This avoids a special artifact read protocol while keeping the original
reason artifacts exist: large outputs stay recoverable without flooding
the next prompt.

## `HarnessDeps` changes

Add:
- `capabilities?: Capability[]` — folded by `prepare-prompt`.
  `undefined` and `[]` both mean no capabilities; products pass the
  capabilities they want.

Remove:
- `skills?: SkillOptions | false`
- `tasks?: boolean`
- `subagents?: boolean`

Each removed flag's behavior moves into explicit product composition:
- Task services are an always-on kernel mechanism
  (`getOrCreateTaskServices` is cheap and no-op until a tool starts
  work). Model-facing task tools appear only when the product passes a
  task management capability.
- `spawn_subagent` appears only when the product passes the subagent
  capability.
- `load_skill` and skill catalog prompt augmentation appear only when
  the product passes the skills capability.

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
- **Artifact storage stays in `@leharness/harness`.** Artifacts are not a
  product-level capability like skills or MCP; they are part of prompt
  and context management. `artifact.created`,
  `tool.completed.artifactId`, terminal task-event `artifactId`,
  `compaction.tool_promoted.artifactId`, and
  `compaction.summary.sourceArtifactId` remain the event-log contract.
- **`read_artifact` is retired in favor of bounded `read_file`.** The
  problem was not that artifacts need a custom reader; it was that
  `read_file` read whole files. Once `read_file` supports line-based
  `offset`/`limit` with safe defaults, artifact stubs can point at real
  paths and the model can use normal file reading in chunks.
- **Bash tool lives with the executor in `@leharness/exec`.** Today it's
  split (`apps/cli/src/tools/bash.ts` + `packages/harness/src/shell.ts`).
  In the new world both belong to `exec`, since the tool fundamentally
  needs the executor.
- **Subagents receive child deps from the product.** The current
  subagent runtime auto-enables shell in child sessions. Replace that
  with explicit `SubagentDefaults`/preset fields for child tools,
  capabilities, and task-management tools. The CLI's default "copy of
  me" behavior can still include exec; the package should not assume it.
- **File I/O tools (`read_file`/`create_file`/`edit_file`) stay in
  `apps/cli`**. They're already decoupled and the product is the right
  owner — no need for a package unless reused elsewhere. `read_file`
  becomes bounded and line-oriented as part of this plan because it is
  the replacement read path for large artifact files.
- **TUI skill search is product-layer behavior.** When skills move out
  of the kernel, `apps/tui` must stop importing `discoverSkills` and
  `Skill` from `@leharness/harness`. The CLI should pass the TUI a small
  skill discovery adapter from `@leharness/skills`, while the harness
  only sees the skills capability in `deps.capabilities`.

## Migration — per-phase detail

Each phase ends green on `pnpm -r build && pnpm biome check . &&
pnpm knip && pnpm smoke`. Phase commits land via PR.

### Phase 1 — Capability hook in the kernel

**No new packages. No default adapter.** The concrete capabilities
still live in the kernel repo for now, but the product opts into them
explicitly through `deps.capabilities`.

Files touched:
- `packages/harness/src/core/capability.ts` — **new.** Defines
  `Capability` and `CapabilityContext`.
- `packages/harness/src/core/prepare-prompt.ts` — replace `applyBuiltIns`
  + the skill block with the fold loop shown above. Remove the direct
  hard imports of `readArtifactTool`/`createLoadSkillTool`/
  `createSpawnSubagentTool`/`builtInTaskTools`. Delete `applyBuiltIns`.
- `packages/harness/src/core/invocation.ts` — add
  `capabilities?: Capability[]` to `HarnessDeps`. Remove the old
  `skills/tasks/subagents` flags.
- `packages/harness/src/skills.ts` — add an exported
  `skillsCapability(opts: SkillOptions): Capability` that wraps the
  existing catalog logic.
- `packages/harness/src/subagents.ts` — add an exported
  `subagentsCapability(services: SessionTaskServices): Capability`
  contributing `createSpawnSubagentTool(services)`.
- `packages/harness/src/tasks.ts` — add
  `taskManagementCapability(): Capability` for wait/read/cancel task
  tools.
- `apps/cli/src/cli.ts` — build the capability list and pass via
  `deps.capabilities`:
  ```ts
  const capabilities = [
    taskManagementCapability(),
    subagentsCapability(services),
    skillsCapability(skillOpts),
  ]
  ```

Verification:
- `pnpm smoke` green.
- Add/adjust one prompt-prep smoke that calls `runInvocation` without
  `deps.capabilities` and asserts only caller-provided tools appear, then
  with `taskManagementCapability()` and asserts task tools appear.
- Spot-check a TUI session: `/mcp`, `/help`, skills load, a bash bg task
  drains — same behavior as before.

### Phase 2 — bounded `read_file`, retire `read_artifact`

Files touched:
- `apps/cli/src/tools/read_file.ts` — change the schema from whole-file
  only to:
  ```ts
  z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  })
  ```
  Use `offset` as a 1-based line number. Default `offset` to `1`.
  Default `limit` to `READ_FILE_DEFAULT_LIMIT_LINES = 400` and clamp to
  `READ_FILE_MAX_LIMIT_LINES = 2000`.
- `apps/cli/src/tools/read_file.ts` — render output with stable line
  numbers. Include a footer like:
  ```text
  [read_file: <path> lines 1-400 of 2319; next offset: 401]
  ```
  If the file fits in the selected range, the footer should say the range
  is complete.
- `packages/harness/src/artifacts.ts` — update `formatArtifactStub` to
  include the artifact file path returned by `resolveArtifactPath(...)`,
  not only the artifact id. The stub should instruct the model to use
  `read_file` with `offset`/`limit` for more content.
- `packages/harness/src/compaction/pressure-gradient.ts` — update T3
  tombstones and prior-promotion stubs so they reference the artifact file
  path + `read_file`, not `read_artifact`.
- `packages/harness/src/artifacts.ts` and `packages/harness/src/index.ts`
  — remove `readArtifactTool`, `createReadArtifactTool`, and
  `readArtifact(...)`; artifact recovery goes through the artifact file
  path plus bounded `read_file`.
- `packages/harness/src/core/prepare-prompt.ts` — no `read_artifact`
  tool is added to the model-facing tool list.
- `apps/tui/src/display/tools.ts` and transcript rendering, if they have
  special `read_artifact` labels, can drop them or treat old event logs as
  historical display only.

Verification:
- Update `smoke-artifacts.ts`: large output still creates
  `artifact.created` + `artifactId`, and the artifact file can be read in
  chunks through `read_file({ path, offset, limit })`.
- Add/adjust a `read_file` smoke covering default limit, explicit
  `offset`, explicit `limit`, and clamp behavior.
- `packages/harness/scripts/smoke/compaction-t2-promote.mjs` still
  observes `artifact.created` + `compaction.tool_promoted`, but projected
  stubs point at paths and `read_file` instructions.
- Assert no `read_artifact` tool appears in the model-facing tool list
  once Phase 2 lands.

### Phase 3 — Extract packages

One sub-phase per package. **Order matters** (deps point right):

| Sub | Package | Moves out of kernel | New location(s) | Inter-deps |
| --- | ------- | ------------------- | --------------- | ---------- |
| 3a | `@leharness/exec` | `packages/harness/src/shell.ts` + `apps/cli/src/tools/bash.ts` + `apps/cli/scripts/smoke-bash-runtime.ts` | `packages/exec/src/{index.ts, executor.ts, bash-tool.ts, capability.ts}` + `packages/exec/scripts/smoke/` | → `harness` |
| 3b | `@leharness/subagents` | `packages/harness/src/subagents.ts` (the executor + `enableSubagentRuntime` + `createSpawnSubagentTool` + `subagentsCapability`) + `apps/cli/scripts/smoke-subagents.ts` + any sample-subagent registration in `apps/cli` | `packages/subagents/src/{index.ts, executor.ts, spawn-tool.ts, capability.ts}` | → `harness` |
| 3c | `@leharness/skills` | `packages/harness/src/skills.ts` (discovery + catalog + `load_skill` + `skillsCapability` + `registerBuiltinSkill`) + `packages/harness/scripts/smoke/skills.mjs` | `packages/skills/src/{index.ts, discovery.ts, catalog.ts, load-tool.ts, capability.ts}` + `packages/skills/scripts/smoke/` | → `harness` |

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

### Phase 4 — Package extraction cleanup

Files touched:
- `packages/harness/src/core/invocation.ts` — keep the always-on task
  services and explicit `capabilities` surface while package imports move
  out of the kernel source tree.
- `packages/harness/src/core/prepare-prompt.ts` — should already be only
  the capability fold plus compaction defaults.
- `packages/harness/src/index.ts` — barrel no longer re-exports the
  extracted modules (they're gone from the source tree after Phase 3
  anyway, but tidy any lingering refs).
- `apps/cli/src/cli.ts` — assemble its full capability set explicitly,
  with no reliance on kernel defaults.
- `apps/tui/src/app.tsx` / `apps/tui/src/index.tsx` — keep background
  update subscriptions and skill discovery product-owned; do not add
  kernel flags back.

Verification:
- Existing `pnpm smoke` green.
- New **bare-kernel smoke** — `packages/harness/scripts/smoke/bare-kernel.mjs`:
  - Construct minimal `HarnessDeps` with `capabilities: []`,
    `tools: [/* one trivial echo tool */]`.
  - Run a one-step invocation against the existing fake provider used by
    other harness smokes.
  - Assert: no `skill.loaded` events; no auto-injected tools in the
    model-facing tool list (only the echo tool); no `read_artifact`;
    no task-management tools are visible unless explicitly passed; large
    outputs may still produce core `artifact.created` events because
    artifact storage is kernel resource management, not a model-facing
    capability.
  This is the property — "kernel ships zero opinions" — made executable.

## Standing conventions (the gates each phase must pass)

- `pnpm -r build` clean.
- `pnpm biome check .` clean (use `pnpm biome check --write` for formatting).
- `pnpm knip` clean.
- `pnpm smoke` (full suite) green.
- The standing project rule: rebuild before testing with the lh-dev
  shim or smoke scripts.

## Do not change in this refactor

- **Remaining tool names** (`bash`, `read_file`, `create_file`,
  `edit_file`, `wait_task`, `read_task`, `cancel_task`,
  `spawn_subagent`, `load_skill`). They're part of the model contract.
  `read_artifact` is the deliberate exception: Phase 2 retires it after
  bounded `read_file` lands.
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
