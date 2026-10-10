import type { Store } from './db.js';

/** Midnight today on this machine, as an ISO timestamp. */
export function startOfToday(at = new Date()): string {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** The project's daily cap in USD: its own setting, else the default for all projects. 0 means no cap. */
export function dailyCap(store: Store, projectId: string): number {
  return Number(store.getSetting(`budget.daily.${projectId}`) ?? store.getSetting('budget.projectDailyUsd') ?? 0) || 0;
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
  return Number(store.getSetting('budget.perRunUsd') ?? 5) || 0;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
