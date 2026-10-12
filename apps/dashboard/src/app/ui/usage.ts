import { Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { Api } from '../api';
import type { Caps, Spent, Usage } from '../models';

/** The rough USD → EUR rate from Settings, loaded once and shared. */
@Injectable({ providedIn: 'root' })
export class Currency {
  private readonly api = inject(Api);
  readonly eurPerUsd = signal(0.9);
  private loaded = false;

  load(force = false): void {
    if (this.loaded && !force) return;
    this.loaded = true;
    void this.api.currency?.().then((c) => this.eurPerUsd.set(c.eurPerUsd), () => undefined);
  }
}

export const totalTokens = (u: Usage | null | undefined): number | null => (u ? u.input + u.output + u.cache : null);

/** "1.24M tokens", "8.4k tokens", "n/a" for unknown. */
export function formatTokens(tokens: number | null | undefined, unit = true): string {
  if (tokens === null || tokens === undefined) return 'n/a';
  const suffix = unit ? ' tokens' : '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M${suffix}`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k${suffix}`;
  return `${tokens}${suffix}`;
}

/** "≈ €0.43", "≈ €0 (local)" when tokens were used at no price, '' when nothing is known. */
export function eurEstimate(usd: number, usage: Usage | null | undefined, rate: number): string {
  if (usd > 0) {
    const eur = usd * rate;
    return `≈ €${eur < 0.01 ? '<0.01' : eur.toFixed(2)}`;
  }
  return totalTokens(usage) ? '≈ €0 (local)' : '';
}

/** "12,345 in · 678 out · 9,000 cache". */
export function usageBreakdown(u: Usage | null | undefined): string {
  if (!u) return 'No token counts for this (from before token tracking, or the provider reports none).';
  const f = (n: number) => n.toLocaleString('en-US');
  return `${f(u.input)} in · ${f(u.output)} out${u.cache ? ` · ${f(u.cache)} cache` : ''}`;
}

/** "2M tokens or €5.00", "no limit". */
export function describeCaps(c: Caps | null | undefined): string {
  if (!c) return '';
  const parts = [c.tokens > 0 ? formatTokens(c.tokens) : '', c.eur > 0 ? `€${c.eur.toFixed(2)}` : ''].filter(Boolean);
  return parts.length ? parts.join(' or ') : 'no limit';
}

/** Tokens as the main figure (in/out in the tooltip), with a rough euro estimate in grey beside it. */
@Component({
  selector: 'app-usage',
  template: `<span class="usage"><span class="usage-tokens" [title]="breakdown()">{{ tokens() }}</span>@if (estimate()) {<span class="usage-eur" title="A rough estimate from the provider's prices and the USD → EUR rate in Settings">{{ estimate() }}</span>}</span>`,
})
export class UsageView {
  private readonly currency = inject(Currency);
  readonly usage = input<Usage | null | undefined>(null);
  readonly usd = input(0);
  readonly tokens = computed(() => formatTokens(totalTokens(this.usage())));
  readonly breakdown = computed(() => usageBreakdown(this.usage()));
  readonly estimate = computed(() => eurEstimate(this.usd(), this.usage(), this.currency.eurPerUsd()));

  constructor() {
    this.currency.load();
  }
}

/** Whether spend has reached either cap (the engine's rule, for warnings). */
export function overCaps(spent: Spent | null | undefined, caps: Caps | null | undefined, rate: number): boolean {
  if (!spent || !caps) return false;
  return (caps.tokens > 0 && (totalTokens(spent.usage) ?? 0) >= caps.tokens) || (caps.eur > 0 && spent.usd * rate >= caps.eur);
}
