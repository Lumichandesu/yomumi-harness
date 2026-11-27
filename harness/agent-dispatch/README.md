# agent-dispatch: an AI agent dispatcher for Claude Code, Codex, Antigravity, Hermes and Cursor

agent-dispatch is the task dispatcher of the Yomumi Harness: you type one request, the calling agent session splits it into sub-tasks, and the dispatcher hands each one to an AI coding agent whose app is open on the same PC. It shows a heavy/light plan before anything runs, requires the owner's verbatim words on every task, gives every writing agent its own git worktree, fails over to the next agent on quota errors, caps runs at two machine-wide, and records every task as a Markdown file in a shared notes folder. It is a Bun/TypeScript CLI and a stdio MCP server with no runtime dependencies.

How it works, why, and what went wrong along the way: [Task dispatch](../../docs/system/task-dispatch.md) · [Model routing](../../docs/system/model-routing.md) · [Agent channel](../../docs/system/agent-channel.md).

> **Snapshot.** This is a public copy of our private dispatcher as of 2026-11-27, with machine-specific paths, product names and private test data removed. Our live copy keeps changing; this one is updated when we choose to publish. It was built and tested on Windows 11; the Linux and macOS code paths exist but were not tested by us.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Register the MCP server](#register-the-mcp-server)
- [CLI](#cli)
- [Plan file and task file formats](#plan-file-and-task-file-formats)
- [Safety model](#safety-model)
- [Tests](#tests)
- [Known limits](#known-limits)

## Requirements

- [Bun](https://bun.com/) 1.4 or later.
- Git, for write tasks (each gets a worktree from `origin/main`).
- At least one supported agent CLI installed and its app open: Claude Code, Codex, Antigravity (`agy`), Hermes or `cursor-agent`. Closed apps are skipped and never launched.

## Quick start

~~~sh
cd harness/agent-dispatch
bun test tests                     # 65 tests with a fake agent; uses no quota
bun run dispatch.ts list-agents    # what is installed and open
~~~

Point the dispatcher at a notes folder for task files and the board, then dispatch a read-only task:

~~~sh
export AGENT_DISPATCH_COMMS_DIR="$HOME/notes/Agent-Comms"   # PowerShell: $env:AGENT_DISPATCH_COMMS_DIR = "..."
bun run dispatch.ts --agent auto --mode read-only --cwd /path/to/repo \
  --quote "<the owner's verbatim words>" --prompt "List the HTTP routes and where each is defined"
~~~

The folder needs a `README.md` (the rules every agent is told to read) and a `Board.md`; `Tasks/` is created on first use.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_DISPATCH_COMMS_DIR` | `<AGENT_DISPATCH_HOME>/vault/Agent-Comms` (ignored by git) | Shared folder: `README.md`, `Board.md`, `Tasks/`. |
| `AGENT_DISPATCH_HOME` | this folder | Where `agent-dispatch.config.json` and `runs/` live. |
| `AGENT_DISPATCH_RUNS_DIR` | `<home>/runs` | Raw output, previews and run-slot locks. Keep it out of git. |
| `AGENT_DISPATCH_BIN_<AGENT>` | auto-detected | Full path to an agent CLI, for example `AGENT_DISPATCH_BIN_CODEX`. |

`agent-dispatch.config.json` next to `package.json` can override models per agent and kind, the routing chains, timeouts and the summary size:

~~~json
{
  "models": { "codex": { "hard": "<model id>" } },
  "chains": { "easy": ["antigravity", "claude", "codex"] },
  "defaultTimeoutSec": 1800
}
~~~

It may tighten, but never loosen, these limits: at most 2 concurrent runs, 3 hops, 2 hand-offs per task and 8 tasks per root. Hermes's model is always left to Hermes. Other settings in the file are **not** clamped and can loosen behavior: `hermesAllowWrite`, `readDirs`, `maxTimeoutSec` and `autoRunHandoffs`.

## Register the MCP server

Launch `bun` directly with the script as its argument. Do not wrap it in a `.cmd` file or `cmd /c`: on Windows that opens a console window every time the server starts.

~~~sh
# Claude Code (user scope)
claude mcp add --scope user agent-dispatch -- <path to bun> <path to>/harness/agent-dispatch/mcp-server.ts
~~~

~~~toml
# Codex: ~/.codex/config.toml
[mcp_servers.agent-dispatch]
command = '<path to bun>'
args = ['<path to>/harness/agent-dispatch/mcp-server.ts']
startup_timeout_sec = 30
~~~

~~~json
// Cursor: ~/.cursor/mcp.json, inside "mcpServers"
"agent-dispatch": { "type": "stdio", "command": "<path to bun>", "args": ["<path to>/harness/agent-dispatch/mcp-server.ts"], "env": {} }
~~~

Antigravity: `agy mcp add agent-dispatch <path to bun> <path to>/harness/agent-dispatch/mcp-server.ts`. Hermes has no MCP client here; it writes task files into `Tasks/` and someone runs `run-queue`.

Back up each config file before you change it. The MCP tools are `preview_plan` → `dispatch_plan` (the main entry), `dispatch_task`, `task_status`, `task_result`, `cancel_task`, `run_queue`, `list_agents` and `list_tasks`.

## CLI

~~~sh
bun run dispatch.ts list-agents
bun run dispatch.ts --agent codex --mode read-only --cwd <repo> --quote "<owner's words>" --prompt "..."
bun run dispatch.ts --agent auto --weight heavy --mode write-in-worktree --cwd <repo> --topic search-fix --quote "..." --prompt-file task.md
bun run dispatch.ts plan plan.json --preview     # heavy/light table only
bun run dispatch.ts plan plan.json               # table, then dispatch and wait
bun run dispatch.ts run-queue --dry-run          # what the notes inbox would run
bun run dispatch.ts run-queue                    # run queued task files once, then exit
bun run dispatch.ts run-queue --watch --interval 60
bun run dispatch.ts list | status <id> | result <id> | cancel <id>
~~~

Other flags: `--model`, `--kind search|easy|short|hard`, `--timeout <sec>`, `--from <name>`, `--parent <task id>`, `--claude-weekly <percent>`, `--urgent`, `--no-failover`.

`scripts/smoke.ts --quote "..."` sends one "reply OK" prompt to each open agent, one at a time. It uses a little real quota.

## Plan file and task file formats

See [Plan preview](../../docs/system/task-dispatch.md#plan-preview-heavy-or-light-shown-before-anything-runs) and [Task files](../../docs/system/task-dispatch.md#task-files-as-queue-and-record). Only files with `type: agent-task` and `status: queued` are picked up; set `status: cancelled` to stop a task.

## Safety model

- Every prompt starts with a fixed preamble: the owner's verbatim quote, the coordination rules, and hard limits (no push, deploy, production migration, secrets, DNS/CDN/security-setting change, live-URL writes or bypass flags). Edit `src/preamble.ts` to match your own rules.
- No adapter emits a permission-bypass flag; a test checks every adapter in both modes.
- Write tasks run only in a fresh worktree; the dispatcher never commits or pushes. Worktrees are created under `<target repo>/.claude/worktrees/`, after a `git fetch origin main` in the target repo.
- At most 2 agent runs at once across every dispatcher process (lock files in `runs/.slots`).
- Hand-offs keep the root's owner quote, cannot raise the mode, and are capped and cycle-checked.
- Prompts, task files, board lines, logs and MCP replies are scrubbed of secret-shaped text.
- Agent output is labelled as data, never instructions or approval.

What the safety model does **not** cover, as published:

- **Hand-offs run without a preview.** A valid `HANDOFF` block in an agent's reply starts the child task at once (`autoRunHandoffs: true`), in write mode if the root was write. Repository text the agent reads can steer it. The caps bound this; set `autoRunHandoffs` to `false` to queue hand-offs instead.
- **Cursor's read-only mode is prompt-only.** Its adapter passes no read-only or sandbox flag and is unverified, yet Cursor is in every chain. Remove it from `chains` if that matters.
- **Hermes sends prompts to free third-party models.** Prompts are scrubbed of secret-shaped text but not topic-checked the way `free-llm` checks them. Keep Hermes out of chains for private work.
- **Read-only Claude runs may read `readDirs`.** The default is the notes folder only. Anything you add there is readable by every read-only Claude run.

## Tests

~~~sh
bun test tests
~~~

The suite uses a fake agent (`tests/fixtures/fake-agent.ts`), temporary folders and a throwaway git repository, so it spends no quota and touches no real vault. One MCP test runs real process detection (it lists processes, it launches nothing).

## Known limits

- The dispatcher cannot prove a quote came from the owner. Anyone who can write to the notes folder can write a task file, so nothing irreversible should be unlocked by a quote alone. `run-queue` prints the plan and starts in the same step (`--dry-run` only looks), and `--watch` runs new files every interval with no confirmation: do not point it at a shared or synced folder.
- Task ids read from hand-written task files are not re-validated before `cancel`, and `cancel` kills a recorded pid when no process image was recorded. Only trust task files you or the dispatcher wrote.
- A task runs inside the process that started it. If that process dies hard, the task stays `running` until `cancel <id>`.
- On Windows, grandchildren that an agent CLI orphaned after a normal exit are out of reach of `taskkill /T`.
- Adapter flags and result formats were observed with the CLI versions we ran in October and November 2026. The Antigravity and Cursor adapters are partly inferred; Cursor's is unverified.
- Timestamps and task ids use the `Asia/Bangkok` time zone (`src/util.ts`); change `bangkokTime()` for yours.
