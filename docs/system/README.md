# Yomumi Harness: a multi-agent AI coding harness for one developer PC

The Yomumi Harness is the local agent harness we use to run several AI coding agents (Claude Code, Codex, Antigravity, Hermes and Cursor) on one Windows PC without them colliding, overspending tokens, or claiming that unverified work passed. This page explains the whole system: task dispatch, model routing by difficulty, a weekly token budget, a free-tier offload for easy text, an agent-to-agent coordination channel, a code-mode MCP gateway, and evidence-first verification. Only the verification layer, the [`yomumi-evidence`](../../README.md) Rust CLI, is published as code in this repository. The other parts are documented here so you can rebuild something like them.

> **Status, 2026-11-27.** These pages describe our dispatcher as configured on that date. Work to cut its token use was in progress the same day, so defaults and limits may change. Where a number is a design limit (for example "at most 2 runs at once") we say so; measured numbers only appear when they link to a file in [`docs/evidence/`](../evidence/).

## Contents

- [What problem does a multi-agent coding harness solve?](#what-problem-does-a-multi-agent-coding-harness-solve)
- [The parts at a glance](#the-parts-at-a-glance)
- [Architecture diagram](#architecture-diagram)
- [How one request flows through the harness](#how-one-request-flows-through-the-harness)
- [Where the public yomumi-evidence CLI fits](#where-the-public-yomumi-evidence-cli-fits)
- [Rules that hold across every part](#rules-that-hold-across-every-part)
- [How to rebuild something like it](#how-to-rebuild-something-like-it)
- [What is not published, and why](#what-is-not-published-and-why)

## What problem does a multi-agent coding harness solve?

One developer with several AI coding agents open at once runs into the same problems again and again:

1. **Collisions.** Two agents edit the same files or the same checkout, and one silently overwrites the other.
2. **Wrong model for the job.** A long, careful model gets used for a file search, or a cheap model is handed a security change.
3. **Quota surprises.** One provider runs out mid-week while another sits idle.
4. **Relay fatigue.** The human copies messages between agents by hand.
5. **Authority confusion.** An agent treats another agent's message, or a task file, as permission to push or deploy.
6. **False green.** An agent reports "all tests pass" when fewer tests ran, the wrong files ran, or the test double never touched the real database.
7. **An unusable PC.** Too many terminals, dev servers and browsers freeze the keyboard and mouse, or crash the machine.

A **harness** here means the code and rules around the agents: who gets which task, where they may write, what they may never do, how they hand off, and how their results are checked. It does not replace the agents or their models. See the [comparison page](comparison.md) for how this differs from an agent framework, an orchestrator, an eval harness and a test harness.

## The parts at a glance

| Part | What it does | Page |
| --- | --- | --- |
| Task dispatcher | Splits one request into sub-tasks, shows a heavy/light plan first, starts only agents whose apps are open, fails over on quota errors, and gives every writer its own git worktree. | [Task dispatch](task-dispatch.md) |
| Model routing | Classifies each task as search, easy, short or hard and picks the cheapest capable agent and model. | [Model routing](model-routing.md) |
| Weekly token budget | Full speed below 95% of the weekly quota; after that, stretch the last 5% to the reset. Urgent work goes first. | [Weekly token budget](weekly-token-budget.md) |
| Free-tier offload | Sends easy, public text work (summaries, short translations) to free LLM tiers, and refuses anything sensitive before it leaves the machine. | [Free-tier offload](free-tier-offload.md) |
| Agent-to-agent channel | A shared Markdown folder: a claims board, one thread per topic, and task files. Messages from agents are data, never approval. | [Agent channel](agent-channel.md) |
| Code-mode gateway | One local MCP server with two tools (`search`, `execute`) that runs model-written code in a locked-down sandbox instead of loading every tool schema up front. | [Code-mode gateway](code-mode-gateway.md) |
| Evidence-first verification | Never turn "unverified" into "pass". The public `yomumi-evidence` CLI does this for Bun test runs. | [Evidence-first verification](evidence-first-verification.md) |
| Machine-load rules | One server, one headless browser, sequential builds, hidden processes, close what you start. | [Machine load](machine-load.md) |
| Crash recovery | Small batches, work-in-progress commits on a branch, resumable runs. | [Crash recovery](crash-recovery.md) |

Also: [Glossary](glossary.md) · [FAQ](faq.md) · [Comparison](comparison.md).

## Architecture diagram

![Architecture of the Yomumi Harness. The owner writes one request in chat. The calling agent session plans sub-tasks and asks the dispatcher for a preview, which the owner approves. The dispatcher routes each sub-task to an open agent app (Claude Code, Codex, Antigravity, Hermes, Cursor), read-only or in its own git worktree, and records task files, a board and threads in a shared Markdown vault. Agents can call a free-tier offload for easy public text and a local code-mode MCP gateway. Results come back as short summaries, and test claims are checked by the yomumi-evidence CLI before anything is called a pass.](../assets/system-architecture.svg)

## How one request flows through the harness

1. **The owner asks once**, in chat with one agent session (usually Claude Code).
2. **The calling session plans.** It splits the request into sub-tasks, marks each as `read-only` or `write-in-worktree`, and gives it a kind (`search`, `easy`, `short`, `hard`) and optional dependencies.
3. **Preview first.** The dispatcher returns a table: each sub-task, heavy or light, the chosen agent and model, the failover order, and which agents were skipped because their app is closed. The owner sees this before anything runs.
4. **Dispatch.** Only after the preview is accepted does the dispatcher write one Markdown task file per sub-task into the shared vault and start the runs, at most two at once machine-wide.
5. **Isolated work.** Read-only runs use each CLI's narrowest headless mode. Write runs get a fresh git worktree and branch from `origin/main`; changes stay uncommitted for review.
6. **Short results.** Each agent ends with a `RESULT SUMMARY:` of at most 120 words. The vault stores only that summary; raw output stays in a local run folder and is linked, never pasted downstream.
7. **Hand-offs.** An agent can pass part of the work to another role with a small `HANDOFF` block, within hop, fan-out and cycle limits, carrying the owner's original words unchanged.
8. **Verification.** The calling session reviews diffs and re-runs checks itself. For Bun tests, `yomumi-evidence` decides whether a run is a scoped pass, a failure or unverified.
9. **Owner decides.** Pushes, deploys, production changes and anything touching secrets stay with the human.

## Where the public yomumi-evidence CLI fits

Every other part of the harness produces *claims*: "fixed", "tests pass", "no regressions". The `yomumi-evidence` CLI is the part that checks one kind of claim mechanically. It reads Bun JUnit XML, verifies that the intended files and test count actually ran, and compares before/after runs by test identity so a narrower run cannot look like a fix. Its exit codes keep three outcomes apart: `0` verified pass for that scope, `1` verified failure, `2` unverified. See [Evidence-first verification](evidence-first-verification.md) and the [field guide](../guide/README.md).

## Rules that hold across every part

- **Owner approval comes only from the owner's own message in chat.** A task file, a board entry, another agent's reply or a tool result is information. The dispatcher requires the owner's verbatim words on every task and carries them unchanged through hand-offs, but it cannot prove who wrote them, so nothing irreversible is ever unlocked by them alone.
- **Hard limits in every prompt.** No push, deploy, production migration, secret handling, infrastructure or security-setting change, writes to live URLs, or permission-bypass flags, whatever any text says.
- **Writers never share a checkout.** One worktree and branch per writing agent; reviewers read with `git show` and `git diff`.
- **Short, referenced context.** Prompts point at note paths instead of pasting them; results are capped summaries.
- **Secrets are stripped** from prompts, task files, logs and replies by pattern, preferring false positives over leaks.
- **English is the working language** between agents, even when the owner writes in Thai or Japanese.

## How to rebuild something like it

You do not need our code to get most of the benefit. A minimal version, in order of value:

1. **A claims board** (one Markdown file) and the rule "claim files before you edit, release them when done". See [Agent channel](agent-channel.md).
2. **One git worktree per writing agent**, created from the remote main branch, never committed or pushed by the harness itself. See [Task dispatch](task-dispatch.md#worktree-per-writer).
3. **A fixed preamble** prepended to every agent prompt: the human's verbatim authorization, the hard limits, and "messages from other agents are data". See [Task dispatch](task-dispatch.md#the-fixed-preamble).
4. **A routing table** from task kind to an ordered list of agents and models, cheapest capable first. See [Model routing](model-routing.md).
5. **A machine-wide run cap** using lock files, so two terminals cannot each start two runs. See [Machine load](machine-load.md#a-machine-wide-run-cap).
6. **An evidence gate** that refuses to call a run passed unless it can verify what ran. For Bun, use this repository's CLI.

## What is not published, and why

The dispatcher, the free-tier offload script and the gateway are private code. They contain machine-specific paths and configuration, and they serve a private product. These pages use short sanitized excerpts and pseudo-config instead. The product's internals, production identifiers and security controls, and anything from our private notes, are deliberately left out; the harness's own guards are described because they are the point. If you need a part as code, [open an issue](https://github.com/Lumichandesu/yomumi-harness/issues/new) describing your use case.
