---
name: typescript-best-practices
description: Use when writing or reviewing TypeScript in this repo, especially dynamic JSON/event parsing, async control flow, public exports, or provider/MCP boundary code.
---

# TypeScript Best Practices

## Types

- Avoid `any`; use `unknown` at external boundaries and narrow immediately.
- Prefer small type guards and parser helpers over `as` casts. If a cast is unavoidable, isolate it at the boundary and explain why the type cannot be derived.
- Keep discriminated unions explicit for events, task states, commands, and tool results.
- Let TypeScript infer `void` and `Promise<void>` return types on implementations.
- Avoid enums; use string literal unions or `as const` objects.

## Async

- Await promises unless intentionally detached.
- For intentional fire-and-forget work, use `void promise.catch(...)` and explain the ownership in nearby code if it is not obvious.
- Do not pass async functions to callback positions that do not observe the returned promise.

## Boundaries

- JSON parsing, provider SDK responses, MCP payloads, and recorded events are trust boundaries.
- Parse once at the edge, return a typed value, and keep downstream code typed.
- When an upstream library has weak types, isolate the cast in one helper with a narrow return type.

## Exports

- Keep package `index.ts` files boring and intentional.
- Do not introduce broad public exports for test-only or app-local helpers.
