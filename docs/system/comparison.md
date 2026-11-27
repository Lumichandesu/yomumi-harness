# Agent harness vs agent framework, orchestrator, eval harness and test harness

"Harness" means different things in AI tooling. This page compares the categories people search for (agent framework, multi-agent orchestrator, agent harness, eval harness, test harness and CI test reporter) and shows where the Yomumi Harness sits: a local agent harness around existing AI coding agent apps, plus a test-evidence CLI for Bun. These are role comparisons, not rankings; where we name a third-party project we link to its own documentation.

[Back to the system overview](README.md)

## Contents

- [The categories](#the-categories)
- [Where the Yomumi Harness sits](#where-the-yomumi-harness-sits)
- [Workflow or agent?](#workflow-or-agent)
- [Inside one agent app versus across agent apps](#inside-one-agent-app-versus-across-agent-apps)
- [When you should use something else](#when-you-should-use-something-else)

## The categories

| Category | Question it answers | Typical scope | Example with its own docs |
| --- | --- | --- | --- |
| **Agent framework** | How do I build an agent: its loop, tool calls, memory? | A library inside your application. | Many exist; compare their own docs against your language and hosting needs. |
| **Multi-agent orchestration** | How do several agents or model calls cooperate on one goal? | Code paths or a runtime that coordinates agents. | Patterns are described in Anthropic's [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). |
| **Agent harness** (our sense) | Which existing agent gets which task, where may it write, what may it never do, and how are its results checked? | Processes, files and rules around agent apps you already use. | **Yomumi Harness** (this repository's docs). |
| **Eval harness** | How well does a model or agent score on a benchmark? | Reproducible evaluation runs over a task set. | [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness), a framework for few-shot evaluation of language models; [SWE-bench](https://github.com/SWE-bench/SWE-bench), whose harness evaluates fixes to real repository issues in containers. |
| **Test harness** | Did the intended tests run, and what changed between runs? | Test runner output. | **`yomumi-evidence`** for [Bun JUnit XML](https://bun.com/docs/test/reporters). |
| **CI test reporter** | How do I show test results in pull requests? | CI job summaries and annotations. | [action-junit-report](https://github.com/mikepenz/action-junit-report), [dorny/test-reporter](https://github.com/dorny/test-reporter). |

## Where the Yomumi Harness sits

| Need | Yomumi Harness | Not this |
| --- | --- | --- |
| Run Claude Code, Codex, Antigravity, Hermes and Cursor side by side on one PC | Yes: dispatcher, routing, failover, worktree per writer. | It does not build or modify those agents. |
| Keep agents from overwriting each other | Yes: claims board plus one worktree per writer. | No merge automation; a human or reviewing agent merges. |
| Route by difficulty and cost | Yes: four kinds, ordered chains, weekly budget rule. | No learned router; rules plus the planner's labels. |
| Keep authority with the human | Yes: owner quote on every task, data-not-approval rule, hard limits. | It cannot verify who wrote a quote; it never unlocks irreversible actions with one. |
| Check test claims | Yes, for Bun: `yomumi-evidence`. | No coverage measurement, no arbitrary JUnit, no automatic ship decision. |
| Benchmark a model | No. | Use an eval harness. |
| Show results in pull requests | No. | Use a CI reporter. |

## Workflow or agent?

Anthropic's [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) separates *workflows*, where models and tools are orchestrated through predefined code paths, from *agents*, where the model directs its own process. The Yomumi Harness is deliberately a workflow at its own level: routing, limits, hand-off validation and verification are fixed code and written rules. The agents inside it are agents. Keeping the outer layer predictable is what lets it enforce limits the agents cannot talk their way past.

## Inside one agent app versus across agent apps

Claude Code [subagents](https://code.claude.com/docs/en/sub-agents) split work inside one Claude Code session, each with its own context window, tools and permissions. Codex has a [non-interactive mode](https://developers.openai.com/codex/noninteractive) (`codex exec`) for scripts and CI that runs in a read-only sandbox by default. The Yomumi Harness uses those headless modes as building blocks: it starts each vendor's own CLI as a separate process with the narrowest mode available, so one request can reach several vendors' agents and fail over between them.

## When you should use something else

- You are building one agent into your product: use an agent framework.
- You want a model's benchmark score: use an eval harness.
- You need PR annotations or dashboards: use a CI reporter, and keep `yomumi-evidence` for the local scope check.
- You use a single agent app and its built-in subagents cover your needs: you may not need a cross-app harness at all. Start with a claims file and one worktree per writer, which cost nothing.
