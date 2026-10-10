import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Live } from '../live';

const KIND_LABEL = { blocked: 'Blocked', failed: 'Failed', budget: 'Budget', ready: 'Ready for review' } as const;

/** Things that need you: blocked or failed runs, budgets reached, changes ready for review. */
@Component({
  selector: 'app-alerts',
  imports: [DatePipe, RouterLink],
  template: `
    <header class="page-head">
      <h1>Alerts</h1>
      @if (live.unread()) { <button (click)="live.markAllRead()">Mark all read</button> }
    </header>
    @if (live.alerts().length === 0) {
      <p class="empty">No alerts. You'll see blocked or failed runs, budgets reached and changes ready for review here.</p>
    }
    <ul class="alerts">
      @for (a of live.alerts(); track a.id) {
        <li [class.unread]="!a.read">
          <span class="alert-kind alert-{{ a.kind }}">{{ kindLabel[a.kind] }}</span>
          <span>{{ a.message }}</span>
          @if (a.runId) { <a [routerLink]="['/runs', a.runId]">Open run</a> }
          @else if (a.projectId) { <a [routerLink]="['/projects', a.projectId]">Open project</a> }
          <time class="muted">{{ a.createdAt | date: 'short' }}</time>
        </li>
      }
    </ul>
  `,
})
export class AlertsPage {
  readonly live = inject(Live);
  readonly kindLabel = KIND_LABEL;
}
