# 003 — First-Class Skills

## Goal

Add skills as a first-class harness feature without treating them as the same
thing as project instruction files.

The desired user-facing behavior is:

1. A repo or user can define reusable skills in familiar skill directories.
2. The model can see a compact list of relevant skills without paying the
   context cost for every skill body.
3. The model can load one skill by name when it needs the full instructions.
4. Newly created or edited skills become available during the same harness
   session without restarting the CLI.
5. The design stays small enough that alternate catalog strategies can be
   tested by rewriting one module instead of carrying a large abstraction tree.

This plan deliberately does not cover `AGENTS.md`, `CLAUDE.md`, or Cursor rule
loading. Those are project instruction features. Skills are procedural modules
with discovery, metadata, activation, and optional supporting files.

## Why Skills Belong In The Harness

Skills are widespread enough across coding harnesses that treating them as
normal files is too weak:

- They need discovery and precedence.
- They need compact model-visible metadata.
- They need a progressive loading path for the full instructions.
- They need hot reload so agents can create or edit skills and use them in the
  next model step.
- They interact with replay and compaction differently from ordinary tool
  output.

The first implementation should still expose the behavior through ordinary
prompt text and tools. "First-class" here means the harness owns the lifecycle,
not that the provider needs a special skill API.

## External Shape To Support

Near-term skill discovery should support the two most useful `SKILL.md`
conventions:

```text
.agents/skills/<skill-name>/SKILL.md
.claude/skills/<skill-name>/SKILL.md
```

Optional later locations:

```text
$HOME/.agents/skills/<skill-name>/SKILL.md
$HOME/.claude/skills/<skill-name>/SKILL.md
```

Keep global user skills out of the first implementation unless the CLI exposes
a flag or config for them. Workspace-local behavior is easier to reason about
and easier to smoke test.

Do not read `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, or OpenCode
configuration as part of this feature. A future instruction loader can share
some parser code, but the product semantics should stay separate.

## Model-Facing Design

Use a hybrid of the Codex and OpenCode patterns:

- The system prompt includes a compact skill catalog.
- The catalog contains names and short descriptions, not full skill bodies.
- The model loads full instructions through a built-in `load_skill` tool.
- The tool reads from the current discovered skill registry, not from whatever
  happened to be rendered into the prompt.

Example catalog:

```text
Available skills. Call load_skill({name}) before applying a skill.
Showing 12 of 34 discovered skills.

- frontend-design: Build or review frontend UI with project conventions and visual QA.
- playwright-debug: Reproduce and inspect browser behavior with Playwright.
- docs-editing: Create, edit, render, and verify docx documents.

Some skills may be omitted by budget. If needed, inspect workspace skill
directories or ask the user for the exact skill name.
```

Do not include file paths in the default catalog. Paths are useful for
debugging, but they increase context cost and make the model more likely to use
ordinary file reads instead of the harness-owned activation path. It should be
easy to change this later by editing the catalog renderer.

## Tool Surface

Start with one tool:

```ts
load_skill({ name: string })
```

Behavior:

- Refresh skill discovery before resolving the name.
- Match by canonical skill name first.
- If there are multiple matching names, pick the highest-precedence source and
  include a short note about the shadowed paths in the result.
- Return the rendered `SKILL.md` content plus a small supporting-file summary.
- Record a `skill.loaded` event with name, path, source, and content hash.

Do not add `search_skills` in the first implementation. The catalog can include
all names with aggressively truncated descriptions for a while, and the model
can inspect workspace skill directories if an omitted skill matters. Add
`search_skills` later if evals show that omitted skills are hard to recover.

The tool result should be concise and deterministic:

```text
Loaded skill: frontend-design
Path: .agents/skills/frontend-design/SKILL.md
Hash: sha256:...

<SKILL.md content>

Supporting files:
- references/react.md
- scripts/check-ui.mjs
```

The first version can return the full `SKILL.md` body up to a fixed byte limit,
for example 32 KiB. If the body exceeds the limit, return the head plus a clear
truncation marker. Supporting files should not be automatically loaded.

## Skill Metadata

Use one flat type in `packages/harness/src/skills.ts`:

```ts
export interface Skill {
  name: string
  description: string
  path: string
  relativePath: string
  source: "workspace_agents" | "workspace_claude"
  mtimeMs: number
  size: number
  contentHash: string
}
```

Metadata parsing rules:

1. Parse YAML frontmatter when present.
2. Use `name` from frontmatter if present; otherwise use the skill directory
   name.
3. Use `description` from frontmatter if present.
4. If no description exists, use the first non-heading paragraph from
   `SKILL.md`, capped to a short length.
5. If no usable description exists, use `No description provided.`

Avoid adding a YAML dependency at first unless it becomes painful. A tiny
frontmatter parser that supports simple `key: value` fields is enough for
`name` and `description`.

## Discovery And Hot Reload

Refresh discovery before every model step and before every `load_skill` call.
This is the simplest reliable hot-reload model:

```ts
const skills = await discoverSkills(process.cwd())
const system = appendSkillCatalog(baseSystem, renderSkillCatalog(skills, ctx))
```

No file watcher is required for correctness. Watchers can miss newly created
directories, introduce platform-specific behavior, and complicate the CLI
lifecycle. Per-step rescan is deterministic and easy to test.

Performance should be acceptable for hundreds of skills if discovery caches
parsed files by:

```text
absolute path + mtimeMs + size
```

The first implementation can skip cross-call caching if needed. Correct hot
reload matters more than optimization. If repeated full reads become noisy, add
a small module-level cache inside `skills.ts`.

## Compact Catalog

The catalog should be generated from the full discovered skill list on each
prompt build.

Default budget:

```ts
const budgetChars = 6000
```

Later, if provider/model metadata exposes a context window:

```ts
const budgetChars = Math.min(8000, Math.max(2500, Math.floor(contextTokens * 4 * 0.02)))
```

Catalog rendering algorithm:

1. Rank skills.
2. Render a header and entries with descriptions capped at 240 chars.
3. If over budget, rerender with descriptions capped at 120 chars.
4. If over budget, rerender with descriptions capped at 60 chars.
5. If still over budget, drop lowest-ranked entries until it fits.
6. Always include the number shown and number discovered.

Ranking can stay simple:

```ts
score =
  explicit mention in user text * 1000 +
  recently loaded in session * 300 +
  workspace source precedence * 100 +
  skill name token match * 80 +
  description token match * 30 -
  long description penalty
```

Inputs available in the current harness:

- latest user text from the invocation
- prior `skill.loaded` events
- source type
- skill name and description

Do not overbuild cwd proximity or glob metadata in the first pass unless the
skill format already contains those fields. They can be added later.

## Prompt Integration

Keep the change close to the current prompt assembly:

1. Add optional `skills?: SkillPromptOptions` to `BuildPromptOptions` or
   `HarnessDeps`.
2. In `runInvocation`, discover skills before `buildInput`.
3. Append the rendered catalog to the system prompt before compaction.
4. Include `load_skill` in the tool list when skills are enabled.

The current compaction code already measures system prompt and tools in
`naiveTruncate`, so catalog bytes will count against the prompt budget. That is
good. It makes catalog cost visible instead of hiding it outside measurement.

The first version does not need a separate prompt-fragment subsystem. A helper
like this is enough:

```ts
function withSkillCatalog(system: string, catalog: string | undefined): string {
  if (catalog === undefined || catalog.length === 0) return system
  return `${system}\n\n${catalog}`
}
```

## Events And Replay

Add an explicit event when a skill is loaded:

```json
{
  "type": "skill.loaded",
  "name": "frontend-design",
  "path": ".agents/skills/frontend-design/SKILL.md",
  "source": "workspace_agents",
  "contentHash": "sha256:..."
}
```

The event should be recorded by the `load_skill` tool through `ToolContext`.
That requires extending `ToolContext` with a narrow event recorder or adding a
tool-result hook in the harness after execution.

Prefer the narrower `ToolContext` extension:

```ts
export interface ToolContext {
  sessionId: string
  recordEvent?: RecordEvent
}
```

That keeps the skill implementation small and makes future tool-emitted events
possible without adding a separate hook system.

Do not project `skill.loaded` directly into provider messages in the first
implementation. The tool result already tells the model what was loaded.
Future compaction can use `skill.loaded` to reattach recent active skills even
if the original tool result was dropped.

## Files To Touch

Expected implementation files:

```text
packages/harness/src/skills.ts
packages/harness/src/harness.ts
packages/harness/src/prompt.ts
packages/harness/src/tools.ts
packages/harness/src/index.ts
packages/harness/scripts/smoke/skills.mjs
packages/harness/scripts/smoke.mjs
```

Possible CLI file if skill enabling should be configurable:

```text
apps/cli/src/cli.ts
```

For the first implementation, skills can be on by default in the CLI and off
only when no skill directories exist. Avoid adding flags until there is a real
need.

## Smoke Test

Add a smoke script that uses a fake provider and a temporary workspace:

1. Create `.agents/skills/example/SKILL.md`.
2. Run an invocation where the fake provider sees the first request.
3. Assert the first request system prompt includes the compact catalog entry.
4. Fake provider calls `load_skill({ name: "example" })`.
5. Assert the tool result includes the skill body.
6. Assert a `skill.loaded` event exists with name, relative path, and hash.
7. Edit `SKILL.md` during the same process.
8. Run another invocation.
9. Assert the second load returns the edited content or edited hash.

This directly covers the important behavior: compact catalog, tool activation,
event recording, and hot reload without restarting the harness.

## Evals Later

Once the smoke test exists, add eval fixtures around catalog strategy:

- all skills visible with short descriptions
- hot set only
- hot set plus recently loaded skills
- no descriptions, names only
- catalog omitted, exact-name load only

For each fixture, measure:

- whether the model loaded the intended skill
- how many model steps it needed
- catalog character cost
- whether it hallucinated a nonexistent skill
- whether it ignored a relevant omitted skill

Keep these as branch-level experiments at first. The implementation should be
easy to rewrite.

## Open Questions

- Should global user skill directories be enabled by default, or only after a
  CLI/config opt-in?
- Should explicit user syntax like `$skill-name` preload the skill without a
  model tool call?
- Should duplicate names be an error, a warning in `load_skill`, or silent
  precedence?
- How large should a loaded `SKILL.md` be allowed to get before truncation?

## Phased Implementation

### Phase 1: Workspace Skills MVP

- Discover workspace `.agents/skills` and `.claude/skills`.
- Render compact catalog into system prompt.
- Add `load_skill`.
- Record `skill.loaded`.
- Add smoke coverage for catalog, load, event, and hot reload.

### Phase 2: Better Selection

- Add recently loaded ranking.
- Add explicit `$skill` or `/skill` handling if useful.
- Add optional global user skill directories.
- Consider `search_skills` only if omitted skills are hard to recover.

### Phase 3: Compaction-Aware Skills

- Reattach recently loaded skills after compaction within a separate skill
  content budget.
- Preserve skill hashes so replay/debug can tell which version was active.
- Add evals for catalog strategies and compaction interaction.
