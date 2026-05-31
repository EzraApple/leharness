---
name: writing-skills
description: Use when creating new skills, editing existing skills, consolidating skills, improving skill routing or discovery, validating whether skill instructions work, updating AGENTS.md, or changing agent guidance under .agents/skills, .claude/skills, or .leharness/skills.
---

# Writing Skills

A skill is reusable operational guidance that helps future agents recognize a situation and apply a proven approach. Treat skill writing like product work for agents: define the job, place it in the right surface, make it discoverable, keep the path through the docs obvious, and verify that agents can actually use it.

## Start With Intent

Before editing, answer these from the current conversation and repo context. Ask only for gaps that cannot be inferred.

- What task should this help agents do?
- When should it trigger? Include user phrases, symptoms, tools, paths, and near-miss cases.
- What should the agent produce or decide after reading it?
- Who is the audience: repo developer agents, Claude-compatible agents, or the leharness runtime product?
- What existing skill, `AGENTS.md` rule, script, lint, or smoke test already covers part of this?

## Choose the Right Home

Do placement before writing content.

- **Existing `.agents/skills/<root>/...`:** Prefer this for repo-level guidance that fits an existing area. A root skill plus nested docs reduces top-level prompt clutter while preserving detailed guidance.
- **New top-level `.agents/skills/<skill>/SKILL.md`:** Use only when the guidance needs its own discovery surface and does not naturally fit an existing root skill.
- **`.claude/skills/<skill>` symlink:** Mirror every repo developer skill here with a symlink to `../../.agents/skills/<skill>`. Do not edit symlink targets as source files.
- **`AGENTS.md`:** Use for broad, always-on repo policy that should apply even when no skill is invoked.
- **Script, lint, or test:** Use when behavior is mechanical and enforceable. The skill should point to the command rather than restating a rule that automation can check.
- **`.leharness/skills`:** Use only when the guidance must be discovered by the harness product at runtime, such as dogfood fixtures or runtime skill-discovery behavior. Do not put repo workflow guidance here.

When in doubt, search first:

```bash
find .agents/skills -maxdepth 2 -name SKILL.md -print | sort
rg -n "keyword|tool|old-skill-name" .agents/skills .claude/skills AGENTS.md packages apps scripts
```

Then propose the best home before creating another top-level skill.

## When to Create or Keep a Skill

Create or keep a skill when the guidance is reusable and requires judgment.

- **Good fit:** non-obvious techniques, repeated workflows, routing decisions, tool-specific debugging, API references, review rubrics, quality heuristics.
- **Poor fit:** one-off history, project facts better suited for `AGENTS.md`, mechanical rules that should be linted, obvious language/library docs, narrative postmortems.

If the desired behavior can be enforced reliably by automation, add or use the automation and make the skill point to the command.

## Frontmatter

Every top-level `SKILL.md` needs:

```yaml
---
name: lowercase-hyphen-name
description: Use when [triggering situations, symptoms, tools, paths, and user phrases]
---
```

Rules:

- `name` must be lowercase hyphen-separated and match the skill directory.
- `description` is the main discovery surface. Make it specific and a little forceful.
- Start descriptions with `Use when`.
- Describe triggering conditions, not the workflow. Do not summarize the skill's steps.
- Include concrete keywords an agent or user would mention: errors, tools, file paths, concepts, symptoms, and common synonyms.
- Include important non-obvious use cases. If a consolidated root skill replaces old skill names or tool-specific docs, those names must appear in the root description.
- Keep it compact enough to scan. Longer descriptions are acceptable when needed to preserve discovery after consolidation.

Bad:

```yaml
description: Use when debugging - checks events, sessions, MCP config, then writes a fix.
```

Good:

```yaml
description: Use when session event logs, MCP connection failures, task lifecycle issues, provider responses, or TUI transcript regressions need investigation.
```

## Body Content

Write for a future agent under time pressure.

- Lead with the core principle in 1-3 sentences.
- Put routing decisions near the top.
- Use imperative instructions when the agent must do something.
- Explain why a rule matters when that helps the agent generalize.
- Prefer one excellent example over several generic examples.
- Use tables for quick reference and comparisons.
- Use small flowcharts only for non-obvious decisions or loops where agents stop too early.
- Keep examples copy-pasteable when they are code or commands.
- Avoid generic labels like `step1`, `helper2`, or `pattern3`.
- Avoid all-caps rules unless the rule is safety-critical or agents have repeatedly rationalized around it.

Do not include:

- Storytelling about a specific past session.
- Long transcripts or postmortems.
- Multiple language examples for the same pattern.
- Full API docs that could live in `references/`.
- Instructions to use a skill that does not exist.

## Progressive Disclosure

Skills should load only the context needed for the task.

- Keep `SKILL.md` as the entry point and router.
- Move bulky reference material over roughly 100-300 lines to a nested file.
- Put deterministic or repetitive work in `scripts/` instead of retyping long commands.
- Put templates or reusable examples in `assets/`, `examples/`, or `references/` when they are part of the skill.
- In the root doc, say exactly when to read each nested file.
- Use repo-relative file paths like `.agents/skills/review/code-review.md`, not hyperlinks, when referencing local docs.

## Routing and Consolidation

For repo developer skills, prefer a root skill plus nested docs when several top-level skills are really variants of one broader area.

Before consolidating:

- Search existing skills and references.
- Decide whether the content belongs under an existing root skill, a new root skill, `AGENTS.md`, automation, or `.leharness/skills`.
- Offer that placement tradeoff if it is not obvious.
- Keep separate top-level skills when separate metadata is important for runtime discovery or user-facing install behavior.

When consolidating:

- The root description must preserve discovery keywords from every top-level skill it replaces.
- Include old skill names, tool names, symptom phrases, and common user wording in the root description when needed.
- The root body must route old skill areas to the new nested docs.
- Nested docs should usually drop frontmatter because the root skill now owns discovery.
- Update every reference to the old skill names and paths.
- Update `.claude/skills` symlinks so they exactly mirror `.agents/skills`.
- Call out non-obvious tradeoffs in the PR description, especially fewer top-level skills vs. two-hop routing.

## Cross-References

Make the strength of the dependency explicit.

- Use `**REQUIRED:** Use <skill-name>` when the other skill must be followed.
- Use `**REQUIRED BACKGROUND:** Read <skill-name>` when the agent needs concepts from it.
- Use `See .agents/skills/<skill>/<doc>.md` for optional local reference docs.
- Avoid vague "see also" lists that do not say when to follow each item.

## Validation

Skill writing is documentation, but the output is agent behavior. Validate enough for the risk.

### Lightweight Validation

Use for small edits, reference updates, and typo-level fixes.

- Search for stale references with `rg`.
- Check local paths exist.
- Run `pnpm lint:agent-skills`.

### Standard Validation

Use for new skills, routing changes, and meaningful behavior changes.

- Write 2-3 realistic prompts that should trigger the skill.
- Write 2-3 near-miss prompts that should not trigger it.
- Read the skill as if you are the future agent and trace what file or instruction each prompt should use.
- If practical, run a small with-skill vs. without-skill or old-skill vs. new-skill comparison.
- Fix gaps where the agent would fail to discover the skill, choose the wrong nested doc, or over-apply it.

### Rigorous Validation

Use for high-risk discipline skills, broad consolidations, or skills that enforce behavior agents tend to rationalize away.

- Treat it like a TDD loop: define pressure scenarios first, observe baseline failure if practical, write the minimal guidance, then rerun.
- Capture the rationalizations or failure modes agents used and address them directly.
- Add should-trigger and should-not-trigger description checks when discovery is the risk.
- For subjective outputs, use human review over brittle assertions.
- For objectively checkable outputs, prefer scripts or assertions.

Do not turn every small skill edit into a full eval project. The TDD idea is useful because it forces clarity about failure modes; apply that level of rigor when the cost of a bad skill is meaningful.

## Improving Existing Skills

When editing an existing skill:

- Preserve the original skill name unless intentionally renaming or consolidating.
- Read references and callers before changing routing.
- Prefer deleting stale guidance over layering exceptions.
- If feedback came from a review, fix both the specific issue and the pattern that allowed it.
- Update PR descriptions when the change makes a non-obvious tradeoff.
- If a symlink disappears because the source skill no longer exists, mention whether that cleanup is intentional.

## Description Quality Pass

Before finishing, test the description mentally against realistic prompts.

- Would a user phrase that names an old skill or tool still trigger the new root skill?
- Would common setup, debugging, review, or runtime-skill workflows route to the right doc?
- Would near misses avoid triggering this skill?
- Does the description include the old top-level skill names or tool names users still say?
- Does it avoid summarizing the workflow?

If discovery is shaky, improve the description before editing the body.

## Anti-Patterns

| Anti-pattern | Why it fails | Fix |
| --- | --- | --- |
| Narrative skill | Future agents cannot reuse a one-off story | Extract the repeatable decision, command, or pattern |
| Workflow hidden in description | Agent may follow the summary and skip the body | Put triggers in description, steps in body |
| Missing old keywords after consolidation | Users mention old tool names and the root skill does not trigger | Add old names and symptoms to root description |
| Link-only routing | Agents do not know when to open which doc | Add explicit routing bullets |
| Overgrown `SKILL.md` | Agents load too much irrelevant context | Move heavy sections to nested docs |
| Excessive `MUST`s | Agents follow rigidly or fight the instruction | Explain why; reserve `MUST` for hard constraints |
| Untested routing change | Skill looks clean but is undiscoverable | Run trigger and near-miss checks |

## Checklist

- [ ] Correct location: `.agents/skills`, `.leharness/skills`, `AGENTS.md`, or automation.
- [ ] New top-level skill is justified; otherwise content is nested under the best existing root.
- [ ] Name is lowercase hyphen-separated and matches the directory.
- [ ] Frontmatter has `name` and `description`.
- [ ] Description starts with `Use when` and contains concrete trigger keywords.
- [ ] Description does not summarize the workflow.
- [ ] Root routing covers every nested doc and old skill name affected by consolidation.
- [ ] Local references use repo-relative paths and point to existing files.
- [ ] Heavy details are moved to nested docs, `references/`, or `scripts/`.
- [ ] Examples are reusable, not narrative.
- [ ] `.claude/skills` symlinks exactly mirror `.agents/skills`.
- [ ] Validation level matches risk.
- [ ] Ran relevant commands: `pnpm lint:agent-skills`, plus `pnpm lint` for PR-ready changes.
