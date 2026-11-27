import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { classify, findDependencyCycle, route } from '../src/routing';
import type { AgentStatus } from '../src/registry';
import type { AgentId } from '../src/config';

const cfg = loadConfig({ paths: { home: 'X', runsDir: 'X', commsDir: 'X', tasksDir: 'X', boardFile: 'X', readmeFile: 'X' } });

function statuses(open: AgentId[], installed: AgentId[] = ['claude', 'codex', 'antigravity', 'hermes']): AgentStatus[] {
  return (['claude', 'codex', 'antigravity', 'hermes', 'cursor'] as AgentId[]).map((id) => ({
    id, label: id, installed: installed.includes(id), running: open.includes(id), processCount: open.includes(id) ? 1 : 0, notes: [],
  }));
}

describe('classification (heavy/light)', () => {
  test('planner hints win; search becomes easy in write mode', () => {
    expect(classify('anything', 'read-only', { weight: 'heavy' })).toMatchObject({ kind: 'hard', weight: 'heavy' });
    expect(classify('anything', 'read-only', { kind: 'search' })).toMatchObject({ kind: 'search', weight: 'light' });
    expect(classify('anything', 'write-in-worktree', { kind: 'search' })).toMatchObject({ kind: 'easy', weight: 'light' });
  });

  test('heuristics', () => {
    expect(classify('Find where the README mentions Hermes', 'read-only')).toMatchObject({ kind: 'search', weight: 'light' });
    expect(classify('Fix the typo in the README', 'write-in-worktree')).toMatchObject({ kind: 'easy' });
    expect(classify('Implement the payment ledger migration', 'write-in-worktree')).toMatchObject({ kind: 'hard', weight: 'heavy' });
    expect(classify('Explain this function', 'read-only')).toMatchObject({ kind: 'short', weight: 'light' });
    expect(classify('Find the auth bug root cause', 'read-only', { weight: 'light' })).toMatchObject({ weight: 'light' });
  });
});

describe('routing', () => {
  const all = statuses(['claude', 'codex', 'antigravity', 'hermes']);

  test('cheapest capable model per weight', () => {
    expect(route({ to: 'auto', kind: 'search', mode: 'read-only' }, all, cfg).chosen).toEqual({ agent: 'claude', model: 'haiku' });
    expect(route({ to: 'auto', kind: 'easy', mode: 'write-in-worktree' }, all, cfg).chosen).toEqual({ agent: 'antigravity', model: 'gemini-3.8-flash-medium' });
    expect(route({ to: 'auto', kind: 'short', mode: 'read-only' }, all, cfg).chosen).toEqual({ agent: 'claude', model: 'sonnet' });
    expect(route({ to: 'auto', kind: 'hard', mode: 'write-in-worktree' }, all, cfg).chosen).toEqual({ agent: 'claude', model: 'opus' });
  });

  test('only open apps: closed and missing agents are skipped, never launched', () => {
    const r = route({ to: 'auto', kind: 'easy', mode: 'read-only' }, statuses(['claude', 'hermes']), cfg);
    expect(r.chosen).toEqual({ agent: 'claude', model: 'sonnet' });
    expect(r.skipped).toContainEqual({ agent: 'antigravity (gemini-3.8-flash-medium)', reason: 'app not open (not launched)' });
    expect(r.skipped.find((s) => s.agent === 'cursor')?.reason).toContain('not installed');
    const none = route({ to: 'auto', kind: 'hard', mode: 'read-only' }, statuses([]), cfg);
    expect(none.chosen).toBeNull();
  });

  test('explicit target first, then failover chain', () => {
    const r = route({ to: 'codex', kind: 'hard', mode: 'read-only' }, all, cfg);
    expect(r.chosen).toEqual({ agent: 'codex', model: null });
    expect(r.fallbacks[0]).toEqual({ agent: 'claude', model: 'opus' });
    const nf = route({ to: 'codex', kind: 'hard', mode: 'read-only', failover: false }, all, cfg);
    expect(nf.fallbacks).toHaveLength(0);
  });

  test('failover excludes agents already tried (whole agent on quota)', () => {
    const r = route({ to: 'auto', kind: 'hard', mode: 'read-only', exclude: new Set(['claude:*']) }, all, cfg);
    expect(r.chosen?.agent).toBe('codex');
  });

  test('weekly Claude usage at 95% or more moves Claude last unless urgent', () => {
    const r = route({ to: 'auto', kind: 'search', mode: 'read-only', claudeWeeklyPercent: 96 }, all, cfg);
    expect(r.chosen?.agent).toBe('antigravity');
    expect(r.fallbacks[r.fallbacks.length - 1].agent).toBe('claude');
    expect(route({ to: 'auto', kind: 'search', mode: 'read-only', claudeWeeklyPercent: 96, urgent: true }, all, cfg).chosen?.agent).toBe('claude');
    expect(route({ to: 'auto', kind: 'search', mode: 'read-only', claudeWeeklyPercent: 94 }, all, cfg).chosen?.agent).toBe('claude');
  });

  test('Hermes: never a model, explicit model rejected, no write without a sandbox', () => {
    expect(() => route({ to: 'hermes', model: 'gpt-x', kind: 'search', mode: 'read-only' }, all, cfg)).toThrow(/Hermes chooses its own free model/);
    expect(route({ to: 'hermes', kind: 'hard', mode: 'read-only' }, all, cfg).chosen).toEqual({ agent: 'hermes', model: null });
    const w = route({ to: 'hermes', kind: 'easy', mode: 'write-in-worktree' }, all, cfg);
    expect(w.chosen?.agent).not.toBe('hermes');
    expect(w.skipped.find((s) => s.agent === 'hermes')?.reason).toContain('no file sandbox');
  });

  test('Haiku never gets write work', () => {
    const r = route({ to: 'claude-haiku', kind: 'easy', mode: 'write-in-worktree' }, all, cfg);
    expect(r.chosen).not.toEqual({ agent: 'claude', model: 'haiku' });
  });

  test('ancestors are skipped for auto (no hand-off back into the chain)', () => {
    const r = route({ to: 'auto', kind: 'short', mode: 'read-only', ancestors: new Set(['claude:sonnet']) }, all, cfg);
    expect(r.chosen?.agent).toBe('codex');
  });

  test('unknown agent names are rejected', () => {
    expect(() => route({ to: 'gpt7', kind: 'short', mode: 'read-only' }, all, cfg)).toThrow(/Unknown agent/);
  });
});

describe('dependency cycles', () => {
  test('DAG passes, cycles are reported', () => {
    expect(findDependencyCycle({ a: [], b: ['a'], c: ['a', 'b'] })).toEqual([]);
    expect(findDependencyCycle({ a: ['c'], b: ['a'], c: ['b'], d: [] }).sort()).toEqual(['a', 'b', 'c']);
    expect(findDependencyCycle({ a: ['a'] })).toEqual(['a']);
  });
});

describe('config clamps', () => {
  test('a config cannot loosen safety limits', () => {
    const c = loadConfig({ maxConcurrent: 10, maxHops: 9, maxHandoffsPerTask: 5, maxTasksPerRoot: 99, paths: cfg.paths } as any);
    expect(c.maxConcurrent).toBe(2);
    expect(c.maxHops).toBe(3);
    expect(c.maxHandoffsPerTask).toBe(2);
    expect(c.maxTasksPerRoot).toBe(8);
    expect(Object.values(c.models.hermes).every((m) => m === null)).toBe(true);
  });
});
