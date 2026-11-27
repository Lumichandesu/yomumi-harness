/**
 * One adapter per agent CLI: the narrowest headless invocation for each mode, and a parser
 * for its output. No adapter ever emits a permission-bypass flag (tests enforce this).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId, Mode } from './config';
import type { ResolvedBinary } from './registry';
import type { RunOutcome } from './runner';

export interface AdapterContext {
  mode: Mode;
  cwd: string;
  model: string | null;
  timeoutSec: number;
  runDir: string;
  promptText: string;
  promptFile: string;
  readDirs: string[];
}

export interface Invocation {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  /** File the CLI writes its final message to (Codex -o). */
  lastMessageFile?: string;
}

export interface ParsedResult {
  ok: boolean;
  text: string;
  errorText: string;
  costUsd?: number;
  quotaExhausted: boolean;
  quotaMatch?: string;
}

export interface Adapter {
  id: AgentId;
  verified: boolean;
  /** Can this agent read the Obsidian vault in this mode? Otherwise summaries are inlined. */
  canReadVault(mode: Mode): boolean;
  build(bin: ResolvedBinary, ctx: AdapterContext): Invocation;
  parse(out: RunOutcome, ctx: AdapterContext, inv: Invocation): ParsedResult;
}

/** Flags that disable approvals or sandboxes. Never emitted; asserted in tests. */
export const FORBIDDEN_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
  '--yolo',
  '-z',
  '--oneshot',
  '--force',
  '-f',
  '--approve-for-me',
  '--dangerously-bypass-hook-trust',
];

export const QUOTA_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /quota/i,
  /RESOURCE_EXHAUSTED/,
  /insufficient[_ ]quota/i,
  /(?:out of|no (?:more )?) ?(?:tokens|credits)\b/i,
  /credit balance is too low/i,
  /limit (?:reached|exceeded|hit)/i,
  /hit your (?:usage |weekly |daily )?limit/i,
  /(?:weekly|daily|5-hour|five-hour) limit/i,
  /tokens? (?:exhausted|depleted)/i,
];

export function detectQuota(text: string): string | undefined {
  for (const re of QUOTA_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

function tail(s: string, n = 4000): string {
  return s.length > n ? s.slice(-n) : s;
}

function finalize(ok: boolean, text: string, errorText: string, extra: Partial<ParsedResult> = {}): ParsedResult {
  const quotaMatch = ok ? undefined : detectQuota(`${errorText}\n${tail(text)}`);
  return { ok, text: text.trim(), errorText: errorText.trim(), quotaExhausted: !!quotaMatch, quotaMatch, ...extra };
}

function lastJsonObject(stdout: string): any | null {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const l of lines) {
    const s = l.trim();
    if (!s.startsWith('{')) continue;
    try {
      return JSON.parse(s);
    } catch {}
  }
  return null;
}

const claude: Adapter = {
  id: 'claude',
  verified: true,
  canReadVault: (mode) => mode === 'read-only',
  build(bin, ctx) {
    const common = ['-p', '--output-format', 'json', '--permission-prompts', 'none', '--restricted', '--strict-mcp-config', '--no-session-persistence'];
    const modeArgs =
      ctx.mode === 'read-only'
        ? ['--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', ...ctx.readDirs.flatMap((d) => ['--add-dir', d])]
        : [
            '--permission-mode',
            'acceptEdits',
            '--tools',
            'Read,Glob,Grep,Edit,Write,Bash',
            '--allowedTools',
            'Bash(git status:*)',
            'Bash(git diff:*)',
            'Bash(git log:*)',
          ];
    return {
      command: bin.command,
      args: [...bin.prefixArgs, ...common, ...(ctx.model ? ['--model', ctx.model] : []), ...modeArgs],
      cwd: ctx.cwd,
      stdin: ctx.promptText,
      // A nested CLI must not think it is the parent's session.
      env: { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined },
    };
  },
  parse(out) {
    const j = lastJsonObject(out.stdout);
    if (j && typeof j === 'object' && ('result' in j || 'is_error' in j)) {
      const isError = !!j.is_error || (j.subtype && j.subtype !== 'success');
      const text = typeof j.result === 'string' ? j.result : '';
      return finalize(out.exitCode === 0 && !isError, text, isError ? `${j.subtype ?? 'error'}: ${text}\n${tail(out.stderr)}` : tail(out.stderr, 1000), {
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
      });
    }
    return finalize(false, out.stdout, `${out.spawnError ?? ''}\n${tail(out.stderr)}`);
  },
};

const codex: Adapter = {
  id: 'codex',
  verified: true,
  canReadVault: () => true,
  build(bin, ctx) {
    const last = join(ctx.runDir, 'last-message.txt');
    return {
      command: bin.command,
      args: [
        ...bin.prefixArgs,
        'exec',
        '--sandbox',
        ctx.mode === 'read-only' ? 'read-only' : 'workspace-write',
        '-c',
        'approval_policy="never"',
        '--ephemeral',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--json',
        '-C',
        ctx.cwd,
        '-o',
        last,
        ...(ctx.model ? ['-m', ctx.model] : []),
        '-',
      ],
      cwd: ctx.cwd,
      stdin: ctx.promptText,
      lastMessageFile: last,
    };
  },
  parse(out, _ctx, inv) {
    let text = '';
    if (inv.lastMessageFile && existsSync(inv.lastMessageFile)) text = readFileSync(inv.lastMessageFile, 'utf8');
    const errors: string[] = [];
    let costUsd: number | undefined;
    for (const line of out.stdout.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      try {
        const ev = JSON.parse(line);
        const t = String(ev.type ?? ev.msg?.type ?? '');
        if (/error|failed/i.test(t)) errors.push(JSON.stringify(ev.error ?? ev.message ?? ev.msg ?? ev).slice(0, 500));
        if (!text && t === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
      } catch {}
    }
    const ok = out.exitCode === 0 && text.trim().length > 0;
    return finalize(ok, text, `${errors.join('\n')}\n${out.spawnError ?? ''}\n${tail(out.stderr)}`, { costUsd });
  },
};

const MAX_ARG_PROMPT = 24000;

const antigravity: Adapter = {
  id: 'antigravity',
  verified: false,
  canReadVault: () => false,
  build(bin, ctx) {
    // Go-style flags: every flag must come before the prompt.
    const longPrompt = ctx.promptText.length > MAX_ARG_PROMPT;
    const prompt = longPrompt ? `Read the full task, including its rules, from ${ctx.promptFile} and follow it exactly.` : ctx.promptText;
    return {
      command: bin.command,
      args: [
        ...bin.prefixArgs,
        '--output-format',
        'json',
        '--mode',
        ctx.mode === 'read-only' ? 'plan' : 'accept-edits',
        '--sandbox',
        // Not --disable-slash-commands: agy ignores --mode plan when it is set (verified 2026-10-09).
        '--print-timeout',
        `${ctx.timeoutSec}s`,
        ...(longPrompt ? ['--add-dir', ctx.runDir] : []),
        ...(ctx.model ? ['--model', ctx.model] : []),
        '--print',
        prompt,
      ],
      cwd: ctx.cwd,
    };
  },
  parse(out) {
    const j = lastJsonObject(out.stdout);
    let text = out.stdout;
    let isError = false;
    if (j && typeof j === 'object') {
      text = String(j.result ?? j.response ?? j.text ?? j.output ?? j.message ?? out.stdout);
      isError = !!(j.is_error ?? j.isError ?? j.error) || (typeof j.status === 'string' && j.status.toUpperCase() !== 'SUCCESS');
    }
    return finalize(out.exitCode === 0 && !isError && text.trim().length > 0, text, `${j?.error ? JSON.stringify(j.error) : ''}\n${out.spawnError ?? ''}\n${tail(out.stderr)}`);
  },
};

const hermes: Adapter = {
  id: 'hermes',
  verified: true,
  canReadVault: () => false,
  build(bin, ctx) {
    // `chat --query-file` + `-Q` answers once and exits. Never `-z/--oneshot` (it forces YOLO approvals)
    // and never `--yolo`. No model or provider: Hermes picks its own free model.
    // Read-only gets no file or terminal tools (Hermes has no read-only file toolset and no sandbox).
    const toolsets = ctx.mode === 'read-only' ? 'web,todo' : 'file,todo';
    return {
      command: bin.command,
      args: [
        ...bin.prefixArgs,
        'chat',
        '--query-file',
        ctx.promptFile,
        '-Q',
        '--source',
        'tool',
        '-t',
        toolsets,
        '--run-budget',
        String(Math.max(30, ctx.timeoutSec - 10)),
        '--in',
        ctx.cwd,
      ],
      cwd: ctx.cwd,
      env: { HERMES_YOLO_MODE: undefined, HERMES_INTERACTIVE: undefined, HERMES_EXEC_ASK: undefined, PYTHONIOENCODING: 'utf-8' },
    };
  },
  parse(out) {
    const text = out.stdout
      .split(/\r?\n/)
      .filter((l) => !/^\s*(session[_ ]id|session)\s*[:=]/i.test(l))
      .join('\n');
    return finalize(out.exitCode === 0 && text.trim().length > 0, text, `${out.spawnError ?? ''}\n${tail(out.stderr)}`);
  },
};

const cursor: Adapter = {
  id: 'cursor',
  verified: false,
  canReadVault: () => true,
  build(bin, ctx) {
    // Without --force, cursor-agent in print mode does not apply writes it was not allowed to make.
    const longPrompt = ctx.promptText.length > MAX_ARG_PROMPT;
    const prompt = longPrompt ? `Read the full task, including its rules, from ${ctx.promptFile} and follow it exactly.` : ctx.promptText;
    return {
      command: bin.command,
      args: [...bin.prefixArgs, '-p', '--output-format', 'json', ...(ctx.model ? ['--model', ctx.model] : []), prompt],
      cwd: ctx.cwd,
    };
  },
  parse(out) {
    const j = lastJsonObject(out.stdout);
    const text = j && typeof j === 'object' ? String(j.result ?? j.text ?? out.stdout) : out.stdout;
    const isError = !!(j && (j.is_error || j.subtype === 'error'));
    return finalize(out.exitCode === 0 && !isError && text.trim().length > 0, text, `${out.spawnError ?? ''}\n${tail(out.stderr)}`);
  },
};

export const ADAPTERS: Record<AgentId, Adapter> = { claude, codex, antigravity, hermes, cursor };
