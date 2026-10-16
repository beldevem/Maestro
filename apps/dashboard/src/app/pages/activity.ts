import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import type { ActivityEntry, Project, UserView } from '../models';
import { Rights } from '../rights';

/** What each logged action reads as. */
export const ACTION_LABEL: Record<string, string> = {
  'account.setup': 'Set up Maestro', 'auth.login': 'Logged in', 'auth.login_failed': 'Failed to log in', 'auth.logout': 'Logged out', 'auth.password_change': 'Changed their password',
  'project.create': 'Created the project', 'project.update': 'Edited the project', 'project.delete': 'Deleted the project', 'project.check': 'Tested connections',
  'project.memory_update': 'Edited project memory', 'project.memory_discard': 'Discarded a memory edit', 'project.ai_update': 'Changed the project’s AI', 'project.budget_update': 'Changed the budget',
  'project.auto_assign': 'Changed auto-assign', 'member.add': 'Added a member', 'member.remove': 'Removed a member',
  'ticket.create': 'Created a ticket', 'ticket.move': 'Moved a ticket', 'run.start': 'Started a run', 'run.stop': 'Stopped a run', 'run.review': 'Reviewed a run', 'run.merge': 'Merged a run',
  'run.worktree_remove': 'Removed a worktree', 'run.cleanup': 'Cleaned up worktrees', 'pr.refresh': 'Refreshed pull requests', 'planner.run': 'Ran the planner',
  'draft.update': 'Edited a backlog draft', 'draft.approve': 'Created tickets from a draft', 'draft.discard': 'Discarded a draft',
  'worker.create': 'Added a worker', 'worker.update': 'Edited a worker', 'worker.action': 'Paused or resumed a worker', 'worker.delete': 'Deleted a worker',
  'chat.ask': 'Asked the chat', 'chat.clear': 'Cleared a project chat', 'chat.confirm': 'Confirmed a chat proposal', 'chat.dismiss': 'Dismissed a chat proposal',
  'chat.new': 'Started a conversation', 'chat.update': 'Edited a conversation', 'chat.delete': 'Deleted a conversation',
  'provider.save': 'Saved an AI provider', 'provider.delete': 'Deleted an AI provider', 'provider.test': 'Tested an AI provider', 'settings.ai_roles': 'Changed who does what',
  'settings.update': 'Changed settings', 'settings.test': 'Tested a connection', 'secret.set': 'Saved a secret', 'secret.delete': 'Removed a secret',
  'user.create': 'Added a user', 'user.update': 'Edited a user', 'user.password_reset': 'Reset a password', 'user.delete': 'Deleted a user',
};

const KINDS = [
  ['', 'All actions'], ['run', 'Runs'], ['ticket', 'Tickets'], ['chat', 'Chat'], ['project', 'Projects'], ['member', 'Members'], ['user', 'Users'],
  ['auth', 'Logins'], ['worker', 'Workers'], ['settings', 'Settings'], ['secret', 'Secrets'], ['provider', 'AI providers'], ['draft', 'Backlog drafts'],
] as const;

@Component({
  selector: 'app-activity',
  imports: [FormsModule, DatePipe, RouterLink],
  template: `
    <header class="page-head">
      <div>
        <h1>Activity</h1>
        <p class="page-sub">{{ rights.can('activity.viewAll') ? 'Who did what, in the projects you can see.' : 'What you did.' }}</p>
      </div>
    </header>
    <form class="toolbar activity-filters" (ngSubmit)="load()" (change)="load()">
      @if (rights.can('activity.viewAll')) {
        <label>Person
          <select [(ngModel)]="f.userId" name="userId"><option value="">Everyone</option>@for (u of people(); track u.id) { <option [value]="u.id">{{ u.name }}</option> }</select>
        </label>
      }
      <label>Project
        <select [(ngModel)]="f.projectId" name="projectId"><option value="">All projects</option>@for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select>
      </label>
      <label>Action
        <select [(ngModel)]="f.action" name="action">@for (k of kinds; track k[0]) { <option [value]="k[0]">{{ k[1] }}</option> }</select>
      </label>
      <label>From <input type="date" [(ngModel)]="f.from" name="from" /></label>
      <label>To <input type="date" [(ngModel)]="f.to" name="to" /></label>
    </form>
    @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
    <div class="table-scroll">
      <table class="table activity-table">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Project</th></tr></thead>
        <tbody>
          @for (e of entries(); track e.id) {
            <tr>
              <td><time [attr.datetime]="e.at">{{ e.at | date: 'MMM d, HH:mm' }}</time></td>
              <td>{{ e.userName }}</td>
              <td>{{ label(e.action) }}@if (note(e); as n) { <span class="meta"> · {{ n }}</span> }</td>
              <td>
                @if (e.targetType === 'run' && e.targetId) { <a [routerLink]="['/runs', e.targetId]">Run</a> }
                @else if (e.targetId && (e.targetType === 'ticket' || e.targetType === 'secret' || e.targetType === 'connection' || e.targetType === 'provider')) { {{ e.targetId }} }
              </td>
              <td>@if (e.projectId && e.projectName) { <a [routerLink]="['/projects', e.projectId]">{{ e.projectName }}</a> }</td>
            </tr>
          } @empty {
            @if (!loading()) { <tr><td colspan="5" class="empty">Nothing matches.</td></tr> }
          }
        </tbody>
      </table>
    </div>
    @if (more()) { <button type="button" (click)="load(true)" [disabled]="loading()">Show older</button> }
  `,
})
export class ActivityPage {
  private readonly api = inject(Api);
  readonly rights = inject(Rights);
  readonly kinds = KINDS;
  readonly entries = signal<ActivityEntry[]>([]);
  readonly people = signal<UserView[]>([]);
  readonly projects = signal<Project[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly more = signal(false);
  f = { userId: '', projectId: '', action: '', from: '', to: '' };

  constructor() {
    void this.load();
    void this.api.projects().then((p) => this.projects.set(p), () => undefined);
    void this.rights.load().then(() => {
      if (this.rights.can('activity.viewAll')) void this.api.users().then((r) => this.people.set(r.users), () => undefined);
    });
  }

  async load(older = false): Promise<void> {
    this.loading.set(true);
    try {
      const day = (d: string, end = false) => (d ? new Date(`${d}T00:00:00`).getTime() + (end ? 86_400_000 : 0) : 0);
      const page = await this.api.activity({
        userId: this.f.userId, projectId: this.f.projectId, action: this.f.action, limit: 100,
        since: this.f.from ? new Date(day(this.f.from)).toISOString() : undefined,
        until: this.f.to ? new Date(day(this.f.to, true)).toISOString() : undefined,
        before: older ? this.entries().at(-1)?.id : undefined,
      });
      this.entries.set(older ? [...this.entries(), ...page] : page);
      this.more.set(page.length === 100);
      this.error.set('');
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  label(action: string): string {
    return ACTION_LABEL[action] ?? action;
  }

  /** A few safe details: a ticket title, a new status, a verdict, roles. */
  note(e: ActivityEntry): string {
    const d = e.detail ?? {};
    const parts = [d['title'], d['status'] && `to ${String(d['status']).replace('_', ' ')}`, d['verdict'] && String(d['verdict']).replace('_', ' '), d['trigger'] === 'auto' && 'auto-assign',
      d['trigger'] === 'chat' && 'from chat', d['by'], d['email'], Array.isArray(d['roles']) && (d['roles'] as string[]).join(', '), Array.isArray(d['keys']) && (d['keys'] as string[]).join(', ')];
    return parts.filter(Boolean).map(String).join(' · ');
  }
}
