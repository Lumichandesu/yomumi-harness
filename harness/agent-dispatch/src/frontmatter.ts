/**
 * Minimal YAML frontmatter + Markdown section handling for task files.
 * Supports what task files need: scalars, quoted strings, inline lists and `- item` lists.
 * Rendering always writes double-quoted JSON strings, which are valid YAML.
 */

export type FMValue = string | number | boolean | null | string[];
export type FMData = Record<string, FMValue>;

export function parseFrontmatter(text: string): { data: FMData; body: string } | null {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end < 0) return null;
  const afterClose = src.indexOf('\n', end + 4);
  const head = src.slice(4, end);
  const body = afterClose < 0 ? '' : src.slice(afterClose + 1);
  const data: FMData = {};
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (raw === '' || raw === '|' || raw === '>') {
      // Block list (`- item` lines) or block scalar.
      const items: string[] = [];
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || /^-\s/.test(lines[j]))) {
        const li = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (li && raw === '') items.push(String(parseScalar(li[1].trim()) ?? ''));
        else block.push(lines[j].replace(/^\s{2}/, ''));
        j++;
      }
      if (items.length) data[key] = items;
      else if (block.length) data[key] = raw === '>' ? block.join(' ').trim() : block.join('\n');
      else data[key] = '';
      i = j - 1;
      continue;
    }
    data[key] = raw.startsWith('[') ? parseInlineList(raw) : parseScalar(raw);
  }
  return { data, body };
}

function parseScalar(raw: string): FMValue {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^"|"$/g, '');
    }
  }
  if (raw.startsWith("'")) return raw.replace(/^'|'$/g, '').replace(/''/g, "'");
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
  if (!inner) return [];
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') {
        cur += inner[++i] ?? '';
      } else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((s) => String(parseScalar(s) ?? '')).filter((s) => s !== '');
}

export function renderFrontmatter(data: FMData, order: string[] = []): string {
  const keys = [...order.filter((k) => k in data), ...Object.keys(data).filter((k) => !order.includes(k))];
  const lines = ['---'];
  for (const k of keys) lines.push(`${k}: ${renderValue(data[k])}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

function renderValue(v: FMValue): string {
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(String(s))).join(', ')}]`;
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Split a Markdown body into `## Title` sections. Text before the first heading goes under ''. */
export function parseSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let title = '';
  let buf: string[] = [];
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      out[title] = buf.join('\n').trim();
      title = m[1];
      buf = [];
    } else buf.push(line);
  }
  out[title] = buf.join('\n').trim();
  if (!out['']) delete out[''];
  return out;
}
