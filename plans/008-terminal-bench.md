# 008 — Terminal-Bench Evaluation Integration

## Goal

Get a real, public number on how well `leharness` handles agentic
coding tasks by integrating it as a custom agent for **Terminal-Bench
2.0** (Stanford + Laude Institute's terminal-agent benchmark, 89 tasks,
runs through Harbor with Daytona sandboxes for concurrency). This turns
all the kernel work from plans 001–007 from "does the algorithm fire?"
into "does the agent complete real tasks?"

Two deliverables:

1. **Publish `leharness@0.3.0` to npm** ✅ — done. v0.3.0 is live with
   background tasks, subagents, artifacts, smart compaction, file-edit
   tools.
2. **Add `evals/terminal_bench/` to this repo** — a small Python
   adapter (one agent.py + requirements.txt + README) extending
   Harbor's `BaseInstalledAgent`. No sibling repo, no PyPI publish.
   Adapter version = whatever leharness commit it's on. Anyone who
   wants to reproduce a run clones leharness and `cd evals/terminal_bench`.

This plan deliberately does not cover:

- Building a custom benchmark — Terminal-Bench is the standard; we use
  what exists.
- Publishing the adapter to PyPI — for a baseline-number eval that's
  primarily for the harness developer, monorepo-subdirectory is enough.
  Promote to a separate package if it ever becomes load-bearing.
- Publishing to the public leaderboard — that's a follow-up once the
  numbers are stable. v1 is private/internal.
- Multi-model scoring (Claude vs DeepSeek vs Ollama) — start with one,
  see the baseline, expand later.
- Iterating leharness's *agent* (system prompt, tool selection) for
  bench scores — first establish the number, then improve.

## Why this shape

### Why Terminal-Bench

Frontier labs use it. The Snorkel/Stanford collaboration that produced
v2.0 makes it the de facto standard for "can your terminal agent do
real work?" Each task is (containerized environment + instruction +
verification tests + reference solution). That's exactly the shape we
want: objective pass/fail per task, comparable to published numbers
from Claude Code, Codex, OpenHands, Deep Agents.

Alternatives considered:
- **SWE-bench** — too narrow (only Python repo issues). Doesn't
  exercise shell, file editing, or general system work.
- **Custom benchmark** — re-inventing the wheel; no comparability.
- **Manual eval** — what we've been doing in plans 001–007; useful for
  development, not for "is this actually any good."

### Why publish to npm now

Terminal-Bench's `BaseInstalledAgent` model assumes the agent is
installable in the sandbox via a standard package manager. We already
have `leharness@0.2.1` on npm (plan 002), so the channel exists — but
0.2.1 was published before background tasks, subagents, artifacts, and
compaction shipped. Running the eval against 0.2.1 would measure a
2026-04-era kernel that's nothing like current state.

Cutting `0.3.0` is the simple fix: rebuild from main, run the existing
`package:verify` script (plan 002 already wired it), `npm publish`,
done. The adapter then `npm install -g leharness@0.3.0` and is current.

### Why Harbor + Daytona, not Docker

Harbor is the orchestrator behind Terminal-Bench; its sandbox layer
abstracts Docker / Modal / Daytona / E2B / Runloop, so leharness as an
agent doesn't care which is used. Daytona is the right pick for
running 89 tasks because:
- Built for AI workloads; LangChain runs Deep Agents on it at ~40
  concurrent trials per their Terminal-Bench 2.0 post.
- Per-trial sandbox; clean isolation, no local Docker pressure.
- API key + Harbor flag is the whole setup.

Local Docker works for the first `hello-world` validation but doesn't
scale to a real run.

## Position vs related work

- **Claude Code** runs Terminal-Bench via Harbor's `claude-code` agent,
  installed via `BaseInstalledAgent`. Pattern we'll mirror exactly.
- **Codex CLI** same pattern, different `BaseInstalledAgent` subclass.
- **OpenHands** uses Harbor's `openhands` agent.
- **Deep Agents** (LangChain) uses Harbor + Daytona at high concurrency.

The leharness adapter is the same shape as these — a Python class that
knows how to (a) install the agent inside a sandbox and (b) shell out
to its CLI with the task description. No deeper integration.

## Decisions locked in

| Area | Decision |
| ---- | -------- |
| Adapter location | `evals/terminal_bench/` directory inside this repo. Python sits next to TS; small enough that mixing build tooling isn't a real cost. No sibling repo, no PyPI. |
| Adapter language | Python — Harbor is Python; the adapter must extend `BaseInstalledAgent`. |
| Agent install | `npm install -g leharness@<pinned>` inside the sandbox during `install()`. Pinned constant in `agent.py` — bump explicitly when re-running against a new leharness release. |
| Agent invocation | `lh "<task_description>"` in one-shot mode. `lh` already supports this (see `apps/cli/src/cli.ts:one_shot`). |
| Provider for first run | DeepSeek-v4-flash. Cheap, fast, has reasoning, already wired and validated in plans 001–007. Swap to Claude Sonnet or GPT-4o once baseline is established. |
| Sandbox provider | Daytona for the real runs. Local Docker for `hello-world` smoke. |
| Compaction defaults | Inherit `lh`'s built-in `contextWindowTokens × 0.85` budget per model (plan 007). Don't override via `LEHARNESS_MAX_INPUT_TOKENS` for eval runs — measuring the kernel's actual default behavior is the point. |
| Concurrency | `--n-concurrent 1` for `hello-world`; `--n-concurrent 5` for the 5-task subset; `--n-concurrent 10–20` for the full 89-task run. Daytona's capacity is the upper bound; cost scales linearly so 10 is a good middle. |
| Cost budget | Aim for <$30 for the first full run. DeepSeek-flash + Daytona compute. Hard ceiling $50; abort if blown. |
| Token-counting source | Pull `usage.promptTokens`/`completionTokens` from the session's `events.jsonl` (final `model.completed`) via `populate_context_post_run`. Already accurate per plan 007's reactive token model. |
| Failure mode | If `lh` errors, exits non-zero, or runs past Harbor's max-turn budget, report it as a task failure with the error in the `AgentResult.failure_mode`. No special handling; just don't crash the harness. |
| Result attribution | Adapter pins a specific `leharness@<version>` constant in `agent.py`; eval result is reproducible from "leharness commit hash + pinned npm version." |

## Adapter shape

```python
# leharness_tb_adapter/agent.py

from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.agents.context import AgentContext

# Pin to the exact version we tested; bump explicitly per adapter release.
LEHARNESS_VERSION = "0.3.0"


class LeharnessAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "leharness"

    def version(self) -> str:
        return LEHARNESS_VERSION

    async def install(self, environment: BaseEnvironment) -> None:
        # Sandbox starts with whatever image Harbor / Daytona provides.
        # Most images already have Node 20+, but be defensive.
        await environment.exec_as_root("apt-get update && apt-get install -y nodejs npm")
        await environment.exec_as_agent(f"npm install -g leharness@{LEHARNESS_VERSION}")
        # Provider credentials — Harbor passes through env vars per its
        # contract. Adapter just needs the key visible to `lh`.
        await environment.exec_as_agent("echo \"$DEEPSEEK_API_KEY\" > /dev/null")  # noop validation

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # One-shot mode: `lh "<task>"` runs to completion (agent.finished),
        # using the sandbox's filesystem as the working directory. All of
        # lh's tools (bash, read_file, edit_file, etc.) operate on the
        # sandbox FS, which is also where the task's verification tests run.
        # Use an explicit session id so populate_context_post_run can find
        # the events.jsonl.
        session_id = f"tb-{context.task_id}"
        await environment.exec_as_agent(
            f"LEHARNESS_PROVIDER=deepseek lh --session {session_id} {_shell_quote(instruction)}"
        )
        # Stash the session id on context for the post-run hook.
        context.metadata["leharness_session_id"] = session_id

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Pull token counts from the last model.completed in the session log.
        # The events.jsonl lives at .leharness/sessions/<id>/events.jsonl
        # *inside the sandbox* — Harbor copies the sandbox's working dir
        # back to the local logging_dir for inspection.
        session_id = context.metadata.get("leharness_session_id")
        if session_id is None:
            return
        usage = _read_final_usage(Path(context.logging_dir) / ".leharness" / "sessions" / session_id / "events.jsonl")
        if usage is None:
            return
        context.token_counts = {
            "input": usage["promptTokens"],
            "output": usage["completionTokens"],
        }
```

Helpers (`_shell_quote`, `_read_final_usage`) are file-local — a
~20-line module total beyond the class. JSONL parser is stdlib only.

The `@with_prompt_template` decorator is Harbor's hook for injecting
the task-pre-text (system prompt, env summary). Adapters typically
accept it as-is.

## Phased rollout

### Phase 1 — Publish `leharness@0.3.0` to npm ✅ DONE

Landed via PR #24. Verified clean-container install end-to-end against
DeepSeek. `v0.3.0` tagged. Brought all of plans 004–007 (background
tasks, subagents, artifacts, file edit tools, smart compaction) into
the npm channel.

### Phase 2 — Add `evals/terminal_bench/` to this repo

```
leharness/
└── evals/
    └── terminal_bench/
        ├── README.md             # install + run examples
        ├── requirements.txt      # harbor-framework, terminal-bench, pytest
        ├── agent.py              # LeharnessAgent class (see "Adapter shape")
        └── tests/
            ├── test_quoting.py   # shell-quote helper
            └── test_usage_parse.py # events.jsonl → token counts
```

No PyPI publish. `.gitignore` for `__pycache__/` + `.venv/` in the
subdirectory. The TS build pipeline ignores `evals/` (already does —
it's not part of any pnpm workspace package).

Cross-language friction is minimal: `evals/terminal_bench/` has its
own `requirements.txt` and tests; root `package.json` doesn't know it
exists. Reproducibility is "this leharness commit + the pinned
`LEHARNESS_VERSION` constant in agent.py."

### Phase 3 — `hello-world` validation

The smallest possible end-to-end:

```bash
pip install harbor terminal-bench leharness-tb-adapter
DEEPSEEK_API_KEY=... harbor run \
  --dataset terminal-bench@2.0 \
  --agent-import-path leharness_tb_adapter.agent:LeharnessAgent \
  --task-id hello-world \
  --n-concurrent 1
```

Expected: one Daytona sandbox spins up, `lh` installs inside it, runs
the hello-world task, exits with success. Harbor reports pass + token
counts.

If this works, every piece of the chain is validated. If it fails,
debug iteratively against the single task before scaling up.

### Phase 4 — 5-task subset

Pick five tasks of varying difficulty (Harbor's docs list task
categories; pick one each from "easy", "medium", and three from
"hard"). Run with `--n-concurrent 5`. Total run time: ~30 minutes.
Cost: < $5.

This is the first real signal of "is the kernel any good?" If 0/5
pass, the adapter is broken or the kernel can't handle real tasks. If
3/5+ pass, the full 89-task run is worth doing.

### Phase 5 — Full 89-task run

```bash
harbor run \
  --dataset terminal-bench@2.0 \
  --agent-import-path leharness_tb_adapter.agent:LeharnessAgent \
  --n-concurrent 15
```

Estimated runtime: 2–4 hours at 15 concurrent. Cost: $15–30 in
DeepSeek + Daytona credits. Report the resolution rate (X/89), median
turn count, token cost per task. Compare to Claude Code's published
scores as a reality-check.

### Phase 6 — Decide what to do with the number

If the score is competitive (>40% pass rate is a respectable starting
point for a hobby harness): document it in the README, consider
submitting to the public leaderboard.

If it's not (<20%): the score itself is data. Identify the failure
mode patterns (timeouts? wrong tool selection? compaction misfires?).
That's the input for the next plan — which won't be a kernel feature,
it'll be agent-quality work (system prompt, tool descriptions, model
choice).

## Cost projections

DeepSeek-v4-flash: ~$0.07/1M input tokens, ~$1.10/1M output tokens.

Per task estimate (rough):
- 30 turns × 5KB prompt = 150KB ≈ 40K input tokens
- 30 turns × 500 tokens output = 15K output tokens
- Cost: 40K × $0.07/M + 15K × $1.10/M = $0.003 + $0.017 ≈ **$0.02/task**

89 tasks × $0.02 ≈ **$1.78 in inference**.

Daytona compute: ~$0.10/sandbox-hour. With 15 concurrent + 4hr total
runtime ≈ 4 sandbox-hours actively running ≈ **$0.40 in compute**.

**Total estimated first-run cost: <$3.** Hard cap at $50 if anything
runs away.

## Verification

### Adapter offline (no Harbor needed)

- `pytest`: token-count parser handles missing `usage`, malformed
  JSONL, empty file, file-doesn't-exist.
- Shell-quote helper handles instructions with quotes, backticks,
  `$`, newlines.

### Adapter live (against Harbor + Docker locally first)

- Hello-world task passes in a local Docker sandbox.
- `AgentResult.token_counts` matches what `events.jsonl` reports.

### End-to-end (Daytona, 5-task subset)

- All 5 tasks run to completion (pass or fail — no harness crashes).
- Run logs are recoverable from Daytona / Harbor's logging_dir.
- Per-task token counts are reported correctly.

### Manual smoke after npm publish

- `docker run -it node:20 bash -c "npm install -g leharness@0.3.0 && lh --help"` succeeds.
- One-shot mode (`lh "say hi"`) works in a fresh container with
  `DEEPSEEK_API_KEY` set.

## What this rules out, what it leaves open

Ruled out:
- Multi-model leaderboard runs in v1. One model (DeepSeek) for the
  baseline.
- Per-task harness customization (e.g. injecting task-specific
  system-prompt text). Use what's there.
- Iterating leharness's agent (system prompt, tool descriptions) for
  bench wins. The point of v1 is to get the *baseline* number; tuning
  the agent for the benchmark is the next plan.
- Public leaderboard submission. v1 results are private; submit only
  if/when they're meaningfully comparable.
- A separate "lh-bench" CLI mode. The eval shape is "Harbor calls
  `lh` like a real user would" — no special hooks.

Left open:
- Multi-provider runs (Claude Sonnet, GPT-4o, Ollama) to surface model
  vs harness contributions to the score.
- Submitting to tbench.ai's public leaderboard.
- Building a small "regression suite" subset of Terminal-Bench tasks
  to run on every PR (cost: a few cents per PR; would catch kernel
  regressions earlier than smokes).
- Agent-quality work to improve scores (next plan after this).

## Naming alternatives

| Concept | Proposed | Alternatives |
| ------- | -------- | ------------ |
| Adapter package | `leharness-tb-adapter` | `harbor-leharness`, `leharness-harbor` — `*-tb-adapter` matches naming pattern of existing community adapters (e.g. `pi-terminal-bench`) |
| Agent class | `LeharnessAgent` | `LhAgent`, `LeHarness` — full name in Python is fine; this is internal code, not a CLI command |
| Session id format | `tb-<task_id>` | `terminal-bench-<task_id>`, `<task_id>` — short prefix tells you which harness ran this session when looking at .leharness/sessions/ |
| Env var for provider | `LEHARNESS_PROVIDER=deepseek` | Pinning in adapter via `--provider deepseek` CLI flag — env var matches existing `lh` config pattern (plan 002) |
