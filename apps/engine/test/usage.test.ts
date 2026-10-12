import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/metrics.js';
import { Store } from '../src/db.js';
import type { Run } from '../src/types.js';
import { addUsage, formatTokens, toEur, totalTokens, usageFromClaude, usageFromCliText, usageFromOpenAI } from '../src/usage.js';

const tmpStore = () => new Store(join(mkdtempSync(join(tmpdir(), 'maestro-usage-')), 'db.sqlite'));

describe('token usage', () => {
  it('reads OpenAI-compatible usage, counting cached prompt tokens as cache', () => {
    expect(usageFromOpenAI({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 300 } })).toEqual({ input: 700, output: 200, cache: 300 });
    expect(usageFromOpenAI({ prompt_tokens: 50, completion_tokens: 5 })).toEqual({ input: 50, output: 5, cache: 0 });
    expect(usageFromOpenAI(undefined)).toBeNull();
  });

  it("reads the Agent SDK's usage, with cache reads and writes", () => {
    expect(usageFromClaude({ input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000 })).toEqual({ input: 10, output: 400, cache: 10_000 });
    expect(usageFromClaude({})).toBeNull();
  });

  it('reads token counts a CLI prints, and null when it prints none', () => {
    expect(usageFromCliText('done.\nTokens: 12,345 input, 678 output')).toEqual({ input: 12_345, output: 678, cache: 0 });
    expect(usageFromCliText('input tokens: 1.2k\noutput tokens: 300\ncached tokens: 50')).toEqual({ input: 1200, output: 300, cache: 50 });
    expect(usageFromCliText('[codex] tokens used: 4,567')).toEqual({ input: 4567, output: 0, cache: 0 });
    expect(usageFromCliText('All tests pass.')).toBeNull();
  });

  it('adds usages, skipping unknown parts, and stays unknown when nothing was known', () => {
    expect(addUsage({ input: 1, output: 2, cache: 3 }, null, { input: 10, output: 0, cache: 0 })).toEqual({ input: 11, output: 2, cache: 3 });
    expect(addUsage(null, undefined)).toBeNull();
    expect(totalTokens({ input: 1, output: 2, cache: 3 })).toBe(6);
    expect(totalTokens(null)).toBe(0);
  });

  it('formats tokens compactly', () => {
    expect([999, 1000, 8_440, 123_456, 1_240_000, 2_000_000, 15_300_000].map(formatTokens)).toEqual([
      '999 tokens', '1k tokens', '8.4k tokens', '123k tokens', '1.24M tokens', '2M tokens', '15.3M tokens',
    ]);
    expect(formatTokens(null)).toBe('n/a');
  });

  it('estimates euros from USD with the rate in Settings', () => {
    const store = tmpStore();
    expect(toEur(store, 1)).toBeCloseTo(0.9);
    store.setSetting('currency.eurPerUsd', '0.85');
    expect(toEur(store, 2)).toBeCloseTo(1.7);
  });

  it('sums the spend ledger by tokens, keeping entries without tokens unknown', () => {
    const store = tmpStore();
    store.addSpend('p', null, 'chat', 0.5);
    expect(store.spendSince('p', '')).toEqual({ usd: 0.5, usage: null });
    store.addSpend('p', 'r', 'worker', 0, { input: 100, output: 20, cache: 5 });
    store.addSpend('p', 'r', 'reviewer', 0.1, { input: 50, output: 10, cache: 0 });
    store.addSpend('q', null, 'chat', 0, null);
    expect(store.spendSince('p', '')).toEqual({ usd: 0.6, usage: { input: 150, output: 30, cache: 5 } });
    expect([...store.spendByProject().keys()]).toEqual(['p']);
  });

  it('totals tokens per ticket in the metrics', () => {
    const base = { projectId: 'p', agentId: 'a', branch: 'b', worktree: '', attempts: 0, costUsd: 0, prUrl: null, error: null, area: null, sessionId: null, baseRef: null, prNumber: null, reviewRounds: 0, checks: null, readyAt: null, startedAt: '2026-10-10T00:00:00Z', endedAt: null };
    const runs: Run[] = [
      { ...base, id: 'a', ticketKey: 'T-1', ticketTitle: 'one', status: 'failed', usage: { input: 1000, output: 100, cache: 0 } },
      { ...base, id: 'b', ticketKey: 'T-1', ticketTitle: 'one', status: 'done', usage: { input: 2000, output: 900, cache: 0 } },
      { ...base, id: 'c', ticketKey: 'T-2', ticketTitle: 'two', status: 'in_review', usage: null },
    ];
    const m = computeMetrics(runs, () => []);
    expect(m.totalUsage).toEqual({ input: 3000, output: 1000, cache: 0 });
    expect(m.tokensPerTicket).toBe(4000);
    expect(m.tickets.map((t) => [t.ticketKey, t.usage && totalTokens(t.usage)])).toEqual([['T-1', 4000], ['T-2', null]]);
  });
});
