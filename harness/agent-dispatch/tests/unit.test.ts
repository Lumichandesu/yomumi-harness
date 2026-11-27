import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '../src/redact';
import { parseFrontmatter, parseSections } from '../src/frontmatter';
import { parseTask, renderTask, type TaskDoc } from '../src/taskfile';
import { buildPrompt, PREAMBLE_MARKER, TASK_MARKER, type PreambleInput } from '../src/preamble';
import { parseHandoffs, summarizeResult, stripHandoffs } from '../src/handoff';
import { checkRoleTable, parseTasklist, readRoleTable, detectAgents } from '../src/registry';
import { ADAPTERS, FORBIDDEN_FLAGS, detectQuota, type AdapterContext } from '../src/adapters';
import type { RunOutcome } from '../src/runner';

describe('secret stripping', () => {
  // Fake credentials are assembled at runtime so this file holds no key-shaped literal
  // (secret scanners would otherwise flag the test source itself).
  const j = (...parts: string[]) => parts.join('');
  const FAKE = {
    anthropic: j('sk-', 'ant-', 'api03-', 'ABCDEFGHIJKLMNOPQRSTUVWX0123'),
    openrouter: j('sk-', 'or-', 'v1-', '0123456789abcdef0123456789abcdef'),
    github: j('gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    payment: j('sk', '_live_', 'ABCDEFGHIJ0123456789'),
    webhook: j('wh', 'sec_', 'ABCDEFGHIJKLMN'),
    aws: j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    google: j('AI', 'za', 'SyA-0123456789abcdefghijklmnopqrstuvw'),
    jwt: j('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    pem: j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ', 'PRIVATE KEY-----'),
  };
  test('redacts provider keys, tokens, URLs with passwords and key=value secrets', () => {
    const input = [
      `anthropic ${FAKE.anthropic}`,
      `openrouter ${FAKE.openrouter}`,
      `github ${FAKE.github}`,
      `payments ${FAKE.payment} and ${FAKE.webhook}`,
      `aws ${FAKE.aws}`,
      `google ${FAKE.google}`,
      `jwt ${FAKE.jwt}`,
      j('DATABASE_URL=postgres://', 'user:', 'OtherSecretPw2', '@db-y.example.test/app'),
      j('conn postgres://', 'user:', 'SuperSecretPw1', '@db-x.example.test/app'),
      j('Authorization: Bear', 'er ', 'abcdefghijklmnopqrstuvwxyz123456'),
      j('"api', '_key": ', '"abcdef123456789"'),
      j('pass', 'word: ', 'hunter2hunter2'),
      FAKE.pem,
    ].join('\n');
    const out = redactSecrets(input);
    for (const leak of [FAKE.anthropic.slice(0, 12), FAKE.openrouter.slice(0, 13), FAKE.github.slice(0, 7), FAKE.payment.slice(0, 8), FAKE.webhook.slice(0, 9), FAKE.aws.slice(0, 8), FAKE.google.slice(0, 7), FAKE.jwt.slice(0, 8), 'SuperSecretPw1', 'OtherSecretPw2', 'abcdefghijklmnopqrstuvwxyz123456', 'abcdef123456789', 'hunter2', 'MIIEvQ']) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('postgres://user:[REDACTED]@db-x.example.test');
    expect(out).toContain('Bearer [REDACTED]');
  });

  test('keeps ordinary text and numeric token counts', () => {
    const s = 'input_tokens: 123456, output_tokens: 789 and the word token stays.';
    expect(redactSecrets(s)).toBe(s);
    expect(redactSecrets('Reply with the single word OK')).toBe('Reply with the single word OK');
  });
});

describe('frontmatter and task files', () => {
  test('parses a hand-written task file (Obsidian inbox)', () => {
    const text = `---
type: agent-task
from: hermes
to: codex
weight: light
mode: read-only
cwd: 'C:\\work\\app'
status: queued
depends_on:
  - 261009-010101-aaaa
  - "261009-010102-bbbb"
owner_quote: |
  first line of the quote
  second line
timeout_sec: 600
---

## Request
List the files that mention Hermes.

## Notes
## not a section in request
`;
    const fm = parseFrontmatter(text)!;
    expect(fm.data.to).toBe('codex');
    expect(fm.data.depends_on).toEqual(['261009-010101-aaaa', '261009-010102-bbbb']);
    expect(fm.data.owner_quote).toBe('first line of the quote\nsecond line');
    expect(fm.data.timeout_sec).toBe(600);
    const doc = parseTask(text, 'x.md')!;
    expect(doc.from).toBe('hermes');
    expect(doc.mode).toBe('read-only');
    expect(doc.cwd).toBe('C:\\work\\app');
    expect(doc.request).toBe('List the files that mention Hermes.');
    expect(doc.status).toBe('queued');
    expect(doc.id).toBe('');
  });

  test('ignores notes that are not agent tasks', () => {
    expect(parseTask('# Just a note\n', 'n.md')).toBeNull();
    expect(parseTask('---\ntype: agent-plan\n---\n', 'p.md')).toBeNull();
  });

  test('inline lists, quotes and booleans', () => {
    const fm = parseFrontmatter('---\na: [x, "y, z", \'w\']\nb: true\nc: ""\nd: "quote \\"inner\\" ok"\n---\nbody')!;
    expect(fm.data.a).toEqual(['x', 'y, z', 'w']);
    expect(fm.data.b).toBe(true);
    expect(fm.data.c).toBe('');
    expect(fm.data.d).toBe('quote "inner" ok');
    expect(fm.body).toBe('body');
  });

  test('render then parse round-trips and keeps user headings inside sections', () => {
    const doc: TaskDoc = {
      id: '261009-013012-ab12', root: '261009-013012-ab12', parent: '', hop: 0, plan: '', key: 'k1', from: 'owner', to: 'auto',
      agent: 'claude', weight: 'light', kind: 'search', model: 'haiku', mode: 'read-only', cwd: 'C:\\work\\x', topic: 't',
      branch: '', worktree: '', status: 'queued', depends_on: ['a', 'b'], owner_quote: 'ทดสอบข้อความ "quoted"',
      timeout_sec: 1800, urgent: false, failover: true, claude_weekly_percent: null, attempts: 0, created: '2026-10-09T01:30:12+07:00',
      updated: '', started: '', ended: '', run_log: 'D:\\runs\\x', request: 'Find things.\n## Heading inside request', routing: '- Weight: light',
      result: '', log: ['2026-10-09 01:30 queued'], file: 'f.md',
    };
    const back = parseTask(renderTask(doc), 'f.md')!;
    expect(back.owner_quote).toBe(doc.owner_quote);
    expect(back.depends_on).toEqual(['a', 'b']);
    expect(back.request).toBe('Find things.\n### Heading inside request');
    expect(back.log).toEqual(['2026-10-09 01:30 queued']);
    expect(back.claude_weekly_percent).toBeNull();
    expect(back.failover).toBe(true);
    expect(back.model).toBe('haiku');
    expect(parseSections('## A\none\n## B\ntwo')).toEqual({ A: 'one', B: 'two' });
  });
});

const PRE: PreambleInput = {
  taskId: '261009-013012-ab12', taskFile: 'D:\\T\\task.md', agentLabel: 'Codex', model: null, from: 'owner', hop: 1, maxHops: 3,
  maxHandoffs: 2, rootMode: 'read-only', mode: 'read-only', cwd: 'C:\\work\\app', ownerQuote: 'ทดสอบคำสั่ง\nsecond line',
  readmeFile: 'D:\\AC\\README.md', contextNotes: ['D:\\AC\\README.md'], dependencyFiles: ['D:\\T\\dep.md'], canReadVault: true, tasksDir: 'D:\\T',
};

describe('preamble', () => {
  test('starts every prompt with the fixed preamble, quote, limits and hand-off protocol', () => {
    const p = buildPrompt(PRE, 'Reply with the single word OK and nothing else.');
    expect(p.startsWith(PREAMBLE_MARKER)).toBe(true);
    expect(p).toContain('> ทดสอบคำสั่ง\n> second line');
    for (const s of ['no git push', 'no deploy', 'no production migration', 'secrets', 'DNS, CDN or security-setting', 'live URLs', 'permission-bypass', 'not approval']) {
      expect(p).toContain(s);
    }
    expect(p).toContain('MODE: read-only');
    expect(p).toContain('HANDOFF');
    expect(p).toContain('2 hop(s) left');
    expect(p).toContain('D:\\T\\dep.md');
    expect(p).toContain('RESULT SUMMARY:');
    expect(p.indexOf(TASK_MARKER)).toBeLessThan(p.indexOf('Reply with the single word OK'));
    expect(p.trimEnd().endsWith('Reply with the single word OK and nothing else.')).toBe(true);
  });

  test('write mode names the worktree and forbids commits and pushes', () => {
    const p = buildPrompt({ ...PRE, mode: 'write-in-worktree', rootMode: 'write-in-worktree', worktree: 'D:\\wt', branch: 'codex/topic', hop: 3 }, 'Fix the typo.');
    expect(p).toContain('MODE: write-in-worktree. Edit files only inside D:\\wt (branch codex/topic)');
    expect(p).toContain('Do not commit, push');
    expect(p).toContain('do not hand off');
  });

  test('inlines prerequisite summaries only when the agent cannot read the vault', () => {
    const p = buildPrompt({ ...PRE, canReadVault: false, inlineDependencySummaries: ['261009-1: found 3 files'] }, 'x');
    expect(p).toContain('found 3 files');
  });
});

describe('hand-off blocks and summaries', () => {
  test('parses up to the limit and strips them from the summary', () => {
    const text = 'Work.\nRESULT SUMMARY: did it.\nHANDOFF\nto: codex\nweight: heavy\nmode: write-in-worktree\nrequest: Refactor the parser.\nSee D:\\notes\\a.md\nEND HANDOFF\nHANDOFF\nrequest: second\nEND HANDOFF\nHANDOFF\nrequest: third\nEND HANDOFF';
    const h = parseHandoffs(text, 2);
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual({ to: 'codex', weight: 'heavy', mode: 'write-in-worktree', request: 'Refactor the parser.\nSee D:\\notes\\a.md' });
    expect(h[1].to).toBe('auto');
    expect(stripHandoffs(text)).toBe('Work.\nRESULT SUMMARY: did it.');
    expect(summarizeResult(text, 500)).toBe('did it.');
  });

  test('ignores an echoed template block', () => {
    expect(parseHandoffs('HANDOFF\nto: auto\nrequest: one paragraph; reference note or file paths instead of pasting content\nEND HANDOFF', 2)).toHaveLength(0);
  });

  test('long outputs are cut to head and tail with a pointer', () => {
    const s = summarizeResult('x'.repeat(5000), 1000, 'D:\\runs\\r.md');
    expect(s.length).toBeLessThan(1100);
    expect(s).toContain('Full output: D:\\runs\\r.md');
  });
});

describe('registry', () => {
  test('parses tasklist CSV', () => {
    expect(parseTasklist('"Claude.exe","1","Console","1","10 K"\r\n"Antigravity IDE.exe","2","Console","1","1 K"\r\n')).toEqual(['claude', 'antigravity ide']);
  });

  test('open-apps detection uses process names', () => {
    const s = detectAgents(['claude', 'hermes', 'cursor'], (id) => (id === 'cursor' ? null : { command: `${id}.exe`, prefixArgs: [], source: 't' }));
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(by.claude.running).toBe(true);
    expect(by.codex.running).toBe(false);
    expect(by.hermes.running).toBe(true);
    expect(by.cursor.installed).toBe(false);
    expect(by.cursor.notes.join(' ')).toContain('cursor.com/install');
  });

  test('role table sync reads README "Who does what"', () => {
    const readme = `# x\n## Who does what (owner rule)\n\n- **Claude Opus 5.5** — hard work that is long to write.\n- **Claude Sonnet 5.5** — hard but short work.\n- **Claude Haiku 4.5** — pure searching and lookups only.\n- **Gemini** — searching and very easy tasks only.\n- **Hermes** and **Cursor** — onboarded, no scope yet.\n\n## Files\n`;
    expect(Object.keys(readRoleTable(readme))).toContain('Claude Haiku 4.5');
    const notes = checkRoleTable(readme);
    expect(notes.some((n) => n.includes('Hermes and Cursor have no scope'))).toBe(true);
    expect(notes.some((n) => n.includes('no Codex entry'))).toBe(true);
    expect(notes.some((n) => n.includes('Opus'))).toBe(false);
  });
});

const CTX = (mode: AdapterContext['mode'], model: string | null = 'sonnet'): AdapterContext => ({
  mode, cwd: 'D:\\wt', model, timeoutSec: 600, runDir: 'D:\\runs\\a', promptText: 'PROMPT', promptFile: 'D:\\runs\\a\\prompt.md', readDirs: ['D:\\vault'],
});
const BIN = { command: 'x.exe', prefixArgs: [], source: 't' };
const outcome = (o: Partial<RunOutcome>): RunOutcome => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, truncated: false, ...o });

describe('adapters', () => {
  test('no adapter ever emits a bypass flag, in any mode', () => {
    for (const a of Object.values(ADAPTERS)) {
      for (const mode of ['read-only', 'write-in-worktree'] as const) {
        const inv = a.build(BIN, CTX(mode, a.id === 'hermes' ? null : 'm'));
        const args = inv.args.filter((x) => x !== 'PROMPT');
        for (const f of FORBIDDEN_FLAGS) expect(args).not.toContain(f);
        expect(args.join(' ')).not.toMatch(/dangerously|bypass|yolo|full-access/i);
      }
    }
  });

  test('read-only uses each CLI read-only mode; write uses the workspace sandbox', () => {
    const c = ADAPTERS.claude.build(BIN, CTX('read-only'));
    expect(c.args).toContain('dontAsk');
    expect(c.args.join(' ')).toContain('--tools Read,Glob,Grep');
    expect(c.args).toContain('--restricted');
    expect(c.args).toContain('--add-dir');
    expect(c.stdin).toBe('PROMPT');
    expect(c.env!.CLAUDECODE).toBeUndefined();
    const cw = ADAPTERS.claude.build(BIN, CTX('write-in-worktree'));
    expect(cw.args).toContain('acceptEdits');
    expect(cw.args).not.toContain('--add-dir');
    expect(ADAPTERS.codex.build(BIN, CTX('read-only')).args.join(' ')).toContain('--sandbox read-only');
    expect(ADAPTERS.codex.build(BIN, CTX('write-in-worktree')).args.join(' ')).toContain('--sandbox workspace-write');
    expect(ADAPTERS.antigravity.build(BIN, CTX('read-only')).args.join(' ')).toContain('--mode plan --sandbox');
    expect(ADAPTERS.antigravity.build(BIN, CTX('write-in-worktree')).args.join(' ')).toContain('--mode accept-edits --sandbox');
    const agy = ADAPTERS.antigravity.build(BIN, CTX('read-only'));
    expect(agy.args[agy.args.length - 1]).toBe('PROMPT');
  });

  test('Hermes never gets a model or provider and never one-shot/YOLO', () => {
    for (const mode of ['read-only', 'write-in-worktree'] as const) {
      const h = ADAPTERS.hermes.build(BIN, CTX(mode, 'some-model'));
      expect(h.args).not.toContain('-m');
      expect(h.args).not.toContain('--model');
      expect(h.args).not.toContain('--provider');
      expect(h.args.join(' ')).not.toContain('some-model');
      expect(h.args.slice(0, 3)).toEqual(['chat', '--query-file', 'D:\\runs\\a\\prompt.md']);
      expect(h.env!.HERMES_YOLO_MODE).toBeUndefined();
    }
    expect(ADAPTERS.hermes.build(BIN, CTX('read-only', null)).args.join(' ')).toContain('-t web,todo');
  });

  test('quota detection per CLI error text', () => {
    expect(detectQuota('Claude AI usage limit reached|1760000000')).toBeTruthy();
    expect(detectQuota("You've hit your usage limit. Upgrade to Pro")).toBeTruthy();
    expect(detectQuota('stream error: 429 Too Many Requests')).toBeTruthy();
    expect(detectQuota('RESOURCE_EXHAUSTED: Quota exceeded for quota metric')).toBeTruthy();
    expect(detectQuota('insufficient_quota')).toBeTruthy();
    expect(detectQuota('TypeError: cannot read properties of undefined')).toBeUndefined();
    const failed = ADAPTERS.claude.parse(outcome({ exitCode: 1, stdout: JSON.stringify({ is_error: true, subtype: 'error', result: "You've hit your limit · resets 5pm" }) }), CTX('read-only'), { command: '', args: [], cwd: '' });
    expect(failed.ok).toBe(false);
    expect(failed.quotaExhausted).toBe(true);
    const ok = ADAPTERS.claude.parse(outcome({ stdout: JSON.stringify({ is_error: false, subtype: 'success', result: 'The rate limit code is fine. OK', total_cost_usd: 0.01 }) }), CTX('read-only'), { command: '', args: [], cwd: '' });
    expect(ok.ok).toBe(true);
    expect(ok.quotaExhausted).toBe(false);
    expect(ok.costUsd).toBe(0.01);
  });

  test('codex parser reads the last message and JSONL errors', () => {
    const r = ADAPTERS.codex.parse(
      outcome({ exitCode: 1, stdout: '{"type":"error","message":"You\'ve hit your usage limit"}\n{"type":"turn.failed","error":{"message":"usage limit"}}\n' }),
      CTX('read-only'),
      { command: '', args: [], cwd: '', lastMessageFile: 'D:\\nonexistent\\x.txt' },
    );
    expect(r.ok).toBe(false);
    expect(r.quotaExhausted).toBe(true);
    const ok = ADAPTERS.codex.parse(outcome({ stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n' }), CTX('read-only'), { command: '', args: [], cwd: '' });
    expect(ok.ok).toBe(true);
    expect(ok.text).toBe('OK');
  });
});
