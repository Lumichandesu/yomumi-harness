/**
 * Small shared helpers: Bangkok time, ids, slugs, atomic writes, process liveness.
 */
import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface BangkokTime {
  date: string; // 2026-10-09
  time: string; // 01:30
  iso: string; // 2026-10-09T01:30:12+07:00
  compact: string; // 261009-013012
}

export function bangkokTime(d: Date = new Date()): BangkokTime {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    time: `${p.hour}:${p.minute}`,
    iso: `${date}T${p.hour}:${p.minute}:${p.second}+07:00`,
    compact: `${p.year.slice(2)}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`,
  };
}

/** Task id such as `261009-013012-ab12`: sortable, readable, unique enough per machine. */
export function newId(d: Date = new Date()): string {
  return `${bangkokTime(d).compact}-${randomBytes(2).toString('hex')}`;
}

export const ID_RE = /^\d{6}-\d{6}-[0-9a-f]{4}$/;

export function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'task';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write via temp file + rename so readers never see a half-written file. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, content, 'utf8');
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch {
      // Obsidian or an indexer may hold the file briefly on Windows.
      Bun.sleepSync(40 * (i + 1));
    }
  }
  writeFileSync(path, content, 'utf8');
  try {
    unlinkSync(tmp);
  } catch {}
}

export function isAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function oneLine(text: string, max = 80): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}
