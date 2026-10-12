import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Api } from '../api';
import type { Usage } from '../models';
import { describeCaps, eurEstimate, formatTokens, overCaps, usageBreakdown, UsageView } from './usage';

describe('usage formatting', () => {
  it('shows tokens compactly, and n/a when unknown', () => {
    expect([0, 999, 1000, 8_440, 123_456, 1_240_000, 2_000_000, 15_300_000].map((n) => formatTokens(n))).toEqual([
      '0 tokens', '999 tokens', '1k tokens', '8.4k tokens', '123k tokens', '1.24M tokens', '2M tokens', '15.3M tokens',
    ]);
    expect(formatTokens(null)).toBe('n/a');
    expect(formatTokens(2_500_000, false)).toBe('2.5M');
  });

  it('estimates euros with the rate, and calls free token use local', () => {
    const u: Usage = { input: 10, output: 5, cache: 0 };
    expect(eurEstimate(0.48, u, 0.9)).toBe('≈ €0.43');
    expect(eurEstimate(0.001, u, 0.9)).toBe('≈ €<0.01');
    expect(eurEstimate(0, u, 0.9)).toBe('≈ €0 (local)');
    expect(eurEstimate(0, null, 0.9)).toBe('');
  });

  it('breaks tokens down for the tooltip, and describes caps', () => {
    expect(usageBreakdown({ input: 12_345, output: 678, cache: 9_000 })).toBe('12,345 in · 678 out · 9,000 cache');
    expect(usageBreakdown(null)).toMatch(/No token counts/);
    expect(describeCaps({ tokens: 2_000_000, eur: 5 })).toBe('2M tokens or €5.00');
    expect(describeCaps({ tokens: 0, eur: 0 })).toBe('no limit');
  });

  it('warns at whichever cap is reached first', () => {
    const caps = { tokens: 1000, eur: 1 };
    expect(overCaps({ usd: 0, usage: { input: 900, output: 100, cache: 0 } }, caps, 0.9)).toBe(true);
    expect(overCaps({ usd: 1.2, usage: null }, caps, 0.9)).toBe(true);
    expect(overCaps({ usd: 1, usage: { input: 10, output: 0, cache: 0 } }, caps, 0.9)).toBe(false);
  });
});

@Component({ imports: [UsageView], template: `<app-usage [usage]="usage()" [usd]="usd()" />` })
class Host {
  readonly usage = signal<Usage | null>({ input: 1_000_000, output: 240_000, cache: 0 });
  readonly usd = signal(0.48);
}

describe('UsageView', () => {
  it('shows tokens first with a grey euro estimate, using the rate from Settings', async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [{ provide: Api, useValue: { currency: () => Promise.resolve({ eurPerUsd: 0.5 }) } }] }).compileComponents();
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('.usage-tokens')?.textContent).toBe('1.24M tokens');
    expect(el.querySelector('.usage-tokens')?.getAttribute('title')).toBe('1,000,000 in · 240,000 out');
    expect(el.querySelector('.usage-eur')?.textContent).toBe('≈ €0.24');
    f.componentInstance.usage.set(null);
    f.componentInstance.usd.set(0);
    f.detectChanges();
    expect(el.querySelector('.usage-tokens')?.textContent).toBe('n/a');
    expect(el.querySelector('.usage-eur')).toBeNull();
  });
});
