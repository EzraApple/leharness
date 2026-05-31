# Agent Instructions

This repo is a TypeScript ESM monorepo for experimenting with local AI harnesses, terminal UX, MCP wiring, subagents, skills, and compaction. Prefer small changes that preserve the public harness API and keep the runnable demos honest.

## Development Workflow

- Start with `rg` and focused file reads before editing.
- Keep event, task, provider, MCP, and TUI contracts stable unless the change is explicitly about that contract.
- Prefer typed parsing helpers at JSON and event boundaries instead of broad casts.
- Use package-local patterns before adding new abstractions.

## Verification

Run the narrowest useful command while iterating, then broaden before handoff:

- `pnpm lint`
- `pnpm -r build`
- `pnpm smoke`
- `pnpm knip`
- `pnpm package:verify` when packaging or exports changed
