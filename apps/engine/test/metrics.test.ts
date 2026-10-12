import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/metrics.js';
import type { Review, Run } from '../src/types.js';

const H = 3_600_000;
const at = (h: number) => new Date(Date.UTC(2026, 9, 10, 0, 0, 0) + h * H).toISOString();

function run(over: Partial<Run> & Pick<Run, 'id' | 'ticketKey' | 'status'>): Run {
  return {
    projectId: 'p', agentId: 'a', ticketTitle: over.ticketKey, branch: 'b', worktree: '', attempts: 0, costUsd: 0, usage: null, prUrl: null, error: null,
    area: null, sessionId: null, baseRef: null, prNumber: null, reviewRounds: 0, checks: null, readyAt: null, startedAt: at(0), endedAt: null, ...over,
  };
}
const review = (runId: string, verdict: Review['verdict'], source: Review['source'] = 'agent'): Review => ({
  id: `${runId}-${verdict}`, runId, source, verdict, summary: '', comments: [], author: null, externalId: null, addressed: true, costUsd: 0, createdAt: at(0),
});

describe('metrics', () => {
  const runs: Run[] = [
    // T-1: failed once, then done; first agent review asked for changes.
    run({ id: 'r1', ticketKey: 'T-1', status: 'failed', costUsd: 1, attempts: 3, startedAt: at(0), endedAt: at(1) }),
    run({ id: 'r2', ticketKey: 'T-1', status: 'done', costUsd: 2, attempts: 1, reviewRounds: 1, startedAt: at(2), readyAt: at(4), endedAt: at(10) }),
    // T-2: approved on first review, waiting for you.
    run({ id: 'r3', ticketKey: 'T-2', status: 'in_review', costUsd: 0.5, startedAt: at(1), readyAt: at(3), endedAt: at(3) }),
    // T-3: still running; not counted as finished.
    run({ id: 'r4', ticketKey: 'T-3', status: 'running', costUsd: 0.5, startedAt: at(5) }),
  ];
  const reviews: Record<string, Review[]> = {
    r2: [review('r2', 'changes_requested'), review('r2', 'approve'), review('r2', 'approve', 'human')],
    r3: [review('r3', 'approve')],
  };
  const m = computeMetrics(runs, (id) => reviews[id] ?? []);

  it('counts runs and success over finished runs', () => {
    expect(m.runs).toBe(4);
    expect(m.finished).toBe(3);
    expect(m.successRate).toBeCloseTo(2 / 3);
    expect(m.byStatus).toEqual({ failed: 1, done: 1, in_review: 1, running: 1 });
  });

  it('measures time to PR, cycle time and the first-pass review rate', () => {
    expect(m.meanTimeToPrMs).toBe(2 * H);
    expect(m.meanCycleTimeMs).toBe(10 * H);
    expect(m.firstPassReviewRate).toBe(0.5);
  });

  it('averages fix attempts and review rounds, and costs per ticket', () => {
    expect(m.meanFixAttempts).toBeCloseTo(4 / 3);
    expect(m.meanReviewRounds).toBeCloseTo(1 / 3);
    expect(m.totalCostUsd).toBe(4);
    expect(m.costPerTicketUsd).toBeCloseTo(4 / 3);
    expect(m.tickets.map((t) => [t.ticketKey, t.runs, t.costUsd, t.fixAttempts, t.status, t.cycleTimeMs])).toEqual([
      ['T-1', 2, 3, 4, 'done', 10 * H],
      ['T-2', 1, 0.5, 0, 'in_review', null],
      ['T-3', 1, 0.5, 0, 'running', null],
    ]);
  });

  it('has empty values with no runs', () => {
    expect(computeMetrics([], () => [])).toMatchObject({ runs: 0, successRate: null, meanTimeToPrMs: null, costPerTicketUsd: null, tickets: [] });
  });
});
