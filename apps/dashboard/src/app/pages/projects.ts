import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../api';
import { DecimalPipe } from '@angular/common';
import type { Project, ProjectSpend } from '../models';
import { ConnectorFields, emptyConnectors } from './connector-fields';

@Component({
  selector: 'app-projects',
  imports: [FormsModule, RouterLink, ConnectorFields, DecimalPipe],
  template: `
    <header class="page-head">
      <h1>Projects</h1>
      <button class="primary" (click)="creating.set(!creating())">{{ creating() ? 'Cancel' : 'New project' }}</button>
    </header>

    @if (creating()) {
      <form class="panel" (ngSubmit)="create()">
        <label>Name <input [(ngModel)]="draft.name" name="name" required /></label>
        <label>Description <input [(ngModel)]="draft.description" name="description" /></label>
        <app-connector-fields [model]="draft" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button class="primary" type="submit" [disabled]="!draft.name">Create project</button>
      </form>
    }

    @if (spendTotal(); as s) {
      <div class="summary">
        <span class="state">Today \${{ s.today | number: '1.2-2' }}</span>
        <span class="state">Last 7 days \${{ s.week | number: '1.2-2' }}</span>
        <span class="state">All time \${{ s.total | number: '1.2-2' }}</span>
      </div>
    }

    @if (projects().length === 0 && !creating()) {
      <p class="empty">No projects yet. Create one and link a repository or a folder.</p>
    }
    <div class="grid">
      @for (p of projects(); track p.id) {
        <a class="card link" [routerLink]="['/projects', p.id]">
          <h2>{{ p.name }}</h2>
          @if (p.description) { <p>{{ p.description }}</p> }
          <p class="meta">
            {{ p.codeHost.provider === 'local' ? p.codeHost.localPath : p.codeHost.repo }}
            · tickets in {{ pmLabel[p.pm.provider] }}
          </p>
          @if (spendFor(p.id); as s) {
            <p class="meta" [class.warn]="s.dailyCap > 0 && s.today >= s.dailyCap">
              Today \${{ s.today | number: '1.2-2' }}{{ s.dailyCap > 0 ? ' of $' + (s.dailyCap | number: '1.0-2') : '' }} · 7 days \${{ s.last7Days | number: '1.2-2' }}
            </p>
          }
        </a>
      }
    </div>
  `,
})
export class ProjectsPage {
  spendFor(id: string): ProjectSpend | undefined {
    return this.spend().find((s) => s.projectId === id);
  }

  spendTotal(): { today: number; week: number; total: number } | null {
    const xs = this.spend();
    if (!xs.some((s) => s.total > 0)) return null;
    return xs.reduce((a, s) => ({ today: a.today + s.today, week: a.week + s.last7Days, total: a.total + s.total }), { today: 0, week: 0, total: 0 });
  }

  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly projects = signal<Project[]>([]);
  readonly creating = signal(false);
  readonly error = signal('');
  readonly spend = signal<ProjectSpend[]>([]);
  readonly pmLabel = { jira: 'Jira', trello: 'Trello', manual: 'Maestro' } as const;
  draft = { name: '', description: '', ...emptyConnectors() };

  constructor() {
    void this.api.spend().then((x) => this.spend.set(x)).catch(() => undefined);
    void this.load();
  }

  async load(): Promise<void> {
    this.projects.set(await this.api.projects());
  }

  async create(): Promise<void> {
    this.error.set('');
    try {
      const p = await this.api.createProject(this.draft);
      await this.router.navigate(['/projects', p.id]);
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }
}
