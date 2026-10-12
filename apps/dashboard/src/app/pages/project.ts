import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../api';
import { Live } from '../live';
import { RUN_LABEL, STATUS_LABEL, type BacklogDraft, type ProjectSpend, type Project, type Ticket, type TicketStatus } from '../models';
import { BacklogDraftPanel } from './backlog-draft';
import { ChatPanel } from '../components/chat-panel';
import { ProjectAi } from '../components/project-ai';
import { Confirm } from '../ui/confirm';
import { Icon } from '../ui/icon';
import { Toasts } from '../ui/toast';
import { ConnectorFields } from './connector-fields';
import { deletionDetails } from './projects';
import { UsageView, describeCaps, formatTokens } from '../ui/usage';

type Tab = 'board' | 'knowledge' | 'workflow' | 'runs' | 'chat' | 'connectors';

@Component({
  selector: 'app-project',
  imports: [FormsModule, RouterLink, DatePipe, ConnectorFields, BacklogDraftPanel, ChatPanel, Icon, ProjectAi, UsageView],
  template: `
    @if (project(); as p) {
      <header class="page-head">
        @if (editingHead()) {
          <form class="head-edit" (ngSubmit)="saveHead()">
            <label class="sr-only" for="pname">Name</label>
            <input id="pname" [(ngModel)]="head.name" name="pname" required maxlength="60" />
            <label class="sr-only" for="pdesc">Description</label>
            <input id="pdesc" [(ngModel)]="head.description" name="pdesc" placeholder="Description" />
            <button class="primary" type="submit" [disabled]="!head.name.trim()">Save</button>
            <button type="button" class="quiet" (click)="editingHead.set(false)">Cancel</button>
          </form>
        } @else {
          <div>
            <a routerLink="/projects" class="crumb">Projects</a>
            <h1>{{ p.name }}</h1>
            @if (p.description) { <p class="page-sub">{{ p.description }}</p> }
          </div>
          <div class="row head-actions">
            <button class="icon-btn" (click)="startHeadEdit(p)" aria-label="Edit name and description" title="Edit name and description"><app-icon name="edit" /></button>
            <button class="icon-btn" (click)="remove()" aria-label="Delete project" title="Delete project"><app-icon name="trash" /></button>
          </div>
        }
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
                      <a class="state state-working" [routerLink]="['/runs', r.id]">{{ r.status === 'reviewing' ? 'Being reviewed' : 'Agent working' }}</a>
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
          <form class="panel" (ngSubmit)="saveMemory()">
            <h2>Project memory <span class="mono muted">.maestro/memory.md</span></h2>
            <p class="hint">Learnings agents record after each ticket, kept in the repository and read by every agent. Your edits are committed with the next ticket's change{{ memoryPending() ? '; one is waiting now' : '' }}.</p>
            <textarea class="code" [(ngModel)]="memoryText" name="memory" aria-label="Project memory" rows="12" spellcheck="false" placeholder="Nothing recorded yet."></textarea>
            <div class="row">
              <button class="primary" type="submit">Save</button>
              @if (memoryPending()) { <button type="button" class="quiet" (click)="discardMemory()">Discard my edit</button> }
            </div>
          </form>
        }

        @case ('workflow') {
          <form class="panel" (ngSubmit)="save({ workflowYaml: p.workflowYaml })">
            <p class="hint">Branch naming, Definition of Ready and Done, quality gates and fix attempts.</p>
            <textarea class="code" [(ngModel)]="p.workflowYaml" name="workflow" aria-label="Workflow configuration (YAML)" rows="28" spellcheck="false"></textarea>
            <button class="primary" type="submit">Save</button>
          </form>
        }

        @case ('runs') {
          <form class="toolbar" (ngSubmit)="saveBudget()">
            <label>Daily budget, tokens
              <input type="number" min="0" step="100000" [(ngModel)]="budgetTokens" name="budgetTokens" [placeholder]="'Default: ' + defaultTokens()" />
            </label>
            <label>Optional daily cap, €
              <input type="number" min="0" step="0.5" [(ngModel)]="budgetEur" name="budgetEur" placeholder="Default from Settings" />
            </label>
            <button type="submit">Save budget</button>
            <button type="button" class="quiet" (click)="cleanupWorktrees()" title="Remove the worktree folders of failed, stopped and done runs; branches stay">Remove finished worktrees</button>
            @if (spend(); as s) {
              <span class="meta">Today <app-usage [usage]="s.today.usage" [usd]="s.today.usd" /> (limit {{ describeCaps(s.dailyCaps) }}) · 7 days <app-usage [usage]="s.last7Days.usage" [usd]="s.last7Days.usd" /> · all time <app-usage [usage]="s.total.usage" [usd]="s.total.usd" /></span>
            }
          </form>
          @if (projectRuns().length === 0) { <p class="empty">No runs yet. Assign a ticket on the board.</p> } @else {
          <table class="table">
            <thead><tr><th>Ticket</th><th>Status</th><th>Branch</th><th>Fix tries</th><th>Usage</th><th>Started</th><th></th></tr></thead>
            <tbody>
              @for (r of projectRuns(); track r.id) {
                <tr>
                  <td><a [routerLink]="['/runs', r.id]">{{ r.ticketKey }}</a> {{ r.ticketTitle }}</td>
                  <td><span class="run run-{{ r.status }}">{{ runLabel[r.status] }}</span></td>
                  <td class="mono">{{ r.branch }}</td>
                  <td>{{ r.attempts }}</td>
                  <td><app-usage [usage]="r.usage" [usd]="r.costUsd" /></td>
                  <td>{{ r.startedAt | date: 'short' }}</td>
                  <td>@if (r.prUrl) { <a [href]="r.prUrl" target="_blank" rel="noopener">PR</a> }</td>
                </tr>
              }
            </tbody>
          </table>
          }
        }

        @case ('chat') {
          <app-chat-panel [projects]="[{ id: p.id, name: p.name }]" [initialScope]="p.id" />
          <p class="hint">This is the Dashboard's assistant, focused on {{ p.name }}. <a routerLink="/" [queryParams]="{ project: p.id }">Open it on the Dashboard</a> to ask across projects.</p>
        }

        @case ('connectors') {
          <form class="panel" (ngSubmit)="save({ codeHost: p.codeHost, pm: p.pm, design: p.design, docs: p.docs })">
            <app-connector-fields [model]="p" />
            <div class="row">
              <button class="primary" type="submit">Save connectors</button>
              <button type="button" (click)="check()">Test connections</button>
              <button type="button" class="danger" (click)="remove()"><app-icon name="trash" [size]="14" /> Delete project</button>
            </div>
            @for (c of checks(); track c.name) {
              <p [class.ok]="c.ok" [class.error]="!c.ok">{{ c.name }}: {{ c.message }}</p>
            }
          </form>
          <div class="panel"><app-project-ai [projectId]="p.id" /></div>
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
  private readonly toasts = inject(Toasts);
  private readonly confirmDialog = inject(Confirm);
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
  readonly tab = signal<Tab>((inject(ActivatedRoute).snapshot.queryParamMap.get('tab') as Tab) || 'board');
  readonly tickets = signal<Ticket[]>([]);
  readonly ticketError = signal('');
  readonly notice = signal('');
  readonly showNewTicket = signal(false);
  readonly checks = signal<{ name: string; ok: boolean; message: string }[]>([]);
  readonly editingHead = signal(false);
  head = { name: '', description: '' };
  readonly autoAssign = signal(false);
  readonly planning = signal(false);
  readonly planError = signal('');
  readonly draft = signal<BacklogDraft | null>(null);
  readonly memoryPending = signal(false);
  readonly spend = signal<ProjectSpend | null>(null);
  budgetTokens: number | null = null;
  budgetEur: number | null = null;
  readonly describeCaps = describeCaps;
  memoryText = '';
  newTicket = { title: '', description: '', acceptanceCriteria: '', size: '', labels: '' };

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
      void this.loadMemory();
      void this.loadSpend();
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

  /** The default daily token cap, for the placeholder. */
  defaultTokens(): string {
    const s = this.spend();
    return s && !s.own.tokens ? formatTokens(s.dailyCaps.tokens) : 'from Settings';
  }

  async loadSpend(): Promise<void> {
    const s = (await this.api.spend().catch(() => [])).find((x) => x.projectId === this.id()) ?? null;
    this.spend.set(s);
    this.budgetTokens = s?.own.tokens ? Number(s.own.tokens) : null;
    this.budgetEur = s?.own.eur ? Number(s.own.eur) : null;
  }

  async cleanupWorktrees(): Promise<void> {
    const { removed } = await this.api.cleanupWorktrees(this.id());
    this.flash(removed ? `Removed ${removed} worktree${removed === 1 ? '' : 's'}; the branches stay.` : 'No finished worktrees to remove.');
  }

  async saveBudget(): Promise<void> {
    const value = (v: number | null) => (v === null || String(v) === '' ? null : Number(v));
    const dailyTokens = value(this.budgetTokens);
    const dailyEur = value(this.budgetEur);
    try {
      await this.api.setProjectBudget(this.id(), { dailyTokens: dailyTokens === null ? null : Math.round(dailyTokens), dailyEur });
      await this.loadSpend();
      this.flash(dailyTokens === null && dailyEur === null ? 'This project uses the default daily budget.' : 'Budget saved.');
    } catch (e) {
      this.flash((e as Error).message);
    }
  }

  async loadMemory(): Promise<void> {
    const m = await this.api.memory(this.id()).catch(() => ({ content: '', pending: false }));
    this.memoryText = m.content;
    this.memoryPending.set(m.pending);
  }

  async saveMemory(): Promise<void> {
    try {
      await this.api.saveMemory(this.id(), this.memoryText);
      this.memoryPending.set(true);
      this.flash('Saved. It goes into the next ticket\'s commit.');
    } catch (e) {
      this.flash((e as Error).message);
    }
  }

  async discardMemory(): Promise<void> {
    await this.api.discardMemory(this.id());
    await this.loadMemory();
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
    return this.projectRuns().find((r) => r.ticketKey === key && (r.status === 'running' || r.status === 'reviewing'));
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
    if (problems.length) {
      const ok = await this.confirmDialog.ask({ title: `${t.key} is not ready`, body: 'Start it anyway?', details: problems, confirm: 'Start anyway' });
      if (!ok) return;
    }
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
      this.toasts.ok('Saved.');
      if (patch.pm) void this.loadTickets();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  async check(): Promise<void> {
    const res = await this.api.checkProject(this.id());
    const names: Record<string, string> = { codeHost: 'Code host', pm: 'PM tool', design: 'Figma', docs: 'Confluence' };
    this.checks.set(Object.entries(res).map(([k, v]) => ({ name: names[k] ?? k, ...v })));
  }

  startHeadEdit(p: Project): void {
    this.head = { name: p.name, description: p.description };
    this.editingHead.set(true);
  }

  async saveHead(): Promise<void> {
    await this.save({ name: this.head.name.trim(), description: this.head.description.trim() });
    this.editingHead.set(false);
  }

  async remove(): Promise<void> {
    const p = this.project();
    if (!p) return;
    const ok = await this.confirmDialog.ask({ title: `Delete ${p.name}?`, body: 'This removes the project from Maestro:', details: deletionDetails(p), confirm: 'Delete project', danger: true });
    if (!ok) return;
    try {
      await this.api.deleteProject(this.id());
      this.toasts.ok(`${p.name} deleted.`);
      await this.router.navigate(['/projects']);
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  private flash(text: string): void {
    this.toasts.info(text);
  }
}
