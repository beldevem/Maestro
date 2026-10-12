import type { Store } from './db.js';
import { numberSetting } from './settings.js';
import { eur, formatTokens, toEur, totalTokens, type Usage } from './usage.js';

/** Midnight today on this machine, as an ISO timestamp. */
export function startOfToday(at = new Date()): string {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** A budget: tokens and, optionally, euros. 0 means no limit for either. */
export interface Caps {
  tokens: number;
  eur: number;
}

function own(store: Store, key: string): number | null {
  const raw = store.getSetting(key);
  const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The project's daily caps: its own settings, else the defaults for all projects. */
export function dailyCaps(store: Store, projectId: string): Caps {
  return {
    tokens: own(store, `budget.dailyTokens.${projectId}`) ?? numberSetting(store, 'budget.projectDailyTokens'),
    eur: own(store, `budget.dailyEur.${projectId}`) ?? numberSetting(store, 'budget.projectDailyEur'),
  };
}

export function perRunCaps(store: Store): Caps {
  return { tokens: numberSetting(store, 'budget.perRunTokens'), eur: numberSetting(store, 'budget.perRunEur') };
}

/** Why spending `usage` (and `usd`) is over `caps`, or null. Whichever cap is hit first counts. */
export function overCaps(store: Store, caps: Caps, usage: Usage | null, usd: number): string | null {
  const tokens = totalTokens(usage);
  if (caps.tokens > 0 && tokens >= caps.tokens) return formatTokens(caps.tokens);
  if (caps.eur > 0 && toEur(store, usd) >= caps.eur) return `≈ ${eur(caps.eur)}`;
  return null;
}

export function describeCaps(caps: Caps): string {
  const parts = [caps.tokens > 0 ? formatTokens(caps.tokens) : '', caps.eur > 0 ? eur(caps.eur) : ''].filter(Boolean);
  return parts.length ? parts.join(' or ') : 'no limit';
}

export interface BudgetState {
  usage: Usage | null;
  usd: number;
  caps: Caps;
  /** The cap that was reached, as text, or null. */
  over: string | null;
  /** Tokens and USD left today (Infinity without a cap). */
  tokensLeft: number;
  usdLeft: number;
}

export function budgetState(store: Store, projectId: string, at = new Date()): BudgetState {
  const { usage, usd } = store.spendSince(projectId, startOfToday(at));
  const caps = dailyCaps(store, projectId);
  const rate = toEur(store, 1);
  return {
    usage,
    usd,
    caps,
    over: overCaps(store, caps, usage, usd),
    tokensLeft: caps.tokens > 0 ? Math.max(0, caps.tokens - totalTokens(usage)) : Infinity,
    usdLeft: caps.eur > 0 && rate > 0 ? Math.max(0, caps.eur / rate - usd) : Infinity,
  };
}
