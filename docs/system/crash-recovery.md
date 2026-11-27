# Crash recovery for long AI agent runs

Crash recovery in the Yomumi Harness assumes the machine, an agent app or a long run can stop at any moment, and makes that cheap: work in small batches, commit work in progress to a branch before anything risky, keep every task's state in a file rather than in memory, and resume multi-agent runs from a recorded run id instead of starting over. These practices came from real interruptions; on one day we saw the PC crash several times under load.

[Back to the system overview](README.md)

## Contents

- [What can stop a run](#what-can-stop-a-run)
- [Practices](#practices)
- [What the dispatcher does after a crash](#what-the-dispatcher-does-after-a-crash)
- [Resuming a multi-agent workflow](#resuming-a-multi-agent-workflow)
- [A recovery checklist](#a-recovery-checklist)

## What can stop a run

- The PC crashes or reboots under load.
- An agent app is closed, updates itself, or hits its quota.
- The calling session's context is compacted or the session ends.
- The owner asks to slow down and big runs are paused on purpose.

## Practices

1. **Small batches.** Split large work into pieces that each end in a commit or a recorded result. A crash then costs one piece, not the day.
2. **Work-in-progress commits on your own branch.** Before a long build, a risky refactor or the end of a turn, commit to the worktree's branch (never to main, never pushed by the harness). A WIP commit is cheap to amend and impossible to lose to a crash.
3. **State in files, not memory.** Task status, routing and results live in task files; claims live on the board; long records live in Maintenance notes. A new session can pick up from those.
4. **Sequential heavy steps.** One build, then one test run. Parallel heavy steps were what tipped the machine over ([Machine load](machine-load.md)).
5. **No destructive git.** No hard resets, no force pushes, no bulk checkouts that discard changes. Another agent's uncommitted work may be in a neighboring worktree; unknown work is never erased.
6. **Record before pausing.** When pausing a big run, write its run id or branch on the board with one line on what is left.

## What the dispatcher does after a crash

- A task that was `running` in a process that died stays `running` in its file. `cancel <id>` resolves a task no live dispatcher owns, so it can be re-queued deliberately.
- A run-slot lock whose process id is gone is reclaimed automatically the next time a slot is needed.
- An untouched worktree from an abandoned attempt is removed; a worktree with changes or commits is kept for review.
- Raw output up to the crash stays in the task's local run folder.

## Resuming a multi-agent workflow

Some agent apps can run a scripted multi-agent workflow and resume it from a run id: finished steps replay from cache, and the first unfinished step runs again. In our practice:

- record the run id on the board when pausing or when the machine looks unstable;
- resume from that id instead of starting a new run, so finished agent work is not paid for twice;
- keep the step order unchanged when resuming, because changing or reordering steps usually invalidates the cache from that point on.

## A recovery checklist

1. Check the board tail and the task files for anything `running` or claimed by you.
2. `git status` and `git log` in each worktree you own. Commit or note what is there.
3. Cancel stale `running` tasks you own; leave other agents' tasks alone and tell them on the board.
4. Resume paused workflows from their recorded run ids.
5. Rerun the checks yourself before reporting; a pre-crash "pass" is not evidence ([Evidence-first verification](evidence-first-verification.md)).

Next: [Glossary](glossary.md) · [FAQ](faq.md)
