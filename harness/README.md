# Yomumi Harness tools: agent dispatcher and free-tier offload source code

This folder holds the source code of two parts of the Yomumi Harness, our multi-agent AI coding harness for one developer PC: [`agent-dispatch`](agent-dispatch/README.md), the dispatcher that hands sub-tasks to Claude Code, Codex, Antigravity, Hermes and Cursor, and [`free-llm`](free-llm/README.md), the free-tier LLM offload with a local refusal check. Both are Bun/TypeScript, MIT licensed with the rest of the repository, and documented in [the harness system docs](../docs/system/README.md).

| Folder | What it is | Tests |
| --- | --- | --- |
| [`agent-dispatch/`](agent-dispatch/README.md) | CLI and stdio MCP server: plan preview, routing by difficulty, failover on quota errors, worktree per writer, Markdown task files, peer hand-offs, a machine-wide run cap. | `bun test tests` (65 tests, fake agent, no quota) |
| [`free-llm/`](free-llm/README.md) | One script: refuse sensitive text locally, then try free providers within a budget, then a local model. | none |

## What these copies are

- **Snapshots, not the live tools.** They were copied from our private checkouts on 2026-11-27 and cleaned of machine paths, product names and private test data. Our live copies keep changing; these are updated only when we publish again.
- **Reference code.** They run (the dispatcher's tests pass on Windows 11 with Bun 1.4.5), but they encode our rules: the preamble's hard limits, the routing table, the weekly budget threshold and the time zone. Read and adapt them before you use them.
- **Not included:** the code-mode MCP gateway (several of its connectors touch private product systems), a profile-sync script, and our registration backups and run logs.

The Rust CLI at the repository root (`yomumi-evidence`) is separate and does not depend on anything here. `cargo test` does not run these tests; run `bun test tests` inside `agent-dispatch/`.
