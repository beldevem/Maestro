import type { Review, Run } from './types.js';

export interface TicketMetrics {
  ticketKey: string;
  ticketTitle: string;
  runs: number;
  costUsd: number;
  fixAttempts: number;
  reviewRounds: number;
  /** Latest run's status. */
  status: Run['status'];
  /** Start of the first run to the end of the run that finished it, when it is done. */
  cycleTimeMs: number | null;
}

export interface Metrics {
  runs: number;
  /** Finished runs that produced a change ready for review, out of all finished runs. */
  successRate: number | null;
  finished: number;
  byStatus: Partial<Record<Run['status'], number>>;
  /** Mean time from a run starting to its change being ready for review. */
  meanTimeToPrMs: number | null;
  /** Mean time from a ticket's first run to done. */
  meanCycleTimeMs: number | null;
  /** Share of reviewed runs the reviewer agent approved on its first look. */
  firstPassReviewRate: number | null;
  meanFixAttempts: number | null;
  meanReviewRounds: number | null;
  totalCostUsd: number;
  costPerTicketUsd: number | null;
  tickets: TicketMetrics[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ms = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();

/** Metrics over the given runs (and their reviews), for one project or all. */
export function computeMetrics(runs: Run[], reviewsOf: (runId: string) => Review[]): Metrics {
  const finished = runs.filter((r) => !['running', 'reviewing'].includes(r.status));
  const succeeded = finished.filter((r) => r.readyAt || ['in_review', 'done'].includes(r.status));
  const byStatus: Metrics['byStatus'] = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const firstVerdicts = runs.map((r) => reviewsOf(r.id).find((v) => v.source === 'agent')?.verdict).filter(Boolean);

  const groups = new Map<string, Run[]>();
  for (const r of runs) groups.set(r.ticketKey, [...(groups.get(r.ticketKey) ?? []), r]);
  const tickets: TicketMetrics[] = [...groups.values()].map((rs) => {
    const sorted = [...rs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const last = sorted.at(-1)!;
    const done = sorted.find((r) => r.status === 'done' && r.endedAt);
    return {
      ticketKey: last.ticketKey,
      ticketTitle: last.ticketTitle,
      runs: rs.length,
      costUsd: rs.reduce((a, r) => a + r.costUsd, 0),
      fixAttempts: rs.reduce((a, r) => a + r.attempts, 0),
      reviewRounds: rs.reduce((a, r) => a + r.reviewRounds, 0),
      status: last.status,
      cycleTimeMs: done ? ms(sorted[0].startedAt, done.endedAt!) : null,
    };
  });
  tickets.sort((a, b) => b.costUsd - a.costUsd);

  const totalCostUsd = runs.reduce((a, r) => a + r.costUsd, 0);
  return {
    runs: runs.length,
    finished: finished.length,
    successRate: finished.length ? succeeded.length / finished.length : null,
    byStatus,
    meanTimeToPrMs: mean(runs.filter((r) => r.readyAt).map((r) => ms(r.startedAt, r.readyAt!))),
    meanCycleTimeMs: mean(tickets.map((t) => t.cycleTimeMs).filter((x): x is number => x !== null)),
    firstPassReviewRate: firstVerdicts.length ? firstVerdicts.filter((v) => v === 'approve').length / firstVerdicts.length : null,
    meanFixAttempts: mean(finished.map((r) => r.attempts)),
    meanReviewRounds: mean(finished.map((r) => r.reviewRounds)),
    totalCostUsd,
    costPerTicketUsd: tickets.length ? totalCostUsd / tickets.length : null,
    tickets,
  };
}
