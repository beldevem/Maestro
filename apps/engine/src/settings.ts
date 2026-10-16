import type { Store } from './db.js';

/** Number settings: their default and the smallest value that makes sense. */
export const NUMBER_SETTINGS: Record<string, { fallback: number; min: number; integer?: boolean }> = {
  maxConcurrentRuns: { fallback: 3, min: 1, integer: true },
  // Budgets count tokens first: a euro cap never stops a free local model. 0 means no limit.
  'budget.perRunTokens': { fallback: 2_000_000, min: 0, integer: true },
  'budget.projectDailyTokens': { fallback: 20_000_000, min: 0, integer: true },
  // Optional euro caps on top, from each provider's prices.
  'budget.perRunEur': { fallback: 0, min: 0 },
  'budget.projectDailyEur': { fallback: 0, min: 0 },
  // Optional: tokens one person's work may use per day (their runs, chat and planning). 0 means no limit.
  'budget.userDailyTokens': { fallback: 0, min: 0, integer: true },
  // A rough rate for showing estimates in euros; no live rate is fetched.
  'currency.eurPerUsd': { fallback: 0.9, min: 0 },
  'worktrees.keepDays': { fallback: 3, min: -1, integer: true },
};

/**
 * A number setting, falling back to its default when it is unset or not a valid number
 * (an empty or "null" value must never turn a limit off).
 */
export function numberSetting(store: Store, key: string, fallback = NUMBER_SETTINGS[key]?.fallback ?? 0): number {
  const raw = store.getSetting(key);
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const spec = NUMBER_SETTINGS[key];
  return Number.isFinite(n) && (!spec || n >= spec.min) ? n : fallback;
}

/** Why a value can't be saved for this setting, or null when it can. */
export function invalidSetting(key: string, value: string): string | null {
  const spec = NUMBER_SETTINGS[key];
  if (!spec) return null;
  const n = value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return `${key} must be a number.`;
  if (n < spec.min) return `${key} must be at least ${spec.min}.`;
  if (spec.integer && !Number.isInteger(n)) return `${key} must be a whole number.`;
  return null;
}
