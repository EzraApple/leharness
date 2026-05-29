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
refactor, not a feature change. The standing smoke suite must stay green
at every phase.

## Why this shape — what's already right vs. what's coupled

The async surface is **already generic** and stays in the kernel:

- `Tool.execute()` returns `ok` (inline) **or** `started` (a durable
  `StartedTask` handle) — that *is* "run inline or hand back a handle."
- `ToolContext` already passes every tool the `SessionTaskServices`, and
  `TaskExecutor` is the plug for "how a kind of background work runs."
  Shell and subagents are just two impls. The loop drains completed
  tasks generically each step.

So the coupling is **not** the runtime — it's package boundaries plus a
few spots where the kernel names concrete capabilities:

1. `core/prepare-prompt.ts` hard-imports `readArtifactTool`,
   `createLoadSkillTool`, `createSpawnSubagentTool`, `builtInTaskTools`
   and auto-injects them (`applyBuiltIns`).
2. The same file composes the **skill catalog into the system prompt**,
   re-rendered per invocation (depends on the user's text + recently
   loaded skills).
3. `core/task-drain.ts` auto-persists large outputs via the artifacts
   store (`writeArtifact`).
4. `HarnessDeps` carries `skills` / `tasks` / `subagents` flags, and the
   kernel `index.ts` re-exports every concrete feature.

Almost all of it is concentrated in `prepare-prompt.ts`.

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

Invert the `prepare-prompt` coupling: instead of naming concrete tools,
the kernel folds over a list of capabilities it knows nothing about.

```ts
interface Capability {
  // contribute tools to this invocation's tool list (may be dynamic)
  tools?(ctx: CapabilityContext): Tool[]
  // optionally augment the system prompt (e.g. the skill catalog)
  augmentSystemPrompt?(base: string, ctx: CapabilityContext): string | Promise<string>
}
```

`prepare-prompt` becomes: start from `deps.tools` + `deps.systemPrompt`,
then fold each `deps.capabilities[i]` over both. It imports no concrete
tool. A capability's `TaskExecutor`/service (if any) is still wired via
the existing `enable*Runtime(services)` pattern — that part already
inverts correctly.

## The two reach-in hooks

- **Skill catalog → prompt:** handled by `Capability.augmentSystemPrompt`
  above. The skills package registers a capability that renders the
  catalog; the kernel never mentions skills.
- **Large output → artifact** (`task-drain`): introduce a small
  `OutputSink` interface the kernel calls for oversized tool/task output.
  The artifacts package provides the default impl; with no sink
  registered, the kernel falls back to truncation (the behavior that
  already exists in `truncateOutput`).

## Dependency direction

- Capabilities depend on `@leharness/harness`; the kernel depends on
  **no** capability.
- Capabilities may depend on each other where real (`@leharness/subagents`
  → `@leharness/exec`, since a child session needs a command runtime) —
  never a cycle, never back to a capability from the kernel.
- The product (`apps/cli`) is the only place that knows the full set; it
  composes them.

## Migration — staged, each phase ships green

1. **Capability hook in the kernel.** Add the `Capability` interface;
   rewrite `prepare-prompt` to fold over `deps.capabilities` instead of
   `applyBuiltIns` + the skill block. The concrete capabilities still
   live in the kernel for now but register *through* the hook. Behavior
   identical; this is the load-bearing change.
2. **`OutputSink` hook** for the large-output reach-in in `task-drain`.
3. **Extract packages** one at a time — `@leharness/exec` first as the
   pattern-setter, then `subagents`, `artifacts`, `skills`. Each is now a
   clean move: the package exports a `Capability` (+ its executor/store)
   and the kernel no longer references it.
4. **Compose in the product + strip the kernel.** `apps/cli` assembles
   the standard capability set so `lh` is unchanged; remove
   `skills/tasks/subagents` from `HarnessDeps`; kernel `index.ts` stops
   re-exporting concrete features. The kernel is now tool-agnostic.

Phases 1–2 are kernel-internal (no new packages). Phase 3 is repetitive
once `exec` proves the pattern. Phase 4 is the cleanup that makes the
property real and testable.

## Verification

- The existing `pnpm smoke` suite stays green after every phase — it's
  the regression guard for "behavior unchanged."
- Each extracted package gets its own smoke (mirrors how `mcp` ships
  `manager-sync` etc.).
- A new "bare kernel" smoke proves tool-agnosticism: run `runInvocation`
  with `capabilities: []` and assert the model sees only the tools the
  caller passed — no auto-injected task/artifact/skill tools.
