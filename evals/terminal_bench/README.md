# Terminal-Bench adapter for leharness

Drives `lh` (the published `leharness@x.y.z` npm package) inside Harbor's
sandboxes as a `BaseInstalledAgent`. See `plans/008-terminal-bench.md`
in the repo root for the full design, and **`RUNS.md` in this directory
for the changelog of bench runs + what changed between them**.

## Setup

```bash
cd evals/terminal_bench
uv venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements.txt
```

## Run one task (local Docker)

```bash
DEEPSEEK_API_KEY=... harbor run \
  --dataset terminal-bench@2.0 \
  --agent-import-path agent:LeharnessAgent \
  --include-task-name log-summary-date-ranges
```

## Run the full 89-task benchmark (local Docker)

```bash
DEEPSEEK_API_KEY=... harbor run \
  --dataset terminal-bench@2.0 \
  --agent-import-path agent:LeharnessAgent \
  --n-concurrent 5
```

**Pick `--n-concurrent` for your hardware.** Each task runs in its own
Docker container with the task image. At `-n 10` on a 128GB M-series Mac
the laptop was usable but warm; **for `work-while-it-runs` use `-n 3`
to `-n 5`**. Full 89-task run at `-n 5` takes roughly 1.5–2 hours.

## Run on Daytona (no local CPU/disk cost)

```bash
DEEPSEEK_API_KEY=... DAYTONA_API_KEY=... harbor run \
  --dataset terminal-bench@2.0 \
  --agent-import-path agent:LeharnessAgent \
  --sandbox daytona \
  --n-concurrent 15
```

## After a run

1. Find the latest job dir: `ls -td jobs/2026-* | head -1`
2. Get pass-rate + cost: see the snippet in `RUNS.md` for the one-liner
3. **Add a row to `RUNS.md`** with leharness version, model, max-steps,
   concurrent, pass/fail/exc counts, pass%, total cost, runtime, and a
   one-line "what changed since the last row" note

## Notes

- `LEHARNESS_NPM_VERSION` in `agent.py` pins which leharness version
  gets installed in the sandbox. Bump explicitly when re-running
  against a newer release; record the bump as a new row in `RUNS.md`.
- `_LEHARNESS_MAX_STEPS` in `agent.py` overrides the kernel default
  (50) for bench runs since Terminal-Bench tasks routinely need 50+
  tool calls. Plan-008's first baseline (max_steps=25 kernel default)
  saw 86% of failures hit this ceiling mid-productive-work.
- The adapter uses `LEHARNESS_PROVIDER=deepseek` by default. To try
  Claude or GPT-4o, edit `agent.py` (no CLI flag yet — small enough
  that we don't need one).
