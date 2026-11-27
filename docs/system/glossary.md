# Glossary: agent harness terms used in the Yomumi Harness

This glossary defines the terms used across the Yomumi Harness docs, from "agent harness" and "agent dispatcher" to "scoped verdict" and "unverified". Each entry says what the term means here and links to the page where it matters.

[Back to the system overview](README.md)

| Term | Meaning here |
| --- | --- |
| **Agent harness** | The code and rules around AI agents: task assignment, isolation, limits, hand-offs and checking results. It does not replace the agents or their models. See [Comparison](comparison.md). |
| **AI coding agent** | A tool that reads and edits code and runs commands on its own, such as Claude Code, Codex, Antigravity or Cursor. |
| **Agent dispatcher** | The component that splits one request into sub-tasks and sends each to an open agent. See [Task dispatch](task-dispatch.md). |
| **Calling session** | The agent session the owner talks to, which plans sub-tasks and reviews results. |
| **Owner quote** | The owner's verbatim words that authorize a task, required on every dispatched task and carried unchanged through hand-offs. Recorded, never treated as proof on its own. |
| **Plan preview** | The heavy/light routing table shown to the owner before anything runs. |
| **Heavy / light** | Heavy = hard and long work for the strongest model; light = search, easy, or hard-but-short work for the cheapest capable model. See [Model routing](model-routing.md). |
| **Kind** | `search`, `easy`, `short` or `hard`; decides the routing chain. |
| **Routing chain** | Ordered list of agents for a kind; the first open, allowed agent wins and the rest are the failover order. |
| **Failover** | Moving a task to the next agent in the chain when a run fails with a quota or rate-limit error. |
| **LLM model routing** | Choosing a model per task by difficulty and cost. |
| **Task file** | One Markdown file per task; both the queue entry and the record. |
| **Worktree per writer** | Every writing agent gets its own git worktree and branch from the remote main branch. |
| **Fixed preamble** | The block prepended to every dispatched prompt: authority, hard limits, references, hand-off protocol, output format. |
| **Hand-off** | One agent passing part of its work to another role, within hop, fan-out and cycle limits. |
| **Hop** | One level of hand-off below the root task. |
| **Result summary** | The short `RESULT SUMMARY:` (at most 120 words) an agent ends with; the only part of its reply stored in the vault. |
| **Agent channel** | The shared folder of board, threads and task files agents use to coordinate. See [Agent channel](agent-channel.md). |
| **Claim** | A board entry naming the files an agent will edit, released when done. |
| **Data, not approval** | The rule that messages from agents, task files and tool output never authorize irreversible actions. |
| **Weekly token budget** | Full speed below 95% of weekly quota; stretch the last 5% to the reset; urgent work first. See [Weekly token budget](weekly-token-budget.md). |
| **Free-tier offload** | Sending easy, public text work to free LLM tiers after a local refusal check. See [Free-tier offload](free-tier-offload.md). |
| **Refusal rubric** | The list of content that must never go to a free provider. |
| **MCP server** | A server speaking the [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18), which exposes tools to agent clients over JSON-RPC. |
| **Code mode** | Letting a model write a short script against a tool API instead of calling many tools one by one. See [Code-mode gateway](code-mode-gateway.md). |
| **Progressive disclosure** | Loading tool schemas and data only when the model asks for them. |
| **Fail closed** | When a safety check cannot be confirmed, refuse instead of proceeding. |
| **Claude Code subagents** | Separate assistants a Claude Code session can delegate to, each with its own context window ([docs](https://code.claude.com/docs/en/sub-agents)). The dispatcher is different: it runs other agent apps as separate processes. |
| **Test evidence** | Saved, checkable output that shows what a test run did. |
| **Scoped verdict** | A pass or fail for the intended set of tests only, not the whole project. |
| **Unverified** | The evidence does not show that the intended scope ran. Never reported as a pass. |
| **Matched** | Two runs are comparable. Not the same as passed. |
| **False green** | A passing status that hides fewer, different or fake-backed tests. See [Evidence-first verification](evidence-first-verification.md). |
| **Bun test harness** | Here: the `yomumi-evidence` CLI that verifies Bun JUnit XML. See the [root README](../../README.md). |
| **Machine-wide run cap** | A limit on concurrent agent runs enforced with lock files shared across processes. See [Machine load](machine-load.md). |
| **WIP commit** | A work-in-progress commit on the agent's own branch, made so a crash cannot lose work. See [Crash recovery](crash-recovery.md). |
