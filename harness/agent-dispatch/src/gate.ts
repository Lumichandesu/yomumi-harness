/**
 * Concurrency gate: at most `max` agent runs at once (machine-load rule: max 2).
 * In-process waiters are served FIFO. With `dir`, slots are lock files shared by every
 * dispatcher process (MCP server, CLI, run-queue), so the cap holds machine-wide.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive } from './util';

export type Release = () => void;

interface Waiter {
  taskId: string;
  resolve: (r: Release) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ConcurrencyGate {
  readonly max: number;
  private readonly dir?: string;
  private readonly pollMs: number;
  private readonly alive: (pid: number) => boolean;
  private waiters: Waiter[] = [];
  private local = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { max: number; dir?: string; pollMs?: number; isAlive?: (pid: number) => boolean }) {
    this.max = Math.max(1, Math.floor(opts.max));
    this.dir = opts.dir;
    this.pollMs = opts.pollMs ?? 1000;
    this.alive = opts.isAlive ?? isAlive;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }

  get active(): number {
    return this.local;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(taskId: string, signal?: AbortSignal): Promise<Release> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const w: Waiter = { taskId, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.pump();
    });
  }

  private pump(): void {
    while (this.waiters.length && this.local < this.max) {
      const w = this.waiters[0];
      let slot: string | null = null;
      if (this.dir) {
        slot = this.claimSlot(w.taskId);
        if (!slot) {
          // Another process holds every slot: poll.
          if (!this.timer) this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
          }, this.pollMs);
          return;
        }
      }
      this.waiters.shift();
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.local++;
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.local--;
        if (slot) {
          try {
            unlinkSync(slot);
          } catch {}
        }
        this.pump();
      });
    }
  }

  private claimSlot(taskId: string): string | null {
    for (let i = 0; i < this.max; i++) {
      const file = join(this.dir!, `slot-${i}.lock`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = openSync(file, 'wx');
          writeSync(fd, JSON.stringify({ pid: process.pid, taskId, at: new Date().toISOString() }));
          closeSync(fd);
          return file;
        } catch (e: any) {
          if (e?.code !== 'EEXIST') break;
          // Reclaim a slot whose owner process is gone.
          try {
            const holder = JSON.parse(readFileSync(file, 'utf8'));
            if (holder?.pid && !this.alive(holder.pid)) {
              unlinkSync(file);
              continue;
            }
          } catch {
            // Half-written or unreadable: leave it; the owner may be writing it right now.
          }
          break;
        }
      }
    }
    return null;
  }
}
