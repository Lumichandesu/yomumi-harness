/**
 * Dedicated git worktree + branch `<agent>/<topic>` from origin/main for write tasks.
 * The dispatcher never pushes and never commits for the agent; changes stay uncommitted for review.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { slug } from './util';

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  base: string;
  warnings: string[];
}

function git(args: string[], cwd: string, timeout = 60000): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Root of the main checkout (not of a linked worktree), via the common git dir. */
export function mainRepoRoot(cwd: string): string {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) throw new Error(`${cwd} is not inside a git repository`);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (common.ok && /[\\/]\.git$/.test(common.out)) return resolve(dirname(common.out));
  return resolve(top.out);
}

export function createWorktree(opts: { cwd: string; agent: string; topic: string; id: string; root?: string; fetch?: boolean }): Worktree {
  const warnings: string[] = [];
  const repo = mainRepoRoot(opts.cwd);
  if (opts.fetch !== false) {
    const f = git(['fetch', '--quiet', 'origin', 'main'], repo, 120000);
    if (!f.ok) warnings.push(`git fetch origin main failed; using the local origin/main ref (${f.err.split('\n')[0]})`);
  }
  const base = 'origin/main';
  if (!git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], repo).ok) {
    throw new Error(`${repo} has no ${base}; cannot create a worktree`);
  }
  const topic = slug(opts.topic, 32);
  let branch = `${opts.agent}/${topic}`;
  if (git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo).ok) branch = `${branch}-${opts.id.slice(-4)}`;
  const root = opts.root ?? join(repo, '.claude', 'worktrees');
  let path = join(root, `${opts.agent}-${topic}`);
  if (existsSync(path)) path = `${path}-${opts.id.slice(-4)}`;
  if (!isAbsolute(path)) path = resolve(path);
  const add = git(['worktree', 'add', '-b', branch, path, base], repo, 300000);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.err.split('\n').slice(0, 3).join(' ')}`);
  return { repo, path, branch, base, warnings };
}

export function worktreeChanges(path: string): { status: string; diffStat: string; commitsAhead: number } {
  const status = git(['status', '--porcelain'], path).out;
  const diffStat = git(['diff', '--stat', 'HEAD'], path).out;
  const ahead = parseInt(git(['rev-list', '--count', 'origin/main..HEAD'], path).out, 10) || 0;
  return { status, diffStat, commitsAhead: ahead };
}

/** Remove a worktree we created only if nothing was changed or committed in it. */
export function removeIfPristine(wt: Worktree): boolean {
  const c = worktreeChanges(wt.path);
  if (c.status || c.commitsAhead) return false;
  const rm = git(['worktree', 'remove', wt.path], wt.repo);
  if (!rm.ok) return false;
  git(['branch', '-d', wt.branch], wt.repo);
  return true;
}
