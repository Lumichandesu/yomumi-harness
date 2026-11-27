/**
 * The dispatcher: validates and routes tasks, writes them to Obsidian, runs them under the
 * concurrency gate, fails over on quota/limit errors, records results, and creates hand-off tasks.
 * Obsidian task files are the source of truth; `runs/<id>/` holds raw output and runtime pids.
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { AgentId, Config, Kind, Mode, Status, Weight } from './config';
import { KINDS, MODES, TERMINAL, loadConfig } from './config';
import { ADAPTERS, type Adapter, type AdapterContext } from './adapters';
import { ConcurrencyGate, type Release } from './gate';
import { parseHandoffs, summarizeResult } from './handoff';
import { buildPrompt, type PreambleInput } from './preamble';
import { redactSecrets } from './redact';
import { AGENTS, detectAgents, processNameOf, resolveBinary, type AgentStatus, type ResolvedBinary } from './registry';
import { candidateKey, classify, displayName, findDependencyCycle, parseTarget, route, validateTargetModel, type Classification, type RouteResult } from './routing';
import { killTree, runProcess, type RunOutcome, type RunSpec } from './runner';
import { appendBoardLine, boardLine, findTaskFile, logLine, readTask, renderTask, scanTasks, taskFileName, writeTask, type TaskDoc } from './taskfile';
import { ID_RE, bangkokTime, isAlive, newId, oneLine, sleep, writeFileAtomic } from './util';
import { createWorktree, removeIfPristine, worktreeChanges, type Worktree } from './worktree';

export interface SubmitSpec {
  to?: string;
  prompt: string;
  cwd: string;
  mode: Mode;
  ownerQuote: string;
  model?: string | null;
  kind?: Kind | '';
  weight?: Weight | '';
  topic?: string;
  timeoutSec?: number;
  from?: string;
  parentId?: string;
  dependsOn?: string[];
  urgent?: boolean;
  failover?: boolean;
  claudeWeeklyPercent?: number | null;
}

export interface PlanTaskSpec {
  key: string;
  to?: string;
  prompt: string;
  cwd: string;
  mode: Mode;
  model?: string | null;
  kind?: Kind | '';
  weight?: Weight | '';
  topic?: string;
  timeoutSec?: number;
  dependsOn?: string[];
  failover?: boolean;
}

export interface PlanSpec {
  ownerQuote: string;
  from?: string;
  claudeWeeklyPercent?: number | null;
  urgent?: boolean;
  tasks: PlanTaskSpec[];
}

export interface PlanRow {
  key: string;
  id?: string;
  summary: string;
  weight: Weight | '';
  kind: Kind | '';
  classification: string;
  agent: string;
  mode: Mode | '';
  dependsOn: string[];
  fallbacks: string[];
  skipped: string[];
  error?: string;
}

export interface DispatcherOptions {
  config?: Config;
  detect?: () => AgentStatus[];
  resolveBinary?: (id: AgentId) => ResolvedBinary | null;
  adapters?: Partial<Record<AgentId, Adapter>>;
  gate?: ConcurrencyGate;
  run?: (spec: RunSpec, signal?: AbortSignal) => Promise<RunOutcome>;
  createWorktree?: typeof createWorktree;
  log?: (msg: string) => void;
  cacheMs?: number;
  pollMs?: number;
}

const MIN_QUOTE = 8;

export class Dispatcher {
  readonly cfg: Config;
  readonly gate: ConcurrencyGate;
  private readonly detectFn: () => AgentStatus[];
  private readonly resolveFn: (id: AgentId) => ResolvedBinary | null;
  private readonly adapters: Record<AgentId, Adapter>;
  private readonly runFn: (spec: RunSpec, signal?: AbortSignal) => Promise<RunOutcome>;
  private readonly createWt: typeof createWorktree;
  private readonly log: (msg: string) => void;
  private readonly cacheMs: number;
  private readonly pollMs: number;
  private cache?: { at: number; value: AgentStatus[] };
  private readonly running = new Map<string, { ctrl: AbortController; promise: Promise<TaskDoc | null> }>();
  private stopReason: string | null = null;

  constructor(opts: DispatcherOptions = {}) {
    this.cfg = opts.config ?? loadConfig();
    this.detectFn = opts.detect ?? (() => detectAgents());
    this.resolveFn = opts.resolveBinary ?? resolveBinary;
    this.adapters = { ...ADAPTERS, ...(opts.adapters ?? {}) } as Record<AgentId, Adapter>;
    this.runFn = opts.run ?? runProcess;
    this.createWt = opts.createWorktree ?? createWorktree;
    this.log = opts.log ?? ((m) => process.stderr.write(`[agent-dispatch] ${m}\n`));
    this.cacheMs = opts.cacheMs ?? 3000;
    this.pollMs = opts.pollMs ?? 1500;
    this.gate = opts.gate ?? new ConcurrencyGate({ max: this.cfg.maxConcurrent, dir: join(this.cfg.paths.runsDir, '.slots') });
    mkdirSync(this.cfg.paths.runsDir, { recursive: true });
    mkdirSync(this.cfg.paths.tasksDir, { recursive: true });
  }

  // ---------------------------------------------------------------- detection

  agents(fresh = false): AgentStatus[] {
    if (!fresh && this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.value;
    const value = this.detectFn();
    this.cache = { at: Date.now(), value };
    return value;
  }

  // ---------------------------------------------------------------- lookup

  load(id: string): TaskDoc {
    const file = findTaskFile(this.cfg.paths.tasksDir, id);
    const doc = file ? readTask(file) : null;
    if (!doc) throw new Error(`Task ${id} not found in ${this.cfg.paths.tasksDir}`);
    return doc;
  }

  tryLoad(id: string): TaskDoc | null {
    try {
      return this.load(id);
    } catch {
      return null;
    }
  }

  runDir(id: string): string {
    return join(this.cfg.paths.runsDir, id);
  }

  listTasks(limit = 20): TaskDoc[] {
    return scanTasks(this.cfg.paths.tasksDir)
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- validation

  private validateBase(spec: { prompt: string; cwd: string; mode: Mode; ownerQuote: string; to?: string; model?: string | null; kind?: string; timeoutSec?: number }): void {
    if (!spec.prompt || !spec.prompt.trim()) throw new Error('prompt is required');
    if (spec.prompt.length > 200_000) throw new Error('prompt is too long (max 200000 characters); pass note paths instead');
    if (!MODES.includes(spec.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    if (!spec.cwd || !isAbsolute(spec.cwd)) throw new Error('cwd must be an absolute path');
    if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) throw new Error(`cwd does not exist: ${spec.cwd}`);
    if (!spec.ownerQuote || spec.ownerQuote.trim().length < MIN_QUOTE) throw new Error("owner_quote is required: the owner's verbatim authorization");
    if (spec.kind && !KINDS.includes(spec.kind as Kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
    parseTarget(spec.to ?? 'auto');
    validateTargetModel(spec.to ?? 'auto', spec.model);
    const t = spec.timeoutSec ?? this.cfg.defaultTimeoutSec;
    if (!Number.isFinite(t) || t < 30 || t > this.cfg.maxTimeoutSec) throw new Error(`timeout must be between 30 and ${this.cfg.maxTimeoutSec} seconds`);
  }

  /** Ancestor chain of a task, parent first. */
  private ancestry(doc: { parent: string }): TaskDoc[] {
    const chain: TaskDoc[] = [];
    let parentId = doc.parent;
    const seen = new Set<string>();
    while (parentId && chain.length < 10) {
      if (seen.has(parentId)) throw new Error(`hand-off chain loops through ${parentId}`);
      seen.add(parentId);
      const p = this.tryLoad(parentId);
      if (!p) throw new Error(`parent task ${parentId} not found`);
      chain.push(p);
      parentId = p.parent;
    }
    return chain;
  }

  private ancestorKeys(doc: { parent: string }): Set<string> {
    return new Set(this.ancestry(doc).map((d) => `${d.agent}:${d.model}`));
  }

  /** Hand-off rules: hop limit, same owner quote, mode ceiling, cwd, per-root task cap. */
  private handoffContext(parentId: string, spec: { ownerQuote: string; mode: Mode; cwd: string }): { root: TaskDoc; hop: number; ancestors: Set<string> } {
    const parent = this.tryLoad(parentId);
    if (!parent) throw new Error(`parent task ${parentId} not found`);
    const chain = [parent, ...this.ancestry(parent)];
    const root = chain[chain.length - 1];
    const hop = parent.hop + 1;
    if (hop > this.cfg.maxHops) throw new Error(`hand-off limit reached: at most ${this.cfg.maxHops} hand-offs per root task (${root.id})`);
    if (spec.ownerQuote.trim() !== root.owner_quote.trim()) throw new Error('the owner quote must be carried unchanged from the root task');
    if (root.mode === 'read-only' && spec.mode !== 'read-only') throw new Error('a hand-off cannot exceed the root task mode (read-only)');
    if (spec.cwd !== parent.cwd && spec.cwd !== root.cwd) throw new Error('a hand-off must use the cwd of its parent or root task');
    const count = scanTasks(this.cfg.paths.tasksDir).filter((t) => (t.root || t.id) === root.id).length;
    if (count >= this.cfg.maxTasksPerRoot) throw new Error(`root task ${root.id} already has ${count} tasks (max ${this.cfg.maxTasksPerRoot})`);
    return { root, hop, ancestors: new Set(chain.map((d) => `${d.agent}:${d.model}`)) };
  }

  private routeFor(
    spec: { to?: string; model?: string | null; mode: Mode; urgent?: boolean; failover?: boolean; claudeWeeklyPercent?: number | null },
    cls: Classification,
    ancestors: Set<string>,
    statuses: AgentStatus[],
  ): RouteResult {
    const r = route(
      { to: spec.to ?? 'auto', model: spec.model, kind: cls.kind, mode: spec.mode, urgent: spec.urgent, failover: spec.failover, claudeWeeklyPercent: spec.claudeWeeklyPercent, ancestors },
      statuses,
      this.cfg,
    );
    const target = parseTarget(spec.to ?? 'auto');
    if (target !== 'auto' && ancestors.size) {
      const model = target.agent === 'hermes' ? null : spec.model || target.model || this.cfg.models[target.agent][cls.kind];
      if (ancestors.has(candidateKey({ agent: target.agent, model }))) {
        throw new Error(`hand-off cycle: ${displayName({ agent: target.agent, model })} is already in this task's chain`);
      }
    }
    return r;
  }

  private routingText(cls: Classification, r: RouteResult): string {
    return [
      `- Weight: **${cls.weight}** (${cls.kind}): ${cls.reason}`,
      `- Planned agent: ${r.chosen ? displayName(r.chosen) : 'none'} (${r.reason})`,
      `- Failover order: ${r.fallbacks.length ? r.fallbacks.map(displayName).join(' → ') : 'none'}`,
      `- Skipped: ${r.skipped.length ? r.skipped.map((s) => `${s.agent}: ${s.reason}`).join('; ') : 'none'}`,
    ].join('\n');
  }

  // ---------------------------------------------------------------- submit

  submitTask(spec: SubmitSpec, opts: { run?: boolean; planId?: string; key?: string; board?: boolean } = {}): TaskDoc {
    this.validateBase(spec);
    let hop = 0;
    let rootId = '';
    let ancestors = new Set<string>();
    if (spec.parentId) {
      const h = this.handoffContext(spec.parentId, spec);
      hop = h.hop;
      rootId = h.root.id;
      ancestors = h.ancestors;
    }
    for (const dep of spec.dependsOn ?? []) if (!this.tryLoad(dep)) throw new Error(`dependency ${dep} not found`);
    const cls = classify(spec.prompt, spec.mode, { kind: spec.kind, weight: spec.weight });
    const r = this.routeFor(spec, cls, ancestors, this.agents());
    if (!r.chosen) {
      throw new Error(`No open agent can take this task. Skipped: ${r.skipped.map((s) => `${s.agent} (${s.reason})`).join('; ') || 'none'}`);
    }
    const id = newId();
    const now = bangkokTime();
    const from = spec.from || 'owner';
    const doc: TaskDoc = {
      id,
      root: rootId || id,
      parent: spec.parentId ?? '',
      hop,
      plan: opts.planId ?? '',
      key: opts.key ?? '',
      from,
      to: (spec.to || 'auto').toLowerCase(),
      agent: r.chosen.agent,
      weight: cls.weight,
      kind: cls.kind,
      model: r.chosen.model ?? '',
      mode: spec.mode,
      cwd: spec.cwd,
      topic: spec.topic || oneLine(spec.prompt, 40),
      branch: '',
      worktree: '',
      status: 'queued',
      depends_on: spec.dependsOn ?? [],
      owner_quote: redactSecrets(spec.ownerQuote.trim()),
      timeout_sec: spec.timeoutSec ?? this.cfg.defaultTimeoutSec,
      urgent: !!spec.urgent,
      failover: spec.failover !== false,
      claude_weekly_percent: spec.claudeWeeklyPercent ?? null,
      attempts: 0,
      created: now.iso,
      updated: now.iso,
      started: '',
      ended: '',
      run_log: this.runDir(id),
      request: redactSecrets(spec.prompt.trim()),
      routing: this.routingText(cls, r),
      result: '',
      log: [logLine(`queued by ${from} → ${displayName(r.chosen)}, ${cls.weight}, ${spec.mode}${spec.parentId ? `, hand-off hop ${hop} from ${spec.parentId}` : ''}`)],
      file: '',
    };
    doc.file = join(this.cfg.paths.tasksDir, taskFileName(doc));
    mkdirSync(this.runDir(id), { recursive: true });
    writeTask(doc);
    if (opts.board !== false) {
      appendBoardLine(
        this.cfg.paths.boardFile,
        boardLine({
          what:
            `task [[Tasks/${basename(doc.file, '.md')}|${id}]] queued: ${from} → ${displayName(r.chosen)}, ${cls.weight}, ${spec.mode}, ` +
            `cwd \`${spec.cwd}\`${spec.parentId ? `, hand-off from ${spec.parentId}` : ''}. Status lives in the task file.`,
        }),
      );
    }
    if (opts.run !== false) this.start(id);
    return doc;
  }

  // ---------------------------------------------------------------- plans

  previewPlan(plan: PlanSpec): { previewId: string; rows: PlanRow[]; table: string; errors: string[] } {
    const errors: string[] = [];
    const keys = new Set<string>();
    if (!plan.tasks?.length) errors.push('plan has no tasks');
    if (!plan.ownerQuote || plan.ownerQuote.trim().length < MIN_QUOTE) errors.push("owner_quote is required: the owner's verbatim authorization");
    for (const t of plan.tasks ?? []) {
      if (!t.key) errors.push('every task needs a key');
      else if (keys.has(t.key)) errors.push(`duplicate key ${t.key}`);
      keys.add(t.key);
    }
    const deps: Record<string, string[]> = {};
    for (const t of plan.tasks ?? []) {
      deps[t.key] = t.dependsOn ?? [];
      for (const d of t.dependsOn ?? []) if (!keys.has(d)) errors.push(`${t.key} depends on unknown key ${d}`);
    }
    const cyc = findDependencyCycle(deps);
    if (cyc.length) errors.push(`dependency cycle between: ${cyc.join(', ')}`);
    const statuses = this.agents(true);
    const rows: PlanRow[] = (plan.tasks ?? []).map((t) => {
      const row: PlanRow = { key: t.key, summary: oneLine(t.prompt ?? '', 60), weight: '', kind: '', classification: '', agent: '', mode: t.mode, dependsOn: t.dependsOn ?? [], fallbacks: [], skipped: [] };
      try {
        this.validateBase({ ...t, ownerQuote: plan.ownerQuote });
        const cls = classify(t.prompt, t.mode, { kind: t.kind, weight: t.weight });
        row.weight = cls.weight;
        row.kind = cls.kind;
        row.classification = cls.reason;
        const r = this.routeFor({ ...t, urgent: plan.urgent, claudeWeeklyPercent: plan.claudeWeeklyPercent }, cls, new Set(), statuses);
        row.agent = r.chosen ? displayName(r.chosen) : '';
        row.fallbacks = r.fallbacks.map(displayName);
        row.skipped = r.skipped.map((s) => `${s.agent}: ${s.reason}`);
        if (!r.chosen) row.error = 'no open agent can take this task';
      } catch (e) {
        row.error = (e as Error).message;
      }
      if (row.error) errors.push(`${t.key}: ${row.error}`);
      return row;
    });
    const previewId = newId();
    const dir = join(this.cfg.paths.runsDir, 'previews');
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${previewId}.json`), JSON.stringify({ created: new Date().toISOString(), plan, rows }, null, 2));
    return { previewId, rows, table: renderPlanTable(rows, statuses), errors };
  }

  loadPreview(previewId: string): PlanSpec {
    if (!ID_RE.test(previewId)) throw new Error('invalid preview_id');
    const file = join(this.cfg.paths.runsDir, 'previews', `${previewId}.json`);
    if (!existsSync(file)) throw new Error(`preview ${previewId} not found; call preview_plan first`);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - Date.parse(saved.created) > 24 * 3600 * 1000) throw new Error('preview is older than 24 hours; preview again');
    return saved.plan as PlanSpec;
  }

  dispatchPlan(plan: PlanSpec, opts: { run?: boolean } = {}): { planId: string; planFile: string; table: string; tasks: { key: string; id: string; file: string; agent: string; weight: string }[] } {
    const preview = this.previewPlan(plan);
    if (preview.errors.length) throw new Error(`Plan rejected:\n- ${preview.errors.join('\n- ')}\n\n${preview.table}`);
    const planId = newId();
    const order = topoOrder(plan.tasks);
    const idByKey = new Map<string, string>();
    const created: TaskDoc[] = [];
    for (const t of order) {
      const doc = this.submitTask(
        {
          to: t.to,
          prompt: t.prompt,
          cwd: t.cwd,
          mode: t.mode,
          model: t.model,
          kind: t.kind,
          weight: t.weight,
          topic: t.topic,
          timeoutSec: t.timeoutSec,
          failover: t.failover,
          ownerQuote: plan.ownerQuote,
          from: plan.from,
          urgent: plan.urgent,
          claudeWeeklyPercent: plan.claudeWeeklyPercent,
          dependsOn: (t.dependsOn ?? []).map((k) => idByKey.get(k)!),
        },
        { run: false, planId, key: t.key, board: false },
      );
      idByKey.set(t.key, doc.id);
      created.push(doc);
    }
    for (const row of preview.rows) row.id = idByKey.get(row.key);
    const table = renderPlanTable(preview.rows, this.agents());
    const planFile = this.writePlanFile(planId, plan, created, table);
    const heavy = created.filter((d) => d.weight === 'heavy').length;
    appendBoardLine(
      this.cfg.paths.boardFile,
      boardLine({
        what:
          `plan [[Tasks/${basename(planFile, '.md')}|${planId}]] queued by ${plan.from || 'owner'}: ${created.length} sub-task(s) ` +
          `(${heavy} heavy, ${created.length - heavy} light) → ${[...new Set(created.map((d) => d.agent))].join(', ')}. Status lives in the task files.`,
      }),
    );
    if (opts.run !== false) for (const d of created) this.start(d.id);
    return {
      planId,
      planFile,
      table,
      tasks: created.map((d) => ({ key: d.key, id: d.id, file: d.file, agent: displayName({ agent: d.agent as AgentId, model: d.model || null }), weight: d.weight })),
    };
  }

  private writePlanFile(planId: string, plan: PlanSpec, docs: TaskDoc[], table: string): string {
    const now = bangkokTime();
    const file = join(this.cfg.paths.tasksDir, `${now.date}_${planId}_plan.md`);
    const body = [
      '---',
      'type: "agent-plan"',
      `id: ${JSON.stringify(planId)}`,
      `from: ${JSON.stringify(plan.from || 'owner')}`,
      `owner_quote: ${JSON.stringify(redactSecrets(plan.ownerQuote.trim()))}`,
      `created: ${JSON.stringify(now.iso)}`,
      `tasks: [${docs.map((d) => JSON.stringify(d.id)).join(', ')}]`,
      '---',
      '',
      `# Plan ${planId}`,
      '',
      '## Sub-tasks (heavy/light shown before the run)',
      table,
      '',
      '## Task files',
      ...docs.map((d) => `- ${d.key}: [[Tasks/${basename(d.file, '.md')}|${d.id}]]`),
      '',
    ].join('\n');
    writeFileAtomic(file, body);
    return file;
  }

  // ---------------------------------------------------------------- queue (Obsidian inbox)

  /**
   * Pick up queued task files (written by the dispatcher, another agent, Hermes or the owner),
   * normalise them, and run them. `dryRun` only returns the heavy/light table.
   */
  async runQueue(opts: { dryRun?: boolean; wait?: boolean } = {}): Promise<{ rows: PlanRow[]; table: string; started: string[]; rejected: string[] }> {
    const statuses = this.agents(true);
    const docs = scanTasks(this.cfg.paths.tasksDir).filter((d) => d.status === 'queued' && !this.running.has(d.id) && !this.claimedElsewhere(d.id));
    const rows: PlanRow[] = [];
    const accepted: TaskDoc[] = [];
    const rejected: string[] = [];
    for (const doc of docs) {
      const row: PlanRow = { key: doc.key || basename(doc.file), id: doc.id, summary: oneLine(doc.request, 60), weight: '', kind: '', classification: '', agent: '', mode: doc.mode, dependsOn: doc.depends_on, fallbacks: [], skipped: [] };
      try {
        const handWritten = !ID_RE.test(doc.id) || !doc.agent;
        if (!ID_RE.test(doc.id)) doc.id = newId();
        if (!doc.created) doc.created = bangkokTime().iso;
        if (!doc.timeout_sec) doc.timeout_sec = this.cfg.defaultTimeoutSec;
        this.validateBase({ prompt: doc.request, cwd: doc.cwd, mode: doc.mode, ownerQuote: doc.owner_quote, to: doc.to, model: doc.to !== 'auto' ? doc.model : null, kind: doc.kind, timeoutSec: doc.timeout_sec });
        let ancestors = new Set<string>();
        if (doc.parent) {
          const h = this.handoffContext(doc.parent, { ownerQuote: doc.owner_quote, mode: doc.mode, cwd: doc.cwd });
          doc.hop = h.hop;
          doc.root = h.root.id;
          ancestors = h.ancestors;
        } else {
          doc.root = doc.root || doc.id;
          doc.hop = 0;
        }
        for (const dep of doc.depends_on) if (!this.tryLoad(dep)) throw new Error(`dependency ${dep} not found`);
        const cls = classify(doc.request, doc.mode, { kind: doc.kind as Kind, weight: doc.weight as Weight });
        const r = this.routeFor({ to: doc.to, model: doc.to !== 'auto' ? doc.model || null : null, mode: doc.mode, urgent: doc.urgent, failover: doc.failover, claudeWeeklyPercent: doc.claude_weekly_percent }, cls, ancestors, statuses);
        doc.weight = cls.weight;
        doc.kind = cls.kind;
        row.weight = cls.weight;
        row.kind = cls.kind;
        row.classification = cls.reason;
        row.agent = r.chosen ? displayName(r.chosen) : '';
        row.fallbacks = r.fallbacks.map(displayName);
        row.skipped = r.skipped.map((s) => `${s.agent}: ${s.reason}`);
        row.id = doc.id;
        if (!r.chosen) throw Object.assign(new Error('no open agent can take this task now; left queued'), { transient: true });
        if (handWritten || !doc.routing) {
          doc.agent = r.chosen.agent;
          doc.model = r.chosen.model ?? '';
          doc.routing = this.routingText(cls, r);
        }
        doc.run_log = this.runDir(doc.id);
        if (handWritten) doc.log.push(logLine(`picked up from the Obsidian inbox (written by ${doc.from}) → ${displayName(r.chosen)}, ${cls.weight}`));
        accepted.push(doc);
      } catch (e) {
        row.error = (e as Error).message;
        if (!opts.dryRun && !(e as any).transient) {
          doc.status = 'failed';
          doc.result = `Rejected by the dispatcher: ${row.error}`;
          doc.log.push(logLine(`rejected: ${row.error}`));
          writeTask(doc);
        }
        rejected.push(`${basename(doc.file)}: ${row.error}`);
      }
      rows.push(row);
    }
    const table = renderPlanTable(rows, statuses);
    if (opts.dryRun) return { rows, table, started: [], rejected };
    for (const doc of accepted) {
      mkdirSync(this.runDir(doc.id), { recursive: true });
      writeTask(doc);
      if (doc.log.some((l) => l.includes('picked up from the Obsidian inbox'))) {
        appendBoardLine(
          this.cfg.paths.boardFile,
          boardLine({ what: `inbox task [[Tasks/${basename(doc.file, '.md')}|${doc.id}]] (written by ${doc.from}) accepted → ${doc.agent}${doc.model ? ` (${doc.model})` : ''}, ${doc.weight}, ${doc.mode}.` }),
        );
      }
    }
    const promises = accepted.map((d) => this.start(d.id));
    if (opts.wait !== false) await Promise.allSettled(promises);
    return { rows, table, started: accepted.map((d) => d.id), rejected };
  }

  // ---------------------------------------------------------------- execution

  start(id: string): Promise<TaskDoc | null> {
    const existing = this.running.get(id);
    if (existing) return existing.promise;
    const ctrl = new AbortController();
    const promise = this.execute(id, ctrl).catch((e) => {
      this.log(`task ${id} crashed: ${(e as Error).stack ?? e}`);
      const doc = this.tryLoad(id);
      if (doc && !TERMINAL.includes(doc.status)) return this.finish(doc, 'failed', `dispatcher error: ${(e as Error).message}`);
      return doc;
    });
    this.running.set(id, { ctrl, promise });
    promise.finally(() => this.running.delete(id));
    return promise;
  }

  waitFor(ids: string[], timeoutMs: number): Promise<void> {
    const ps = ids.map((id) => this.running.get(id)?.promise).filter(Boolean) as Promise<unknown>[];
    return Promise.race([Promise.allSettled(ps).then(() => undefined), sleep(timeoutMs)]);
  }

  private claimFile(id: string): string {
    return join(this.runDir(id), 'claim.lock');
  }

  private claim(id: string): boolean {
    mkdirSync(this.runDir(id), { recursive: true });
    const file = this.claimFile(id);
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(file, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        closeSync(fd);
        return true;
      } catch (e: any) {
        if (e?.code !== 'EEXIST') return false;
        try {
          const holder = JSON.parse(readFileSync(file, 'utf8'));
          if (holder.pid === process.pid || !isAlive(holder.pid)) {
            unlinkSync(file);
            continue;
          }
        } catch {}
        return false;
      }
    }
    return false;
  }

  private claimedElsewhere(id: string): boolean {
    try {
      const holder = JSON.parse(readFileSync(this.claimFile(id), 'utf8'));
      return holder.pid !== process.pid && isAlive(holder.pid);
    } catch {
      return false;
    }
  }

  private releaseClaim(id: string): void {
    try {
      unlinkSync(this.claimFile(id));
    } catch {}
  }

  private cancelRequested(id: string): boolean {
    if (existsSync(join(this.runDir(id), 'cancel'))) return true;
    const doc = this.tryLoad(id);
    return doc?.status === 'cancelled';
  }

  private writeRuntime(id: string, data: Record<string, unknown>): void {
    writeFileAtomic(join(this.runDir(id), 'runtime.json'), JSON.stringify({ ...data, updated: new Date().toISOString() }, null, 2));
  }

  private readRuntime(id: string): any {
    try {
      return JSON.parse(readFileSync(join(this.runDir(id), 'runtime.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  private finish(doc: TaskDoc, status: Status, note: string): TaskDoc {
    doc.status = status;
    doc.ended = bangkokTime().iso;
    if (status !== 'done' && !doc.result) doc.result = note;
    doc.log.push(logLine(`${status}: ${note}`));
    writeTask(doc);
    return doc;
  }

  private async execute(id: string, ctrl: AbortController): Promise<TaskDoc | null> {
    if (!this.claim(id)) {
      this.log(`task ${id} is claimed by another dispatcher process`);
      return this.tryLoad(id);
    }
    const poll = setInterval(() => {
      if (!ctrl.signal.aborted && this.cancelRequested(id)) ctrl.abort();
    }, this.pollMs);
    try {
      let doc = this.load(id);
      if (doc.status !== 'queued') return doc;
      const depFailure = await this.waitForDeps(doc, ctrl.signal);
      doc = this.load(id);
      if (ctrl.signal.aborted || doc.status === 'cancelled') return this.finish(doc, 'cancelled', this.stopReason ?? 'cancelled while waiting');
      if (depFailure) return this.finish(doc, 'failed', depFailure);
      let release: Release;
      try {
        release = await this.gate.acquire(id, ctrl.signal);
      } catch {
        return this.finish(this.load(id), 'cancelled', this.stopReason ?? 'cancelled while queued for a run slot');
      }
      try {
        return await this.attempts(this.load(id), ctrl);
      } finally {
        release();
      }
    } finally {
      clearInterval(poll);
      this.releaseClaim(id);
    }
  }

  private async waitForDeps(doc: TaskDoc, signal: AbortSignal): Promise<string | null> {
    const deadline = Date.now() + 12 * 3600 * 1000;
    while (doc.depends_on.length) {
      let pending = false;
      for (const depId of doc.depends_on) {
        const dep = this.tryLoad(depId);
        if (!dep) return `dependency ${depId} not found`;
        if (dep.status === 'done') continue;
        if (TERMINAL.includes(dep.status)) return `dependency ${depId} ended with status ${dep.status}`;
        pending = true;
      }
      if (!pending) return null;
      if (signal.aborted) return null;
      if (Date.now() > deadline) return 'dependencies did not finish within 12 hours';
      await sleep(this.pollMs);
    }
    return null;
  }

  private async attempts(doc: TaskDoc, ctrl: AbortController): Promise<TaskDoc> {
    const tried = new Set<string>();
    const ancestors = doc.parent ? this.ancestorKeys(doc) : new Set<string>();
    const requestedModel = doc.to !== 'auto' ? doc.model || null : null;
    const cls: Classification = { kind: (doc.kind as Kind) || 'short', weight: (doc.weight as Weight) || 'light', reason: '' };
    while (true) {
      if (ctrl.signal.aborted) return this.finish(doc, 'cancelled', this.stopReason ?? 'cancelled');
      const r = route(
        {
          to: doc.to,
          model: requestedModel,
          kind: cls.kind,
          mode: doc.mode,
          urgent: doc.urgent,
          failover: doc.failover,
          claudeWeeklyPercent: doc.claude_weekly_percent,
          exclude: tried,
          ancestors,
        },
        this.agents(true),
        this.cfg,
      );
      if (!r.chosen) {
        const why = r.skipped.map((s) => `${s.agent}: ${s.reason}`).join('; ');
        return this.finish(doc, 'failed', tried.size ? `no open agent left after failover (${why})` : `no open agent can take this task (${why})`);
      }
      const c = r.chosen;
      tried.add(`${c.agent}:*`);
      const n = doc.attempts + 1;
      const bin = this.resolveFn(c.agent);
      if (!bin) {
        doc.log.push(logLine(`${c.agent}: CLI not found, skipped`));
        continue;
      }
      const adapter = this.adapters[c.agent];
      let wt: Worktree | undefined;
      let cwd = doc.cwd;
      if (doc.mode === 'write-in-worktree') {
        try {
          wt = this.createWt({ cwd: doc.cwd, agent: c.agent, topic: doc.topic || doc.request, id: doc.id });
          cwd = wt.path;
          for (const w of wt.warnings) doc.log.push(logLine(`worktree: ${w}`));
        } catch (e) {
          return this.finish(doc, 'failed', `could not create a worktree: ${(e as Error).message}`);
        }
      }
      const attemptDir = join(this.runDir(doc.id), `attempt-${n}-${c.agent}`);
      mkdirSync(attemptDir, { recursive: true });
      const deps = doc.depends_on.map((d) => this.tryLoad(d)).filter(Boolean) as TaskDoc[];
      const root = doc.root && doc.root !== doc.id ? this.tryLoad(doc.root) : null;
      const pre: PreambleInput = {
        taskId: doc.id,
        taskFile: doc.file,
        agentLabel: AGENTS[c.agent].label,
        model: c.model,
        from: doc.from,
        hop: doc.hop,
        maxHops: this.cfg.maxHops,
        maxHandoffs: this.cfg.maxHandoffsPerTask,
        rootMode: root?.mode ?? doc.mode,
        mode: doc.mode,
        cwd: doc.cwd,
        branch: wt?.branch,
        worktree: wt?.path,
        ownerQuote: doc.owner_quote,
        readmeFile: this.cfg.paths.readmeFile,
        contextNotes: this.cfg.contextNotes,
        dependencyFiles: deps.map((d) => d.file),
        inlineDependencySummaries: adapter.canReadVault(doc.mode) ? [] : deps.map((d) => `${d.id}: ${oneLine(d.result, 600)}`),
        canReadVault: adapter.canReadVault(doc.mode),
        tasksDir: this.cfg.paths.tasksDir,
      };
      // Prompts are redacted before they leave the dispatcher, so no secret is sent or stored.
      const promptText = redactSecrets(buildPrompt(pre, doc.request));
      const promptFile = join(attemptDir, 'prompt.md');
      writeFileSync(promptFile, promptText, 'utf8');
      const ctx: AdapterContext = { mode: doc.mode, cwd, model: c.model, timeoutSec: doc.timeout_sec, runDir: attemptDir, promptText, promptFile, readDirs: this.cfg.readDirs };
      const inv = adapter.build(bin, ctx);
      writeFileSync(
        join(attemptDir, 'invocation.json'),
        JSON.stringify({ command: inv.command, args: inv.args.map((a) => (a === promptText ? '<prompt>' : a)), cwd: inv.cwd }, null, 2),
      );
      doc.status = 'running';
      doc.agent = c.agent;
      doc.model = c.model ?? '';
      doc.attempts = n;
      doc.branch = wt?.branch ?? '';
      doc.worktree = wt?.path ?? '';
      if (!doc.started) doc.started = bangkokTime().iso;
      doc.log.push(logLine(`attempt ${n}: ${displayName(c)} started${wt ? ` in ${wt.path} (${wt.branch})` : ''}`));
      writeTask(doc);
      const outcome = await this.runFn(
        {
          command: inv.command,
          args: inv.args,
          cwd: inv.cwd,
          env: inv.env,
          stdin: inv.stdin,
          timeoutMs: doc.timeout_sec * 1000,
          onSpawn: (pid) => this.writeRuntime(doc.id, { ownerPid: process.pid, childPid: pid, attempt: n, agent: c.agent, image: basename(inv.command).toLowerCase() }),
        },
        ctrl.signal,
      );
      const parsed = adapter.parse(outcome, ctx, inv);
      writeFileSync(join(attemptDir, 'stdout.log'), redactSecrets(outcome.stdout), 'utf8');
      writeFileSync(join(attemptDir, 'stderr.log'), redactSecrets(outcome.stderr), 'utf8');
      const resultFile = join(attemptDir, 'result.md');
      writeFileSync(resultFile, redactSecrets(parsed.text || parsed.errorText), 'utf8');
      this.writeRuntime(doc.id, { ownerPid: process.pid, childPid: null, attempt: n, agent: c.agent, exitCode: outcome.exitCode });
      const secs = Math.round(outcome.durationMs / 1000);

      if (outcome.cancelled || this.cancelRequested(doc.id)) {
        return this.finish(doc, 'cancelled', `${this.stopReason ?? 'cancelled'} after ${secs}s (${displayName(c)})`);
      }
      if (outcome.timedOut) {
        doc.result = summarizeResult(parsed.text, this.cfg.summaryMaxChars, resultFile);
        return this.finish(doc, 'timeout', `${displayName(c)} hit the ${doc.timeout_sec}s timeout; process tree killed`);
      }
      if (parsed.ok) {
        doc.result = summarizeResult(parsed.text, this.cfg.summaryMaxChars, resultFile);
        if (wt) {
          const ch = worktreeChanges(wt.path);
          const files = ch.status.split('\n').filter(Boolean);
          doc.result += `\n\nWorktree \`${wt.path}\` on branch \`${wt.branch}\`: ${files.length ? `${files.length} changed file(s), uncommitted, waiting for review` : 'no changes'}.`;
          if (files.length) doc.result += `\n${files.slice(0, 20).map((f) => `- \`${f.trim()}\``).join('\n')}`;
        }
        doc.result += `\n\nFull output (raw, not for downstream agents): ${resultFile}`;
        const finished = this.finish(doc, 'done', `${displayName(c)} finished in ${secs}s${parsed.costUsd !== undefined ? `, cost ${parsed.costUsd.toFixed(4)} USD` : ''}`);
        this.createHandoffs(finished, parsed.text, c);
        return finished;
      }
      if (parsed.quotaExhausted && doc.failover) {
        doc.log.push(logLine(`attempt ${n}: ${displayName(c)} hit a quota or rate limit ("${parsed.quotaMatch}"); switching to the next open agent`));
        if (wt && removeIfPristine(wt)) doc.log.push(logLine(`removed the unused worktree ${wt.path}`));
        writeTask(doc);
        continue;
      }
      const err = oneLine(redactSecrets(parsed.errorText || `exit code ${outcome.exitCode}`), 400);
      doc.result = `Failed on ${displayName(c)}: ${err}\nRaw output: ${attemptDir}`;
      return this.finish(doc, 'failed', `${displayName(c)} failed (exit ${outcome.exitCode}${outcome.spawnError ? `, ${outcome.spawnError}` : ''})`);
    }
  }

  /** Turn HANDOFF blocks in a finished task's reply into child tasks (validated and capped). */
  private createHandoffs(parent: TaskDoc, text: string, by: { agent: AgentId; model: string | null }): void {
    const blocks = parseHandoffs(text, this.cfg.maxHandoffsPerTask);
    if (!blocks.length) return;
    for (const h of blocks) {
      try {
        const child = this.submitTask(
          {
            to: h.to || 'auto',
            prompt: h.request,
            cwd: parent.cwd,
            mode: (h.mode || 'read-only') as Mode,
            weight: h.weight,
            ownerQuote: parent.owner_quote,
            from: displayName(by),
            parentId: parent.id,
            urgent: parent.urgent,
            claudeWeeklyPercent: parent.claude_weekly_percent,
            timeoutSec: parent.timeout_sec,
          },
          { run: this.cfg.autoRunHandoffs && !this.stopReason },
        );
        parent.log.push(logLine(`hand-off → [[Tasks/${basename(child.file, '.md')}|${child.id}]] (${child.agent}${child.model ? ` ${child.model}` : ''}, ${child.weight})`));
      } catch (e) {
        parent.log.push(logLine(`hand-off rejected: ${(e as Error).message}`));
      }
    }
    writeTask(parent);
  }

  // ---------------------------------------------------------------- control

  async cancel(id: string): Promise<{ doc: TaskDoc; note: string }> {
    const doc = this.load(id);
    if (TERMINAL.includes(doc.status)) return { doc, note: `already ${doc.status}` };
    mkdirSync(this.runDir(id), { recursive: true });
    writeFileSync(join(this.runDir(id), 'cancel'), new Date().toISOString());
    const local = this.running.get(id);
    if (local) {
      local.ctrl.abort();
      await Promise.race([local.promise, sleep(30000)]);
      return { doc: this.load(id), note: 'cancelled; process tree killed' };
    }
    if (this.claimedElsewhere(id)) return { doc, note: 'cancel requested; the dispatcher process running it stops it within a few seconds' };
    const rt = this.readRuntime(id);
    if (rt.childPid && isAlive(rt.childPid)) {
      const name = processNameOf(rt.childPid);
      if (!name || !rt.image || rt.image.startsWith(name)) killTree(rt.childPid);
    }
    return { doc: this.finish(doc, 'cancelled', 'cancelled (no live dispatcher owned it)'), note: 'cancelled' };
  }

  /** Stop accepting work, cancel running tasks and kill their process trees. */
  async shutdown(reason = 'dispatcher stopped'): Promise<void> {
    this.stopReason = reason;
    const all = [...this.running.values()];
    for (const r of all) r.ctrl.abort();
    await Promise.race([Promise.allSettled(all.map((r) => r.promise)), sleep(30000)]);
  }

  get activeCount(): number {
    return this.running.size;
  }

  /** Wait until no task (including hand-offs started meanwhile) runs in this process. */
  async waitIdle(timeoutMs = Number.POSITIVE_INFINITY): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.running.size && Date.now() < end) {
      const all = [...this.running.values()].map((r) => r.promise);
      await Promise.race([Promise.allSettled(all), sleep(Math.max(10, Math.min(5000, end - Date.now())))]);
    }
  }

  status(id: string): Record<string, unknown> {
    const d = this.load(id);
    return {
      id: d.id,
      status: d.status,
      from: d.from,
      to: d.to,
      agent: d.agent,
      model: d.model || (d.agent === 'hermes' ? '(Hermes chooses)' : '(CLI default)'),
      weight: d.weight,
      kind: d.kind,
      mode: d.mode,
      cwd: d.cwd,
      branch: d.branch,
      worktree: d.worktree,
      hop: d.hop,
      root: d.root,
      parent: d.parent,
      plan: d.plan,
      depends_on: d.depends_on,
      attempts: d.attempts,
      created: d.created,
      started: d.started,
      ended: d.ended,
      task_file: d.file,
      run_log: d.run_log,
      running_here: this.running.has(id),
      log: d.log.slice(-8),
    };
  }

  result(id: string): { status: Status; summary: string; task_file: string; run_log: string } {
    const d = this.load(id);
    return { status: d.status, summary: d.result || '(no result yet)', task_file: d.file, run_log: d.run_log };
  }
}

function topoOrder(tasks: PlanTaskSpec[]): PlanTaskSpec[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const done = new Set<string>();
  const out: PlanTaskSpec[] = [];
  const visit = (t: PlanTaskSpec) => {
    if (done.has(t.key)) return;
    done.add(t.key);
    for (const d of t.dependsOn ?? []) visit(byKey.get(d)!);
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

export function renderPlanTable(rows: PlanRow[], statuses: AgentStatus[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    '| # | Sub-task | Weight | Agent (model) | Mode | Depends on | Notes |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  ];
  rows.forEach((r, i) => {
    const notes = [
      r.error ? `ERROR: ${r.error}` : '',
      r.classification ? `why: ${r.classification}` : '',
      r.fallbacks.length ? `failover: ${r.fallbacks.join(' → ')}` : '',
      r.skipped.length ? `skipped: ${r.skipped.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('<br>');
    lines.push(
      `| ${i + 1} | ${esc(r.key)}: ${esc(r.summary)} | ${r.weight ? `**${r.weight}** (${r.kind})` : '-'} | ${esc(r.agent || '-')} | ${r.mode || '-'} | ${r.dependsOn.join(', ') || '-'} | ${esc(notes) || '-'} |`,
    );
  });
  const closed = statuses.filter((s) => s.installed && !s.running).map((s) => s.id);
  const missing = statuses.filter((s) => !s.installed).map((s) => s.id);
  if (closed.length) lines.push('', `Apps not open (skipped, not launched): ${closed.join(', ')}.`);
  if (missing.length) lines.push(`Not installed: ${missing.join(', ')}.`);
  return lines.join('\n');
}
