import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { RUN_LABEL, type Run, type RunEvent } from '../models';

@Component({
  selector: 'app-run',
  imports: [RouterLink, DatePipe, DecimalPipe],
  template: `
    @if (run(); as r) {
      <header class="page-head">
        <div>
          <a [routerLink]="['/projects', r.projectId]" class="crumb">Project</a>
          <h1>{{ r.ticketKey }}: {{ r.ticketTitle }}</h1>
        </div>
        <span class="run run-{{ r.status }}">{{ runLabel[r.status] }}</span>
      </header>
      <dl class="facts">
        <div><dt>Agent</dt><dd>{{ agentName() }}</dd></div>
        <div><dt>Branch</dt><dd class="mono">{{ r.branch }}</dd></div>
        <div><dt>Fix tries</dt><dd>{{ r.attempts }}</dd></div>
        <div><dt>Cost</dt><dd>\${{ r.costUsd | number: '1.2-2' }}</dd></div>
        <div><dt>Started</dt><dd>{{ r.startedAt | date: 'medium' }}</dd></div>
        @if (r.prUrl) { <div><dt>Pull request</dt><dd><a [href]="r.prUrl" target="_blank" rel="noopener">{{ r.prUrl }}</a></dd></div> }
      </dl>
      @if (r.error) { <p class="error">{{ r.error }}</p> }
      <div class="row">
        @if (r.status === 'running') { <button class="danger" (click)="stop()">Stop</button> }
        <button (click)="loadDiff()">{{ r.status === 'running' ? 'Show changes so far' : 'Show changes' }}</button>
        @if (r.status !== 'running') { <button class="quiet" (click)="cleanup()">Remove worktree</button> }
      </div>
      @if (diff()) { <pre class="diff">{{ diff() }}</pre> }

      <h2>Activity</h2>
      <ol class="log">
        @for (e of events(); track e.id) {
          <li class="log-{{ e.kind }}"><time>{{ e.ts | date: 'HH:mm:ss' }}</time><span class="kind">{{ e.kind }}</span><pre>{{ e.message }}</pre></li>
        }
      </ol>
    } @else {
      <p class="empty">Loading…</p>
    }
  `,
})
export class RunPage {
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  readonly id = input.required<string>();
  readonly runLabel = RUN_LABEL;
  readonly base = signal<Run | null>(null);
  readonly events = signal<RunEvent[]>([]);
  readonly diff = signal('');

  /** Prefer the live copy so status changes show without reloading. */
  readonly run = computed(() => this.live.runs().find((r) => r.id === this.id()) ?? this.base());
  readonly agentName = computed(() => this.live.agents().find((a) => a.id === this.run()?.agentId)?.name ?? 'Removed agent');

  constructor() {
    const off = this.live.onRunEvent((e) => {
      if (e.runId === this.id()) this.events.update((xs) => [...xs, e]);
    });
    inject(DestroyRef).onDestroy(off);
    effect(() => {
      const id = this.id();
      this.diff.set('');
      void this.api.run(id).then(({ events, ...run }) => {
        this.base.set(run);
        this.events.set(events);
      });
    });
  }

  async stop(): Promise<void> {
    await this.api.stopRun(this.id());
  }

  async loadDiff(): Promise<void> {
    try {
      this.diff.set((await this.api.diff(this.id())).diff || 'No changes yet.');
    } catch (e) {
      this.diff.set((e as Error).message);
    }
  }

  async cleanup(): Promise<void> {
    if (!confirm('Remove this run\'s worktree folder? The branch stays.')) return;
    await this.api.removeWorktree(this.id());
    this.diff.set('Worktree removed.');
  }
}
