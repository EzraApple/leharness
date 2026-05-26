# Terminal-Bench adapter for leharness

Drives `lh` (the published `leharness@x.y.z` npm package) inside Harbor's
sandboxes as a `BaseInstalledAgent`. See `plans/008-terminal-bench.md`
in the repo root for the full design.

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
  --dataset terminal-bench-core==head \
  --agent-import-path agent:LeharnessAgent \
  --task-id hello-world
```

## Run the full benchmark on Daytona

```bash
DEEPSEEK_API_KEY=... DAYTONA_API_KEY=... harbor run \
  --dataset terminal-bench-core==head \
  --agent-import-path agent:LeharnessAgent \
  --sandbox daytona \
  --n-concurrent 15
```

## Notes

- `LEHARNESS_NPM_VERSION` in `agent.py` pins which leharness version
  gets installed in the sandbox. Bump explicitly when re-running
  against a newer release.
- The adapter uses `LEHARNESS_PROVIDER=deepseek` by default. To try
  Claude or GPT-4o, edit `agent.py` (no CLI flag yet — small enough
  that we don't need one).
