import { Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import type { ChatAction, ChatMessage, Project, Ticket } from '../models';
import { Icon } from '../ui/icon';
import { Confirm } from '../ui/confirm';
import { Toasts } from '../ui/toast';

interface ContextChip {
  id: string;
  label: string;
  text: string;
}

const SUGGESTIONS = [
  'What needs my attention right now?',
  'Summarise progress across my projects.',
  'Which tickets are blocked, and why?',
  'What did the agents do today?',
];

/** The assistant across all projects: optional project focus, context chips, confirmable actions. */
@Component({
  selector: 'app-chat-panel',
  imports: [FormsModule, RouterLink, DatePipe, Icon],
  template: `
    <section class="chat-panel" aria-label="Ask Maestro">
      <header class="chat-head">
        <div>
          <h2><app-icon name="chat" /> Ask Maestro</h2>
          <p class="hint">About any project, ticket, pull request or run.</p>
        </div>
        @if (messages().length) {
          <button class="icon-btn" (click)="clear()" title="Clear conversation" aria-label="Clear conversation"><app-icon name="trash" /></button>
        }
      </header>

      <div class="chat-scope">
        <label class="sr-only" for="chat-scope">Focus</label>
        <select id="chat-scope" [ngModel]="scope()" (ngModelChange)="setScope($event)" name="scope">
          <option value="">All projects</option>
          @for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
        </select>
        <button type="button" class="quiet" (click)="picking.set(!picking())" [attr.aria-expanded]="picking()">
          <app-icon name="link" [size]="16" /> Add context
        </button>
      </div>

      @if (picking()) {
        <div class="chat-picker" role="listbox" aria-label="Add a ticket, pull request or run">
          <input [(ngModel)]="pickFilter" name="pf" placeholder="Filter tickets and runs" aria-label="Filter" />
          @for (o of pickOptions(); track o.id) {
            <button type="button" role="option" class="pick" (click)="addChip(o)">{{ o.label }}</button>
          } @empty {
            <p class="hint">{{ scope() ? 'No tickets or runs match.' : 'Pick a project to list its tickets; runs from all projects show here.' }}</p>
          }
        </div>
      }

      <div class="chat-log" #log>
        @if (loading()) {
          <div class="skeleton" style="height:40px"></div><div class="skeleton" style="height:60px;width:70%"></div>
        } @else if (messages().length === 0) {
          <div class="chat-empty">
            <p>Try one of these:</p>
            @for (s of suggestions; track s) { <button type="button" class="suggestion" (click)="send(s)">{{ s }}</button> }
          </div>
        }
        @for (m of messages(); track $index) {
          <div class="msg msg-{{ m.role }}">
            {{ m.content }}
            @if (m.createdAt) { <time class="msg-time">{{ m.createdAt | date: 'shortTime' }}</time> }
          </div>
          @for (a of m.actions ?? []; track a.id) {
            <div class="action-card">
              <app-icon name="sparkles" [size]="16" />
              <span class="action-text">{{ a.summary }}</span>
              @switch (a.state) {
                @case ('running') { <span class="spinner" aria-label="Running"></span> }
                @case ('done') {
                  <span class="ok">{{ a.result }}</span>
                  @if (a.runId) { <a [routerLink]="['/runs', a.runId]">Open run</a> }
                }
                @case ('failed') { <span class="error">{{ a.result }}</span> }
                @case ('dismissed') { <span class="muted">Dismissed</span> }
                @default {
                  <button class="primary" (click)="confirm(a)"><app-icon name="check" [size]="14" /> Confirm</button>
                  <button class="quiet" (click)="dismiss(a)">Dismiss</button>
                }
              }
            </div>
          }
        }
        @if (thinking()) { <div class="msg msg-assistant muted"><span class="spinner"></span> Thinking…</div> }
      </div>

      @if (chips().length) {
        <div class="chips">
          @for (c of chips(); track c.id) {
            <span class="chip">{{ c.label }} <button type="button" class="chip-x" (click)="removeChip(c.id)" [attr.aria-label]="'Remove ' + c.label">×</button></span>
          }
        </div>
      }
      <form class="chat-compose" (ngSubmit)="send()">
        <label class="sr-only" for="chat-input">Message</label>
        <textarea id="chat-input" [(ngModel)]="text" name="text" rows="2" [disabled]="thinking()"
          [placeholder]="scope() ? 'Ask about ' + scopeName() + '…' : 'Ask about your projects…'"
          (keydown.enter)="onEnter($any($event))"></textarea>
        <button class="primary" type="submit" [disabled]="!text.trim() || thinking()" aria-label="Send"><app-icon name="send" [size]="16" /></button>
      </form>
    </section>
  `,
})
export class ChatPanel {
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  private readonly toasts = inject(Toasts);
  private readonly confirmDialog = inject(Confirm);
  /** Project to focus on when the panel opens. */
  readonly initialScope = input<string>('');
  readonly projects = input<Pick<Project, 'id' | 'name'>[]>([]);

  readonly suggestions = SUGGESTIONS;
  readonly messages = signal<ChatMessage[]>([]);
  readonly loading = signal(true);
  readonly thinking = signal(false);
  readonly scope = signal('');
  readonly picking = signal(false);
  readonly chips = signal<ContextChip[]>([]);
  readonly tickets = signal<Ticket[]>([]);
  pickFilter = '';
  text = '';
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  readonly scopeName = computed(() => this.projects().find((p) => p.id === this.scope())?.name ?? '');
  readonly pickOptions = computed((): ContextChip[] => {
    const name = (id: string) => this.projects().find((p) => p.id === id)?.name ?? '';
    const fromTickets = this.tickets().map((t) => ({ id: `t:${t.key}`, label: `${t.key} ${t.title}`, text: `ticket ${t.key} "${t.title}" (${t.status}) in ${this.scopeName()}` }));
    const fromRuns = this.live
      .runs()
      .filter((r) => (!this.scope() || r.projectId === this.scope()) && ['running', 'reviewing', 'in_review', 'blocked', 'failed'].includes(r.status))
      .slice(0, 20)
      .map((r) => ({
        id: `r:${r.id}`,
        label: `${r.prUrl ? 'PR' : 'Run'} ${r.ticketKey} · ${r.status.replace('_', ' ')}`,
        text: `${r.prUrl ? `pull request ${r.prUrl}` : 'run'} for ${r.ticketKey} "${r.ticketTitle}" in ${name(r.projectId)} (${r.status}${r.error ? `: ${r.error}` : ''})`,
      }));
    const f = this.pickFilter.trim().toLowerCase();
    return [...fromRuns, ...fromTickets].filter((o) => !this.chips().some((c) => c.id === o.id) && (!f || o.label.toLowerCase().includes(f)));
  });

  constructor() {
    void this.api.globalChatHistory().then(
      (m) => {
        this.messages.set(m);
        this.loading.set(false);
        this.scrollDown();
      },
      () => this.loading.set(false),
    );
    effect(() => this.setScope(this.initialScope()));
  }

  setScope(id: string): void {
    this.scope.set(id);
    this.chips.set([]);
    this.tickets.set([]);
    if (id) void this.api.tickets(id).then((t) => this.tickets.set(t.filter((x) => x.status !== 'done')), () => undefined);
  }

  addChip(c: ContextChip): void {
    this.chips.update((xs) => [...xs, c]);
    this.picking.set(false);
    this.pickFilter = '';
  }

  removeChip(id: string): void {
    this.chips.update((xs) => xs.filter((c) => c.id !== id));
  }

  onEnter(e: KeyboardEvent): void {
    if (e.shiftKey) return;
    e.preventDefault();
    void this.send();
  }

  async send(preset?: string): Promise<void> {
    const typed = (preset ?? this.text).trim();
    if (!typed || this.thinking()) return;
    const context = this.chips().map((c) => c.text);
    const message = context.length ? `About ${context.join('; ')}:\n${typed}` : typed;
    this.messages.update((m) => [...m, { role: 'user', content: message }]);
    this.text = '';
    this.chips.set([]);
    this.thinking.set(true);
    this.scrollDown();
    try {
      const res = await this.api.globalChat(message, this.scope() || undefined);
      this.messages.update((m) => [...m, { role: 'assistant', content: res.answer, createdAt: res.createdAt, actions: res.actions }]);
    } catch (e) {
      this.messages.update((m) => [...m, { role: 'assistant', content: `Couldn't answer: ${(e as Error).message}` }]);
    } finally {
      this.thinking.set(false);
      this.scrollDown();
    }
  }

  async confirm(a: ChatAction): Promise<void> {
    this.setAction(a.id, { state: 'running' });
    try {
      const res = await this.api.confirmGlobalAction(a.id);
      this.setAction(a.id, { state: 'done', result: res.message, runId: res.runId });
      this.toasts.ok(res.message);
      void this.live.refresh();
    } catch (e) {
      this.setAction(a.id, { state: 'failed', result: (e as Error).message });
    }
  }

  async dismiss(a: ChatAction): Promise<void> {
    this.setAction(a.id, { state: 'dismissed' });
    await this.api.dismissGlobalAction(a.id).catch(() => undefined);
  }

  async clear(): Promise<void> {
    const ok = await this.confirmDialog.ask({ title: 'Clear the conversation?', body: 'The messages and any proposals you did not confirm are removed.', confirm: 'Clear', danger: true });
    if (!ok) return;
    await this.api.clearGlobalChat();
    this.messages.set([]);
  }

  private setAction(id: string, patch: Partial<ChatAction>): void {
    this.messages.update((ms) => ms.map((m) => (m.actions?.some((a) => a.id === id) ? { ...m, actions: m.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) } : m)));
  }

  private scrollDown(): void {
    setTimeout(() => {
      const el = this.log()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
