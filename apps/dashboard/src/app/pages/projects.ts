import { Component, computed, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../api';
import type { Project, ProjectSpend, ProjectTemplate } from '../models';
import { Confirm } from '../ui/confirm';
import { Icon } from '../ui/icon';
import { Toasts } from '../ui/toast';
import { ConnectorFields, emptyConnectors, type ConnectorModel } from './connector-fields';
import { Currency, UsageView, overCaps } from '../ui/usage';

type WizardStep = 'basics' | 'code' | 'tickets' | 'context' | 'review';
const WIZARD: { id: WizardStep; title: string }[] = [
  { id: 'basics', title: 'Basics' },
  { id: 'code', title: 'Code host' },
  { id: 'tickets', title: 'Tickets' },
  { id: 'context', title: 'Design and docs' },
  { id: 'review', title: 'Review' },
];
const PM_LABEL = { jira: 'Jira', trello: 'Trello', manual: 'Maestro' } as const;
const HOST_LABEL = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', local: 'Local folder' } as const;

/** What deleting a project removes, and what it never touches. */
export function deletionDetails(p: Pick<Project, 'pm'>): string[] {
  return [
    'Its runs, their logs and reviews, alerts, spend records, backlog drafts and chat',
    ...(p.pm.provider === 'manual' ? ['The tickets kept in Maestro for it'] : []),
    `Not touched: the repository and its branches${p.pm.provider === 'manual' ? '' : `, and the tickets in ${PM_LABEL[p.pm.provider]}`}`,
  ];
}

/** All projects, with a guided way to add one. */
@Component({
  selector: 'app-projects',
  imports: [FormsModule, RouterLink, ConnectorFields, Icon, UsageView],
  template: `
    <header class="page-head">
      <div>
        <h1>Projects</h1>
        <p class="page-sub">Each project links a repository to where its tickets live.</p>
      </div>
      @if (!wizard()) { <button class="primary" (click)="startWizard()"><app-icon name="plus" [size]="16" /> New project</button> }
    </header>

    @if (wizard()) {
      <section class="panel wizard" aria-label="New project">
        <ol class="wizard-steps">
          @for (w of steps; track w.id; let i = $index) {
            <li [class.current]="w.id === step()" [class.done]="i < stepIndex()">
              <button type="button" (click)="goTo(w.id)" [disabled]="i > stepIndex() && !canLeave()" [attr.aria-current]="w.id === step() ? 'step' : null">
                <span class="step-num" [class.step-done]="i < stepIndex()">@if (i < stepIndex()) { <app-icon name="check" [size]="12" /> } @else { {{ i + 1 }} }</span>
                {{ w.title }}
              </button>
            </li>
          }
        </ol>

        <form (ngSubmit)="next()" class="wizard-body" novalidate>
          @switch (step()) {
            @case ('basics') {
              <h2>What is this project?</h2>
              <label>Name <input [(ngModel)]="draft.name" name="name" required maxlength="60" placeholder="Shop" [attr.aria-invalid]="touched() && !draft.name.trim()" />
                @if (touched() && !draft.name.trim()) { <small class="field-hint error">Give the project a name.</small> }
              </label>
              <label>Description <input [(ngModel)]="draft.description" name="description" placeholder="Online shop for our coffee beans" /></label>
              <label>Start from
                <select [(ngModel)]="draft.template" name="template">
                  <option value="">Blank: default workflow, no best practices</option>
                  @for (t of templates(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }
                </select>
              </label>
              @if (templateInfo(); as t) {
                <p class="hint">{{ t.description }} Quality gates: {{ gateNames(t) }}. You can edit the workflow and best practices later.</p>
              }
            }
            @case ('code') {
              <h2>Where is the code?</h2>
              <app-connector-fields [model]="draft" only="codeHost" />
              @if (touched() && codeError()) { <p class="error">{{ codeError() }}</p> }
            }
            @case ('tickets') {
              <h2>Where do tickets live?</h2>
              <p class="hint">Keep them in Maestro, or connect Jira or Trello. The PM tool stays the source of truth.</p>
              <app-connector-fields [model]="draft" only="pm" />
            }
            @case ('context') {
              <h2>Design and docs (optional)</h2>
              <p class="hint">Agents read linked Figma frames and Confluence pages as context. Skip this if you don't use them.</p>
              <app-connector-fields [model]="draft" only="design" />
              <app-connector-fields [model]="draft" only="docs" />
            }
            @case ('review') {
              <h2>Ready to create</h2>
              <dl class="facts">
                <div><dt>Name</dt><dd>{{ draft.name }}</dd></div>
                <div><dt>Template</dt><dd>{{ templateInfo()?.name ?? 'Blank' }}</dd></div>
                <div><dt>Code</dt><dd>{{ hostLabel[draft.codeHost.provider] }}: {{ draft.codeHost.provider === 'local' ? draft.codeHost.localPath : draft.codeHost.repo }}</dd></div>
                <div><dt>Tickets</dt><dd>{{ pmLabel[draft.pm.provider] }}</dd></div>
                <div><dt>Design</dt><dd>{{ draft.design.provider === 'figma' ? 'Figma' : 'None' }}</dd></div>
                <div><dt>Docs</dt><dd>{{ draft.docs.provider === 'confluence' ? 'Confluence' : 'None' }}</dd></div>
              </dl>
              <p class="hint">Next you can add the project's context and requirements, then plan a backlog.</p>
            }
          }
          @if (error()) { <p class="error">{{ error() }}</p> }
          <div class="step-nav">
            <button type="button" class="quiet" (click)="stepIndex() === 0 ? wizard.set(false) : back()">{{ stepIndex() === 0 ? 'Cancel' : 'Back' }}</button>
            <button class="primary" type="submit" [disabled]="busy()">
              @if (step() === 'review') { Create project } @else { Next <app-icon name="arrow" [size]="14" /> }
            </button>
          </div>
        </form>
      </section>
    }

    @if (loading()) {
      <div class="grid">@for (i of [1, 2, 3]; track i) { <div class="skeleton" style="height:120px"></div> }</div>
    } @else if (projects().length === 0 && !wizard()) {
      <div class="empty-state">
        <app-icon name="folder" [size]="28" />
        <h2>No projects yet</h2>
        <p>Link a repository or a local folder and choose where tickets live.</p>
        <button class="primary" (click)="startWizard()">Create your first project</button>
      </div>
    }

    <div class="grid">
      @for (p of projects(); track p.id) {
        <article class="card project-card">
          @if (editing() === p.id) {
            <form (ngSubmit)="saveEdit(p)">
              <label>Name <input [(ngModel)]="edit.name" name="name" required maxlength="60" /></label>
              <label>Description <input [(ngModel)]="edit.description" name="description" /></label>
              <div class="row">
                <button class="primary" type="submit" [disabled]="!edit.name.trim() || busy()">Save</button>
                <button type="button" class="quiet" (click)="editing.set('')">Cancel</button>
              </div>
            </form>
          } @else {
            <a [routerLink]="['/projects', p.id]" class="card-title"><h2>{{ p.name }}</h2></a>
            @if (p.description) { <p>{{ p.description }}</p> }
            <p class="meta">{{ hostLabel[p.codeHost.provider] }} · {{ p.codeHost.provider === 'local' ? p.codeHost.localPath : p.codeHost.repo }} · tickets in {{ pmLabel[p.pm.provider] }}</p>
            @if (spendFor(p.id); as s) {
              <p class="meta" [class.warn]="isOver(s)">
                Today <app-usage [usage]="s.today.usage" [usd]="s.today.usd" /> · 7 days <app-usage [usage]="s.last7Days.usage" [usd]="s.last7Days.usd" />
              </p>
            }
            <div class="card-actions">
              <a class="button" [routerLink]="['/projects', p.id]">Open</a>
              <a class="button quiet" routerLink="/" [queryParams]="{ project: p.id }"><app-icon name="chat" [size]="14" /> Ask</a>
              <span class="spacer"></span>
              <button class="icon-btn" (click)="startEdit(p)" [attr.aria-label]="'Edit ' + p.name" title="Edit"><app-icon name="edit" /></button>
              <button class="icon-btn" (click)="remove(p)" [attr.aria-label]="'Delete ' + p.name" title="Delete"><app-icon name="trash" /></button>
            </div>
          }
        </article>
      }
    </div>
  `,
})
export class ProjectsPage {
  private readonly currency = inject(Currency);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  readonly steps = WIZARD;
  readonly pmLabel = PM_LABEL;
  readonly hostLabel = HOST_LABEL;
  readonly projects = signal<Project[]>([]);
  readonly loading = signal(true);
  readonly spend = signal<ProjectSpend[]>([]);
  readonly templates = signal<ProjectTemplate[]>([]);
  readonly wizard = signal(false);
  readonly step = signal<WizardStep>('basics');
  readonly touched = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly editing = signal('');
  draft: ConnectorModel & { name: string; description: string; template: string } = { name: '', description: '', template: '', ...emptyConnectors() };
  edit = { name: '', description: '' };

  readonly stepIndex = computed(() => WIZARD.findIndex((w) => w.id === this.step()));

  constructor() {
    void this.load();
    void this.api.spend().then((x) => this.spend.set(x)).catch(() => undefined);
    void this.api.templates().then((x) => this.templates.set(x)).catch(() => undefined);
    if (inject(ActivatedRoute).snapshot.queryParamMap.get('new')) this.startWizard();
  }

  async load(): Promise<void> {
    try {
      this.projects.set(await this.api.projects());
    } catch (e) {
      this.toasts.error(`Couldn't load the projects: ${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  templateInfo(): ProjectTemplate | undefined {
    return this.templates().find((t) => t.id === this.draft.template);
  }

  gateNames(t: ProjectTemplate): string {
    return t.gates.map((g) => g.name).join(', ');
  }

  isOver(s: ProjectSpend): boolean {
    return overCaps(s.today, s.dailyCaps, this.currency.eurPerUsd());
  }

  spendFor(id: string): ProjectSpend | undefined {
    return this.spend().find((s) => s.projectId === id);
  }

  codeError(): string {
    const c = this.draft.codeHost;
    if (c.provider === 'local') return c.localPath?.trim() ? '' : 'Enter the folder path of the local repository.';
    return c.repo?.trim() ? '' : 'Enter the repository.';
  }

  /** Errors that keep you on the current step. */
  stepError(): string {
    if (this.step() === 'basics') return this.draft.name.trim() ? '' : 'Give the project a name.';
    if (this.step() === 'code') return this.codeError();
    return '';
  }

  canLeave(): boolean {
    return !this.stepError();
  }

  startWizard(): void {
    this.draft = { name: '', description: '', template: '', ...emptyConnectors() };
    this.step.set('basics');
    this.touched.set(false);
    this.error.set('');
    this.wizard.set(true);
  }

  goTo(id: WizardStep): void {
    const target = WIZARD.findIndex((w) => w.id === id);
    if (target > this.stepIndex() && !this.canLeave()) {
      this.touched.set(true);
      return;
    }
    this.step.set(id);
    this.touched.set(false);
  }

  back(): void {
    this.step.set(WIZARD[Math.max(0, this.stepIndex() - 1)].id);
  }

  async next(): Promise<void> {
    this.touched.set(true);
    if (!this.canLeave()) return;
    if (this.step() !== 'review') {
      this.step.set(WIZARD[this.stepIndex() + 1].id);
      this.touched.set(false);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const { template, ...fields } = this.draft;
      const p = await this.api.createProject({ ...fields, name: fields.name.trim(), ...(template ? { template } : {}) });
      this.toasts.ok(`${p.name} created.`);
      await this.router.navigate(['/projects', p.id], { queryParams: { tab: 'knowledge' } });
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  startEdit(p: Project): void {
    this.edit = { name: p.name, description: p.description };
    this.editing.set(p.id);
  }

  async saveEdit(p: Project): Promise<void> {
    this.busy.set(true);
    try {
      const saved = await this.api.updateProject(p.id, { name: this.edit.name.trim(), description: this.edit.description.trim() });
      this.projects.update((xs) => xs.map((x) => (x.id === p.id ? saved : x)));
      this.editing.set('');
      this.toasts.ok('Project saved.');
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(p: Project): Promise<void> {
    const ok = await this.confirm.ask({
      title: `Delete ${p.name}?`,
      body: 'This removes the project from Maestro:',
      details: deletionDetails(p),
      confirm: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteProject(p.id);
      this.projects.update((xs) => xs.filter((x) => x.id !== p.id));
      this.toasts.ok(`${p.name} deleted.`);
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }
}
