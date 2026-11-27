# Machine-load rules for running many AI agents on one PC

The machine-load rules keep a developer PC usable while several AI coding agents run on it at once: no visible terminal windows, at most one dev server and one headless browser per agent, builds and tests run one after another, at most two dispatched agent runs machine-wide, and every agent stops what it started and nothing else. These rules exist because we saw too many agent terminals and background processes make the owner's mouse and keyboard unresponsive, and heavy parallel work later crash the machine.

[Back to the system overview](README.md)

## Contents

- [The rules](#the-rules)
- [A machine-wide run cap](#a-machine-wide-run-cap)
- [Hidden processes on Windows](#hidden-processes-on-windows)
- [Close what you start, and only that](#close-what-you-start-and-only-that)
- [When the owner says the PC is slow](#when-the-owner-says-the-pc-is-slow)

## The rules

1. **No visible terminals.** Run commands hidden or in the tool's background mode.
2. **One dev or preview server and one headless browser per agent**, at most, and stop them as soon as the check is done. Headless browsers run muted.
3. **Sequential builds and tests.** Prefer one build or test run at a time over several in parallel.
4. **No daemons left behind.** Before finishing, list the processes you started and stop them: dev servers, previews, indexers, MCP helpers.
5. **Never kill another agent's process.** Tell its owner on the board instead. Exceptions, if any, are named by the owner, narrowly.
6. **At most two dispatched agent runs at once**, across every dispatcher process.

## A machine-wide run cap

Two MCP clients, a terminal and a queue watcher can each start the dispatcher. An in-process counter would allow two runs *each*. The cap is enforced with lock files in a shared folder instead:

~~~ts
// Claim one of N slots; a slot is a file created with the exclusive flag.
for (let i = 0; i < max; i++) {
  const file = join(slotsDir, `slot-${i}.lock`);
  try {
    const fd = openSync(file, 'wx');                 // fails if the file exists
    writeSync(fd, JSON.stringify({ pid: process.pid, taskId, at: new Date().toISOString() }));
    closeSync(fd);
    return file;                                     // slot acquired
  } catch (e) {
    if (e.code !== 'EEXIST') break;
    const holder = readHolder(file);
    if (holder?.pid && !isAlive(holder.pid)) { unlinkSync(file); /* reclaim, retry once */ }
  }
}
return null;                                          // all slots busy: poll again in a second
~~~

Waiters inside one process are served first-in, first-out, a cancelled waiter leaves the queue, and a slot whose owning process has died is reclaimed. A half-written lock file is left alone, because its owner may be writing it right now.

## Hidden processes on Windows

On Windows, a console program started from a background process can still open a window, and if Windows Terminal is the default terminal it can open a new tab instead. Lessons:

- Spawn every child process with `windowsHide: true`.
- Register MCP servers by launching the runtime binary (`bun.exe`, `node.exe`) directly with the script path as an argument. A `.cmd` launcher or `cmd /c` opens a console window every time the server starts.
- If hidden console programs still pop up as terminal tabs, the cause is the system's default-terminal setting, which is the owner's to change, not something an agent should flip.

## Close what you start, and only that

The dispatcher kills a run's whole process tree on exit, timeout and cancel (`taskkill /T /F` on Windows), and cancels every running task when its MCP client disconnects or the command line gets Ctrl+C. A known gap: grandchildren that an agent CLI orphaned after a normal exit are out of reach of a tree kill; a Windows job object would close that gap.

## When the owner says the PC is slow

Pause the big runs first, keep at most two heavy ones going, record what was paused (run id or branch) on the board, and resume later from that record. See [Crash recovery](crash-recovery.md).

Next: [Crash recovery](crash-recovery.md)
