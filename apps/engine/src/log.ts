/**
 * The engine's logger: one line per event with a level, as text (default) or JSON
 * (MAESTRO_LOG_FORMAT=json). MAESTRO_LOG_LEVEL picks the least severe level shown (default info).
 * Anything that looks like a secret is masked before it is written.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|cookie|credential)/i;
const SECRET_VALUES: RegExp[] = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bfigd_[A-Za-z0-9_-]{16,}/g, // Figma
  /\bATATT[A-Za-z0-9_=-]{16,}/g, // Atlassian
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, // credentials in URLs
];
const known = new Set<string>();

/** Values that must never appear in logs, e.g. every secret the engine has loaded. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) known.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const v of known) out = out.split(v).join('***');
  for (const re of SECRET_VALUES) out = out.replace(re, (m, p1: string) => (p1 && /^https?:\/\/$/.test(p1) ? `${p1}***@` : p1 && /^(Bearer|Basic)$/i.test(p1) ? `${p1} ***` : '***'));
  return out;
}

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) out[k] = '***';
    else if (v instanceof Error) out[k] = redact(v.message);
    else if (typeof v === 'string') out[k] = redact(v);
    else if (v && typeof v === 'object') out[k] = clean(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

export interface Sink {
  write(line: string, level: Level): void;
}
const stdio: Sink = { write: (line, level) => (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`) };

export function createLogger(opts: { level?: string; format?: string; sink?: Sink } = {}) {
  const min = ORDER[(opts.level ?? process.env.MAESTRO_LOG_LEVEL ?? 'info').toLowerCase() as Level] ?? ORDER.info;
  const json = (opts.format ?? process.env.MAESTRO_LOG_FORMAT ?? 'text').toLowerCase() === 'json';
  const sink = opts.sink ?? stdio;
  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    const f = clean(fields);
    const m = redact(msg);
    const time = new Date().toISOString();
    if (json) sink.write(JSON.stringify({ time, level, msg: m, ...f }), level);
    else {
      const extra = Object.entries(f).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
      sink.write(`${time} ${level.toUpperCase().padEnd(5)} ${m}${extra ? ` ${extra}` : ''}`, level);
    }
  };
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  };
}

export const log = createLogger();
