---
name: typescript-best-practices
description: Use when writing, modifying, refactoring, or reviewing TypeScript in this repo, especially dynamic JSON or event parsing, async control flow, public exports, naming, nullish handling, provider adapters, MCP boundaries, CLI code, or TUI state.
---

# TypeScript Best Practices

This repo uses TypeScript as a contract tool, not just a syntax check. Make invalid states hard to represent, keep external data as `unknown` until parsed, and let lint rules catch patterns agents tend to rationalize around.

## Naming

- Use descriptive names from the local domain: `event`, `toolCall`, `taskId`, `sessionId`, `transport`, `provider`, `transcriptCell`.
- Avoid "bag of data" names like `data`, `info`, `payload2`, `resultObj` unless that is the domain term.
- Do not abbreviate outside well-known terms. Prefer `command`, `message`, `response`, `request`, `position`, `identifier`.
- Callback parameters should be readable: `events.map((event) => event.type)`, not `events.map((e) => e.type)`.
- Name functions by what they return or decide: `readToolCall`, `isShellExecutor`, `getSessionPath`. Avoid vague `process*`, `handle*`, or `resolve*` unless the file already owns that vocabulary.
- Extract complex conditionals into named booleans.

## Comments

- Comments should explain non-obvious current behavior, not narrate the next line.
- Do not document alternatives in code comments. Put alternatives-considered reasoning in the PR description.
- Keep comments close to fragile ownership, compatibility, or lifecycle details: event compatibility, cancellation, stream parsing, artifact recoverability.

## Types and Boundaries

- Use `unknown` at external boundaries: JSON, event logs, provider SDK responses, MCP messages, file configs, and environment-derived values.
- Parse once at the edge and return a typed value. Downstream code should not repeatedly narrow the same payload.
- Prefer small type guards and reader helpers over `as` casts.
- If a cast is unavoidable, isolate it at the narrowest adapter boundary and explain why the type cannot be derived. The `leharness/no-as-cast` rule should usually be disabled only around SDK overload limitations.
- Keep discriminated unions explicit for events, task states, tool results, and command variants.
- Do not use enums. Use string literal unions or `as const` objects.
- Let TypeScript infer implementation return types when the return is `void` or `Promise<void>`.
- Avoid `any`. If a third-party type is weak, wrap it in a local parser or adapter.

## Nullish and Boolean Patterns

- Use `Boolean(value)` instead of `!!value`.
- Use `??` instead of `||` when defaulting values that may validly be `0`, `""`, or `false`.
- Use optional chaining for optional calls and property access.
- Throw or return a typed error when a required value is missing. Do not use non-null assertions.
- Do not make inputs nullable just to immediately return on null. Narrow before calling when possible.

## Async Ownership

- Await promises unless they are intentionally detached.
- For intentional fire-and-forget work, use `void promise.catch(...)` and make ownership clear nearby.
- Do not pass async callbacks to APIs that ignore returned promises.
- Preserve cancellation and close paths. Shell, subagent, MCP transport, and provider stream code should make it clear who owns cleanup.
- In tests and smoke scripts, fail loudly when scripted provider responses are exhausted.

## Imports and Exports

- Avoid new barrel files for app-local code.
- Published package entrypoints are the exception: keep `packages/harness/src/index.ts` intentional and boring.
- Do not export test-only helpers or app-local utilities from package roots.
- Prefer importing the source helper directly inside a package unless it is part of the public API.

## JSON and Event Parsing

Do not write:

```ts
const event = JSON.parse(line) as Event
```

Use a parser or reader helper:

```ts
const event = parseEvent(JSON.parse(line))
```

For untrusted records:

```ts
const command = readStringField(payload, "command")
if (command === undefined) return
```

Reader helpers are a good fit when the shape is small and local. Use schema validation when the shape is larger, user-authored, or reused across boundaries.

## Anti-Patterns

| Anti-pattern | Why it fails | Better shape |
| --- | --- | --- |
| `value as SomeType` after JSON parse | Hides malformed input until runtime | Parser or schema returning `SomeType` |
| `!!value` | Hides intent and is linted | `Boolean(value)` |
| Explicit `: void` on implementations | Adds noise and is linted | Let inference handle it |
| Enum for string states | Emits runtime JS and adds indirection | String literal union |
| Repeated optional-field checks downstream | Parsing happened too late | Parse once at the boundary |
| Detached promise without catch | Unhandled rejection or hidden lifecycle | `void task.catch(...)` with ownership comment |
| New helper for one call site | Often abstraction theater | Inline or use existing helper |
