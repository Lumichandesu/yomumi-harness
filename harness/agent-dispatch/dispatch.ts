#!/usr/bin/env bun
/**
 * agent-dispatch CLI.
 *
 *   bun run dispatch.ts --agent codex --mode read-only --cwd C:\work\app --quote "..." --prompt "..."
 *   bun run dispatch.ts list-agents | list | status <id> | result <id> | cancel <id>
 *   bun run dispatch.ts plan <plan.json> [--preview]      (heavy/light table first, then dispatch)
 *   bun run dispatch.ts run-queue [--dry-run] [--watch --interval 60]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Dispatcher } from './src/dispatcher';
import { normalizePlan, normalizeTask, renderAgents, safeText, UNTRUSTED_NOTE } from './src/api';
import { sleep } from './src/util';

const BOOL = new Set(['json', 'urgent', 'no-failover', 'watch', 'dry-run', 'preview', 'help']);

function parseArgs(argv: string[]): { _: string[]; f: Record<string, string | boolean> } {
  const out = { _: [] as string[], f: {} as Record<string, string | boolean> };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.f[name] = a.slice(eq + 1);
      else if (BOOL.has(name)) out.f[name] = true;
      else out.f[name] = argv[++i] ?? '';
    } else out._.push(a);
  }
  return out;
}

const HELP = `agent-dispatch: hand tasks to the AI agents whose apps are open on this PC.

Commands
  (default)            dispatch one task and wait for it
      --agent auto|claude|claude-opus|claude-sonnet|claude-haiku|codex|antigravity|hermes|cursor
      --mode read-only|write-in-worktree   --cwd <abs dir>   --quote "<owner's verbatim words>"
      --prompt "..." | --prompt-file <f>   [--model m] [--weight light|heavy] [--kind search|easy|short|hard]
      [--topic t] [--timeout 1800] [--from name] [--parent <task id>] [--claude-weekly 96] [--urgent] [--no-failover]
  plan <plan.json>     show the heavy/light plan, then dispatch it (--preview: only show)
  run-queue            run queued task files from Obsidian Agent-Comms/Tasks (--dry-run, --watch [--interval 60])
  list-agents          installed / app open / models / roles
  list [--limit 20]    recent tasks
  status <id> | result <id> | cancel <id>
`;

async function main(): Promise<number> {
  const { _, f } = parseArgs(process.argv.slice(2));
  const cmd = _[0] ?? (f.prompt || f['prompt-file'] ? 'dispatch' : 'help');
  if (f.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const d = new Dispatcher();
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${sig}: stopping, cancelling running tasks and killing their process trees...`);
    await d.shutdown(`dispatcher stopped (${sig})`);
    process.exit(130);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  switch (cmd) {
    case 'list-agents': {
      const s = d.agents(true);
      console.log(f.json ? JSON.stringify(s, null, 2) : renderAgents(s, d.cfg));
      return 0;
    }
    case 'list': {
      const tasks = d.listTasks(Number(f.limit) || 20);
      for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(9)} ${t.weight.padEnd(5)} ${(t.agent + (t.model ? `:${t.model}` : '')).padEnd(22)} ${t.request.replace(/\s+/g, ' ').slice(0, 60)}`);
      return 0;
    }
    case 'status': {
      console.log(JSON.stringify(d.status(need(_[1], 'task id')), null, 2));
      return 0;
    }
    case 'result': {
      const r = d.result(need(_[1], 'task id'));
      console.log(`status: ${r.status}\ntask file: ${r.task_file}\nraw output: ${r.run_log}\n\n${UNTRUSTED_NOTE}\n\n${safeText(r.summary)}`);
      return 0;
    }
    case 'cancel': {
      const r = await d.cancel(need(_[1], 'task id'));
      console.log(`${r.doc.id}: ${r.note} (status ${r.doc.status})`);
      return 0;
    }
    case 'preview':
    case 'plan': {
      const plan = normalizePlan(JSON.parse(readFileSync(resolve(need(_[1], 'plan file')), 'utf8')));
      if (f['claude-weekly'] !== undefined) plan.claudeWeeklyPercent = Number(f['claude-weekly']);
      const p = d.previewPlan(plan);
      console.log(`Plan preview ${p.previewId}\n\n${p.table}\n`);
      if (p.errors.length) {
        console.error(`Errors:\n- ${p.errors.join('\n- ')}`);
        return 2;
      }
      if (cmd === 'preview' || f.preview) return 0;
      const res = d.dispatchPlan(plan);
      console.log(`Dispatched plan ${res.planId} (${res.planFile})`);
      for (const t of res.tasks) console.log(`  ${t.key}: ${t.id} → ${t.agent} [${t.weight}]`);
      await d.waitIdle();
      for (const t of res.tasks) console.log(`  ${t.key}: ${d.result(t.id).status}`);
      return 0;
    }
    case 'run-queue': {
      if (f.watch) {
        const interval = Math.max(15, Number(f.interval) || 60) * 1000;
        console.error(`Watching ${d.cfg.paths.tasksDir} every ${interval / 1000}s (max ${d.cfg.maxConcurrent} concurrent runs). Ctrl+C stops cleanly.`);
        while (!stopping) {
          const r = await d.runQueue({ wait: false });
          if (r.started.length) console.log(`${new Date().toISOString()} started ${r.started.join(', ')}\n${r.table}`);
          for (const x of r.rejected) console.error(`rejected ${x}`);
          await sleep(interval);
        }
        return 0;
      }
      const r = await d.runQueue({ dryRun: !!f['dry-run'] });
      console.log(r.rows.length ? r.table : 'No queued task files.');
      for (const x of r.rejected) console.error(`rejected ${x}`);
      if (!f['dry-run']) {
        await d.waitIdle();
        for (const id of r.started) console.log(`${id}: ${d.result(id).status}`);
      }
      return 0;
    }
    case 'dispatch': {
      const prompt = f['prompt-file'] ? readFileSync(resolve(String(f['prompt-file'])), 'utf8') : String(f.prompt ?? '');
      const spec = normalizeTask({
        to: f.agent ?? f.to ?? 'auto',
        prompt,
        cwd: f.cwd ? resolve(String(f.cwd)) : '',
        mode: f.mode,
        owner_quote: f.quote,
        model: f.model,
        kind: f.kind,
        weight: f.weight,
        topic: f.topic,
        timeout_sec: f.timeout,
        from: f.from ?? 'cli',
        parent_task_id: f.parent,
        urgent: !!f.urgent,
        failover: f['no-failover'] ? false : undefined,
        claude_weekly_percent: f['claude-weekly'],
      });
      const doc = d.submitTask(spec, { run: true });
      console.log(`Task ${doc.id} → ${doc.agent}${doc.model ? ` (${doc.model})` : ''} [${doc.weight}, ${doc.mode}]\nTask file: ${doc.file}`);
      await d.waitIdle();
      const r = d.result(doc.id);
      console.log(`\nstatus: ${r.status}\n${UNTRUSTED_NOTE}\n\n${safeText(r.summary)}`);
      return r.status === 'done' ? 0 : 1;
    }
    default:
      console.error(`Unknown command ${cmd}\n\n${HELP}`);
      return 2;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
