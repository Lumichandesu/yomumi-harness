/**
 * Configuration: paths, limits, per-agent models and routing chains.
 * Defaults live here; `agent-dispatch.config.json` next to package.json may override
 * models, chains and a few limits. Safety limits are clamped so a config file cannot loosen them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type AgentId = 'claude' | 'codex' | 'antigravity' | 'hermes' | 'cursor';
export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'antigravity', 'hermes', 'cursor'];

export type Mode = 'read-only' | 'write-in-worktree';
export const MODES: Mode[] = ['read-only', 'write-in-worktree'];

/** search = lookups only; easy = trivial edits/docs; short = hard but short; hard = hard and long. */
export type Kind = 'search' | 'easy' | 'short' | 'hard';
export const KINDS: Kind[] = ['search', 'easy', 'short', 'hard'];
export type Weight = 'light' | 'heavy';

export type Status = 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled';
export const TERMINAL: Status[] = ['done', 'failed', 'timeout', 'cancelled'];

export interface Paths {
  home: string;
  runsDir: string;
  commsDir: string;
  tasksDir: string;
  boardFile: string;
  readmeFile: string;
}

export interface Config {
  paths: Paths;
  /** Hard cap on concurrent agent runs across all dispatcher processes (the shared machine-load rule). Max 2. */
  maxConcurrent: number;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  /** Claude weekly usage (percent) at which Claude is moved to the end of every chain. */
  claudeWeeklyThreshold: number;
  /** Maximum hand-off depth below a root task (owner: 3). */
  maxHops: number;
  maxHandoffsPerTask: number;
  maxTasksPerRoot: number;
  autoRunHandoffs: boolean;
  /** Hermes has no file sandbox, so write mode stays off unless the owner enables it. */
  hermesAllowWrite: boolean;
  /** Model per agent and kind. `null` = the CLI's own default. Hermes is always null. */
  models: Record<AgentId, Record<Kind, string | null>>;
  /** Preferred agent order per kind. Cheapest capable agent first. */
  chains: Record<Kind, AgentId[]>;
  /** Extra directories a read-only Claude run may read (Obsidian notes). */
  readDirs: string[];
  /** Notes every agent is told to read before exploring. */
  contextNotes: string[];
  /** Max characters of an agent result stored in the vault task file. */
  summaryMaxChars: number;
}


export function defaultConfig(): Config {
  const home = resolve(process.env.AGENT_DISPATCH_HOME ?? join(import.meta.dir, '..'));
  // The shared notes folder (board, threads, task files). Set AGENT_DISPATCH_COMMS_DIR to your own vault folder.
  const commsDir = resolve(process.env.AGENT_DISPATCH_COMMS_DIR ?? join(home, 'vault', 'Agent-Comms'));
  return {
    paths: {
      home,
      runsDir: resolve(process.env.AGENT_DISPATCH_RUNS_DIR ?? join(home, 'runs')),
      commsDir,
      tasksDir: join(commsDir, 'Tasks'),
      boardFile: join(commsDir, 'Board.md'),
      readmeFile: join(commsDir, 'README.md'),
    },
    maxConcurrent: 2,
    defaultTimeoutSec: 1800,
    maxTimeoutSec: 4 * 3600,
    claudeWeeklyThreshold: 95,
    maxHops: 3,
    maxHandoffsPerTask: 2,
    maxTasksPerRoot: 8,
    autoRunHandoffs: true,
    hermesAllowWrite: false,
    models: {
      claude: { search: 'haiku', easy: 'sonnet', short: 'sonnet', hard: 'opus' },
      antigravity: {
        search: 'gemini-3.8-flash-low',
        easy: 'gemini-3.8-flash-medium',
        short: 'gemini-3.1-pro-low',
        hard: 'gemini-3.1-pro-high',
      },
      codex: { search: null, easy: null, short: null, hard: null },
      cursor: { search: null, easy: null, short: null, hard: null },
      hermes: { search: null, easy: null, short: null, hard: null },
    },
    chains: {
      search: ['claude', 'antigravity', 'hermes', 'codex', 'cursor'],
      easy: ['antigravity', 'claude', 'hermes', 'codex', 'cursor'],
      short: ['claude', 'codex', 'antigravity', 'cursor', 'hermes'],
      hard: ['claude', 'codex', 'antigravity', 'cursor', 'hermes'],
    },
    readDirs: [commsDir],
    contextNotes: [join(commsDir, 'README.md')],
    summaryMaxChars: 1500,
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const cfg = defaultConfig();
  const file = join(cfg.paths.home, 'agent-dispatch.config.json');
  let fromFile: any = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Cannot parse ${file}: ${(e as Error).message}`);
    }
  }
  const merged: Config = {
    ...cfg,
    ...pick(fromFile, ['defaultTimeoutSec', 'maxTimeoutSec', 'claudeWeeklyThreshold', 'autoRunHandoffs', 'summaryMaxChars', 'contextNotes', 'readDirs', 'maxConcurrent', 'maxHops', 'maxHandoffsPerTask', 'maxTasksPerRoot', 'hermesAllowWrite']),
    ...overrides,
    models: mergeModels(cfg.models, fromFile.models, overrides.models),
    chains: { ...cfg.chains, ...(fromFile.chains ?? {}), ...(overrides.chains ?? {}) },
    paths: { ...cfg.paths, ...(overrides.paths ?? {}) },
  };
  // Safety clamps: a config file can tighten these limits but never loosen them.
  merged.maxConcurrent = clamp(merged.maxConcurrent, 1, 2);
  merged.maxHops = clamp(merged.maxHops, 0, 3);
  merged.maxHandoffsPerTask = clamp(merged.maxHandoffsPerTask, 0, 2);
  merged.maxTasksPerRoot = clamp(merged.maxTasksPerRoot, 1, 8);
  merged.models.hermes = { search: null, easy: null, short: null, hard: null };
  return merged;
}

function pick(obj: any, keys: string[]): any {
  const out: any = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function mergeModels(base: Config['models'], ...layers: any[]): Config['models'] {
  const out = structuredClone(base);
  for (const layer of layers) {
    if (!layer) continue;
    for (const agent of Object.keys(layer)) {
      if (!(agent in out)) continue;
      Object.assign((out as any)[agent], layer[agent]);
    }
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return hi;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
