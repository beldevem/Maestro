import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../api';
import { Live } from '../live';
import { RUN_LABEL, STATUS_LABEL, type BacklogDraft, type Project, type Ticket, type TicketStatus } from '../models';
import { BacklogDraftPanel } from './backlog-draft';
import { ConnectorFields } from './connector-fields';

type Tab = 'board' | 'knowledge' | 'workflow' | 'runs' | 'chat' | 'connectors';

@Component({
  selector: 'app-project',
  imports: [FormsModule, RouterLink, DatePipe, DecimalPipe, ConnectorFields, BacklogDraftPanel],
  template: `
    @if (project(); as p) {
      <header class="page-head">
        <div>
          <a routerLink="/projects" class="crumb">Projects</a>
          <h1>{{ p.name }}</h1>
        </div>
      </header>
      <nav class="tabs">
        @for (t of tabs; track t.id) {
          <button [class.active]="tab() === t.id" (click)="tab.set(t.id)">{{ t.label }}</button>
        }
      </nav>

      @if (notice()) { <p class="notice">{{ notice() }}</p> }

      @switch (tab()) {
        @case ('board') {
          <div class="toolbar">
            <button (click)="loadTickets()">Refresh</button>
            <button class="primary" (click)="showNewTicket.set(!showNewTicket())">{{ showNewTicket() ? 'Cancel' : 'New ticket' }}</button>
            <button (click)="plan()" [disabled]="planning() || !!draft()" [title]="draft() ? 'Create or discard the current draft first' : ''">Plan backlog</button>
            <label class="toggle" title="Assign ready tickets to free workers automatically">
              <input type="checkbox" [checked]="autoAssign()" (change)="toggleAutoAssign($any($event.target).checked)" /> Auto-assign
            </label>
          </div>
          @if (planning()) {
            <p class="notice"><span class="spinner"></span> The planner is reading the requirements and the code. This can take a minute or more.</p>
          }
          @if (planError()) { <p class="error">{{ planError() }}</p> }
          @if (draft(); as dr) {
            <app-backlog-draft [draft]="dr" [pmName]="pmName()" (done)="draftDone($event)" />
          }
          @if (showNewTicket()) {
            <form class="panel" (ngSubmit)="createTicket()">
              <label>Title <input [(ngModel)]="newTicket.title" name="title" required /></label>
              <label>Description <textarea [(ngModel)]="newTicket.description" name="description" rows="3"></textarea></label>
              <label>Acceptance criteria <textarea [(ngModel)]="newTicket.acceptanceCriteria" name="ac" rows="3"></textarea></label>
              <div class="row">
                <label>Size
                  <select [(ngModel)]="newTicket.size" name="size">
                    <option value="">Unsized</option>
                    @for (s of sizes; track s) { <option [value]="s">{{ s }}</option> }
                  </select>
                </label>
                <label>Labels <input [(ngModel)]="newTicket.labels" name="labels" placeholder="frontend, bug" /></label>
              </div>
              <button class="primary" type="submit" [disabled]="!newTicket.title">Create in {{ pmName() }}</button>
            </form>
          }
          @if (ticketError()) { <p class="error">{{ ticketError() }}</p> }
          <div class="board">
            @for (col of columns; track col) {
              <section class="column">
                <h2>{{ statusLabel[col] }} <span class="count">{{ byStatus()[col].length }}</span></h2>
                @for (t of byStatus()[col]; track t.key) {
                  <article class="ticket">
                    <div class="ticket-head">
                      @if (t.url) { <a [href]="t.url" target="_blank" rel="noopener">{{ t.key }}</a> } @else { <span>{{ t.key }}</span> }
                      @if (t.size) { <span class="pill">{{ t.size }}</span> }
                    </div>
                    <p>{{ t.title }}</p>
                    @if (activeRun(t.key); as r) {
                      <a class="state state-working" [routerLink]="['/runs', r.id]">Agent working</a>
                    } @else if (t.status === 'todo' || t.status === 'in_progress') {
                      @if (t.blockedBy.length) {
                        <p class="warn">Waits on {{ t.blockedBy.join(', ') }}</p>
                      }
                      @if (t.notReady.length) {
                        <p class="warn" [title]="t.notReady.join(' ')">Not ready: {{ t.notReady[0] }}</p>
                      }
                      @if (t.blockedBy.length) {
                        <button class="quiet" (click)="start(t)">Start anyway</button>
                      } @else {
                        <button (click)="start(t)">{{ t.notReady.length ? 'Start anyway' : 'Assign to agent' }}</button>
                      }
                    } @else if (t.status === 'in_review' && p.pm.provider === 'manual') {
                      <button (click)="markDone(t)">Mark done</button>
                    }
                  </article>
                }
              </section>
            }
          </div>
        }

        @case ('knowledge') {
          <form class="panel" (ngSubmit)="save({ context: p.context, requirements: p.requirements, bestPractices: p.bestPractices, description: p.description })">
            <p class="hint">Every agent reads this before working on a ticket.</p>
            <label>Description <input [(ngModel)]="p.description" name="description" /></label>
            <label>Context <textarea [(ngModel)]="p.context" name="context" rows="6" placeholder="What the product is, who uses it, the architecture"></textarea></label>
            <label>Requirements <textarea [(ngModel)]="p.requirements" name="requirements" rows="8"></textarea></label>
            <label>Best practices <textarea [(ngModel)]="p.bestPractices" name="bestPractices" rows="6" placeholder="Coding standards, patterns to use or avoid"></textarea></label>
            <button class="primary" type="submit">Save</button>
          </form>
        }

        @case ('workflow') {
          <form class="panel" (ngSubmit)="save({ workflowYaml: p.workflowYaml })">
            <p class="hint">Branch naming, Definition of Ready and Done, quality gates and fix attempts.</p>
            <textarea class="code" [(ngModel)]="p.workflowYaml" name="workflow" rows="28" spellcheck="false"></textarea>
            <button class="primary" type="submit">Save</button>
          </form>
        }

        @case ('runs') {
          @if (projectRuns().length === 0) { <p class="empty">No runs yet. Assign a ticket on the board.</p> }
          <table class="table">
            <thead><tr><th>Ticket</th><th>Status</th><th>Branch</th><th>Fix tries</th><th>Cost</th><th>Started</th><th></th></tr></thead>
            <tbody>
              @for (r of projectRuns(); track r.id) {
                <tr>
                  <td><a [routerLink]="['/runs', r.id]">{{ r.ticketKey }}</a> {{ r.ticketTitle }}</td>
                  <td><span class="run run-{{ r.status }}">{{ runLabel[r.status] }}</span></td>
                  <td class="mono">{{ r.branch }}</td>
                  <td>{{ r.attempts }}</td>
                  <td>\${{ r.costUsd | number: '1.2-2' }}</td>
                  <td>{{ r.startedAt | date: 'short' }}</td>
                  <td>@if (r.prUrl) { <a [href]="r.prUrl" target="_blank" rel="noopener">PR</a> }</td>
                </tr>
              }
            </tbody>
          </table>
        }

        @case ('chat') {
          <section class="chat panel">
            @if (messages().length === 0) {
              <p class="hint">Ask about this project: tickets, why an agent is blocked, how the code works.</p>
            }
            @for (m of messages(); track $index) {
              <div class="msg msg-{{ m.role }}">{{ m.content }}</div>
            }
            @if (thinking()) { <div class="msg msg-assistant muted">Thinking…</div> }
            <form class="chat-input" (ngSubmit)="send()">
              <input [(ngModel)]="question" name="q" placeholder="Why is the login ticket blocked?" [disabled]="thinking()" />
              <button class="primary" type="submit" [disabled]="!question.trim() || thinking()">Send</button>
            </form>
          </section>
        }

        @case ('connectors') {
          <form class="panel" (ngSubmit)="save({ codeHost: p.codeHost, pm: p.pm, design: p.design })">
            <app-connector-fields [model]="p" />
            <div class="row">
              <button class="primary" type="submit">Save</button>
              <button type="button" (click)="check()">Test connections</button>
              <button type="button" class="danger" (click)="remove()">Delete project</button>
            </div>
            @for (c of checks(); track c.name) {
              <p [class.ok]="c.ok" [class.error]="!c.ok">{{ c.name }}: {{ c.message }}</p>
            }
          </form>
        }
      }
    } @else {
      <p class="empty">Loading…</p>
    }
  `,
})
export class ProjectPage {
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  private readonly router = inject(Router);
  readonly id = input.required<string>();

  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'board', label: 'Board' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'workflow', label: 'Workflow' },
    { id: 'runs', label: 'Runs' },
    { id: 'chat', label: 'Chat' },
    { id: 'connectors', label: 'Connectors' },
  ];
  readonly columns: TicketStatus[] = ['todo', 'in_progress', 'in_review', 'done'];
  readonly sizes = ['XS', 'S', 'M', 'L', 'XL'];
  readonly statusLabel = STATUS_LABEL;
  readonly runLabel = RUN_LABEL;

  readonly project = signal<Project | null>(null);
  readonly tab = signal<Tab>('board');
  readonly tickets = signal<Ticket[]>([]);
  readonly ticketError = signal('');
  readonly notice = signal('');
  readonly showNewTicket = signal(false);
  readonly checks = signal<{ name: string; ok: boolean; message: string }[]>([]);
  readonly messages = signal<{ role: 'user' | 'assistant'; content: string }[]>([]);
  readonly thinking = signal(false);
  readonly autoAssign = signal(false);
  readonly planning = signal(false);
  readonly planError = signal('');
  readonly draft = signal<BacklogDraft | null>(null);
  newTicket = { title: '', description: '', acceptanceCriteria: '', size: '', labels: '' };
  question = '';

  readonly projectRuns = computed(() => this.live.runs().filter((r) => r.projectId === this.id()));
  readonly byStatus = computed(() => {
    const groups: Record<TicketStatus, Ticket[]> = { todo: [], in_progress: [], in_review: [], done: [] };
    for (const t of this.tickets()) groups[t.status].push(t);
    return groups;
  });
  readonly pmName = computed(() => ({ jira: 'Jira', trello: 'Trello', manual: 'Maestro' })[this.project()?.pm.provider ?? 'manual']);

  constructor() {
    effect(() => {
      const id = this.id();
      void this.api.project(id).then((p) => this.project.set(p));
      void this.loadTickets();
      void this.loadDraft();
      void this.api.autoAssign(id).then((a) => this.autoAssign.set(a.enabled));
    });
    // Auto-assign moves tickets on its own; keep the board in step with runs starting and finishing.
    let seen = '';
    effect(() => {
      const sig = this.projectRuns().map((r) => `${r.id}:${r.status}`).join(',');
      if (seen && sig !== seen) void this.loadTickets();
      seen = sig;
    });
  }

  async loadDraft(): Promise<void> {
    const drafts = await this.api.drafts(this.id()).catch(() => []);
    this.draft.set(drafts.find((d) => d.status === 'draft') ?? null);
  }

  async plan(): Promise<void> {
    this.planning.set(true);
    this.planError.set('');
    try {
      this.draft.set(await this.api.plan(this.id()));
    } catch (e) {
      this.planError.set(`Planning failed: ${(e as Error).message}`);
    } finally {
      this.planning.set(false);
    }
  }

  async draftDone(error: string | null): Promise<void> {
    await Promise.all([this.loadDraft(), this.loadTickets()]);
    if (!error) this.flash('Backlog updated.');
  }

  async toggleAutoAssign(enabled: boolean): Promise<void> {
    try {
      this.autoAssign.set((await this.api.setAutoAssign(this.id(), enabled)).enabled);
      this.flash(enabled ? 'Auto-assign is on: ready tickets go to free workers.' : 'Auto-assign is off.');
    } catch (e) {
      this.flash((e as Error).message);
    }
  }

  async markDone(t: Ticket): Promise<void> {
    try {
      await this.api.setTicketStatus(this.id(), t.key, 'done');
      await this.loadTickets();
    } catch (e) {
      this.ticketError.set((e as Error).message);
    }
  }

  activeRun(key: string) {
    return this.projectRuns().find((r) => r.ticketKey === key && r.status === 'running');
  }

  async loadTickets(): Promise<void> {
    this.ticketError.set('');
    try {
      this.tickets.set(await this.api.tickets(this.id()));
    } catch (e) {
      this.ticketError.set((e as Error).message);
    }
  }

  async createTicket(): Promise<void> {
    const t = this.newTicket;
    try {
      await this.api.createTicket(this.id(), {
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        size: t.size || undefined,
        labels: t.labels.split(',').map((l) => l.trim()).filter(Boolean),
      });
      this.newTicket = { title: '', description: '', acceptanceCriteria: '', size: '', labels: '' };
      this.showNewTicket.set(false);
      await this.loadTickets();
    } catch (e) {
      this.ticketError.set((e as Error).message);
    }
  }

  async start(t: Ticket): Promise<void> {
    const problems = [...(t.blockedBy.length ? [`It waits on ${t.blockedBy.join(', ')}.`] : []), ...t.notReady];
    if (problems.length && !confirm(`${t.key} is not ready:\n${problems.join('\n')}\n\nStart anyway?`)) return;
    try {
      const run = await this.api.startTicket(this.id(), t.key, t.notReady.length > 0);
      await this.router.navigate(['/runs', run.id]);
    } catch (e) {
      const err = e as ApiError;
      this.ticketError.set(err.reasons.length ? `${err.message}` : err.message);
    }
  }

  async save(patch: Partial<Project>): Promise<void> {
    try {
      this.project.set(await this.api.updateProject(this.id(), patch));
      this.flash('Saved.');
      if (patch.pm) void this.loadTickets();
    } catch (e) {
      this.flash((e as Error).message);
    }
  }

  async check(): Promise<void> {
    const res = await this.api.checkProject(this.id());
    const names: Record<string, string> = { codeHost: 'Code host', pm: 'PM tool' };
    this.checks.set(Object.entries(res).map(([k, v]) => ({ name: names[k] ?? k, ...v })));
  }

  async remove(): Promise<void> {
    if (!confirm('Delete this project from Maestro? Your repository and PM tool are not touched.')) return;
    await this.api.deleteProject(this.id());
    await this.router.navigate(['/projects']);
  }

  async send(): Promise<void> {
    const message = this.question.trim();
    if (!message) return;
    const history = this.messages();
    this.messages.set([...history, { role: 'user', content: message }]);
    this.question = '';
    this.thinking.set(true);
    try {
      const { answer } = await this.api.chat(this.id(), message, history);
      this.messages.update((m) => [...m, { role: 'assistant', content: answer }]);
    } catch (e) {
      this.messages.update((m) => [...m, { role: 'assistant', content: `Couldn't answer: ${(e as Error).message}` }]);
    } finally {
      this.thinking.set(false);
    }
  }

  private flash(text: string): void {
    this.notice.set(text);
    setTimeout(() => this.notice.set(''), 3000);
  }
}
