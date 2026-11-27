/**
 * Classification (heavy/light) and routing (which open agent, which model, failover order).
 * Pure functions: callers pass the detected agent statuses, so tests need no real apps.
 */
import type { AgentId, Config, Kind, Mode, Weight } from './config';
import { KINDS } from './config';
import type { AgentStatus } from './registry';

export interface Candidate {
  agent: AgentId;
  model: string | null;
}

export interface Classification {
  kind: Kind;
  weight: Weight;
  reason: string;
}

export const ALIASES: Record<string, Candidate> = {
  claude: { agent: 'claude', model: null },
  'claude-opus': { agent: 'claude', model: 'opus' },
  'claude-sonnet': { agent: 'claude', model: 'sonnet' },
  'claude-haiku': { agent: 'claude', model: 'haiku' },
  opus: { agent: 'claude', model: 'opus' },
  sonnet: { agent: 'claude', model: 'sonnet' },
  haiku: { agent: 'claude', model: 'haiku' },
  codex: { agent: 'codex', model: null },
  antigravity: { agent: 'antigravity', model: null },
  agy: { agent: 'antigravity', model: null },
  gemini: { agent: 'antigravity', model: null },
  hermes: { agent: 'hermes', model: null },
  cursor: { agent: 'cursor', model: null },
  'cursor-agent': { agent: 'cursor', model: null },
};

export function parseTarget(to: string): Candidate | 'auto' {
  const t = (to || 'auto').trim().toLowerCase();
  if (t === 'auto' || t === '') return 'auto';
  const c = ALIASES[t];
  if (!c) throw new Error(`Unknown agent "${to}". Use auto or one of: ${Object.keys(ALIASES).join(', ')}`);
  return { ...c };
}

export function weightOf(kind: Kind): Weight {
  return kind === 'hard' ? 'heavy' : 'light';
}

const SEARCH_RE = /\b(find|search|locate|look ?up|list|where (is|are|do)|grep|which files?|inventory|check whether|is there)\b/i;
const EASY_RE = /\b(typo|spelling|readme|docs?|comment|rename|dead code|unused|lint|format|bump|dependency hygiene|wording)\b/i;
const HEAVY_RE = /\b(implement|build|refactor|architecture|design|security|auth(entication|orization)?|payment|wallet|ledger|migration|end-to-end|audit|rewrite|redesign|investigate|root cause)\b/i;

/**
 * Heavy = hard and long work (strong model). Light = search, easy or hard-but-short (cheapest capable model).
 * The planner (the calling Claude session) should pass weight/kind; the heuristic is only a fallback.
 */
export function classify(prompt: string, mode: Mode, hint: { kind?: Kind | ''; weight?: Weight | '' } = {}): Classification {
  if (hint.kind && KINDS.includes(hint.kind)) {
    const kind = hint.kind === 'search' && mode !== 'read-only' ? 'easy' : hint.kind;
    return { kind, weight: weightOf(kind), reason: kind === hint.kind ? 'given by planner' : 'search tasks are read-only; write work treated as easy' };
  }
  if (hint.weight === 'heavy') return { kind: 'hard', weight: 'heavy', reason: 'given by planner (heavy)' };
  const light = hint.weight === 'light';
  if (!light && (HEAVY_RE.test(prompt) || prompt.length > 2000)) {
    return { kind: 'hard', weight: 'heavy', reason: 'heuristic: heavy keywords or long request' };
  }
  if (mode === 'read-only' && SEARCH_RE.test(prompt) && prompt.length < 1200) {
    return { kind: 'search', weight: 'light', reason: `heuristic: lookup request${light ? ' (planner said light)' : ''}` };
  }
  if (EASY_RE.test(prompt) && prompt.length < 1200) {
    return { kind: 'easy', weight: 'light', reason: `heuristic: easy change${light ? ' (planner said light)' : ''}` };
  }
  return { kind: 'short', weight: 'light', reason: light ? 'given by planner (light)' : 'heuristic: default light (hard but short)' };
}

export function candidateKey(c: Candidate): string {
  return `${c.agent}:${c.model ?? ''}`;
}

export interface RouteRequest {
  to: string;
  model?: string | null;
  kind: Kind;
  mode: Mode;
  urgent?: boolean;
  failover?: boolean;
  claudeWeeklyPercent?: number | null;
  /** Candidate keys already tried for this task (failover). */
  exclude?: Set<string>;
  /** Agent keys of ancestor tasks (hand-off chain). Routing there would be a cycle. */
  ancestors?: Set<string>;
}

export interface RouteResult {
  chosen: Candidate | null;
  /** Remaining usable candidates after `chosen`, in failover order. */
  fallbacks: Candidate[];
  skipped: { agent: string; reason: string }[];
  reason: string;
}

export function modelFor(agent: AgentId, kind: Kind, cfg: Config): string | null {
  if (agent === 'hermes') return null;
  return cfg.models[agent]?.[kind] ?? null;
}

export function validateTargetModel(to: string, model?: string | null): void {
  const t = parseTarget(to);
  if (t !== 'auto' && t.agent === 'hermes' && model) {
    throw new Error('Hermes chooses its own free model and switches it on limits; do not pass a model for Hermes.');
  }
}

export function route(req: RouteRequest, statuses: AgentStatus[], cfg: Config): RouteResult {
  const target = parseTarget(req.to);
  validateTargetModel(req.to, req.model);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const skipped: RouteResult['skipped'] = [];
  const ordered: Candidate[] = [];
  let reason: string;

  if (target !== 'auto') {
    const model = target.agent === 'hermes' ? null : (req.model || target.model || modelFor(target.agent, req.kind, cfg));
    ordered.push({ agent: target.agent, model });
    reason = `explicit target ${req.to}`;
    if (req.failover !== false) {
      for (const a of cfg.chains[req.kind]) if (a !== target.agent) ordered.push({ agent: a, model: modelFor(a, req.kind, cfg) });
    }
  } else {
    for (const a of cfg.chains[req.kind]) ordered.push({ agent: a, model: modelFor(a, req.kind, cfg) });
    reason = `auto: ${req.kind} chain`;
  }
  // Weekly token rule: at or above the threshold, Claude goes last unless the work is urgent.
  // An explicitly named first target is kept first; only the rest of the order changes.
  const weekly = req.claudeWeeklyPercent ?? null;
  if (weekly !== null && weekly >= cfg.claudeWeeklyThreshold && !req.urgent) {
    const head = target === 'auto' ? [] : ordered.slice(0, 1);
    const tail = target === 'auto' ? ordered : ordered.slice(1);
    const claude = tail.filter((c) => c.agent === 'claude');
    const rest = tail.filter((c) => c.agent !== 'claude');
    ordered.splice(0, ordered.length, ...head, ...rest, ...claude);
    reason += `; Claude weekly ${weekly}% >= ${cfg.claudeWeeklyThreshold}%, Claude moved last`;
  }

  const usable: Candidate[] = [];
  for (const c of ordered) {
    const s = byId.get(c.agent);
    const key = candidateKey(c);
    let why: string | null = null;
    if (req.exclude?.has(key) || req.exclude?.has(`${c.agent}:*`)) why = 'already tried for this task';
    else if (req.ancestors?.has(key)) why = 'would hand work back to an agent already in this chain (cycle)';
    else if (!s?.installed) why = c.agent === 'cursor' ? 'cursor-agent CLI not installed' : 'CLI not installed';
    else if (!s.running) why = 'app not open (not launched)';
    else if (c.agent === 'hermes' && req.mode === 'write-in-worktree' && !cfg.hermesAllowWrite) why = 'Hermes has no file sandbox; write mode disabled';
    else if (c.agent === 'claude' && c.model === 'haiku' && req.mode !== 'read-only') why = 'Haiku is search-only (never edits)';
    if (why) {
      if (!skipped.some((x) => x.agent === displayName(c))) skipped.push({ agent: displayName(c), reason: why });
    } else usable.push(c);
  }
  return { chosen: usable[0] ?? null, fallbacks: usable.slice(1), skipped, reason };
}

export function displayName(c: Candidate): string {
  return c.model ? `${c.agent} (${c.model})` : c.agent;
}

/** Kahn's algorithm. Returns the keys that sit on a cycle (empty when the graph is a DAG). */
export function findDependencyCycle(deps: Record<string, string[]>): string[] {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const k of Object.keys(deps)) {
    indeg.set(k, indeg.get(k) ?? 0);
    for (const d of deps[k]) {
      if (!(d in deps)) continue;
      indeg.set(k, (indeg.get(k) ?? 0) + 1);
      out.set(d, [...(out.get(d) ?? []), k]);
    }
  }
  const queue = [...indeg].filter(([, n]) => n === 0).map(([k]) => k);
  const seen = new Set<string>();
  while (queue.length) {
    const k = queue.shift()!;
    seen.add(k);
    for (const n of out.get(k) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  return Object.keys(deps).filter((k) => !seen.has(k));
}
