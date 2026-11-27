#!/usr/bin/env bun
/**
 * Smoke test: one harmless read-only prompt per installed agent whose app is open, run one at a
 * time (machine-load rule). Uses each agent's quota minimally. Closed apps are skipped, never launched.
 *   bun run scripts/smoke.ts --quote "<owner's verbatim words>" [--only claude,codex]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dispatcher } from '../src/dispatcher';
import { appendBoardLine, boardLine } from '../src/taskfile';
import { isAlive } from '../src/util';
import type { AgentId } from '../src/config';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const quote = flag('quote');
if (!quote) {
  console.error('--quote "<owner verbatim authorization>" is required');
  process.exit(2);
}
const only = flag('only')?.split(',');
const PROMPT = 'Reply with the single word OK and nothing else.';
const MODEL: Partial<Record<AgentId, string>> = { claude: 'haiku' };

const d = new Dispatcher();
const statuses = d.agents(true);
const rows: string[] = [];
const ids: string[] = [];
for (const s of statuses) {
  if (only && !only.includes(s.id)) continue;
  if (!s.installed) {
    rows.push(`| ${s.label} | no | ${s.running ? 'yes' : 'no'} | skipped | not installed |`);
    continue;
  }
  if (!s.running) {
    rows.push(`| ${s.label} | yes | no | skipped | app not open: not launched (owner rule) |`);
    continue;
  }
  const started = Date.now();
  let line: string;
  try {
    const doc = d.submitTask(
      { to: s.id, model: MODEL[s.id] ?? null, prompt: PROMPT, cwd: d.cfg.paths.home, mode: 'read-only', ownerQuote: quote, kind: 'search', from: 'smoke-test', failover: false, timeoutSec: 300 },
      { run: true, board: false },
    );
    ids.push(doc.id);
    await d.waitIdle(330000);
    const r = d.result(doc.id);
    const secs = Math.round((Date.now() - started) / 1000);
    const rawFile = join(r.run_log, `attempt-1-${s.id}`, 'result.md');
    const raw = existsSync(rawFile) ? readFileSync(rawFile, 'utf8') : r.summary;
    const ok = r.status === 'done' && /^\s*OK\b/.test(raw);
    line = `| ${s.label} | yes | yes | ${ok ? 'OK' : r.status.toUpperCase()} | ${doc.id}, ${secs}s: ${r.summary.replace(/\s+/g, ' ').slice(0, 140)} |`;
  } catch (e) {
    line = `| ${s.label} | yes | yes | ERROR | ${(e as Error).message.slice(0, 160)} |`;
  }
  rows.push(line);
}

if (ids.length) {
  appendBoardLine(d.cfg.paths.boardFile, boardLine({ what: `smoke test, one read-only "OK" prompt per open agent: tasks ${ids.join(', ')} (task files in Tasks/).` }));
}

// Nothing left behind: every recorded child pid must be gone.
const leftovers: string[] = [];
for (const id of ids) {
  const f = join(d.cfg.paths.runsDir, id, 'runtime.json');
  if (!existsSync(f)) continue;
  const rt = JSON.parse(readFileSync(f, 'utf8'));
  if (rt.childPid && isAlive(rt.childPid)) leftovers.push(`${id}: pid ${rt.childPid}`);
}
console.log('| Agent | Installed | App open | Smoke | Notes |\n| :--- | :--- | :--- | :--- | :--- |');
console.log(rows.join('\n'));
console.log(leftovers.length ? `\nLEFTOVER PROCESSES: ${leftovers.join(', ')}` : '\nNo leftover agent processes.');
process.exit(0);
