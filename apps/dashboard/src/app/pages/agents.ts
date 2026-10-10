import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { STATE_LABEL, type Agent, type AgentState } from '../models';

@Component({
  selector: 'app-agents',
  imports: [FormsModule, RouterLink],
  template: `
    <header class="page-head">
      <h1>Agents</h1>
      <button class="primary" (click)="adding.set(!adding())">{{ adding() ? 'Cancel' : 'Add agent' }}</button>
    </header>

    <div class="summary">
      @for (s of summary(); track s.state) {
        <span class="state state-{{ s.state }}">{{ s.label }}: {{ s.count }}</span>
      }
    </div>

    @if (adding()) {
      <form class="panel row" (ngSubmit)="add()">
        <label>Name <input [(ngModel)]="draft.name" name="name" required /></label>
        <label>Model <input [(ngModel)]="draft.model" name="model" placeholder="Default from Settings" /></label>
        <button class="primary" type="submit" [disabled]="!draft.name">Add worker</button>
      </form>
    }
    @if (error()) { <p class="error">{{ error() }}</p> }

    <div class="grid">
      @for (a of live.agents(); track a.id) {
        <article class="card agent">
          <div class="agent-head">
            <h2>{{ a.name }}</h2>
            <span class="state state-{{ a.state }}">{{ stateLabel[a.state] }}</span>
          </div>
          <p class="meta">{{ a.role }} · {{ a.model || 'default model' }}</p>
          @if (a.note) { <p>{{ a.note }}</p> }
          @if (runFor(a); as r) {
            <p><a [routerLink]="['/runs', r.id]">{{ r.ticketKey }}: {{ r.ticketTitle }}</a></p>
          }
          <div class="row">
            @if (a.state === 'available') { <button (click)="act(a, 'pause')">Pause</button> }
            @if (a.state === 'paused') { <button (click)="act(a, 'resume')">Resume</button> }
            @if (a.state === 'blocked') { <button class="primary" (click)="act(a, 'unblock')">Mark unblocked</button> }
            @if (a.currentRunId && busy(a)) { <button class="danger" (click)="stop(a)">Stop run</button> }
            @if (!busy(a)) { <button class="quiet" (click)="remove(a)">Remove</button> }
          </div>
        </article>
      }
    </div>
  `,
})
export class AgentsPage {
  private readonly api = inject(Api);
  readonly live = inject(Live);
  readonly stateLabel = STATE_LABEL;
  readonly adding = signal(false);
  readonly error = signal('');
  draft = { name: '', model: '' };

  readonly summary = computed(() => {
    const counts = new Map<AgentState, number>();
    for (const a of this.live.agents()) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
    return [...counts].map(([state, count]) => ({ state, count, label: STATE_LABEL[state] }));
  });

  runFor(a: Agent) {
    return a.currentRunId ? this.live.runs().find((r) => r.id === a.currentRunId) : undefined;
  }

  busy(a: Agent): boolean {
    return ['working', 'running_checks', 'addressing_review'].includes(a.state);
  }

  async add(): Promise<void> {
    try {
      await this.api.createAgent({ name: this.draft.name, model: this.draft.model, role: 'worker' });
      this.draft = { name: '', model: '' };
      this.adding.set(false);
      await this.live.refresh();
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  async act(a: Agent, action: 'pause' | 'resume' | 'unblock'): Promise<void> {
    await this.run(() => this.api.agentAction(a.id, action));
  }

  async stop(a: Agent): Promise<void> {
    if (a.currentRunId && confirm(`Stop ${a.name}'s run? Work so far stays on its branch.`)) await this.run(() => this.api.stopRun(a.currentRunId!));
  }

  async remove(a: Agent): Promise<void> {
    if (confirm(`Remove ${a.name}?`)) {
      await this.run(() => this.api.deleteAgent(a.id));
      await this.live.refresh();
    }
  }

  private async run(fn: () => Promise<unknown>): Promise<void> {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }
}
