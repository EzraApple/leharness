# 006 — Filesystem Artifacts

## Goal

Add a session-scoped artifact storage primitive so large tool outputs no
longer bloat the prompt or get truncated into uselessness. The harness
auto-artifacts any tool result over a threshold, writes the full content to
disk, and replaces the in-context value with a short stub + the artifact id.
A built-in `read_artifact` tool lets the model pull back full content (or a
slice) when it actually needs it.

This is the foundation that the next plan (smart compaction) builds on:
once arbitrary content can be stashed under a stable id, compaction stops
being purely lossy ("delete old turns") and becomes "move to disk with a
summary, recoverable on demand."

This plan deliberately does not cover:
- Smart compaction (next plan, consumes the artifact service)
- Artifact cleanup / retention policy
- Cross-session artifact access (subagent reading parent's artifacts)
- Non-string MIME types beyond a best-effort label field

## Why filesystem artifacts belong in the kernel

The README's third unbuilt core bet, restated:

> Big outputs should live on disk with stable references so they can be
> revisited later without bloating active context.

Currently `packages/harness/src/tools.ts:truncateOutput` caps every tool
result at 16KB inline; anything past gets a `[truncated: N bytes]` footer
and the rest is lost. That's a quality ceiling for any session that touches
verbose commands (`pnpm test --reporter=verbose`, `git log -p`, `read_file`
on a 2000-line file). It's also the reason verbose-background bash feels
fragile — the longer it runs, the more output is dropped before the model
ever sees it.

The fix has been waiting for the right shape: instead of truncating,
**write the full content to disk and hand the model a stable reference**.
The model sees a stub small enough to fit comfortably; it can call
`read_artifact` to pull the full content (or a paginated slice) when its
reasoning actually needs the detail.

This also creates the seam compaction needs. Once "moving content to a
referenced artifact" is a primitive, compaction can do the same trick on
old turns — replace `tool.completed` history with stub + artifact_id +
summary instead of dropping it. The model loses no recoverable information.

## Position vs neighbouring harnesses

- **OpenDev** compaction explicitly writes old tool results to files and
  references them — the closest reference for what this plan ships.
- **OpenCode** has `subtask` and `snapshot` parts in its message store,
  filesystem-backed; same idea, different framing.
- **Claude Code** truncates large outputs in-context with a "ctrl+r to
  expand" UI hint but doesn't persist by reference.
- **Codex** caps tool output size; large outputs are summarized inline.

leharness's shape: closest to OpenDev. Treat artifacts as a kernel service
both tools (auto-on-big-output) and compaction (future) consume through
the same primitive.

## Decisions locked in

| Area | Decision |
| ---- | -------- |
| Storage location | `.leharness/sessions/<sessionId>/artifacts/<artifactId>` — co-located with the session's `events.jsonl` so cleanup is a single directory remove. |
| Id scheme | `artifact_<ulid>` — same shape as `task_<ulid>` for consistency. |
| Auto-artifact threshold | 8 * 1024 bytes (8KB). Tool outputs above this get artifacted automatically; outputs below pass through inline as today. Configurable later if real usage shows the threshold is wrong. |
| Truncation cap | **Stays** as a last-resort safety net for adversarially-huge results. Auto-artifact catches outputs at 8KB before truncation ever fires in normal use; if the artifact write itself errors or the path is somehow bypassed, the existing 16KB truncation prevents context blow-up. |
| Removability | The feature is its own module — `packages/harness/src/artifacts.ts` plus the two call sites in `core/execute-tools.ts` and `core/task-drain.ts`. No runtime flag: if the feature ever needs to come out, deleting the module + reverting the two ~10-line auto-artifact branches restores truncation as the only safety net. Consumers' code never had to *read* the new event type or `artifactId` field — both are additive. See *Removability* section below. |
| Stub format | `[artifact: <id> · <byteCount> bytes · head:\n<first ~400 chars>\n]`. Gives the model immediate context + a stable handle to fetch more. |
| Event | New `artifact.created { id, sessionId, byteCount, mime?, sourceCallId?, sourceTaskId? }`. Records what tool/task produced the artifact for replay tooling. |
| Tool result projection | When a tool result was artifacted, the `tool.completed` event records the stub as `result` AND adds an `artifactId: <id>` field. `eventToMessage` projects the stub verbatim — the model sees what the tool effectively returned. |
| Model-facing tool | `read_artifact({ artifact_id, since_byte? })`, built-in shipped from the harness, auto-injected when tasks are enabled (same gate as `read_task` — both are read primitives for harness-managed durable storage). |
| MIME | `mime?: string` field on the Artifact record. Defaults unset (treated as text). Tool integration sets `text/plain` for now. Hooks for `application/json` etc. when needed. |
| Cross-session access | Per-session only. `read_artifact(id)` resolves within the calling invocation's sessionId. A subagent reading a parent's artifact requires a future explicit-pointer mechanism. |
| Cleanup | Not in scope. Artifacts accumulate; manual cleanup is a workspace-level concern for v1. |

## Event additions

One new event type, plus an optional field on `tool.completed`:

```ts
// new
{ type: "artifact.created", id, sessionId, byteCount, mime?, sourceCallId?, sourceTaskId? }

// existing tool.completed gains an optional field:
{
  type: "tool.completed",
  call,
  result,                  // the stub when artifactId is present
  summary?,
  artifactId?: string      // present when result was artifacted
}
```

Same envelope (`v: 1`). Replay-friendly: the artifact_id lets a future
inspector load the on-disk content even after the session has long ended.

## Internal types

```ts
// packages/harness/src/artifacts.ts (new)

export interface Artifact {
  id: string                 // "artifact_01J..."
  sessionId: string
  createdAt: string          // ISO
  byteCount: number
  mime?: string              // "text/plain" default; unset = treat as text
}

export interface WriteArtifactOptions {
  mime?: string
  sourceCallId?: string      // recorded into artifact.created for replay
  sourceTaskId?: string      // same
}

export async function writeArtifact(
  sessionId: string,
  content: string | Buffer,
  options?: WriteArtifactOptions,
): Promise<Artifact>

export async function readArtifact(
  sessionId: string,
  artifactId: string,
): Promise<{ content: string; byteCount: number; mime?: string }>

export function resolveArtifactPath(sessionId: string, artifactId: string): string
export function newArtifactId(): string

// Constants
export const AUTO_ARTIFACT_THRESHOLD_BYTES = 8 * 1024
export const STUB_HEAD_CHARS = 400
```

The async ops use `fs.promises`; `writeArtifact` does `mkdir -p` on the
artifacts directory if it doesn't exist.

## Auto-artifact in the loop

In `core/execute-tools.ts` (post-rename), after a successful tool result:

```ts
if (result.kind === "ok") {
  const value = result.value
  if (byteLength(value) > AUTO_ARTIFACT_THRESHOLD_BYTES) {
    const artifact = await writeArtifact(ctx.sessionId, value, {
      mime: "text/plain",
      sourceCallId: result.call.id,
    })
    await ctx.recordEvent?.("artifact.created", {
      id: artifact.id,
      sessionId: artifact.sessionId,
      byteCount: artifact.byteCount,
      mime: artifact.mime,
      sourceCallId: result.call.id,
    })
    const stub = formatArtifactStub(artifact, value)
    await ctx.recordEvent?.("tool.completed", {
      call: result.call,
      result: stub,
      summary: result.summary,
      artifactId: artifact.id,
    })
  } else {
    // existing inline path
    await ctx.recordEvent?.("tool.completed", { call: result.call, result: value, summary: result.summary })
  }
}
```

`formatArtifactStub` builds the `[artifact: ... · head: ...]` string.

Background-task results (the `task.completed` Messages posted by
executors) go through the same path: when the loop drains a Message and
the result exceeds the threshold, it artifacts before recording the
`task.completed` event. Means `bash` with verbose output, finished in the
background, gets the same treatment as foreground.

## `read_artifact` tool

```ts
read_artifact({
  artifact_id: string,
  since_byte?: number,       // for pagination, mirrors read_task's since_byte
})
```

Tool implementation:
- Read the artifact from `resolveArtifactPath(ctx.sessionId, artifact_id)`.
- If `since_byte` is set, return the slice from that cursor onward.
- Truncate the returned slice at `MAX_TOOL_OUTPUT_BYTES` (16KB, same cap
  as foreground tool inline output) — calls the artifact-from-an-artifact
  rabbit hole closed by capping the read. Models can paginate via
  `since_byte` if they want more.
- Return:
  ```
  [artifact <id> · <total> bytes · <mime> · cursor <from> → <to>]
  <slice>
  ```
- `summary` field on the result: `<bytes returned> bytes`.

`read_artifact` is auto-injected by `preparePrompt` alongside `wait_task`
/ `read_task` / `cancel_task` when tasks are enabled — both rely on the
same harness-managed disk storage and apps that enable tasks almost
always want artifact access too.

## Files to modify or add

| File | Change |
| ---- | ------ |
| `packages/harness/src/artifacts.ts` *(new)* | `Artifact`, `writeArtifact`, `readArtifact`, `resolveArtifactPath`, `newArtifactId`, `AUTO_ARTIFACT_THRESHOLD_BYTES`, `STUB_HEAD_CHARS`, `formatArtifactStub`. |
| `packages/harness/src/tasks.ts` | Add `readArtifactTool` next to `readTaskTool` / `cancelTaskTool`; add to `builtInTaskTools` array. |
| `packages/harness/src/core/execute-tools.ts` *(after rename)* | Auto-artifact branch for tool results > threshold. |
| `packages/harness/src/core/task-drain.ts` *(after rename)* | Auto-artifact branch when draining `task.completed` Messages with large `result` strings. |
| `packages/harness/src/tools.ts` | Remove `MAX_TOOL_OUTPUT_BYTES` / `truncateOutput` (or leave as a private last-resort cap above some very high ceiling like 1MB — pending preference). |
| `packages/harness/src/index.ts` | Export the new symbols. |
| `apps/cli/src/render.ts` | Render `tool.completed` events with `artifactId` showing the stub (already does — stub *is* `result`); render new `artifact.created` event as a one-line note (`← artifact <id> · <bytes>`). |
| `apps/tui/src/state/transcript.ts` | Reduce `artifact.created` to a small system cell or attach as detail to the tool cell that produced it. |
| `apps/tui/src/display/tools.ts` | `read_artifact` display verbs (reading / read / read failed for, target = short id). |
| `apps/cli/scripts/smoke-artifacts.ts` *(new)* | End-to-end: tool produces > threshold output, assert `artifact.created` + `tool.completed.artifactId`, file exists on disk, `read_artifact` returns the content; pagination via `since_byte`. |
| `package.json` | Add `smoke-artifacts` to `smoke:apps`. |

**Folded into the same PR (separate commit)**: the long-overdue rename of
`packages/harness/src/harness/` → `packages/harness/src/core/`. Pure
mechanical move + import path updates.

## Verification

Smoke (`apps/cli/scripts/smoke-artifacts.ts`):

1. **Auto-artifact for large tool output.** Register a fake tool returning
   a 20KB string. Run runInvocation. Assert: an `artifact.created` event
   landed; `tool.completed.artifactId` is set; the stub starts with
   `[artifact:`; the file exists at `resolveArtifactPath(...)`;
   `readArtifact()` returns the original 20KB content byte-equal.
2. **Inline path unchanged for small outputs.** Register a fake tool
   returning 1KB. Assert: no `artifact.created`; `tool.completed.result`
   is the original 1KB string; `tool.completed.artifactId` is absent.
3. **`read_artifact` round-trip.** After (1), call `read_artifact` with
   the artifact id. Assert: the tool result contains the byte range header
   and the content slice matches the original.
4. **Pagination via `since_byte`.** Call `read_artifact` with
   `since_byte: 8000`. Assert: the slice starts at byte 8000 and goes to
   the end; `next_byte_cursor` is the total length.
5. **Background-task auto-artifact.** Spawn a background `bash` that
   produces > 8KB of output (e.g. `for i in $(seq 1 500); do echo line $i; done`).
   Drain the completion. Assert: `task.completed` event landed; the
   message's `result` is an artifact stub; an `artifact.created` event
   followed; the original output is on disk.

Plus manual verification with `lh-dev`: run a `bash` command that produces
a long output (`pnpm smoke` or similar). The model's prompt should show
the artifact stub, not the full content; if the model asks "what does the
output say", calling `read_artifact` should give it the full thing.

## Removability

Treated as a first-class property because this is the first kernel
feature that *might* not survive a real-usage review. The rollback story
is modularity, not a runtime flag — a feature flag would just be more
code paths to maintain, and the "off" branch would slowly bit-rot. If
artifacts ever need to come out, deleting the module is straightforward:

**Single-point-of-removal:** if the file
`packages/harness/src/artifacts.ts` is deleted, the only other code
that needs to come out is:

- The `import` + ~10-line auto-artifact branch in
  `core/execute-tools.ts` (collapse `sizeForContext` back to a
  `truncateOutput` call).
- The `import` + ~10-line auto-artifact branch in `core/task-drain.ts`
  (collapse `renderLarge` back to a `truncateOutput` call).
- The `readArtifactTool` injection in `core/prepare-prompt.ts`.
- The `export * from "./artifacts.js"` line in `index.ts`.

Roughly ~80 lines of net deletion, no projection refactors, no
event-log migration. The `tool.completed.artifactId` field becomes
permanently absent (reducers that ignored it keep working unchanged),
and the `artifact.created` event type simply stops being emitted
(reducers that didn't have a case for it already fall through to the
default — a no-op in the TUI's `reduceEvent` and the CLI's
`LiveRenderer`). Truncation comes back as the only safety net, which
is exactly where the harness was before.

## What this rules out, what it leaves open

Ruled out for this plan:

- Smart compaction strategies (next plan). The artifact primitive is the
  foundation; the compaction strategy that consumes it lands separately.
- Artifact cleanup / retention policy. Artifacts pile up; cleanup is a
  workspace-level concern for v1.
- Cross-session artifact access (subagent reading parent's artifacts).
  Per-session resolution only.
- Non-text artifacts (binary, image). The `mime` field is captured for
  forward-compat but `read_artifact` returns strings; binary reading is
  out of scope.
- Streaming reads. `read_artifact` reads the requested slice into memory
  and returns it. Reasonable for capped reads; revisit if a real use case
  needs streaming.

Left open and additive:

- A `delete_artifact` / `gc_artifacts(sessionId, keepMostRecent: N)` for
  manual cleanup.
- A `write_artifact` tool exposed to the model so it can stash large
  intermediate output it wants to refer back to later.
- Cross-session artifact pointers (e.g. `parent:artifact_01J...`).
- A web inspector view that follows `artifact.created` events and
  surfaces a "view artifact" link.

## Naming alternatives

| Concept | Proposed | Alternatives |
| ------- | -------- | ------------ |
| Storage primitive | `Artifact` *(locked)* | `Blob`, `Attachment`, `Document` — `artifact` matches README + research-doc terminology |
| Auto-artifact threshold | `AUTO_ARTIFACT_THRESHOLD_BYTES` *(locked)* | `INLINE_LIMIT_BYTES`, `MAX_INLINE_TOOL_OUTPUT_BYTES` |
| Read tool | `read_artifact` *(locked)* | `load_artifact`, `fetch_artifact`, `get_artifact` — `read` mirrors `read_file` / `read_task` |
| Stub prefix | `[artifact: <id> · <bytes> bytes · head:` | `[stored as artifact:`, `[artifact ref:`, `[disk:` — the bracket-prefix convention is consistent with task drain projection format |
| Event | `artifact.created` *(locked)* | `artifact.written`, `artifact.recorded` — matches `*.created` shape elsewhere |
| Tool result field | `artifactId` *(locked)* | `artifact_id`, `artifactRef` — camelCase matches existing event field conventions |
