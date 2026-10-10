import { Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { CHECKS_LABEL, RUN_LABEL, VERDICT_LABEL, type PullRequestRow } from '../models';

/** Every change waiting for or going through review, across projects. */
@Component({
  selector: 'app-pull-requests',
  imports: [RouterLink, DecimalPipe],
  template: `
    <header class="page-head">
      <h1>Pull requests</h1>
      <div class="row">
        <label class="toggle"><input type="checkbox" [checked]="showDone()" (change)="showDone.set($any($event.target).checked)" /> Show finished</label>
        <button (click)="checkNow()" [disabled]="checking()">{{ checking() ? 'Checking…' : 'Check now' }}</button>
      </div>
    </header>
    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (visible().length === 0) {
      <p class="empty">Nothing waiting for review. Changes show up here once a worker has finished a ticket.</p>
    } @else {
      <table class="table">
        <thead><tr><th>Ticket</th><th>Status</th><th>Pull request</th><th>CI</th><th>Reviewer agent</th><th>Open comments</th><th>Rounds</th><th>Cost</th></tr></thead>
        <tbody>
          @for (r of visible(); track r.id) {
            <tr>
              <td><a [routerLink]="['/runs', r.id]">{{ r.ticketKey }}</a> {{ r.ticketTitle }}<div class="meta">{{ r.projectName }}</div></td>
              <td><span class="run run-{{ r.status }}">{{ runLabel[r.status] }}</span></td>
              <td>
                @if (r.prUrl) { <a [href]="r.prUrl" target="_blank" rel="noopener">#{{ r.prNumber }}</a> }
                @else { <span class="mono meta">{{ r.branch }}</span> }
              </td>
              <td>@if (r.checks) { <span class="checks-{{ r.checks }}">{{ checksLabel[r.checks] }}</span> } @else { <span class="muted">–</span> }</td>
              <td>@if (r.reviewerVerdict) { <span class="verdict-{{ r.reviewerVerdict }}">{{ verdictLabel[r.reviewerVerdict] }}</span> } @else { <span class="muted">–</span> }</td>
              <td>{{ r.openComments || '–' }}</td>
              <td>{{ r.reviewRounds }}</td>
              <td>\${{ r.costUsd | number: '1.2-2' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class PullRequestsPage {
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  readonly runLabel = RUN_LABEL;
  readonly verdictLabel = VERDICT_LABEL;
  readonly checksLabel = CHECKS_LABEL;
  readonly rows = signal<PullRequestRow[]>([]);
  readonly showDone = signal(false);
  readonly checking = signal(false);
  readonly error = signal('');
  readonly visible = computed(() => this.rows().filter((r) => this.showDone() || !['done', 'stopped', 'failed'].includes(r.status)));

  constructor() {
    // Reload whenever a run changes state.
    effect(() => {
      this.live.runs();
      void this.load();
    });
  }

  async load(): Promise<void> {
    try {
      this.rows.set(await this.api.pullRequests());
      this.error.set('');
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  async checkNow(): Promise<void> {
    this.checking.set(true);
    try {
      await this.api.pollPullRequests();
      await this.load();
    } finally {
      this.checking.set(false);
    }
  }
}
