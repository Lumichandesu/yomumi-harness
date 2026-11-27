/**
 * Agent registry: who exists, where the CLI lives, whether the app is open, and the role table.
 * The role table mirrors the "Who does what" section of the shared README plus the dispatcher's
 * own routing; `checkRoleTable` reports drift between the two.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentId } from './config';
import { AGENT_IDS } from './config';

export interface ResolvedBinary {
  command: string;
  prefixArgs: string[];
  source: string;
}

export interface AgentDef {
  id: AgentId;
  label: string;
  /** Lower-case process image names without `.exe` that mean "the app is open". */
  processNames: string[];
  role: string;
  supportsModel: boolean;
  /** Can the owner register our MCP server in this app? */
  mcp: string;
  installNote?: string;
}

export const AGENTS: Record<AgentId, AgentDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    processNames: ['claude'],
    role: 'Opus = hard and long; Sonnet = hard but short; Haiku = search and lookups only (never code).',
    supportsModel: true,
    mcp: 'yes (claude mcp add --scope user)',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    processNames: ['codex'],
    role: 'Failover for short and hard work.',
    supportsModel: true,
    mcp: 'yes (~/.codex/config.toml [mcp_servers])',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity (agy)',
    processNames: ['antigravity', 'antigravity ide', 'agy'],
    role: 'Gemini = search and easy tasks (docs fixes, dead code, read-only checks).',
    supportsModel: true,
    mcp: 'yes (agy mcp add)',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes (local agent)',
    processNames: ['hermes'],
    role: 'Free models only; Hermes picks and switches its own model. Never pass a model. Uses the Obsidian task inbox.',
    supportsModel: false,
    mcp: 'no MCP client registration; uses the Obsidian task-file inbox',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor (cursor-agent CLI)',
    processNames: ['cursor'],
    role: 'Late failover. Needs the cursor-agent CLI.',
    supportsModel: true,
    mcp: 'yes (~/.cursor/mcp.json)',
    // A docs link only: agents read this note, so it must not hand them a pipe-to-shell command.
    installNote: 'cursor-agent is not installed. A person installs it by hand from https://cursor.com/install (instructions: https://cursor.com/docs/cli/installation).',
  },
};

export interface AgentStatus {
  id: AgentId;
  label: string;
  installed: boolean;
  binary?: string;
  running: boolean;
  processCount: number;
  notes: string[];
}

const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function which(name: string): string | null {
  try {
    return Bun.which(name) ?? null;
  } catch {
    return null;
  }
}

/** Claude Code lives in a version folder that changes on update, so pick the newest each time. */
export function findClaudeBinary(root = join(ROAMING, 'Claude', 'claude-code')): string | null {
  const versions = safeDirs(root).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(compareVersions).reverse();
  for (const v of versions) {
    for (const hash of safeDirs(join(root, v))) {
      const exe = join(root, v, hash, process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

export function findCodexBinary(root = join(LOCAL, 'OpenAI', 'Codex', 'bin')): string | null {
  const candidates = safeDirs(root)
    .map((d) => join(root, d, process.platform === 'win32' ? 'codex.exe' : 'codex'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

export function resolveBinary(id: AgentId): ResolvedBinary | null {
  const override = process.env[`AGENT_DISPATCH_BIN_${id.toUpperCase()}`];
  if (override) return existsSync(override) ? { command: override, prefixArgs: [], source: 'env override' } : null;
  const home = homedir();
  switch (id) {
    case 'claude': {
      const p = findClaudeBinary() ?? which('claude') ?? existing(join(home, '.local', 'bin', 'claude.exe'));
      return p ? { command: p, prefixArgs: [], source: 'Claude desktop version folder (newest)' } : null;
    }
    case 'codex': {
      const p = findCodexBinary() ?? which('codex');
      return p ? { command: p, prefixArgs: [], source: 'Codex app bin folder (newest)' } : null;
    }
    case 'antigravity': {
      const p = existing(join(home, '.gemini', 'bin', 'agy.exe')) ?? which('agy');
      return p ? { command: p, prefixArgs: [], source: '~/.gemini/bin/agy.exe' } : null;
    }
    case 'hermes': {
      const agentDir = join(LOCAL, 'hermes', 'hermes-agent');
      const venv = existing(join(agentDir, '.venv', 'Scripts', 'hermes.exe')) ?? existing(join(agentDir, '.venv', 'bin', 'hermes'));
      if (venv) return { command: venv, prefixArgs: [], source: 'hermes-agent .venv' };
      const uv = existing(join(LOCAL, 'hermes', 'bin', 'uv.exe'));
      if (uv && existsSync(agentDir)) return { command: uv, prefixArgs: ['run', '--project', agentDir, 'hermes'], source: 'uv run (hermes.cmd equivalent)' };
      return null;
    }
    case 'cursor': {
      const p =
        which('cursor-agent') ??
        existing(join(home, '.local', 'bin', 'cursor-agent.exe')) ??
        existing(join(home, '.local', 'bin', 'cursor-agent')) ??
        existing(join(LOCAL, 'cursor-agent', 'cursor-agent.exe')) ??
        existing(join(LOCAL, 'cursor-agent', 'cursor-agent.cmd'));
      return p ? { command: p, prefixArgs: [], source: 'cursor-agent' } : null;
    }
  }
}

function existing(p: string): string | null {
  return existsSync(p) ? p : null;
}

/** Lower-case image names of running processes, without `.exe`. */
export function listProcessNames(): string[] {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      return parseTasklist(r.stdout ?? '');
    }
    const r = spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 15000 });
    return (r.stdout ?? '')
      .split('\n')
      .map((l) => l.trim().split('/').pop()!.toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function parseTasklist(csv: string): string[] {
  const names: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1].toLowerCase().replace(/\.exe$/, ''));
  }
  return names;
}

/** Image name of one pid (Windows), used before killing a pid recorded by another process. */
export function processNameOf(pid: number): string | null {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  return parseTasklist(r.stdout ?? '')[0] ?? null;
}

export function detectAgents(processNames: string[] = listProcessNames(), resolver = resolveBinary): AgentStatus[] {
  return AGENT_IDS.map((id) => {
    const def = AGENTS[id];
    const bin = resolver(id);
    const processCount = processNames.filter((n) => def.processNames.includes(n)).length;
    const notes: string[] = [];
    if (!bin && def.installNote) notes.push(def.installNote);
    if (!bin && !def.installNote) notes.push('CLI not found.');
    if (processCount === 0) notes.push('App not open: skipped by routing (never launched).');
    return {
      id,
      label: def.label,
      installed: !!bin,
      binary: bin ? [bin.command, ...bin.prefixArgs].join(' ') : undefined,
      running: processCount > 0,
      processCount,
      notes,
    };
  });
}

/** README "Who does what" bullets, keyed by the bold name. */
export function readRoleTable(readmeText: string): Record<string, string> {
  const start = readmeText.search(/^##\s+Who does what/m);
  if (start < 0) return {};
  const rest = readmeText.slice(start).split('\n').slice(1);
  const out: Record<string, string> = {};
  for (const line of rest) {
    if (/^##\s/.test(line)) break;
    const m = /^-\s+\*\*(.+?)\*\*\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^[—–-]\s*/, '');
  }
  return out;
}

/** Compare the README role table with what the dispatcher does; returns human-readable drift notes. */
export function checkRoleTable(readmeText: string): string[] {
  const table = readRoleTable(readmeText);
  const notes: string[] = [];
  if (!Object.keys(table).length) return ['README "Who does what" section not found.'];
  const expect: [RegExp, RegExp, string][] = [
    [/Opus/i, /long/i, 'Opus = hard and long'],
    [/Sonnet/i, /short/i, 'Sonnet = hard but short'],
    [/Haiku/i, /search/i, 'Haiku = search only'],
    [/Gemini/i, /search|easy/i, 'Gemini = search and easy'],
  ];
  for (const [name, text, label] of expect) {
    const entry = Object.entries(table).find(([k]) => name.test(k));
    if (!entry) notes.push(`README has no entry for "${label}".`);
    else if (!text.test(entry[1])) notes.push(`README entry for ${entry[0]} no longer says "${label}".`);
  }
  const hermes = Object.entries(table).find(([k]) => /Hermes/i.test(k));
  if (hermes && /no scope|not hand them work|no tasks are assigned/i.test(hermes[1])) {
    notes.push('README still says Hermes and Cursor have no scope, but the dispatcher puts every open app in the pool. Update README "Who does what".');
  }
  if (!Object.keys(table).some((k) => /Codex/i.test(k))) notes.push('README "Who does what" has no Codex entry.');
  return notes;
}

export function readRoleTableFile(readmeFile: string): string[] {
  try {
    return checkRoleTable(readFileSync(readmeFile, 'utf8'));
  } catch {
    return [`Cannot read ${readmeFile}.`];
  }
}
