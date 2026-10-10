import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import type { Agent, Alert, Review, Run, RunEvent } from './models';

/** Keeps agents and runs current from the engine's event stream. */
@Injectable({ providedIn: 'root' })
export class Live {
  private readonly api = inject(Api);
  readonly agents = signal<Agent[]>([]);
  readonly runs = signal<Run[]>([]);
  readonly connected = signal(false);
  readonly alerts = signal<Alert[]>([]);
  readonly unread = computed(() => this.alerts().filter((a) => !a.read).length);
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
      if (e.type === 'alert') this.onAlert(e.alert as Alert);
    };
  }

  async refresh(): Promise<void> {
    const [agents, runs, alerts] = await Promise.all([this.api.agents(), this.api.runs(), this.api.alerts().catch(() => ({ alerts: [] }))]);
    this.agents.set(agents);
    this.runs.set(runs);
    this.alerts.set(alerts.alerts);
  }

  async markAllRead(): Promise<void> {
    await this.api.markAlertsRead();
    this.alerts.update((xs) => xs.map((a) => ({ ...a, read: true })));
  }

  /** Desktop notifications are opt-in per browser (Settings). */
  get notifyEnabled(): boolean {
    try {
      return localStorage.getItem('maestro.notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch {
      return false;
    }
  }

  private onAlert(alert: Alert): void {
    this.alerts.update((xs) => [alert, ...xs].slice(0, 50));
    if (!this.notifyEnabled) return;
    const title = { blocked: 'Agent blocked', failed: 'Run failed', budget: 'Budget reached', ready: 'Ready for review' }[alert.kind];
    const n = new Notification(`Maestro: ${title}`, { body: alert.message, tag: `maestro-${alert.id}` });
    n.onclick = () => {
      window.focus();
      if (alert.runId) location.assign(`/runs/${alert.runId}`);
    };
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
