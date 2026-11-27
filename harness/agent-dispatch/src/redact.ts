/**
 * Strip anything that looks like a secret before text reaches a log, the vault or an MCP reply.
 * Heuristic by design: it prefers false positives over leaks.
 */

const R = '[REDACTED]';

const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // PEM private keys (whole block).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  // Provider keys with recognisable prefixes.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, R],
  [/\bsk-(?:or-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bwhsec_[A-Za-z0-9+/=_-]{10,}/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, R],
  [/\bnpm_[A-Za-z0-9]{30,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{35,}/g, R],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, R],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  // Credentials inside URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${R}@`],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, (_m, kind) => `${kind} ${R}`],
  // key = value / key: value / "key": "value" for secret-looking key names.
  [
    /((?:["']?)[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credential|session[_-]?key|database_url|connection[_-]?string)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)(?![0-9]+(?:["',;}\s]|$))([^\s"',;}{]{6,})(["']?)/gi,
    (_m, lead, q1, _value, q2) => `${lead}${q1}${R}${q2}`,
  ],
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as any);
  return out;
}
