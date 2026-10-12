import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { STATE_LABEL, type Agent, type AgentState } from '../models';
import { Confirm } from '../ui/confirm';
import { Icon } from '../ui/icon';
import { Toasts } from '../ui/toast';

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
const BUSY: AgentState[] = ['working', 'running_checks', 'addressing_review', 'waiting_review'];

/** The workers that implement tickets: add, rename, change model, pause, delete. */
@Component({
  selector: 'app-agents',
  imports: [FormsModule, RouterLink, Icon],
  template: `
    <header class="page-head">
      <div>
        <h1>Workers</h1>
        <p class="page-sub">Each worker takes one ticket at a time. Reviewing, planning and chat use the models set in Settings.</p>
      </div>
      <button class="primary" (click)="startAdd()"><app-icon name="plus" [size]="16" /> Add worker</button>
    </header>

    <div class="summary">
      @for (s of summary(); track s.state) {
        <span class="state state-{{ s.state }}">{{ s.label }}: {{ s.count }}</span>
      }
    </div>

    @if (adding()) {
      <form class="panel worker-form" (ngSubmit)="add()" aria-label="New worker">
        <h2>New worker</h2>
        <div class="row">
          <label>Name <input [(ngModel)]="draft.name" name="name" required maxlength="40" placeholder="Worker 3" /></label>
          <label>Model <input [(ngModel)]="draft.model" name="model" list="worker-models" placeholder="Default from Settings" spellcheck="false" /></label>
        </div>
        <div class="row">
          <button class="primary" type="submit" [disabled]="!draft.name.trim() || busy()">Add worker</button>
          <button type="button" class="quiet" (click)="adding.set(false)">Cancel</button>
        </div>
      </form>
    }
    <datalist id="worker-models">@for (m of models; track m) { <option [value]="m"></option> }</datalist>

    @if (live.agents().length === 0) {
      <div class="empty-state">
        <app-icon name="bot" [size]="28" />
        <h2>No workers</h2>
        <p>Add a worker so tickets can be assigned.</p>
        <button class="primary" (click)="startAdd()">Add worker</button>
      </div>
    }

    <div class="grid">
      @for (a of live.agents(); track a.id) {
        <article class="card agent" [attr.aria-label]="a.name">
          @if (editing() === a.id) {
            <form (ngSubmit)="save(a)" class="worker-edit">
              <label>Name <input [(ngModel)]="edit.name" name="name" required maxlength="40" /></label>
              <label>Model <input [(ngModel)]="edit.model" name="model" list="worker-models" placeholder="Default from Settings" spellcheck="false" /></label>
              <div class="row">
                <button class="primary" type="submit" [disabled]="!edit.name.trim() || busy()">Save</button>
                <button type="button" class="quiet" (click)="editing.set('')">Cancel</button>
              </div>
            </form>
          } @else {
            <div class="agent-head">
              <h2>{{ a.name }}</h2>
              <span class="state state-{{ a.state }}">{{ stateLabel[a.state] }}</span>
            </div>
            <p class="meta">{{ a.model || 'Default model (Settings)' }}</p>
            @if (a.note) { <p>{{ a.note }}</p> }
            @if (runFor(a); as r) {
              <p><a [routerLink]="['/runs', r.id]">{{ r.ticketKey }}: {{ r.ticketTitle }}</a></p>
            }
            <div class="card-actions">
              @if (a.state === 'available') { <button (click)="act(a, 'pause')"><app-icon name="pause" [size]="14" /> Pause</button> }
              @if (a.state === 'paused') { <button (click)="act(a, 'resume')"><app-icon name="play" [size]="14" /> Resume</button> }
              @if (a.state === 'blocked') { <button class="primary" (click)="act(a, 'unblock')">Mark unblocked</button> }
              @if (a.currentRunId && isBusy(a)) { <button class="danger" (click)="stop(a)">Stop run</button> }
              <span class="spacer"></span>
              <button class="icon-btn" (click)="startEdit(a)" [attr.aria-label]="'Edit ' + a.name" title="Edit"><app-icon name="edit" /></button>
              <button class="icon-btn" (click)="remove(a)" [disabled]="isBusy(a)" [attr.aria-label]="'Delete ' + a.name"
                [title]="isBusy(a) ? 'Stop its run before deleting it' : 'Delete'"><app-icon name="trash" /></button>
            </div>
          }
        </article>
      }
    </div>
  `,
})
export class AgentsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  readonly live = inject(Live);
  readonly stateLabel = STATE_LABEL;
  readonly models = MODELS;
  readonly adding = signal(false);
  readonly editing = signal('');
  readonly busy = signal(false);
  draft = { name: '', model: '' };
  edit = { name: '', model: '' };

  readonly summary = computed(() => {
    const counts = new Map<AgentState, number>();
    for (const a of this.live.agents()) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
    return [...counts].map(([state, count]) => ({ state, count, label: STATE_LABEL[state] }));
  });

  runFor(a: Agent) {
    return a.currentRunId ? this.live.runs().find((r) => r.id === a.currentRunId) : undefined;
  }

  isBusy(a: Agent): boolean {
    return BUSY.includes(a.state);
  }

  startAdd(): void {
    this.draft = { name: `Worker ${this.live.agents().length + 1}`, model: '' };
    this.adding.set(true);
  }

  startEdit(a: Agent): void {
    this.edit = { name: a.name, model: a.model };
    this.editing.set(a.id);
  }

  async add(): Promise<void> {
    await this.run(async () => {
      await this.api.createAgent({ name: this.draft.name.trim(), model: this.draft.model.trim(), role: 'worker' });
      this.adding.set(false);
      await this.live.refresh();
      this.toasts.ok(`${this.draft.name.trim()} added.`);
    });
  }

  async save(a: Agent): Promise<void> {
    await this.run(async () => {
      await this.api.updateAgent(a.id, { name: this.edit.name.trim(), model: this.edit.model.trim() });
      this.editing.set('');
      await this.live.refresh();
      this.toasts.ok('Worker saved.');
    });
  }

  async act(a: Agent, action: 'pause' | 'resume' | 'unblock'): Promise<void> {
    await this.run(() => this.api.agentAction(a.id, action));
  }

  async stop(a: Agent): Promise<void> {
    const ok = await this.confirm.ask({ title: `Stop ${a.name}'s run?`, body: 'The work so far stays on its branch, and the worker becomes available.', confirm: 'Stop run', danger: true });
    if (ok && a.currentRunId) await this.run(() => this.api.stopRun(a.currentRunId!));
  }

  async remove(a: Agent): Promise<void> {
    const ok = await this.confirm.ask({
      title: `Delete ${a.name}?`,
      body: 'The worker is removed. Its past runs and their branches stay.',
      confirm: 'Delete worker',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      await this.api.deleteAgent(a.id);
      await this.live.refresh();
      this.toasts.ok(`${a.name} deleted.`);
    });
  }

  private async run(fn: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
