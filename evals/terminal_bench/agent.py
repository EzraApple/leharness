"""leharness adapter for Terminal-Bench (via Harbor).

Tells Harbor how to install `lh` inside a sandbox and run it against
a task description. No PyPI publish, no separate repo — just one file
under evals/terminal_bench/ in the leharness monorepo. See
plans/008-terminal-bench.md for the full design.

Run:
    cd evals/terminal_bench
    source .venv/bin/activate
    DEEPSEEK_API_KEY=... harbor run \\
        --dataset terminal-bench-core==head \\
        --agent-import-path agent:LeharnessAgent \\
        --task-id hello-world
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


# Pin to the published npm version. Bump explicitly when re-running
# against a new leharness release so eval results stay reproducible
# from (this commit, this constant).
LEHARNESS_NPM_VERSION = "0.3.0"

# Stable session id we pass to `lh --session`. Doubles as the
# directory name under /logs/artifacts/.leharness/sessions/ that we
# look up in populate_context_post_run after Harbor syncs the
# sandbox's /logs back to host.
_LEHARNESS_SESSION_ID = "tb-run"

# Sourced at the top of any sandbox command that needs `lh` on PATH.
# nvm doesn't install a system-wide binary; it installs under
# ~/.nvm/versions/node/<v>/bin and adds itself to interactive shell
# init. exec_as_agent runs non-interactive shells, so we re-source.
_NVM_PRELUDE = (
    "export NVM_DIR=\"$HOME/.nvm\"; "
    "if [ -s \"$NVM_DIR/nvm.sh\" ]; then . \"$NVM_DIR/nvm.sh\"; fi; "
)


class LeharnessAgent(BaseInstalledAgent):
    """Run leharness (`lh`) inside a Harbor-managed sandbox."""

    @staticmethod
    def name() -> str:
        return "leharness"

    def get_version_command(self) -> str | None:
        return "lh --help | head -1"

    async def install(self, environment: BaseEnvironment) -> None:
        # leharness@0.3.0 requires Node >=20 (uses regex /v flag).
        # Many Terminal-Bench task images ship Node 18, so we install
        # Node 22 via nvm under the agent's home directory regardless
        # of what's already there. `run()` re-sources nvm so `lh` is
        # on PATH.
        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
                "  apk add --no-cache curl bash; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y curl ca-certificates; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y curl; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=_NVM_PRELUDE + (
                "set -e; "
                "if ! command -v nvm >/dev/null 2>&1; then "
                "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash >/dev/null; "
                "  export NVM_DIR=\"$HOME/.nvm\"; "
                "  . \"$NVM_DIR/nvm.sh\"; "
                "fi; "
                "nvm install 22 >/dev/null; "
                "nvm alias default 22 >/dev/null; "
                f"npm install -g leharness@{LEHARNESS_NPM_VERSION}; "
                "lh --help | head -1"
            ),
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        deepseek_key = self._get_env("DEEPSEEK_API_KEY") or ""
        if not deepseek_key:
            raise RuntimeError(
                "DEEPSEEK_API_KEY not set — leharness adapter needs it to drive DeepSeek."
            )

        quoted = shlex.quote(instruction)

        # Point LEHARNESS_HOME at /logs/artifacts so the session's
        # events.jsonl lands in Harbor's auto-downloaded artifacts dir
        # (sandbox is torn down after run; this is how we preserve the
        # log for populate_context_post_run to pull token counts from).
        await self.exec_as_root(
            environment,
            command="mkdir -p /logs/artifacts && chmod 777 /logs/artifacts",
        )
        await self.exec_as_agent(
            environment,
            command=_NVM_PRELUDE + (
                f"LEHARNESS_HOME=/logs/artifacts/.leharness "
                f"LEHARNESS_PROVIDER=deepseek "
                f"DEEPSEEK_API_KEY={shlex.quote(deepseek_key)} "
                f"lh --session {_LEHARNESS_SESSION_ID} {quoted}"
            ),
        )
        # NOTE: Do NOT mutate context here. Harbor only calls
        # populate_context_post_run when context.is_empty() — any
        # field set during run() suppresses the hook entirely.

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Pull final token usage out of the downloaded events.jsonl.

        Harbor downloads the sandbox's /logs/artifacts → the trial's
        artifacts/ dir. We wrote leharness's session log there, so we
        can read the last model.completed event for usage data.
        """
        # self.logs_dir is trial_dir/agent/; Harbor lands /logs/artifacts/
        # from the sandbox into trial_dir/artifacts/ (sibling of agent/).
        events_path = (
            Path(self.logs_dir).parent
            / "artifacts"
            / ".leharness"
            / "sessions"
            / _LEHARNESS_SESSION_ID
            / "events.jsonl"
        )
        if not events_path.exists():
            return

        # Each model.completed represents one billed provider call.
        # Sum prompt + completion tokens across the whole trial to
        # surface true cost-per-task in Harbor's result.json.
        total_input = 0
        total_output = 0
        saw_any = False
        for line in events_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "model.completed":
                continue
            usage = event.get("usage")
            if not isinstance(usage, dict):
                continue
            prompt_tokens = usage.get("promptTokens")
            completion_tokens = usage.get("completionTokens")
            if isinstance(prompt_tokens, int):
                total_input += prompt_tokens
                saw_any = True
            if isinstance(completion_tokens, int):
                total_output += completion_tokens

        if not saw_any:
            return
        context.n_input_tokens = total_input
        context.n_output_tokens = total_output
