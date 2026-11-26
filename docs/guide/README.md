# Yomumi Harness field guide

Start with the decision you need to make, not a list of flags. A runner status, a verified file scope, and a before/after delta answer three different questions.

[Try the saved reports without Bun or Python](../../examples/replay/README.md).

1. [First real run](01-first-run.md): generate three reports and see why “green” can be insufficient.
2. [Review recipes](02-review-recipes.md): reusable checklists and copyable agent briefs.
3. [Performance and proof](03-measurement.md): read the numbers, reproduce them, and find the evidence behind each claim.
4. [Reference and recovery](04-reference.md): exit codes, supported scope, and how to recover without weakening checks.

5. [Token budget](05-token-budget.md): see what was measured and why.
6. [Fork and adapt](06-fork-and-adapt.md): map a new use case to the files and tests you need.
7. [Verification](07-verification.md): know what each test layer proves and what it doesn't.

8. [Integrate locally](08-integrate.md): use evidence in a real review check without conflating matching and passing.

9. [Equal failure counts](09-equal-counts.md): find the new regression or changed assertion hiding behind the same total.

## Decision map

~~~mermaid
flowchart LR
    A["Bun report + actual exit + intended paths"] --> B["Compact and check one run"]
    B -->|Missing or inconsistent evidence| C["Unverified: check the input"]
    B -->|Scoped result| D["Pass or fail for this run"]
    E["Two reports + both actual exits"] --> F["Compare observed tests"]
    F -->|Tests disappeared or evidence is ambiguous| G["Incomplete: no improvement claim"]
    F -->|Matched| H["Inspect fixes, regressions, and changed failures"]
~~~

Already know the commands? [Agent quick reference](../../AGENT-START.md). Changing the CLI or evidence rules? [Contributor checklist](../../CONTRIBUTING.md).

This guide borrows the documentation pattern of a short front door and task-oriented pages from [poteto’s pstack guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide). Yomumi Harness is a local report tool and does not run pstack playbooks.

[Case study: when the 12-row cap hid a new regression](10-bounded-summaries.md)
