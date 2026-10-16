import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Api } from '../api';
import { ChatPanel } from '../components/chat-panel';
import { Live } from '../live';
import { RUN_LABEL, STATE_LABEL, type Overview } from '../models';
import { Icon } from '../ui/icon';
import { UsageView, describeCaps } from '../ui/usage';
import { ChatDock } from '../ui/chat-dock';
import { Needs } from '../ui/needs';

const WHY = { blocked: { icon: 'alert', label: 'Blocked' }, review: { icon: 'pr', label: 'Ready for review' }, failed: { icon: 'x', label: 'Failed today' } } as const;

/** Everything at a glance, plus the assistant. */
@Component({
  selector: 'app-home',
  imports: [Needs, UsageView, RouterLink, DatePipe, Icon, ChatPanel],
  template: `
    <header class="page-head">
      <div>
        <h1>Dashboard</h1>
        <p class="page-sub">What your agents are doing and what needs you.</p>
      </div>
      <a class="button primary" appNeeds="project.create" routerLink="/projects" [queryParams]="{ new: 1 }"><app-icon name="plus" [size]="16" /> New project</a>
    </header>

    @if (dock.state() === 'minimized' && !dock.phone()) {
      <div class="chat-bar" role="region" aria-label="Ask Maestro, minimized">
        <button type="button" class="chat-bar-open" (click)="dock.open()" aria-expanded="false" aria-label="Expand the chat">
          <app-icon name="chat" /> <strong>Ask Maestro</strong> <span class="hint">About any project, ticket, pull request or run</span>
        </button>
        <button type="button" class="icon-btn" (click)="dock.open()" title="Expand" aria-label="Expand the chat"><app-icon name="expand" /></button>
        <button type="button" class="icon-btn" (click)="dock.close()" title="Close" aria-label="Close the chat"><app-icon name="x" /></button>
      </div>
    }

    <div class="home" [class.solo]="!chatDocked()">
      <div class="home-main">
        @if (o(); as o) {
          <div class="tiles">
            <a class="tile link" routerLink="/agents">
              <span class="tile-label"><app-icon name="play" [size]="14" /> Working now</span>
              <span class="tile-value">{{ o.active.length }}</span>
              <span class="tile-note">{{ busyWorkers() }} of {{ o.agents.length }} workers busy</span>
            </a>
            <a class="tile link" routerLink="/pull-requests">
              <span class="tile-label"><app-icon name="pr" [size]="14" /> Waiting for you</span>
              <span class="tile-value">{{ count('review') }}</span>
              <span class="tile-note">changes ready for review</span>
            </a>
            <a class="tile link" [class.tile-bad]="count('blocked')" routerLink="/alerts">
              <span class="tile-label"><app-icon name="alert" [size]="14" /> Blocked</span>
              <span class="tile-value">{{ count('blocked') }}</span>
              <span class="tile-note">{{ o.alertsUnread }} unread alerts</span>
            </a>
            <a class="tile link" routerLink="/metrics">
              <span class="tile-label"><app-icon name="coin" [size]="14" /> Usage today</span>
              <span class="tile-value"><app-usage [usage]="o.spend.today.usage" [usd]="o.spend.today.usd" /></span>
              <span class="tile-note"><app-usage [usage]="o.spend.last7Days.usage" [usd]="o.spend.last7Days.usd" /> in 7 days</span>
            </a>
          </div>
          @if ((o.spend.byUser ?? []).length) {
            <section class="panel usage-people" aria-label="Usage today by person">
              <h2>Usage today by person</h2>
              <ul>
                @for (u of o.spend.byUser; track u.userId) {
                  <li><span class="member-name">{{ u.name }}</span><app-usage [usage]="u.usage" [usd]="u.usd" /></li>
                }
              </ul>
            </section>
          }

          <section class="card section">
            <div class="section-head"><h2>Needs you</h2></div>
            @for (n of o.needsYou; track n.runId) {
              <a class="row-item" [routerLink]="['/runs', n.runId]">
                <span class="why why-{{ n.why }}"><app-icon [name]="why[n.why].icon" [size]="16" /></span>
                <span class="row-main">
                  <strong>{{ n.ticketKey }}</strong> {{ n.ticketTitle }}
                  <span class="meta">{{ n.projectName }} · {{ why[n.why].label }}{{ n.error ? ': ' + n.error : '' }}</span>
                </span>
                <app-icon name="arrow" [size]="16" />
              </a>
            } @empty {
              <p class="all-clear"><app-icon name="check" [size]="16" /> All clear: nothing is blocked or waiting for review.</p>
            }
          </section>

          <section class="card section">
            <div class="section-head"><h2>Working now</h2><a routerLink="/agents">Workers</a></div>
            <div class="worker-strip">
              @for (a of o.agents; track a.id) {
                <span class="state state-{{ a.state }}" [title]="a.note">{{ a.name }} · {{ stateLabel[a.state] }}</span>
              } @empty { <span class="hint">No workers yet. <a routerLink="/agents">Add one</a>.</span> }
            </div>
            @for (r of o.active; track r.runId) {
              <a class="row-item" [routerLink]="['/runs', r.runId]">
                <span class="spinner" aria-hidden="true"></span>
                <span class="row-main"><strong>{{ r.ticketKey }}</strong> {{ r.ticketTitle }} <span class="meta">{{ r.projectName }} · {{ runLabel[r.status] }}</span></span>
                <span class="meta"><app-usage [usage]="r.usage" [usd]="r.costUsd" /></span>
              </a>
            }
          </section>

          <section class="section">
            <div class="section-head"><h2>Projects</h2><a routerLink="/projects">All projects</a></div>
            @if (o.projects.length === 0) {
              <div class="empty-state">
                <app-icon name="folder" [size]="28" />
                <h2>No projects yet</h2>
                <p>Link a repository and a place for tickets, then let agents work on them.</p>
                <a class="button primary" appNeeds="project.create" routerLink="/projects" [queryParams]="{ new: 1 }">Create a project</a>
              </div>
            }
            <div class="grid">
              @for (p of o.projects; track p.id) {
                <a class="card link project-card" [routerLink]="['/projects', p.id]">
                  <div class="agent-head"><h2>{{ p.name }}</h2>@if (p.autoAssign) { <span class="pill">Auto-assign</span> }</div>
                  @if (p.tickets; as t) {
                    <div class="ticket-bar" [attr.aria-label]="t.todo + ' to do, ' + t.in_progress + ' in progress, ' + t.in_review + ' in review, ' + t.done + ' done'">
                      @for (seg of segments(t); track seg.key) { <span class="seg seg-{{ seg.key }}" [style.flex-grow]="seg.n"></span> }
                    </div>
                    <p class="meta">{{ t.todo }} to do · {{ t.in_progress }} in progress · {{ t.in_review }} in review · {{ t.done }} done</p>
                  } @else {
                    <p class="meta">Tickets unavailable (check the PM connection)</p>
                  }
                  <p class="meta">
                    @if (p.running) { <span>{{ p.running }} running · </span> }
                    @if (p.blocked) { <span class="error">{{ p.blocked }} blocked · </span> }
                    <app-usage [usage]="p.spendToday.usage" [usd]="p.spendToday.usd" /> today · limit {{ describeCaps(p.dailyCaps) }}
                  </p>
                </a>
              }
            </div>
          </section>

          <section class="card section">
            <div class="section-head"><h2>Recent activity</h2></div>
            <ul class="activity">
              @for (e of o.activity; track e.id) {
                <li>
                  <time>{{ e.ts | date: 'short' }}</time>
                  <a [routerLink]="['/runs', e.runId]">{{ e.ticketKey }}</a>
                  <span class="meta">{{ e.projectName }}</span>
                  <span class="activity-msg" [class.error]="e.kind === 'error'">{{ firstLine(e.message) }}</span>
                </li>
              } @empty { <li class="hint">No activity yet.</li> }
            </ul>
          </section>
        } @else if (error()) {
          <p class="error">{{ error() }}</p>
        } @else {
          <div class="tiles">@for (i of [1, 2, 3, 4]; track i) { <div class="skeleton" style="height:96px"></div> }</div>
          <div class="skeleton" style="height:160px;margin-top:16px"></div>
        }
      </div>

      @if (chatDocked()) {
        <aside class="home-chat">
          <app-chat-panel [projects]="projects()" [initialScope]="focus() ?? ''" [canMinimize]="true" [canClose]="true" (minimize)="dock.minimize()" (closed)="dock.close()" />
        </aside>
      }
    </div>
  `,
})
export class HomePage {
  readonly describeCaps = describeCaps;
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  readonly stateLabel = STATE_LABEL;
  readonly runLabel = RUN_LABEL;
  readonly why = WHY;
  readonly o = signal<Overview | null>(null);
  readonly error = signal('');
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly dock = inject(ChatDock);
  /** The chat beside the Dashboard: open, on a wide screen (phones open it as a sheet from the chat button). */
  readonly chatDocked = computed(() => this.dock.state() === 'open' && !this.dock.phone());
  readonly focus = computed(() => this.query()?.get('project') ?? '');

  readonly projects = computed(() => (this.o()?.projects ?? []).map(({ id, name }) => ({ id, name })));
  readonly busyWorkers = computed(() => (this.o()?.agents ?? []).filter((a) => a.state !== 'available' && a.state !== 'paused').length);

  constructor() {
    // Refresh when agents or runs change; the first load happens right away.
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      this.live.runs();
      this.live.agents();
      clearTimeout(timer);
      timer = setTimeout(() => void this.load(), this.o() ? 800 : 0);
    });
  }

  async load(): Promise<void> {
    try {
      this.o.set(await this.api.overview());
      this.error.set('');
    } catch (e) {
      this.error.set(`Couldn't load the overview: ${(e as Error).message}`);
    }
  }

  count(why: 'blocked' | 'review' | 'failed'): number {
    return (this.o()?.needsYou ?? []).filter((n) => n.why === why).length;
  }

  segments(t: Record<string, number>) {
    return ['todo', 'in_progress', 'in_review', 'done'].map((key) => ({ key, n: t[key] ?? 0 })).filter((s) => s.n > 0);
  }

  firstLine(text: string): string {
    return text.split('\n')[0].slice(0, 160);
  }
}
