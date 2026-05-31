# Verification

Use the smallest loop that proves the change, then broaden before handoff. If a command already ran after the relevant edit in this conversation, do not rerun it just for ceremony.

## Verification Matrix

| Change surface | Minimum check | Broaden when |
| --- | --- | --- |
| Formatting, lint rules, TypeScript patterns, skills | `pnpm lint` | Always before PR handoff |
| Package TypeScript or public types | `pnpm -r build` | Exports, provider, MCP, CLI, or TUI changed |
| Harness behavior, events, tools, tasks, compaction, skills | `pnpm smoke:harness` or `pnpm smoke` | Behavior crosses package or app boundaries |
| MCP protocol, auth, transport, manager | `pnpm smoke:mcp` | Any MCP package change |
| CLI or TUI behavior | `pnpm smoke:apps` | Transcript, prompt input, slash commands, or app scripts changed |
| Exports, dependencies, unused code | `pnpm knip` | Public exports or package manifests changed |
| NPM package output or launcher | `pnpm package:verify` | Packaging, CLI bundle, exports, or package metadata changed |

## Skill and Agent-Guidance Checks

For changes under `.agents/skills`, `.claude/skills`, or `AGENTS.md`:

```bash
pnpm lint:agent-skills
pnpm lint
```

`pnpm lint:agent-skills` checks skill frontmatter, disallows `.codex/skills`, and verifies `.claude/skills` mirrors `.agents/skills` by symlink.

## Knip and Package Checks

- Treat `pnpm knip` findings as real until proven otherwise. Remove unused exports, dependencies, and files rather than hiding them.
- Run `pnpm package:verify` when package metadata, CLI bundle behavior, public exports, or packed assets change.
- If `knip` only reports a stale config hint, prefer cleaning the config over leaving noisy verification output.

## Reporting

In the final handoff or PR description, list commands that actually ran. If a relevant command could not run, say why and name the remaining risk.
