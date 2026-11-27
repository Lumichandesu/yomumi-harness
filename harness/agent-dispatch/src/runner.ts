/**
 * Run one agent CLI hidden (no console window on Windows), capture output, enforce the timeout
 * and always kill the whole process tree on exit, timeout or cancel.
 */
import { spawn, spawnSync } from 'node:child_process';
import { isAlive } from './util';

export interface RunSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  onSpawn?: (pid: number) => void;
}

export interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  pid?: number;
  spawnError?: string;
  truncated: boolean;
}

/** Kill a process and all its children. Safe to call on a pid that already exited. */
export function killTree(pid: number): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function buildEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** `.cmd`/`.bat` cannot be spawned directly on Windows; wrap them in cmd.exe with strict quoting. */
function launchTarget(command: string, args: string[]): { file: string; argv: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    for (const a of [command, ...args]) {
      if (/["%^&|<>!\r\n]/.test(a)) throw new Error(`Refusing to pass unsafe characters through cmd.exe: ${a.slice(0, 40)}`);
    }
    const line = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`] };
  }
  return { file: command, argv: args };
}

export function runProcess(spec: RunSpec, signal?: AbortSignal): Promise<RunOutcome> {
  const started = Date.now();
  const max = spec.maxOutputBytes ?? 20 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      signal?.removeEventListener('abort', onAbort);
      if (child?.pid && isAlive(child.pid)) killTree(child.pid);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - started, pid: child?.pid, spawnError, truncated });
    };
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child?.pid) killTree(child.pid);
      // If the pipes never close after the kill, settle anyway.
      hardStop = setTimeout(() => finish(null), 10000);
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    let target: { file: string; argv: string[] };
    try {
      target = launchTarget(spec.command, spec.args);
    } catch (e) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 0, spawnError: (e as Error).message, truncated: false });
      return;
    }
    try {
      child = spawn(target.file, target.argv, {
        cwd: spec.cwd,
        env: buildEnv(spec.env),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: target.file !== spec.command,
      });
    } catch (e) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 0, spawnError: (e as Error).message, truncated: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, spec.timeoutMs));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (child.pid) spec.onSpawn?.(child.pid);
    const append = (which: 'out' | 'err', chunk: Buffer) => {
      const s = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + s.length > max) truncated = true;
        else stdout += s;
      } else if (stderr.length + s.length > max) truncated = true;
      else stderr += s;
    };
    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin, 'utf8');
    else child.stdin?.end();
  });
}
