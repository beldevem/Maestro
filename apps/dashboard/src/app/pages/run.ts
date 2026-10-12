import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { Confirm } from '../ui/confirm';
import { CHECKS_LABEL, RUN_LABEL, VERDICT_LABEL, type Review, type Run, type RunEvent } from '../models';

@Component({
  selector: 'app-run',
  imports: [RouterLink, DatePipe, DecimalPipe, FormsModule],
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
        <div><dt>Review rounds</dt><dd>{{ r.reviewRounds }}</dd></div>
        @if (r.checks) { <div><dt>CI</dt><dd><span class="checks-{{ r.checks }}">{{ checksLabel[r.checks] }}</span></dd></div> }
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

      @if (r.status === 'in_review' || r.status === 'blocked') {
        <form class="panel review-form" (ngSubmit)="requestChanges()">
          <h2>{{ r.status === 'blocked' ? 'Help the worker' : 'Your review' }}</h2>
          @if (r.status === 'blocked') {
            <p class="hint">Say what to do differently; a worker picks the run up again in the same worktree and session. Raise the budget first if that is what stopped it.</p>
          } @else if (r.prNumber) {
            <p class="hint">You can also review on the pull request: Maestro checks it every minute and hands change requests to a worker. Merging it finishes the ticket.</p>
          }
          <label>{{ r.status === 'blocked' ? 'Guidance' : 'What should change?' }} <textarea [(ngModel)]="feedback" name="feedback" rows="4" placeholder="One point per line"></textarea></label>
          <div class="row">
            <button type="submit" [disabled]="!feedback.trim() || sending()">{{ r.status === 'blocked' ? 'Send to the worker' : 'Request changes' }}</button>
            @if (r.status === 'in_review' && !r.prUrl) {
              <button type="button" class="primary" (click)="merge()" [disabled]="sending()">Approve and merge</button>
            }
            <button type="button" [class.primary]="r.status !== 'blocked' && !!r.prUrl" (click)="approve()" [disabled]="sending()">{{ r.prUrl || r.status === 'blocked' ? 'Mark done' : 'Approve, merge myself' }}</button>
          </div>
          @if (reviewError()) { <p class="error">{{ reviewError() }}</p> }
        </form>
      }

      @if (reviews().length) {
        <h2>Reviews</h2>
        <section class="panel">
          @for (rv of reviews(); track rv.id) {
            <article class="review">
              <div class="review-head">
                <strong>{{ rv.source === 'agent' ? 'Reviewer agent' : rv.source === 'human' ? 'You' : rv.author }}</strong>
                <span class="verdict-{{ rv.verdict }}">{{ verdictLabel[rv.verdict] }}</span>
                @if (rv.source === 'github') { <span class="muted">on the pull request</span> }
                @if (rv.verdict === 'changes_requested') { <span class="muted">{{ rv.addressed ? 'addressed' : 'waiting for a worker' }}</span> }
                <time class="muted">{{ rv.createdAt | date: 'short' }}</time>
              </div>
              @if (rv.summary) { <p>{{ rv.summary }}</p> }
              @if (rv.comments.length) {
                <ul>
                  @for (c of rv.comments; track $index) {
                    <li>@if (c.file) { <span class="mono">{{ c.file }}{{ c.line ? ':' + c.line : '' }}</span> } {{ c.body }}</li>
                  }
                </ul>
              }
            </article>
          }
        </section>
      }

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
  private readonly confirmDialog = inject(Confirm);
  private readonly live = inject(Live);
  readonly id = input.required<string>();
  readonly runLabel = RUN_LABEL;
  readonly base = signal<Run | null>(null);
  readonly events = signal<RunEvent[]>([]);
  readonly diff = signal('');
  readonly reviews = signal<Review[]>([]);
  readonly sending = signal(false);
  readonly reviewError = signal('');
  readonly verdictLabel = VERDICT_LABEL;
  readonly checksLabel = CHECKS_LABEL;
  feedback = '';

  /** Prefer the live copy so status changes show without reloading. */
  readonly run = computed(() => this.live.runs().find((r) => r.id === this.id()) ?? this.base());
  readonly agentName = computed(() => this.live.agents().find((a) => a.id === this.run()?.agentId)?.name ?? 'Removed agent');

  constructor() {
    const off = this.live.onRunEvent((e) => {
      if (e.runId === this.id()) this.events.update((xs) => [...xs, e]);
    });
    const offReview = this.live.onReview((rv) => {
      if (rv.runId !== this.id()) return;
      this.reviews.update((xs) => (xs.some((x) => x.id === rv.id) ? xs.map((x) => (x.id === rv.id ? rv : x)) : [...xs, rv]));
    });
    inject(DestroyRef).onDestroy(() => {
      off();
      offReview();
    });
    effect(() => {
      const id = this.id();
      this.diff.set('');
      void this.api.run(id).then(({ events, reviews, ...run }) => {
        this.base.set(run);
        this.events.set(events);
        this.reviews.set(reviews);
      });
    });
  }

  async requestChanges(): Promise<void> {
    await this.sendReview('changes_requested', this.feedback.trim());
    this.feedback = '';
  }

  async approve(): Promise<void> {
    if (!(await this.confirmDialog.ask({ title: 'Mark this ticket done?', body: 'The ticket moves to done and the worktree folder is removed. The branch stays.', confirm: 'Mark done' }))) return;
    await this.sendReview('approve', '');
  }

  async merge(): Promise<void> {
    if (!(await this.confirmDialog.ask({ title: 'Merge into the base branch?', body: 'The branch is merged into the base branch of your local repository and the ticket is marked done. Nothing happens if the working tree has uncommitted changes or the merge conflicts.', confirm: 'Merge' }))) return;
    this.sending.set(true);
    this.reviewError.set('');
    try {
      await this.api.mergeRun(this.id());
    } catch (e) {
      this.reviewError.set((e as Error).message);
    } finally {
      this.sending.set(false);
    }
  }

  private async sendReview(verdict: 'approve' | 'changes_requested', summary: string): Promise<void> {
    this.sending.set(true);
    this.reviewError.set('');
    try {
      await this.api.review(this.id(), verdict, summary);
    } catch (e) {
      this.reviewError.set((e as Error).message);
    } finally {
      this.sending.set(false);
    }
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
    if (!(await this.confirmDialog.ask({ title: 'Remove the worktree folder?', body: 'The folder with this run’s checkout is deleted. The branch and its commits stay.', confirm: 'Remove', danger: true }))) return;
    await this.api.removeWorktree(this.id());
    this.diff.set('Worktree removed.');
  }
}
