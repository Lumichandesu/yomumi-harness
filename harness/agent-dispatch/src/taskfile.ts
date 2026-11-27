/**
 * Task files in Obsidian (`Agent-Comms/Tasks/*.md`) are the canonical queue entries.
 * YAML frontmatter holds the state; the body holds the request, the routing plan, a concise
 * result and a short log. Raw output stays in `runs/<id>/` and is only linked.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Mode, Status } from './config';
import { MODES } from './config';
import { parseFrontmatter, parseSections, renderFrontmatter, type FMData } from './frontmatter';
import { redactSecrets } from './redact';
import { bangkokTime, oneLine, writeFileAtomic } from './util';

export const TASK_TYPE = 'agent-task';

export interface TaskDoc {
  id: string;
  root: string;
  parent: string;
  hop: number;
  plan: string;
  key: string;
  from: string;
  to: string;
  agent: string;
  weight: string;
  kind: string;
  model: string;
  mode: Mode;
  cwd: string;
  topic: string;
  branch: string;
  worktree: string;
  status: Status;
  depends_on: string[];
  owner_quote: string;
  timeout_sec: number;
  urgent: boolean;
  failover: boolean;
  claude_weekly_percent: number | null;
  attempts: number;
  created: string;
  updated: string;
  started: string;
  ended: string;
  run_log: string;
  /** Body sections. */
  request: string;
  routing: string;
  result: string;
  log: string[];
  /** Path of the task file (not stored in frontmatter). */
  file: string;
}

const ORDER = [
  'type', 'id', 'root', 'parent', 'hop', 'plan', 'key', 'from', 'to', 'agent', 'weight', 'kind', 'model', 'mode',
  'cwd', 'topic', 'branch', 'worktree', 'status', 'depends_on', 'owner_quote', 'timeout_sec', 'urgent', 'failover',
  'claude_weekly_percent', 'attempts', 'created', 'updated', 'started', 'ended', 'run_log',
];

export function taskFileName(doc: Pick<TaskDoc, 'id' | 'created' | 'agent' | 'to'>): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(doc.created)?.[0] ?? bangkokTime().date;
  const who = (doc.agent || doc.to || 'auto').replace(/[^a-z0-9-]/gi, '');
  return `${date}_${doc.id}_${who}.md`;
}

export function renderTask(doc: TaskDoc): string {
  const data: FMData = { type: TASK_TYPE };
  for (const k of ORDER) {
    if (k === 'type') continue;
    const v = (doc as any)[k];
    data[k] = v === undefined ? '' : v;
  }
  if (data.claude_weekly_percent === null) data.claude_weekly_percent = '';
  const title = `# Task ${doc.id}: ${oneLine(doc.request, 70)}`;
  const body = [
    title,
    '',
    '## Request',
    demote(redactSecrets(doc.request.trim())),
    '',
    '## Routing',
    doc.routing.trim() || '(not routed yet)',
    '',
    '## Result',
    demote(doc.result.trim()) || '(pending)',
    '',
    '## Log',
    ...(doc.log.length ? doc.log.map((l) => `- ${l}`) : ['- (empty)']),
    '',
  ].join('\n');
  return renderFrontmatter(data, ORDER) + '\n' + body;
}

/** Keep user text from creating new ## sections that would break parsing. */
function demote(text: string): string {
  return text.replace(/^##(?=\s)/gm, '###');
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/** Parse a task file. Returns null for notes that are not agent tasks. */
export function parseTask(text: string, file: string): TaskDoc | null {
  const fm = parseFrontmatter(text);
  if (!fm || fm.data.type !== TASK_TYPE) return null;
  const d = fm.data;
  const sections = parseSections(fm.body);
  const mode = str(d.mode) as Mode;
  const weekly = d.claude_weekly_percent;
  return {
    id: str(d.id),
    root: str(d.root),
    parent: str(d.parent),
    hop: Number(d.hop) || 0,
    plan: str(d.plan),
    key: str(d.key),
    from: str(d.from) || 'owner',
    to: str(d.to) || 'auto',
    agent: str(d.agent),
    weight: str(d.weight),
    kind: str(d.kind),
    model: str(d.model),
    mode: MODES.includes(mode) ? mode : ('' as Mode),
    cwd: str(d.cwd),
    topic: str(d.topic),
    branch: str(d.branch),
    worktree: str(d.worktree),
    status: (str(d.status) || 'queued') as Status,
    depends_on: Array.isArray(d.depends_on) ? d.depends_on.map(String) : str(d.depends_on) ? str(d.depends_on).split(/[,\s]+/).filter(Boolean) : [],
    owner_quote: str(d.owner_quote),
    timeout_sec: Number(d.timeout_sec) || 0,
    urgent: d.urgent === true,
    failover: d.failover !== false,
    claude_weekly_percent: typeof weekly === 'number' ? weekly : null,
    attempts: Number(d.attempts) || 0,
    created: str(d.created),
    updated: str(d.updated),
    started: str(d.started),
    ended: str(d.ended),
    run_log: str(d.run_log),
    request: sections['Request'] ?? str(d.request),
    routing: sections['Routing'] ?? '',
    result: sections['Result'] === '(pending)' ? '' : sections['Result'] ?? '',
    log: (sections['Log'] ?? '')
      .split('\n')
      .map((l) => l.replace(/^-\s*/, '').trim())
      .filter((l) => l && l !== '(empty)'),
    file,
  };
}

export function readTask(file: string): TaskDoc | null {
  try {
    return parseTask(readFileSync(file, 'utf8'), file);
  } catch {
    return null;
  }
}

export function writeTask(doc: TaskDoc): void {
  doc.updated = bangkokTime().iso;
  writeFileAtomic(doc.file, renderTask(doc));
}

export function listTaskFiles(tasksDir: string): string[] {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map((f) => join(tasksDir, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export function scanTasks(tasksDir: string): TaskDoc[] {
  const out: TaskDoc[] = [];
  for (const f of listTaskFiles(tasksDir)) {
    const t = readTask(f);
    if (t) out.push(t);
  }
  return out;
}

export function findTaskFile(tasksDir: string, id: string): string | null {
  const files = listTaskFiles(tasksDir);
  const byName = files.find((f) => basename(f).includes(`_${id}_`));
  if (byName) return byName;
  for (const f of files) if (readTask(f)?.id === id) return f;
  return null;
}

export function appendBoardLine(boardFile: string, line: string): void {
  let prefix = '';
  try {
    const cur = readFileSync(boardFile, 'utf8');
    if (cur.length && !cur.endsWith('\n')) prefix = '\n';
  } catch {}
  appendFileSync(boardFile, `${prefix}${redactSecrets(line)}\n`, 'utf8');
}

export function boardLine(t: { time?: string; what: string }): string {
  const now = bangkokTime();
  return `- ${now.date} ${t.time ?? now.time} (Asia/Bangkok) — agent-dispatch: ${t.what}`;
}

export function logLine(text: string): string {
  const now = bangkokTime();
  return `${now.date} ${now.time} ${redactSecrets(text)}`;
}
