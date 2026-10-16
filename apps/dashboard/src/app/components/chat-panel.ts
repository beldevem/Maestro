import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import type { ChatAction, ChatMessage, ChatModels, ChatThread, Project, Ticket } from '../models';
import { renderMarkdown } from '../ui/markdown';
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
        <div class="chat-head-actions">
          <button type="button" class="icon-btn" (click)="newChat()" title="New chat" aria-label="New chat"><app-icon name="plus" /></button>
          @if (canMinimize()) {
            <button type="button" class="icon-btn" (click)="minimize.emit()" title="Minimize" aria-label="Minimize the chat" aria-expanded="true" aria-controls="chat-body"><app-icon name="minus" /></button>
          }
          @if (canClose()) {
            <button type="button" class="icon-btn" (click)="closed.emit()" title="Close" aria-label="Close the chat"><app-icon name="x" /></button>
          }
        </div>
      </header>

      <div class="chat-threads">
        @if (renaming()) {
          <form class="chat-rename" (ngSubmit)="saveTitle()">
            <label class="sr-only" for="chat-title">Conversation title</label>
            <input id="chat-title" [(ngModel)]="titleText" name="title" maxlength="80" (keydown.escape)="renaming.set(false)" />
            <button type="submit" class="primary" [disabled]="!titleText.trim()">Save</button>
            <button type="button" class="quiet" (click)="renaming.set(false)">Cancel</button>
          </form>
        } @else {
          <label class="sr-only" for="chat-thread">Conversation</label>
          <select id="chat-thread" [ngModel]="threadId()" (ngModelChange)="openThread($event)" name="thread">
            @if (!threadId()) { <option value="">New chat</option> }
            @for (t of visibleThreads(); track t.id) { <option [value]="t.id">{{ t.title }} · {{ t.updatedAt | date: 'MMM d, HH:mm' }}</option> }
          </select>
          @if (threadId()) {
            <button type="button" class="icon-btn" (click)="startRename()" title="Rename" aria-label="Rename this conversation"><app-icon name="edit" /></button>
            <button type="button" class="icon-btn" (click)="deleteThread()" title="Delete this conversation" aria-label="Delete this conversation"><app-icon name="trash" /></button>
          }
        }
      </div>

      <div class="chat-body" id="chat-body">
      <div class="chat-scope">
        <label class="sr-only" for="chat-scope">Focus</label>
        <select id="chat-scope" [ngModel]="scope()" (ngModelChange)="setScope($event)" name="scope">
          <option value="">All projects</option>
          @for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
        </select>
        <label class="sr-only" for="chat-model">Model</label>
        <select id="chat-model" class="chat-model" [ngModel]="modelKey()" (ngModelChange)="pickModel($event)" name="model" [title]="modelHint()">
          <option value="">Default: {{ defaultLabel() }}</option>
          @for (g of modelGroups(); track g.provider) {
            <optgroup [label]="g.name + (g.hint ? ' (' + g.hint + ')' : '')">
              @if (g.error) { <option disabled [value]="g.provider + '::!'">{{ g.error }}</option> }
              @for (m of g.models; track m) { <option [value]="g.provider + '::' + m">{{ m || 'its default model' }}</option> }
            </optgroup>
          }
        </select>
        <button type="button" class="quiet" (click)="picking.set(!picking())" [attr.aria-expanded]="picking()">
          <app-icon name="link" [size]="16" /> Add context
        </button>
      </div>
      @if (modelHint()) { <p class="warn chat-warn">{{ modelHint() }}</p> }

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
            @if (m.role === 'assistant') { <div class="md" [innerHTML]="md(m.content)"></div> } @else { <div class="msg-text">{{ m.content }}</div> }
            <span class="msg-time">
              @if (m.createdAt) { <time>{{ m.createdAt | date: 'shortTime' }}</time> }
              @if (m.role === 'assistant' && m.model) { <span class="msg-model">{{ m.model }}</span> }
            </span>
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
      </div>
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
  /** Shows a minimize button (the Dashboard). */
  readonly canMinimize = input(false);
  /** Shows a close button (the Dashboard, the drawer). */
  readonly canClose = input(false);
  readonly minimize = output<void>();
  readonly closed = output<void>();

  readonly suggestions = SUGGESTIONS;
  readonly messages = signal<ChatMessage[]>([]);
  readonly loading = signal(true);
  readonly thinking = signal(false);
  readonly scope = signal('');
  readonly picking = signal(false);
  readonly chips = signal<ContextChip[]>([]);
  readonly tickets = signal<Ticket[]>([]);
  readonly models = signal<ChatModels | null>(null);
  readonly modelKey = signal('');
  readonly threads = signal<ChatThread[]>([]);
  /** The open conversation; '' for a new one, created on its first question. */
  readonly threadId = signal('');
  readonly renaming = signal(false);
  titleText = '';
  readonly md = renderMarkdown;
  pickFilter = '';
  text = '';
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  readonly modelGroups = computed(() => this.models()?.groups ?? []);
  readonly defaultLabel = computed(() => {
    const m = this.models();
    if (!m) return 'chat model from Settings';
    return `${this.modelGroups().find((g) => g.provider === m.default.provider)?.name ?? m.default.provider}${m.default.model ? ' · ' + m.default.model : ''}`;
  });
  /** A warning about the chosen model's provider, if it is a poor fit for chat or unreachable. */
  readonly modelHint = computed(() => {
    const m = this.models();
    if (!m) return '';
    const provider = this.modelKey() ? this.modelKey().split('::')[0] : m.default.provider;
    const g = this.modelGroups().find((x) => x.provider === provider);
    return g?.error || g?.hint || '';
  });
  /** On a project's page, only the conversations about that project. */
  readonly visibleThreads = computed(() => {
    const only = this.projects().length === 1 && this.initialScope() ? this.initialScope() : '';
    return only ? this.threads().filter((t) => t.projectId === only) : this.threads();
  });
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
    void this.loadThreads();
    // The page's project focus applies to a new conversation; an open one keeps its own.
    effect(() => {
      const scope = this.initialScope();
      untracked(() => {
        if (!this.threadId()) this.setScope(scope, false);
      });
    });
    void this.loadModels();
  }

  /** Opens the most recent conversation (on a project's page: about that project), or a new one. */
  async loadThreads(): Promise<void> {
    try {
      this.threads.set(await this.api.chatThreads());
      const latest = this.visibleThreads()[0];
      if (latest) await this.openThread(latest.id);
      else this.loading.set(false);
    } catch {
      this.loading.set(false);
    }
  }

  async openThread(id: string): Promise<void> {
    this.renaming.set(false);
    if (!id) return this.newChat();
    this.loading.set(true);
    try {
      const { thread, messages } = await this.api.chatThread(id);
      this.threadId.set(thread.id);
      this.messages.set(messages);
      this.setScope(thread.projectId ?? '', false);
      this.modelKey.set(thread.model ? `${thread.model.provider}::${thread.model.model}` : '');
      this.scrollDown();
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /** A fresh conversation, created on its first question; it starts on the page's project focus. */
  newChat(): void {
    this.threadId.set('');
    this.messages.set([]);
    this.modelKey.set('');
    this.renaming.set(false);
    this.setScope(this.initialScope(), false);
    this.loading.set(false);
  }

  startRename(): void {
    this.titleText = this.threads().find((t) => t.id === this.threadId())?.title ?? '';
    this.renaming.set(true);
  }

  async saveTitle(): Promise<void> {
    const title = this.titleText.trim();
    if (!title) return;
    try {
      this.replaceThread(await this.api.updateChatThread(this.threadId(), { title }));
      this.renaming.set(false);
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  async deleteThread(): Promise<void> {
    const t = this.threads().find((x) => x.id === this.threadId());
    const ok = await this.confirmDialog.ask({ title: `Delete “${t?.title ?? 'this conversation'}”?`, body: 'Its messages and any proposals you did not confirm are removed. Other conversations stay.', confirm: 'Delete', danger: true });
    if (!ok) return;
    try {
      await this.api.deleteChatThread(this.threadId());
      this.threads.update((xs) => xs.filter((x) => x.id !== this.threadId()));
      const next = this.visibleThreads()[0];
      if (next) await this.openThread(next.id);
      else this.newChat();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  private replaceThread(t: ChatThread): void {
    this.threads.update((xs) => [t, ...xs.filter((x) => x.id !== t.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async loadModels(): Promise<void> {
    if (!this.api.chatModels) return;
    try {
      this.models.set(await this.api.chatModels());
    } catch {
      // The picker then only offers the default.
    }
  }

  async pickModel(key: string): Promise<void> {
    const [provider, model] = key ? key.split('::') : ['', ''];
    const choice = provider ? { provider, model } : null;
    try {
      // A new conversation is created now, so it keeps the model you picked.
      const t = this.threadId()
        ? await this.api.updateChatThread(this.threadId(), { model: choice })
        : await this.api.createChatThread({ projectId: this.scope() || null, model: choice });
      this.threadId.set(t.id);
      this.replaceThread(t);
      this.modelKey.set(key);
      const g = this.modelGroups().find((x) => x.provider === provider);
      this.toasts.info(provider ? `Chat now uses ${g?.name ?? provider}${model ? ' · ' + model : ''}.` : 'Chat uses the default model again.');
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  /** Changes the project in focus; for an existing conversation it is saved with it. */
  setScope(id: string, save = true): void {
    if (save && this.threadId() && id !== this.scope()) {
      void this.api.updateChatThread(this.threadId(), { projectId: id || null }).then((t) => this.replaceThread(t), () => undefined);
    }
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
      const res = await this.api.globalChat(message, this.threadId() || undefined, this.scope() || null);
      if (res.thread) {
        this.threadId.set(res.thread.id);
        this.replaceThread(res.thread);
      }
      this.messages.update((m) => [...m, { role: 'assistant', content: res.answer, createdAt: res.createdAt, model: res.model, actions: res.actions }]);
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
