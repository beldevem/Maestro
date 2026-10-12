import { Component, effect, inject, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { RUN_LABEL, type Metrics, type Project } from '../models';
import { UsageView, formatTokens } from '../ui/usage';

/** "2h 05m", "3d 4h", "12m" */
export function duration(ms: number | null): string {
  if (ms === null) return '–';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How agents are doing: success, speed, review quality and cost, from the runs. */
@Component({
  selector: 'app-metrics',
  imports: [UsageView, FormsModule, DecimalPipe, PercentPipe],
  template: `
    <header class="page-head">
      <h1>Metrics</h1>
      <div class="row">
        <select [ngModel]="projectId()" (ngModelChange)="projectId.set($event)" name="project" aria-label="Project">
          <option value="">All projects</option>
          @for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
        </select>
        <select [ngModel]="days()" (ngModelChange)="days.set(+$event)" name="days" aria-label="Period">
          <option [value]="0">All time</option>
          <option [value]="30">Last 30 days</option>
          <option [value]="7">Last 7 days</option>
        </select>
      </div>
    </header>
    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (m(); as m) {
      @if (m.runs === 0) {
        <p class="empty">No runs in this period yet.</p>
      } @else {
        <div class="tiles">
          <div class="tile"><span class="tile-label">Runs</span><span class="tile-value">{{ m.runs }}</span><span class="tile-note">{{ m.finished }} finished</span></div>
          <div class="tile"><span class="tile-label">Success rate</span><span class="tile-value">{{ m.successRate === null ? '–' : (m.successRate | percent) }}</span><span class="tile-note">finished runs that reached review</span></div>
          <div class="tile"><span class="tile-label">Mean time to PR</span><span class="tile-value">{{ fmt(m.meanTimeToPrMs) }}</span><span class="tile-note">run start to ready for review</span></div>
          <div class="tile"><span class="tile-label">Mean cycle time</span><span class="tile-value">{{ fmt(m.meanCycleTimeMs) }}</span><span class="tile-note">first run to done</span></div>
          <div class="tile"><span class="tile-label">First-pass review</span><span class="tile-value">{{ m.firstPassReviewRate === null ? '–' : (m.firstPassReviewRate | percent) }}</span><span class="tile-note">approved by the reviewer agent at once</span></div>
          <div class="tile"><span class="tile-label">Fix attempts</span><span class="tile-value">{{ m.meanFixAttempts === null ? '–' : (m.meanFixAttempts | number: '1.1-1') }}</span><span class="tile-note">per finished run</span></div>
          <div class="tile"><span class="tile-label">Review rounds</span><span class="tile-value">{{ m.meanReviewRounds === null ? '–' : (m.meanReviewRounds | number: '1.1-1') }}</span><span class="tile-note">per finished run</span></div>
          <div class="tile"><span class="tile-label">Usage per ticket</span><span class="tile-value">{{ m.tokensPerTicket === null ? 'n/a' : formatTokens(m.tokensPerTicket) }}</span><span class="tile-note"><app-usage [usage]="m.totalUsage" [usd]="m.totalCostUsd" /> in total</span></div>
        </div>

        <h2>Tickets</h2>
        <table class="table">
          <thead><tr><th>Ticket</th><th>Status</th><th class="num">Runs</th><th class="num">Fix attempts</th><th class="num">Review rounds</th><th class="num">Cycle time</th><th class="num">Usage</th></tr></thead>
          <tbody>
            @for (t of m.tickets; track t.ticketKey) {
              <tr>
                <td>{{ t.ticketKey }} {{ t.ticketTitle }}</td>
                <td><span class="run run-{{ t.status }}">{{ runLabel[t.status] }}</span></td>
                <td class="num">{{ t.runs }}</td>
                <td class="num">{{ t.fixAttempts }}</td>
                <td class="num">{{ t.reviewRounds }}</td>
                <td class="num">{{ fmt(t.cycleTimeMs) }}</td>
                <td class="num"><app-usage [usage]="t.usage" [usd]="t.costUsd" /></td>
              </tr>
            }
          </tbody>
        </table>
      }
    } @else {
      <p class="empty">Loading…</p>
    }
  `,
})
export class MetricsPage {
  readonly formatTokens = formatTokens;
  private readonly api = inject(Api);
  readonly runLabel = RUN_LABEL;
  readonly fmt = duration;
  readonly projects = signal<Project[]>([]);
  readonly projectId = signal('');
  readonly days = signal(0);
  readonly m = signal<Metrics | null>(null);
  readonly error = signal('');

  constructor() {
    void this.api.projects().then((ps) => this.projects.set(ps));
    effect(() => {
      const projectId = this.projectId();
      const days = this.days();
      this.api.metrics(projectId || undefined, days).then(
        (m) => {
          this.m.set(m);
          this.error.set('');
        },
        (e) => this.error.set((e as Error).message),
      );
    });
  }
}
