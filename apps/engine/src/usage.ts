import type { Store } from './db.js';
import { numberSetting } from './settings.js';

/** Tokens one or more agent calls used. Cache counts tokens read from or written to a prompt cache. */
export interface Usage {
  input: number;
  output: number;
  cache: number;
}

export const ZERO: Usage = { input: 0, output: 0, cache: 0 };

export function totalTokens(u: Usage | null | undefined): number {
  return u ? u.input + u.output + u.cache : 0;
}

/** Sums usages; unknown (null) parts are skipped, and the result is null only when nothing was known. */
export function addUsage(...parts: (Usage | null | undefined)[]): Usage | null {
  const known = parts.filter((p): p is Usage => !!p);
  if (!known.length) return null;
  return known.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, cache: a.cache + b.cache }), ZERO);
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** OpenAI-style `usage`: prompt tokens include cached ones, which are counted as cache here. */
export function usageFromOpenAI(u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined): Usage | null {
  if (!u || (u.prompt_tokens === undefined && u.completion_tokens === undefined)) return null;
  const cache = n(u.prompt_tokens_details?.cached_tokens);
  return { input: Math.max(0, n(u.prompt_tokens) - cache), output: n(u.completion_tokens), cache };
}

/** The Agent SDK's result `usage` (Anthropic Messages fields). */
export function usageFromClaude(u: Record<string, unknown> | undefined): Usage | null {
  if (!u || (u.input_tokens === undefined && u.output_tokens === undefined)) return null;
  return { input: n(u.input_tokens), output: n(u.output_tokens), cache: n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) };
}

const num = (s: string) => {
  const m = s.trim().toLowerCase().match(/^([\d.,]+)\s*([km])?$/);
  if (!m) return 0;
  const base = Number(m[1].replace(/,/g, ''));
  return Math.round(base * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1));
};

/**
 * Token counts a coding CLI printed, when it prints them: "Tokens: 1,234 input, 567 output",
 * "input tokens: 1234", "tokens used: 12,345" (a total, counted as input). Null when there are none.
 */
export function usageFromCliText(text: string): Usage | null {
  const tail = text.slice(-4000);
  const NUM = '([\\d][\\d.,]*\\s*[kKmM]?)';
  const find = (labels: string) =>
    tail.match(new RegExp(`(?:${labels})[ _-]?tokens?\\s*[:=]?\\s*${NUM}`, 'i'))?.[1] ?? tail.match(new RegExp(`${NUM}\\s*(?:${labels})(?:[ _-]?tokens?)?\\b`, 'i'))?.[1];
  const input = find('input|prompt');
  const output = find('output|completion');
  const cache = find('cached|cache[ _-]?read');
  if (input || output) return { input: input ? num(input) : 0, output: output ? num(output) : 0, cache: cache ? num(cache) : 0 };
  const total = tail.match(new RegExp(`tokens?\\s+used\\s*[:=]?\\s*${NUM}`, 'i'))?.[1] ?? tail.match(new RegExp(`total[ _-]?tokens?\\s*[:=]?\\s*${NUM}`, 'i'))?.[1];
  return total ? { input: num(total), output: 0, cache: 0 } : null;
}

/** The rough USD → EUR rate from Settings (no live rate is fetched). */
export function eurPerUsd(store: Store): number {
  return numberSetting(store, 'currency.eurPerUsd');
}

export function toEur(store: Store, usd: number): number {
  return usd * eurPerUsd(store);
}

/** "1.24M tokens", "8.4k tokens", "n/a" for unknown. */
export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return 'n/a';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k tokens`;
  return `${tokens} tokens`;
}

export const eur = (n: number) => `€${n.toFixed(2)}`;
