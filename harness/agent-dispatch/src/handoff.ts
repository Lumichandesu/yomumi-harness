/**
 * Hand-off blocks and result summaries.
 * A HANDOFF block is the only structured thing the dispatcher reads from an agent's reply, and every
 * field is validated and capped (hop limit, cycle check, mode ceiling, same owner quote).
 */
import type { Mode, Weight } from './config';
import { redactSecrets } from './redact';

export interface HandoffRequest {
  to: string;
  weight: Weight | '';
  mode: Mode | '';
  request: string;
}

const BLOCK_RE = /^[ \t>*`]*HANDOFF[ \t]*$([\s\S]*?)^[ \t>*`]*END HANDOFF[ \t]*$/gm;
const KEYS = ['to', 'weight', 'mode', 'request'];

export function parseHandoffs(text: string, max: number): HandoffRequest[] {
  const out: HandoffRequest[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const fields: Record<string, string> = {};
    let current: string | null = null;
    for (const rawLine of m[1].split(/\r?\n/)) {
      const line = rawLine.replace(/^[ \t>]*/, '');
      const kv = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line);
      if (kv && KEYS.includes(kv[1].toLowerCase())) {
        current = kv[1].toLowerCase();
        fields[current] = kv[2].replace(/\s{2,}\(.*\)\s*$/, '').trim();
      } else if (current === 'request' && line.trim()) {
        fields.request += `\n${line.trim()}`;
      }
    }
    // Skip empty blocks and an echoed copy of the preamble's template.
    if (!fields.request?.trim() || /^one paragraph; reference note/i.test(fields.request.trim())) continue;
    const weight = (fields.weight ?? '').toLowerCase();
    const mode = (fields.mode ?? '').toLowerCase();
    out.push({
      to: (fields.to || 'auto').split(/\s+/)[0].toLowerCase(),
      weight: weight === 'heavy' || weight === 'light' ? weight : '',
      mode: mode === 'read-only' || mode === 'write-in-worktree' ? mode : '',
      request: fields.request.trim().slice(0, 4000),
    });
    if (out.length >= max) break;
  }
  return out;
}

export function stripHandoffs(text: string): string {
  return text.replace(BLOCK_RE, '').trim();
}

/**
 * Concise, redacted summary for the vault. Prefers the agent's own "RESULT SUMMARY:" section;
 * otherwise keeps the head and tail of the reply and points to the full output file.
 */
export function summarizeResult(text: string, maxChars: number, fullPath?: string): string {
  const clean = redactSecrets(stripHandoffs(text ?? '')).trim();
  if (!clean) return '(no output)';
  const idx = clean.search(/RESULT SUMMARY\s*:/i);
  let summary = idx >= 0 ? clean.slice(idx).replace(/^RESULT SUMMARY\s*:\s*/i, '').trim() : clean;
  if (summary.length > maxChars) {
    const head = Math.floor(maxChars * 0.75);
    const tailLen = Math.floor(maxChars * 0.2);
    summary = `${summary.slice(0, head).trimEnd()}\n…\n${summary.slice(-tailLen).trimStart()}`;
    if (fullPath) summary += `\n(Truncated. Full output: ${fullPath})`;
  }
  return summary;
}
