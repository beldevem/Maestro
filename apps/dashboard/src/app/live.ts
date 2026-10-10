import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';
import type { Agent, Review, Run, RunEvent } from './models';

/** Keeps agents and runs current from the engine's event stream. */
@Injectable({ providedIn: 'root' })
export class Live {
  private readonly api = inject(Api);
  readonly agents = signal<Agent[]>([]);
  readonly runs = signal<Run[]>([]);
  readonly connected = signal(false);
  private readonly listeners = new Set<(e: RunEvent) => void>();
  private readonly reviewListeners = new Set<(r: Review) => void>();
  private source?: EventSource;

  start(): void {
    if (this.source) return;
    void this.refresh();
    this.source = new EventSource('/api/events');
    this.source.onopen = () => {
      this.connected.set(true);
      void this.refresh();
    };
    this.source.onerror = () => this.connected.set(false);
    this.source.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.type === 'agent') this.upsert(this.agents, e.agent as Agent);
      if (e.type === 'run') this.upsert(this.runs, e.run as Run, true);
      if (e.type === 'run_event') this.listeners.forEach((l) => l(e.event as RunEvent));
      if (e.type === 'review') this.reviewListeners.forEach((l) => l(e.review as Review));
    };
  }

  async refresh(): Promise<void> {
    const [agents, runs] = await Promise.all([this.api.agents(), this.api.runs()]);
    this.agents.set(agents);
    this.runs.set(runs);
  }

  onReview(fn: (r: Review) => void): () => void {
    this.reviewListeners.add(fn);
    return () => this.reviewListeners.delete(fn);
  }

  onRunEvent(fn: (e: RunEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private upsert<T extends { id: string }>(list: ReturnType<typeof signal<T[]>>, item: T, prepend = false): void {
    list.update((xs) => {
      const i = xs.findIndex((x) => x.id === item.id);
      if (i >= 0) return xs.map((x, j) => (j === i ? item : x));
      return prepend ? [item, ...xs] : [...xs, item];
    });
  }
}
