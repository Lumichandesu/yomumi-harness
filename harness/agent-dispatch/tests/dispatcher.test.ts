import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/dispatcher';
import { loadConfig, type AgentId } from '../src/config';
import { ConcurrencyGate } from '../src/gate';
import { ADAPTERS, type Adapter } from '../src/adapters';
import type { AgentStatus } from '../src/registry';
import { readTask } from '../src/taskfile';
import { isAlive, sleep } from '../src/util';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-agent.ts');
const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-disp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const QUOTE = 'ทดสอบข้อความภาษาไทย: please run this (test quote)';
const ALL: AgentId[] = ['claude', 'codex', 'antigravity', 'hermes', 'cursor'];

let n = 0;
interface Env {
  d: Dispatcher;
  dir: string;
  tasksDir: string;
  board: string;
  cwd: string;
  behaviors: Partial<Record<AgentId, string>>;
  open: AgentId[];
  calls: { agent: AgentId; args: string[]; prompt: string }[];
}

function makeEnv(opts: { open?: AgentId[]; behaviors?: Partial<Record<AgentId, string>>; autoRunHandoffs?: boolean } = {}): Env {
  const dir = join(root, `e${++n}`);
  const comms = join(dir, 'Agent-Comms');
  const tasksDir = join(comms, 'Tasks');
  mkdirSync(tasksDir, { recursive: true });
  const cwd = join(dir, 'work');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(comms, 'Board.md'), '# Board\n');
  writeFileSync(join(comms, 'README.md'), '# README\n');
  const env: Env = { d: null as any, dir, tasksDir, board: join(comms, 'Board.md'), cwd, behaviors: opts.behaviors ?? {}, open: opts.open ?? ['claude', 'codex', 'antigravity', 'hermes'], calls: [] };
  const cfg = loadConfig({
    paths: { home: dir, runsDir: join(dir, 'runs'), commsDir: comms, tasksDir, boardFile: env.board, readmeFile: join(comms, 'README.md') },
    readDirs: [],
    contextNotes: [join(comms, 'README.md')],
    autoRunHandoffs: opts.autoRunHandoffs ?? true,
  });
  const fake = (id: AgentId): Adapter => ({
    id,
    verified: true,
    canReadVault: () => true,
    build: (_bin, ctx) => {
      env.calls.push({ agent: id, args: [], prompt: ctx.promptText });
      return { command: process.execPath, args: [FIXTURE, env.behaviors[id] ?? 'ok', ctx.runDir], cwd: ctx.cwd, stdin: ctx.promptText };
    },
    parse: ADAPTERS.claude.parse,
  });
  env.d = new Dispatcher({
    config: cfg,
    detect: (): AgentStatus[] =>
      ALL.map((id) => ({ id, label: id, installed: id !== 'cursor', running: env.open.includes(id), processCount: env.open.includes(id) ? 1 : 0, notes: [] })),
    resolveBinary: (id) => (id === 'cursor' ? null : { command: 'fake', prefixArgs: [], source: 'test' }),
    adapters: Object.fromEntries(ALL.map((id) => [id, fake(id)])) as any,
    gate: new ConcurrencyGate({ max: cfg.maxConcurrent, dir: join(dir, 'runs', '.slots'), pollMs: 20 }),
    log: () => {},
    cacheMs: 0,
    pollMs: 50,
  });
  return env;
}

function taskFiles(env: Env): string[] {
  return readdirSync(env.tasksDir).filter((f) => f.endsWith('.md'));
}

describe('dispatch one task', () => {
  test('writes the Obsidian task file and a Board line, runs, stores a concise redacted result', async () => {
    const env = makeEnv({ behaviors: { claude: 'secret' } });
    const doc = env.d.submitTask({ to: 'auto', prompt: 'Find where config is loaded', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE, from: 'test' });
    expect(doc.status).toBe('queued');
    expect(doc.agent).toBe('claude');
    expect(doc.model).toBe('haiku');
    expect(doc.weight).toBe('light');
    expect(taskFiles(env)[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}-\d{6}-[0-9a-f]{4}_claude\.md$/);
    const board = readFileSync(env.board, 'utf8');
    expect(board).toContain(`[[Tasks/${taskFiles(env)[0].replace(/\.md$/, '')}|${doc.id}]] queued: test → claude (haiku), light, read-only`);
    await env.d.waitIdle(20000);
    const done = readTask(doc.file)!;
    expect(done.status).toBe('done');
    expect(done.owner_quote).toBe(QUOTE);
    expect(done.result).toContain('leaked [REDACTED]');
    expect(readFileSync(doc.file, 'utf8')).not.toContain(['sk', 'ant', 'api03'].join('-'));
    const runFiles = readdirSync(join(env.dir, 'runs', doc.id));
    expect(runFiles.some((f) => f.startsWith('attempt-1-claude'))).toBe(true);
    const stdout = readFileSync(join(env.dir, 'runs', doc.id, 'attempt-1-claude', 'stdout.log'), 'utf8');
    expect(stdout).not.toContain(['sk', 'ant', 'api03'].join('-'));
    expect(env.calls[0].prompt.startsWith('=== AGENT-DISPATCH PREAMBLE')).toBe(true);
    expect(env.calls[0].prompt).toContain(QUOTE);
    expect(env.calls[0].prompt).toContain(doc.file);
  });

  test('validation: owner quote, absolute cwd, Hermes model, unknown agent', () => {
    const env = makeEnv();
    const base = { prompt: 'x', cwd: env.cwd, mode: 'read-only' as const, ownerQuote: QUOTE };
    expect(() => env.d.submitTask({ ...base, ownerQuote: '' })).toThrow(/owner_quote/);
    expect(() => env.d.submitTask({ ...base, cwd: 'relative/dir' })).toThrow(/absolute/);
    expect(() => env.d.submitTask({ ...base, to: 'hermes', model: 'qwen' })).toThrow(/Hermes chooses/);
    expect(() => env.d.submitTask({ ...base, to: 'gpt9' })).toThrow(/Unknown agent/);
    expect(taskFiles(env)).toHaveLength(0);
  });

  test('closed apps are never used; no open agent means the task is refused', () => {
    const env = makeEnv({ open: [] });
    expect(() => env.d.submitTask({ prompt: 'x', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE })).toThrow(/No open agent/);
    const env2 = makeEnv({ open: ['hermes'] });
    const doc = env2.d.submitTask({ to: 'codex', prompt: 'x', cwd: env2.cwd, mode: 'read-only', ownerQuote: QUOTE }, { run: false });
    expect(doc.agent).toBe('hermes');
    expect(doc.routing).toContain('codex: app not open (not launched)');
  });
});

describe('failover on quota', () => {
  test('switches to the next open agent and records the switch in the task file', async () => {
    const env = makeEnv({ behaviors: { claude: 'quota', codex: 'ok' } });
    const doc = env.d.submitTask({ to: 'auto', prompt: 'Explain the module', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE, weight: 'heavy' });
    await env.d.waitIdle(20000);
    const t = readTask(doc.file)!;
    expect(t.status).toBe('done');
    expect(t.agent).toBe('codex');
    expect(t.attempts).toBe(2);
    expect(t.log.join('\n')).toContain('claude (opus) hit a quota or rate limit');
    expect(env.calls.map((c) => c.agent)).toEqual(['claude', 'codex']);
  });

  test('a non-quota failure does not fail over', async () => {
    const env = makeEnv({ behaviors: { claude: 'fail' } });
    const doc = env.d.submitTask({ prompt: 'Explain the module', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE });
    await env.d.waitIdle(20000);
    expect(readTask(doc.file)!.status).toBe('failed');
    expect(env.calls).toHaveLength(1);
  });

  test('all open agents out of quota → failed with the reason', async () => {
    const env = makeEnv({ open: ['claude', 'codex'], behaviors: { claude: 'quota', codex: 'quota' } });
    const doc = env.d.submitTask({ prompt: 'Explain', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE, kind: 'short' });
    await env.d.waitIdle(20000);
    const t = readTask(doc.file)!;
    expect(t.status).toBe('failed');
    expect(t.result).toContain('no open agent left after failover');
  });
});

describe('timeout and cancel', () => {
  test('timeout marks the task and kills the tree', async () => {
    const env = makeEnv({ behaviors: { claude: 'sleep' } });
    const doc = env.d.submitTask({ prompt: 'Explain', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE }, { run: false });
    // 30 s is the public minimum; shorten it in the task file (the file is the source of truth).
    writeFileSync(doc.file, readFileSync(doc.file, 'utf8').replace('timeout_sec: 1800', 'timeout_sec: 2'));
    const t = (await env.d.start(doc.id))!;
    expect(t.status).toBe('timeout');
    expect(t.log.join('\n')).toContain('process tree killed');
  });

  test('cancel kills a running task', async () => {
    const env = makeEnv({ behaviors: { claude: 'sleep' } });
    const doc = env.d.submitTask({ prompt: 'Explain', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE });
    await sleep(400);
    const r = await env.d.cancel(doc.id);
    expect(r.doc.status).toBe('cancelled');
    const rt = JSON.parse(readFileSync(join(env.dir, 'runs', doc.id, 'runtime.json'), 'utf8'));
    expect(rt.childPid ?? null).toBeNull();
  });

  test('owner can cancel from Obsidian by setting status: cancelled', async () => {
    const env = makeEnv({ behaviors: { claude: 'sleep' } });
    const doc = env.d.submitTask({ prompt: 'Explain', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE });
    await sleep(400);
    const text = readFileSync(doc.file, 'utf8').replace('status: "running"', 'status: "cancelled"');
    writeFileSync(doc.file, text);
    await env.d.waitIdle(20000);
    expect(readTask(doc.file)!.status).toBe('cancelled');
  });
});

describe('plans', () => {
  test('preview shows heavy/light and agents; dispatch respects dependencies; one Board line', async () => {
    const env = makeEnv({ open: ['claude', 'codex', 'hermes'] });
    const plan = {
      ownerQuote: QUOTE,
      from: 'claude-session',
      tasks: [
        { key: 'find', prompt: 'Find where the router is defined', cwd: env.cwd, mode: 'read-only' as const, kind: 'search' as const },
        { key: 'design', prompt: 'Design the new router', cwd: env.cwd, mode: 'read-only' as const, weight: 'heavy' as const, dependsOn: ['find'] },
        { key: 'free', prompt: 'Summarise the README', cwd: env.cwd, mode: 'read-only' as const, to: 'hermes' },
      ],
    };
    const p = env.d.previewPlan(plan);
    expect(p.errors).toEqual([]);
    expect(p.table).toContain('**light** (search)');
    expect(p.table).toContain('**heavy** (hard)');
    expect(p.table).toContain('claude (haiku)');
    expect(p.table).toContain('claude (opus)');
    expect(p.table).toContain('Apps not open (skipped, not launched): antigravity');
    const r = env.d.dispatchPlan(env.d.loadPreview(p.previewId));
    expect(r.tasks.map((t) => t.agent)).toEqual(['claude (haiku)', 'claude (opus)', 'hermes']);
    await env.d.waitIdle(30000);
    const docs = r.tasks.map((t) => readTask(t.file)!);
    expect(docs.every((x) => x.status === 'done')).toBe(true);
    expect(docs[1].depends_on).toEqual([docs[0].id]);
    expect(Date.parse(docs[1].started)).toBeGreaterThanOrEqual(Date.parse(docs[0].ended));
    const designPrompt = env.calls.find((c) => c.prompt.includes('Design the new router'))!.prompt;
    expect(designPrompt).toContain(docs[0].file);
    const board = readFileSync(env.board, 'utf8').trim().split('\n').filter((l) => l.includes('agent-dispatch'));
    expect(board).toHaveLength(1);
    expect(board[0]).toContain('3 sub-task(s) (1 heavy, 2 light)');
    expect(existsSync(r.planFile)).toBe(true);
  });

  test('dependency cycles and unknown keys are rejected', () => {
    const env = makeEnv();
    const t = (key: string, deps: string[]) => ({ key, prompt: 'x', cwd: env.cwd, mode: 'read-only' as const, dependsOn: deps });
    const p = env.d.previewPlan({ ownerQuote: QUOTE, tasks: [t('a', ['b']), t('b', ['a']), t('c', ['zzz'])] });
    expect(p.errors.join('\n')).toContain('dependency cycle between: a, b');
    expect(p.errors.join('\n')).toContain('unknown key zzz');
    expect(() => env.d.dispatchPlan({ ownerQuote: QUOTE, tasks: [t('a', ['b']), t('b', ['a'])] })).toThrow(/Plan rejected/);
    expect(taskFiles(env)).toHaveLength(0);
  });

  test('the concurrency cap of 2 holds across a plan', async () => {
    const env = makeEnv({ behaviors: { claude: 'slow:400', codex: 'slow:400', hermes: 'slow:400' } });
    const tasks = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, prompt: `Explain part ${i}`, cwd: env.cwd, mode: 'read-only' as const, to: ['claude', 'codex', 'hermes'][i % 3] }));
    env.d.dispatchPlan({ ownerQuote: QUOTE, tasks });
    await env.d.waitIdle(30000);
    const events = readFileSync(join(env.dir, 'runs', 'fake-agent.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
      .map(([k, t]) => ({ k, t: Number(t) }))
      .sort((a, b) => a.t - b.t || (a.k === 'end' ? -1 : 1));
    let cur = 0;
    let max = 0;
    for (const e of events) {
      cur += e.k === 'start' ? 1 : -1;
      max = Math.max(max, cur);
    }
    expect(events.filter((e) => e.k === 'start')).toHaveLength(5);
    expect(max).toBeLessThanOrEqual(2);
  });
});

describe('peer hand-offs', () => {
  test('a HANDOFF block creates a child task with the same owner quote and hop + 1', async () => {
    const env = makeEnv({ behaviors: { claude: 'handoff' }, autoRunHandoffs: false });
    const doc = env.d.submitTask({ to: 'claude-sonnet', prompt: 'Review the README', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE });
    await env.d.waitIdle(20000);
    const parent = readTask(doc.file)!;
    expect(parent.status).toBe('done');
    expect(parent.log.join('\n')).toContain('hand-off →');
    const child = env.d.listTasks(10).find((t) => t.parent === doc.id)!;
    expect(child.hop).toBe(1);
    expect(child.root).toBe(doc.id);
    expect(child.owner_quote).toBe(QUOTE);
    expect(child.from).toBe('claude (sonnet)');
    expect(child.status).toBe('queued');
    expect(child.agent).toBe('claude');
    expect(child.model).toBe('haiku');
  });

  test('hop limit of 3, quote must match, mode ceiling, explicit cycles rejected', () => {
    const env = makeEnv();
    const base = { prompt: 'x', cwd: env.cwd, mode: 'read-only' as const, ownerQuote: QUOTE };
    const r = env.d.submitTask({ ...base, to: 'claude-opus' }, { run: false });
    expect(() => env.d.submitTask({ ...base, parentId: r.id, ownerQuote: 'a different quote here' }, { run: false })).toThrow(/carried unchanged/);
    expect(() => env.d.submitTask({ ...base, parentId: r.id, mode: 'write-in-worktree' }, { run: false })).toThrow(/cannot exceed the root task mode/);
    expect(() => env.d.submitTask({ ...base, parentId: r.id, to: 'claude-opus' }, { run: false })).toThrow(/cycle/);
    const h1 = env.d.submitTask({ ...base, parentId: r.id, to: 'codex' }, { run: false });
    const h2 = env.d.submitTask({ ...base, parentId: h1.id, to: 'hermes' }, { run: false });
    expect(() => env.d.submitTask({ ...base, parentId: h2.id, to: 'codex' }, { run: false })).toThrow(/cycle/);
    const h3 = env.d.submitTask({ ...base, parentId: h2.id, to: 'antigravity' }, { run: false });
    expect(h3.hop).toBe(3);
    expect(() => env.d.submitTask({ ...base, parentId: h3.id, to: 'claude-haiku' }, { run: false })).toThrow(/hand-off limit/);
    // Auto skips agents already in the chain instead of failing.
    const auto = env.d.submitTask({ ...base, parentId: h1.id, kind: 'short' }, { run: false });
    expect(auto.agent).not.toBe('codex');
  });
});

describe('Obsidian inbox (run-queue)', () => {
  test('a hand-written task file is normalised, shown as a plan and run', async () => {
    const env = makeEnv();
    writeFileSync(
      join(env.tasksDir, 'my request.md'),
      `---\ntype: agent-task\nfrom: owner\nto: auto\nweight: light\nmode: read-only\ncwd: ${JSON.stringify(env.cwd)}\nstatus: queued\nowner_quote: ${JSON.stringify(QUOTE)}\n---\n\n## Request\nFind the entry point of the app.\n`,
    );
    writeFileSync(join(env.tasksDir, 'random note.md'), '# not a task\n');
    const dry = await env.d.runQueue({ dryRun: true });
    expect(dry.rows).toHaveLength(1);
    expect(dry.table).toContain('**light** (search)');
    expect(readTask(join(env.tasksDir, 'my request.md'))!.id).toBe('');
    const r = await env.d.runQueue();
    expect(r.started).toHaveLength(1);
    const t = readTask(join(env.tasksDir, 'my request.md'))!;
    expect(t.status).toBe('done');
    expect(t.id).toMatch(/^\d{6}-\d{6}-[0-9a-f]{4}$/);
    expect(t.log.join('\n')).toContain('picked up from the Obsidian inbox');
    expect(readFileSync(env.board, 'utf8')).toContain('inbox task');
    const again = await env.d.runQueue();
    expect(again.started).toHaveLength(0);
  });

  test('invalid inbox files are marked failed with the reason (not retried forever)', async () => {
    const env = makeEnv();
    writeFileSync(join(env.tasksDir, 'bad.md'), `---\ntype: agent-task\nto: hermes\nmodel: some-model\nmode: read-only\ncwd: ${JSON.stringify(env.cwd)}\nstatus: queued\nowner_quote: ${JSON.stringify(QUOTE)}\n---\n## Request\nx\n`);
    const r = await env.d.runQueue();
    expect(r.rejected[0]).toContain('Hermes chooses');
    expect(readTask(join(env.tasksDir, 'bad.md'))!.status).toBe('failed');
  });

  test('a queued file waits (stays queued) while no suitable app is open', async () => {
    const env = makeEnv({ open: [] });
    writeFileSync(join(env.tasksDir, 'later.md'), `---\ntype: agent-task\nto: auto\nmode: read-only\ncwd: ${JSON.stringify(env.cwd)}\nstatus: queued\nowner_quote: ${JSON.stringify(QUOTE)}\n---\n## Request\nFind x\n`);
    await env.d.runQueue();
    expect(readTask(join(env.tasksDir, 'later.md'))!.status).toBe('queued');
  });
});

describe('shutdown leaves nothing behind', () => {
  test('running children are killed and tasks marked cancelled', async () => {
    const env = makeEnv({ behaviors: { claude: 'sleep' } });
    const doc = env.d.submitTask({ prompt: 'Explain', cwd: env.cwd, mode: 'read-only', ownerQuote: QUOTE });
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
      await sleep(100);
      try {
        pid = JSON.parse(readFileSync(join(env.dir, 'runs', doc.id, 'runtime.json'), 'utf8')).childPid ?? 0;
      } catch {}
    }
    expect(pid).toBeGreaterThan(0);
    await env.d.shutdown('test stop');
    expect(readTask(doc.file)!.status).toBe('cancelled');
    expect(isAlive(pid)).toBe(false);
    expect(env.d.activeCount).toBe(0);
  });
});
