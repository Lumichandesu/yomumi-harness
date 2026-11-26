# Reframe before changing the harness

Adapted from [pstack /reframe, pinned source](https://raw.githubusercontent.com/cursor/plugins/9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc/pstack/skills/reframe/SKILL.md). This is a review practice, not a plugin install, a runtime dependency, or permission to execute third-party instructions.

## When to use it

Use this when different readings of a request would change the implementation or the acceptance test. For a precise bug, skip straight to reproduction.

1. Read the operator's words, the current implementation, the reporter contract, and one actual report.
2. List two or three plausible problems. Give each a name and one observation that distinguishes it. Pick the best-supported one and state what remains unknown.
3. Use domain terms only if they change a decision. Check primary references directly; drop claims you cannot substantiate. Borrow a technique from another field only after noting where it stops applying.
4. Rewrite the brief as **decision → inputs → guardrails → pass/fail/unverified examples**. Then verify it on a real run before changing defaults. Save the minimal replay and do not publish private logs or secrets.

## Worked example: “Make sure green means the right tests ran”

| Possible problem | Distinguishing observation |
| --- | --- |
| **Test selection drift** | Bun exits 0, but expected and recorded cases differ. |
| **Reporter reconciliation** | The XML's suite or root counts disagree with its own rows. |
| **Source-code coverage** | The intended test identities match, but application lines or branches remain unexercised. That requires instrumentation, not a JUnit-count check. |

Pick **test selection drift** for the [actual focused-run check](11-focused-tests.md): the full and focused runs both returned 0 and reported zero skips; their recorded counts were 2 and 1. The reports did not contradict themselves.

### Vocabulary that changes the implementation

| Term | Meaning and what to ask the agent to do |
| --- | --- |
| [Test selection](https://docs.pytest.org/en/stable/example/markers.html) | Which test cases the runner selects. Keep intended and observed selections separate. |
| [Test identity](04-reference.md#run-scoped) | What identifies a case in the report. Compare file, class, name, line and repeat count when a trusted baseline is available. |
| [JUnit report](https://bun.com/docs/test/reporters) | Machine-readable output from the runner. Keep it separate from console output and validate its totals. |
| [Runner exit status](https://docs.pytest.org/en/stable/reference/exit-codes.html) | The process result, not proof of coverage. Capture the actual exit; preserve the distinction between failure and unverified evidence. |
| [Scoped verdict](04-reference.md#run-scoped) | The decision about this intended test set only. Do not describe a scoped pass as full project coverage. |
| [Focused execution](11-focused-tests.md) | Running only a selected case or group. Include a real focus case that returns zero but must be rejected. |
| [Hermetic test environment](https://bazel.build/reference/test-encyclopedia) | A test depends on declared inputs rather than incidental machine state. Prevent accidental dotenv loading; do not call that complete isolation. |
| [Artifact provenance](https://docs.github.com/en/actions/concepts/security/artifact-attestations) | Where and how an artifact was made. Record commit, Bun version, and command next to the private baseline without claiming it is signed or authenticated. |

### Borrow from two neighboring fields, narrowly

- **Build engineering:** Bazel's execution environment encourages explicit inputs. Carry over the declared file list, expected count, and dotenv guard. The Harness still runs ordinary Bun and is not a hermetic build system.
- **Software supply chain:** GitHub attestations distinguish provenance from contents. Carry over recording where a report came from. A local baseline is not an attestation, and matching identities do not prove a trustworthy producer or identical runtime flags.

### Rewritten brief

> Make the Rust scoped check reject test selection drift. Run Bun on the intended files, retain its actual exit, and compare the observed count with a trusted full-run count. If a trusted baseline is supplied, also compare test identities and repeat counts. Verify a full pass, a full run with a failing test, and a focused run that returns 0 but omits a case. Report those as exit 0, 1, and 2 respectively. Do not infer source coverage or publish raw reports.

**What this brief must not forget:** A deliberate rename or move can change identity. Re-establish a baseline from a reviewed full run, never from a narrowed green run.
