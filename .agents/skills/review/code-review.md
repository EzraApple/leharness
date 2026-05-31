# Code Review

Catch bugs and enforce repo standards. Name the file, function, and line. A suspicious smell is not enough; trace the real path before flagging it.

## Scope

Prioritize issues that can break behavior, confuse future maintainers, or leave contracts untested:

- Event replay/resume compatibility
- Provider, MCP, JSON, and event parsing boundaries
- Promise ownership, cancellation, streams, and close/error paths
- Task lifecycle and background drain behavior
- TUI transcript state vs. rendered display
- Public exports, package metadata, and package verification
- Tests that miss the real event or runtime path

Load the relevant repo skill for standards before judging:

- TypeScript files: `typescript-best-practices`
- Tests or smoke scripts: `writing-and-running-tests`
- Harness/event/provider/MCP/TUI architecture: `harness-architecture`
- Agent guidance or skills: `writing-skills`

## Process

1. Read the diff and changed files.
2. Identify the contract each changed area owns.
3. Read the implementation and the closest smoke coverage.
4. Trace suspicious values from producer to consumer before commenting.
5. Check whether verification covers the real path.

## What to Flag

- A change that breaks old event shapes or assumes optional event fields are present.
- External data trusted without parsing at the boundary.
- An async task, stream, or transport close path that can leak, hang, or hide errors.
- A TUI reducer/render mismatch that leaves pending cells, wrong statuses, or stale displays.
- A package export or dependency change without `knip` or package verification.
- A test that asserts a helper while the real behavior is event-driven.

Do not flag style nits already enforced by lint unless the pattern creates a design or correctness issue. Do not pad the review to reach a finding count.

## Output

Findings first, ordered by severity. Each finding should include:

- File and line
- The concrete broken path
- A specific fix or test recommendation

If no issues are found, say `No findings.` and list any checks you could not run or verify.
