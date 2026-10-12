import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { STATE_LABEL, type Agent, type AgentState, type ProviderView } from '../models';
import { Confirm } from '../ui/confirm';
import { Icon } from '../ui/icon';
import { ModelSelect } from '../ui/model-select';
import { Toasts } from '../ui/toast';

const BUSY: AgentState[] = ['working', 'running_checks', 'addressing_review', 'waiting_review'];

/** The workers that implement tickets: add, rename, change model, pause, delete. */
@Component({
  selector: 'app-agents',
  imports: [FormsModule, RouterLink, Icon, ModelSelect],
  template: `
    <header class="page-head">
      <div>
        <h1>Workers</h1>
        <p class="page-sub">Each worker takes one ticket at a time, using its own AI provider or the one set for workers in Settings.</p>
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
          <label>AI provider
            <select [(ngModel)]="draft.provider" name="provider">
              <option value="">Default for workers ({{ defaultName() }})</option>
              @for (p of providers(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select>
          </label>
          <div class="field"><span class="field-label">Model</span>
            <app-model-select [provider]="draft.provider || defaultId()" [(value)]="draft.model" selectId="new-model" label="Model" [defaultLabel]="defaultModelLabel(draft.provider)" />
          </div>
        </div>
        <div class="row">
          <button class="primary" type="submit" [disabled]="!draft.name.trim() || busy()">Add worker</button>
          <button type="button" class="quiet" (click)="adding.set(false)">Cancel</button>
        </div>
      </form>
    }


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
              <label>AI provider
                <select [(ngModel)]="edit.provider" name="provider">
                  <option value="">Default for workers ({{ defaultName() }})</option>
                  @for (p of providers(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                </select>
              </label>
              <div class="field"><span class="field-label">Model</span>
                <app-model-select [provider]="edit.provider || defaultId()" [(value)]="edit.model" [selectId]="'edit-model-' + a.id" label="Model" [defaultLabel]="defaultModelLabel(edit.provider)" />
              </div>
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
            <p class="meta">{{ providerName(a.provider) }} · {{ a.model || defaultModel(a.provider) }}</p>
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
  readonly adding = signal(false);
  readonly editing = signal('');
  readonly busy = signal(false);
  draft = { name: '', provider: '', model: '' };
  edit = { name: '', provider: '', model: '' };
  readonly providers = signal<ProviderView[]>([]);
  readonly defaultId = signal('claude');
  /** The model set for the worker role in Settings. */
  readonly roleModel = signal('');

  readonly summary = computed(() => {
    const counts = new Map<AgentState, number>();
    for (const a of this.live.agents()) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
    return [...counts].map(([state, count]) => ({ state, count, label: STATE_LABEL[state] }));
  });

  constructor() {
    void this.api.providers?.().then((i) => {
      this.providers.set(i.providers);
      this.defaultId.set(i.roles.worker.provider);
      this.roleModel.set(i.roles.worker.model);
    }, () => undefined);
  }

  /** What "no model" means for a worker: the worker role's model when it uses that provider, else the provider's own default. */
  defaultModel(provider: string): string {
    const usesRole = !provider || provider === this.defaultId();
    return usesRole && this.roleModel() ? `${this.roleModel()} (default)` : 'default model';
  }

  defaultModelLabel(provider: string): string {
    const usesRole = !provider || provider === this.defaultId();
    return usesRole && this.roleModel() ? `Default: ${this.roleModel()}` : 'The provider’s default model';
  }

  defaultName(): string {
    return this.providerName('');
  }

  providerName(id: string): string {
    const pid = id || this.defaultId();
    return this.providers().find((p) => p.id === pid)?.name ?? pid;
  }

  runFor(a: Agent) {
    return a.currentRunId ? this.live.runs().find((r) => r.id === a.currentRunId) : undefined;
  }

  isBusy(a: Agent): boolean {
    return BUSY.includes(a.state);
  }

  startAdd(): void {
    this.draft = { name: `Worker ${this.live.agents().length + 1}`, provider: '', model: '' };
    this.adding.set(true);
  }

  startEdit(a: Agent): void {
    this.edit = { name: a.name, provider: a.provider ?? '', model: a.model };
    this.editing.set(a.id);
  }

  async add(): Promise<void> {
    await this.run(async () => {
      await this.api.createAgent({ name: this.draft.name.trim(), provider: this.draft.provider, model: this.draft.model.trim(), role: 'worker' });
      this.adding.set(false);
      await this.live.refresh();
      this.toasts.ok(`${this.draft.name.trim()} added.`);
    });
  }

  async save(a: Agent): Promise<void> {
    await this.run(async () => {
      await this.api.updateAgent(a.id, { name: this.edit.name.trim(), provider: this.edit.provider, model: this.edit.model.trim() });
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
