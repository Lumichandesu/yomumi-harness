# Weekly token budget for AI coding agents

The weekly token budget is the scheduling rule that comes before every other priority in the Yomumi Harness: work at full speed while more than 5% of the weekly AI quota is left, then slow down and spread the last 5% so it runs out about ten minutes before the weekly reset. Genuinely urgent work, such as an owner's urgent bug fix, a production outage or a security incident, always goes first. This page explains why the rule has two phases, how agents read their quota, and how the dispatcher applies it automatically.

[Back to the system overview](README.md)

## Contents

- [The rule](#the-rule)
- [Why two phases instead of even pacing](#why-two-phases-instead-of-even-pacing)
- [How an agent reads its quota](#how-an-agent-reads-its-quota)
- [How the dispatcher applies it](#how-the-dispatcher-applies-it)
- [Saving tokens inside a run](#saving-tokens-inside-a-run)
- [What this rule does not do](#what-this-rule-does-not-do)

## The rule

| Phase | When | What agents do |
| --- | --- | --- |
| 1. Full speed | Weekly usage below 95% | Normal speed, no pacing cap, even early in the week. Still route every task to the cheapest capable model. |
| 2. Stretch the last 5% | Weekly usage at or above 95% | Slow down. Spread the remaining quota evenly so it runs out about 10 minutes before the reset, not earlier. Start only small or urgent work. Pause big runs and record their run ids or branches on the coordination board so they can resume. |
| Exception | Any time | Genuinely urgent work goes first in both phases. |

The short rolling window some providers also enforce (for example a five-hour window) has no extra rule: when it is full, wait for its reset. The budget rule never overrides safety rules.

## Why two phases instead of even pacing

An earlier version paced usage at all times. The owner replaced it to allow faster use early in the week, with one condition: when 5% is left, slow down and use it up by about ten minutes before the reset. The result spends freely while there is plenty left and only becomes careful when running out would block work before the reset.

## How an agent reads its quota

Each agent reads its own provider's usage page or tool. In the Claude desktop app, a session can read the weekly percent used and the reset time from its usage tool, and it checks before starting a large task.

## How the dispatcher applies it

The calling session passes `claude_weekly_percent` with a plan or task. At 95% or more, Claude moves to the end of every routing chain unless the task is marked urgent, so other open agents take the work first. See [Model routing](model-routing.md#how-the-weekly-budget-changes-the-order).

When a run fails because an agent hit its limit, the dispatcher fails over to the next open agent instead of waiting, and logs the switch. See [Task dispatch](task-dispatch.md#failover-when-an-agent-is-out-of-quota).

## Saving tokens inside a run

The budget rule decides *when* to spend. These habits decide *how much* each task costs:

- **Reference, do not paste.** Prompts carry note and file paths; agents read them on demand.
- **Short results.** Each agent ends with a summary of at most 120 words, and the vault stores at most 1,500 characters of it (head and tail, with a pointer to the full local output when longer).
- **Downstream agents read summaries, never raw logs.**
- **Minimal tool profiles for headless runs**, so a small task does not load every MCP server and plugin.
- **Free tiers for easy public text** ([Free-tier offload](free-tier-offload.md)).
- **Compact evidence.** Hand an agent a compact verdict before the raw test report. This repository measured that on two fixtures: [Token budget guide](../guide/05-token-budget.md).
- **Cost check before spending.** Before any action that incurs money (not just quota), the agent states the cost and waits for the owner's approval. Paid add-ons are avoided in favor of free alternatives.

## What this rule does not do

- It does not authorize anything. Being in phase 1 is not permission to deploy or push.
- It does not make an agent skip verification to save tokens. Correctness first; then cost.
- It does not apply to tools that cost money per call: those always need the owner's approval first.

Next: [Free-tier offload](free-tier-offload.md)
