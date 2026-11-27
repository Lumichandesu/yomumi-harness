# Model routing by difficulty and cost

LLM model routing in the Yomumi Harness sends each task to the cheapest AI model that can do it well: a fast, cheap model for search, a precise mid-size model for hard-but-short work, and the strongest model only for hard and long work. The dispatcher classifies every task into one of four kinds, maps each kind to an ordered chain of agents and models, skips agents that are closed or not allowed for that mode, and moves Claude to the end of every chain when its weekly quota is nearly used.

[Back to the system overview](README.md)

## Contents

- [Four kinds, two weights](#four-kinds-two-weights)
- [Routing chains](#routing-chains)
- [Who does what](#who-does-what)
- [How a task is classified](#how-a-task-is-classified)
- [Rules the router enforces](#rules-the-router-enforces)
- [How the weekly budget changes the order](#how-the-weekly-budget-changes-the-order)
- [Overriding models and chains safely](#overriding-models-and-chains-safely)
- [What we learned](#what-we-learned)

## Four kinds, two weights

| Kind | Meaning | Weight |
| --- | --- | --- |
| `search` | Lookups only: find, list, locate, check whether something exists. Always read-only. | light |
| `easy` | Trivial edits: typos, docs wording, renames, dead code, dependency hygiene. | light |
| `short` | Hard but short: little to write, but it needs care and precision. | light |
| `hard` | Hard and long: large implementations, design, security, money, migrations, final review. | heavy |

"Heavy" or "light" is shown in the plan preview before the owner approves anything, so the cost of a request is visible up front.

## Routing chains

The first open, allowed agent in the chain wins; the rest become the failover order.

| Kind | Chain (first open agent wins) | Claude model for this kind |
| --- | --- | --- |
| search | Claude → Antigravity → Hermes → Codex → Cursor | Haiku |
| easy | Antigravity → Claude → Hermes → Codex → Cursor | Sonnet |
| short | Claude → Codex → Antigravity → Cursor → Hermes | Sonnet |
| hard | Claude → Codex → Antigravity → Cursor → Hermes | Opus |

Antigravity gets a configured Gemini model per kind: a lighter one for search and easy work, a stronger one for short and hard work. Codex and Cursor use their CLI's default model, because the owner chose to let Codex pick its own model per task. Hermes always picks its own free model.

## Who does what

The routing table encodes a role list the owner wrote for every agent:

- **Claude Opus**: hard work that is long to write or long to think through: calculation, large implementations, design, security, money, final review.
- **Claude Sonnet**: hard but short work.
- **Claude Haiku**: pure searching and lookups. Never code, design or review.
- **Gemini (Antigravity)**: searching and very easy tasks, reviewed before merge.
- **Codex**: in the general work pool; chooses its own model.
- **Hermes**: research and lookups only, read-only, free models only.
- **Cursor**: in the pool once its CLI is installed.

The dispatcher compares its routing table with this role list in the coordination README and reports drift, so the code and the written rule do not silently diverge.

## How a task is classified

The planner (the calling agent session) should pass `kind` or `weight` itself. A keyword heuristic is only the fallback. Simplified excerpt:

~~~ts
const SEARCH = /\b(find|search|locate|look ?up|list|where (is|are|do)|grep|which files?|inventory|check whether|is there)\b/i;
const EASY   = /\b(typo|spelling|readme|docs?|comment|rename|dead code|unused|lint|format|bump|dependency hygiene|wording)\b/i;
const HEAVY  = /\b(implement|build|refactor|architecture|design|security|auth|payment|migration|end-to-end|audit|rewrite|redesign|investigate|root cause)\b/i;

function classify(prompt, mode, hint) {
  if (hint.kind) return hint.kind === 'search' && mode !== 'read-only' ? 'easy' : hint.kind;
  if (hint.weight === 'heavy') return 'hard';
  if (hint.weight !== 'light' && (HEAVY.test(prompt) || prompt.length > 2000)) return 'hard';
  if (mode === 'read-only' && SEARCH.test(prompt) && prompt.length < 1200) return 'search';
  if (EASY.test(prompt) && prompt.length < 1200) return 'easy';
  return 'short'; // default: light, hard but short
}
~~~

The heuristic leans toward the heavier side for anything that mentions security, money or migrations. A long request is treated as heavy even without keywords.

## Rules the router enforces

These are checks in code, not advice:

- **Haiku never edits.** A Haiku candidate in write mode is skipped, and a `search` task requested in write mode is treated as `easy`.
- **Hermes never writes** (we could not confine it to a worktree) and **never gets a model** (passing one is an error).
- **Closed apps are skipped**, never launched.
- **No cycles.** A candidate already in the hand-off chain is skipped.
- **No retries of the same candidate** within one task's failover.
- An explicitly named target stays first; the chain after it is still available for failover unless failover is turned off.

## How the weekly budget changes the order

The calling session can pass Claude's current weekly usage percentage. At or above the threshold (95%), Claude moves to the end of every chain unless the task is marked urgent. An explicitly named first target is kept first; only the rest of the order changes. See [Weekly token budget](weekly-token-budget.md).

~~~ts
if (weekly >= 95 && !urgent) {
  // keep an explicit first target; move every Claude candidate after the others
  order = [...head, ...rest.filter(notClaude), ...rest.filter(isClaude)];
}
~~~

## Overriding models and chains safely

A local `agent-dispatch.config.json` may override models per agent and kind, and the chain per kind:

~~~json
{ "models": { "codex": { "hard": "<model id>" } }, "chains": { "easy": ["antigravity", "claude"] } }
~~~

The same file can tighten the safety limits (concurrent runs, hops, hand-offs, tasks per root) but never loosen them: values above the defaults are clamped. Hermes's model map is reset to "its own choice" after every merge, whatever the file says.

## What we learned

- **The planner knows more than a regex.** In our use, the misroutes we noticed tended to come from the fallback heuristic, so we ask the calling session to label each sub-task instead of tuning keywords.
- **Price the hidden prompt, not just the visible one.** A headless agent run can load the user's entire tool profile before reading your one-line task. For tiny tasks that overhead can decide which agent is actually cheapest.
- **Free first, when it is safe.** Easy public text work can skip paid models entirely: see [Free-tier offload](free-tier-offload.md).

Next: [Weekly token budget](weekly-token-budget.md)
