import type { Store } from './db.js';
import { numberSetting } from './settings.js';

/** Midnight today on this machine, as an ISO timestamp. */
export function startOfToday(at = new Date()): string {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** The project's daily cap in USD: its own setting, else the default for all projects. 0 means no cap. */
export function dailyCap(store: Store, projectId: string): number {
  const own = store.getSetting(`budget.daily.${projectId}`);
  const n = own?.trim() ? Number(own) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : numberSetting(store, 'budget.projectDailyUsd');
}

export interface BudgetState {
  spentToday: number;
  cap: number;
  /** USD left today, or Infinity with no cap. */
  remaining: number;
  over: boolean;
}

export function budgetState(store: Store, projectId: string, at = new Date()): BudgetState {
  const spentToday = store.spendSince(projectId, startOfToday(at));
  const cap = dailyCap(store, projectId);
  const remaining = cap > 0 ? Math.max(0, cap - spentToday) : Infinity;
  return { spentToday, cap, remaining, over: cap > 0 && spentToday >= cap };
}

export function perRunCap(store: Store): number {
  return numberSetting(store, 'budget.perRunUsd');
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
