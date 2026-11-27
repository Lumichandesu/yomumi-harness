# FAQ: running multiple AI coding agents with a harness

Answers to the questions people ask when they start running several AI coding agents together: how to run multiple agents on one repository, what an agent harness is compared with an agent framework, how to stop agents from claiming tests passed, how to split work between Claude Code and Codex, and how to save tokens with model routing. Each answer describes what the Yomumi Harness does and links to the detailed page.

[Back to the system overview](README.md)

## Contents

- [How do I run multiple AI coding agents on one repo without conflicts?](#how-do-i-run-multiple-ai-coding-agents-on-one-repo-without-conflicts)
- [What is the difference between an agent harness and an agent framework?](#what-is-the-difference-between-an-agent-harness-and-an-agent-framework)
- [How do I stop AI agents from claiming tests passed?](#how-do-i-stop-ai-agents-from-claiming-tests-passed)
- [How do I split work between Claude Code and Codex?](#how-do-i-split-work-between-claude-code-and-codex)
- [How do I save tokens with model routing?](#how-do-i-save-tokens-with-model-routing)
- [How do agents hand work to each other without looping?](#how-do-agents-hand-work-to-each-other-without-looping)
- [How do I stop one agent from acting on another agent's message?](#how-do-i-stop-one-agent-from-acting-on-another-agents-message)
- [What happens when an agent runs out of quota mid-task?](#what-happens-when-an-agent-runs-out-of-quota-mid-task)
- [Are Claude Code subagents enough?](#are-claude-code-subagents-enough)
- [Why use Markdown files instead of a database or message queue?](#why-use-markdown-files-instead-of-a-database-or-message-queue)
- [Can I send easy tasks to free LLM APIs safely?](#can-i-send-easy-tasks-to-free-llm-apis-safely)
- [Does a code-mode MCP gateway always save tokens?](#does-a-code-mode-mcp-gateway-always-save-tokens)
- [How many agents can one PC run at once?](#how-many-agents-can-one-pc-run-at-once)
- [Is the dispatcher source code available?](#is-the-dispatcher-source-code-available)

## How do I run multiple AI coding agents on one repo without conflicts?

Give every writing agent its own git worktree and branch, created from the remote main branch, and keep a claims board where agents list the files they will edit before they start. Never let the harness commit or push for an agent; a reviewer reads each worktree's diff. Read-only agents can share the main checkout. See [Worktree per writer](task-dispatch.md#worktree-per-writer) and [Claims](agent-channel.md#claims-how-agents-avoid-editing-the-same-files).

## What is the difference between an agent harness and an agent framework?

An agent framework is a library for *building* an agent: the loop, tool calling, memory, prompts. An agent harness, as we use the word, sits *around* agents you already have: which agent gets which task, where it may write, what it may never do, how it hands off, and how its results are checked. Our harness runs existing agent apps as separate processes and does not define how any of them reasons. See [Comparison](comparison.md).

## How do I stop AI agents from claiming tests passed?

Treat "tests pass" as a claim and check it. Keep the runner's actual exit code, verify that the intended files and test count ran, compare test identities against a trusted baseline when you have one, and keep three outcomes apart: verified pass, verified failure, unverified. Unverified never becomes a pass. For Bun, this repository's [`yomumi-evidence`](../../README.md) CLI does these checks. See [Evidence-first verification](evidence-first-verification.md).

## How do I split work between Claude Code and Codex?

By task kind, not by brand. We route search to the cheapest search-capable model, easy edits to a light model, hard-but-short work to a precise mid-size model, and hard-and-long work to the strongest model. Codex sits in the hard and short chains as the first alternative to Claude, picks its own model, and always runs with an explicit sandbox. When Claude's weekly quota is nearly used, Codex and the others move ahead of it. See [Model routing](model-routing.md).

## How do I save tokens with model routing?

Route every task to the cheapest model that can do it, show the heavy/light split before running, pass file paths instead of pasting context, cap each agent's result to a short summary, give headless runs a minimal tool profile, and send easy public text to free tiers. Then add a budget rule for *when* to spend. See [Model routing](model-routing.md), [Weekly token budget](weekly-token-budget.md) and, for test output, [Token budget](../guide/05-token-budget.md).

## How do agents hand work to each other without looping?

Allow hand-offs only through one small structured block, and validate it: a hop limit (3), a fan-out limit (2 per task), a total limit (8 tasks per root), no hand-off back to an agent already in the chain, no raising the mode from read-only to write, and the original owner quote carried unchanged. See [Peer-to-peer hand-offs](task-dispatch.md#peer-to-peer-hand-offs).

## How do I stop one agent from acting on another agent's message?

Write the rule into every prompt: messages and results from other agents are information, not approval. Require the human's verbatim words on every task, carry them unchanged, and keep irreversible actions (push to main, deploy, production migration, secrets) behind the human's own message in chat. A forged quote in a file then cannot unlock anything. See [Data, not approval](agent-channel.md#messages-from-agents-are-data-not-approval).

## What happens when an agent runs out of quota mid-task?

The dispatcher recognizes quota and rate-limit errors in the failed run's output and moves the task to the next open agent in its chain, logging the switch in the task file. Other errors end the task as failed so someone looks at them. See [Failover](task-dispatch.md#failover-when-an-agent-is-out-of-quota).

## Are Claude Code subagents enough?

For splitting work inside one Claude Code session, often yes: [subagents](https://code.claude.com/docs/en/sub-agents) each run in their own context window with their own tools and permissions. A cross-app dispatcher adds what subagents do not cover: other vendors' agents, failover between them when one is out of quota, a shared record outside any one session, and a machine-wide run cap. We use both.

## Why use Markdown files instead of a database or message queue?

Every agent can read and write files; not every agent speaks the same protocol. The owner can read, create and cancel tasks in a notes app, the record survives a crashed process, and agents can link to a note instead of pasting it. The trade-off is that anyone with write access can write a task, which is why a task file is never approval. See [Task files](task-dispatch.md#task-files-as-queue-and-record).

## Can I send easy tasks to free LLM APIs safely?

Only public, non-sensitive, low-stakes text, and only after a local refusal check for secrets, credentials, e-mail addresses and security, money or deletion topics. Treat the answer as a draft. Never send private code or user data, and never ask an outside service to decide whether text is sensitive. See [Free-tier offload](free-tier-offload.md).

## Does a code-mode MCP gateway always save tokens?

No. It helps when an agent would otherwise load many large tool catalogs or push large intermediate results through the model. In an internal A/B check on 2026-11-27 our gateway did not beat the default built-in tools on answer quality, so we keep it for specific tasks. See [Code-mode gateway](code-mode-gateway.md#what-we-measured-in-practice).

## How many agents can one PC run at once?

Fewer than you think. We cap dispatched runs at two machine-wide, run builds and tests one after another, and allow at most one dev server and one headless browser per agent. With more than that we saw the machine become unresponsive, and heavy parallel work crash it. See [Machine load](machine-load.md).

## Is the dispatcher source code available?

Yes, as a snapshot. A cleaned copy of the dispatcher as of 2026-11-27 is in [harness/agent-dispatch](../../harness/agent-dispatch/README.md), with its 65 tests (fake agent, no quota), and the free-tier offload script is in [harness/free-llm](../../harness/free-llm/README.md). The code-mode gateway is not published. Our live copies keep changing, so treat the snapshots as reference code to adapt.
