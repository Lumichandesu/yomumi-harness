import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConcurrencyGate } from '../src/gate';
import { runProcess } from '../src/runner';
import { isAlive, sleep } from '../src/util';
import { createWorktree, removeIfPristine, worktreeChanges } from '../src/worktree';

const tmp = mkdtempSync(join(tmpdir(), 'agent-dispatch-proc-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-agent.ts');

async function maxConcurrent(gate: ConcurrencyGate, n: number, holdMs: number, other?: ConcurrencyGate): Promise<number> {
  let cur = 0;
  let max = 0;
  const run = async (g: ConcurrencyGate, i: number) => {
    const release = await g.acquire(`t${i}`);
    cur++;
    max = Math.max(max, cur);
    await sleep(holdMs);
    cur--;
    release();
  };
  await Promise.all(Array.from({ length: n }, (_, i) => run(other && i % 2 ? other : gate, i)));
  return max;
}

describe('concurrency gate', () => {
  test('in-process cap of 2 with FIFO queue', async () => {
    const g = new ConcurrencyGate({ max: 2 });
    expect(await maxConcurrent(g, 6, 30)).toBe(2);
    expect(g.active).toBe(0);
  });

  test('file slots hold the cap across two dispatcher processes (two gates, one dir)', async () => {
    const dir = join(tmp, 'slots');
    const a = new ConcurrencyGate({ max: 2, dir, pollMs: 10 });
    const b = new ConcurrencyGate({ max: 2, dir, pollMs: 10 });
    expect(await maxConcurrent(a, 8, 40, b)).toBe(2);
  });

  test('a slot left by a dead process is reclaimed', async () => {
    const dir = join(tmp, 'stale');
    const g = new ConcurrencyGate({ max: 1, dir, pollMs: 10, isAlive: () => false });
    writeFileSync(join(dir, 'slot-0.lock'), JSON.stringify({ pid: 999999, taskId: 'old' }));
    const release = await Promise.race([g.acquire('new'), sleep(1000).then(() => null)]);
    expect(release).not.toBeNull();
    (release as () => void)();
  });

  test('aborting a queued waiter removes it', async () => {
    const g = new ConcurrencyGate({ max: 1 });
    const r1 = await g.acquire('a');
    const ctrl = new AbortController();
    const p = g.acquire('b', ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(g.queued).toBe(0);
    r1();
  });
});

describe('runner: hidden spawn, timeout, tree kill', () => {
  test('captures stdout and stdin', async () => {
    const r = await runProcess({ command: process.execPath, args: [FIXTURE, 'ok', tmp], cwd: tmp, stdin: 'hello', timeoutMs: 20000 });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).result).toContain('prompt 5 chars');
  });

  test('timeout kills the whole process tree', async () => {
    const dir = join(tmp, 'tree');
    require('node:fs').mkdirSync(dir, { recursive: true });
    const r = await runProcess({ command: process.execPath, args: [FIXTURE, 'tree', dir], cwd: tmp, timeoutMs: 2500 });
    expect(r.timedOut).toBe(true);
    const pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      alive = isAlive(pids.parent) || isAlive(pids.child);
      if (alive) await sleep(100);
    }
    expect(isAlive(pids.parent)).toBe(false);
    expect(isAlive(pids.child)).toBe(false);
  });

  test('abort signal cancels and kills', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 500);
    const r = await runProcess({ command: process.execPath, args: [FIXTURE, 'sleep', tmp], cwd: tmp, timeoutMs: 60000 }, ctrl.signal);
    expect(r.cancelled).toBe(true);
    expect(isAlive(r.pid)).toBe(false);
  });

  test('spawn errors are reported, not thrown', async () => {
    const r = await runProcess({ command: join(tmp, 'does-not-exist.exe'), args: [], cwd: tmp, timeoutMs: 5000 });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeTruthy();
  });
});

describe('worktree from origin/main', () => {
  test('creates <agent>/<topic> on origin/main and removes it only when pristine', () => {
    const git = (args: string[], cwd: string) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const origin = join(tmp, 'origin.git');
    const repo = join(tmp, 'repo');
    git(['init', '-q', '--bare', '-b', 'main', origin], tmp);
    git(['init', '-q', '-b', 'main', repo], tmp);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    git(['remote', 'add', 'origin', origin], repo);
    git(['push', '-q', 'origin', 'main'], repo);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'local only'], repo);
    const wt = createWorktree({ cwd: repo, agent: 'codex', topic: 'Fix README typo!', id: '261009-013012-ab12', root: join(tmp, 'wts') });
    expect(wt.branch).toBe('codex/fix-readme-typo');
    expect(existsSync(wt.path)).toBe(true);
    expect(git(['rev-parse', 'HEAD'], wt.path)).toBe(git(['rev-parse', 'origin/main'], repo));
    const again = createWorktree({ cwd: repo, agent: 'codex', topic: 'Fix README typo!', id: '261009-013012-ab12', root: join(tmp, 'wts') });
    expect(again.branch).toBe('codex/fix-readme-typo-ab12');
    writeFileSync(join(again.path, 'new.txt'), 'x');
    expect(worktreeChanges(again.path).status).toContain('new.txt');
    expect(removeIfPristine(again)).toBe(false);
    expect(removeIfPristine(wt)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });
});
