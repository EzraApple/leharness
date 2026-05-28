# Terminal-Bench 2.0 — run log

One row per real bench run. Bump `LEHARNESS_NPM_VERSION`, change a
constant in `agent.py`, or change harbor flags → new row. Cost is
computed from `events.jsonl` token sums post-run (see snippet below).

The "What changed" column is the single most important field — it
makes this table tell a story about leharness's evolution. Keep it
to one specific delta vs the previous row.

| Date       | leharness | Model         | Max steps   | Concurrent | Pass | Fail | Exc | Pass% | Cost   | Runtime | What changed |
|------------|-----------|---------------|-------------|------------|------|------|-----|-------|--------|---------|--------------|
| 2026-05-26 | 0.3.0     | ds-v4-flash   | 25 (kernel) | 10 local   | 28   | 51   | 10  | 31% (35% eff) | $0.64  | 1h27m   | **Baseline.** Identified `DEFAULT_MAX_STEPS=25` as the kernel ceiling: 44 of 51 failures were cutoffs mid-productive-work, not real model failures. |
| 2026-05-27 | 0.3.1     | ds-v4-flash   | 100 (env)   | 2 daytona  | 28   | 31   | 34  | 31% (**51% eff**) | ~$0.03 | 5h53m   | **`max_steps=100`** (kernel default bumped 25→50; env override to 100 for bench). Filtered pass% jumped 35→51% — into OpenCode+Opus 4.5 territory (51.7%). 34 Daytona disk-cap exceptions (free-tier 30GB ceiling) tanked the headline; the real signal is the effective pass% gain. |

**"Effective"** = pass / (pass + fail), excluding infra exceptions that never reached the agent (Daytona disk caps, env start timeouts). That's the metric for "given the sandbox actually started, did the harness+model solve the task?" Raw % is what shows up on leaderboards but effective % is what tells you about the harness.

<!-- Template for next row:
| YYYY-MM-DD | x.y.z     | ds-v4-flash   | NN          | N <env>    | NN   | NN   | NN  | NN% (NN% eff) | $N.NN  | NhNNm   | one-line delta vs prev row |
-->

## Compute pass-rate + cost from a job dir

```bash
LATEST=$(ls -td jobs/2026-* | head -1)
echo "job: $LATEST"
PASSED=$(find "$LATEST" -name "reward.txt" -exec grep -l "^1" {} \; | wc -l | tr -d ' ')
FAILED=$(find "$LATEST" -name "reward.txt" -exec grep -l "^0" {} \; | wc -l | tr -d ' ')
EXC=$(find "$LATEST" -name "exception.txt" | wc -l | tr -d ' ')
DONE=$((PASSED + FAILED + EXC))
PCT=$((PASSED * 100 / (DONE > 0 ? DONE : 1)))
echo "pass=$PASSED  fail=$FAILED  exc=$EXC  → ${PCT}%"

python3 - <<EOF
import json
from pathlib import Path
root = Path("$LATEST")
ti = to = 0
for r in root.glob("*/result.json"):
    try: d = json.loads(r.read_text())
    except: continue
    ar = d.get("agent_result") or {}
    if isinstance(ar.get("n_input_tokens"), int): ti += ar["n_input_tokens"]
    if isinstance(ar.get("n_output_tokens"), int): to += ar["n_output_tokens"]
# DeepSeek-v4-flash listed rates (cache-hit input is much cheaper IRL)
cost = ti * 0.07 / 1_000_000 + to * 1.10 / 1_000_000
print(f"input={ti:,}  output={to:,}  → est ~\${cost:.2f} list ({ti*1.10/1_000_000:.2f} headline)")
print("(actual DeepSeek bill is usually ~1/5 of list due to cache hits — check the dashboard)")
EOF
```
