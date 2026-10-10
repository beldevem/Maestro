import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../api';
import type { Project } from '../models';
import { ConnectorFields, emptyConnectors } from './connector-fields';

@Component({
  selector: 'app-projects',
  imports: [FormsModule, RouterLink, ConnectorFields],
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

    @if (projects().length === 0 && !creating()) {
      <p class="empty">No projects yet. Create one and link a repository or a folder.</p>
    }
    <div class="grid">
      @for (p of projects(); track p.id) {
        <a class="card link" [routerLink]="['/projects', p.id]">
          <h2>{{ p.name }}</h2>
          @if (p.description) { <p>{{ p.description }}</p> }
          <p class="meta">
            {{ p.codeHost.provider === 'github' ? p.codeHost.repo : p.codeHost.localPath }}
            · tickets in {{ pmLabel[p.pm.provider] }}
          </p>
        </a>
      }
    </div>
  `,
})
export class ProjectsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly projects = signal<Project[]>([]);
  readonly creating = signal(false);
  readonly error = signal('');
  readonly pmLabel = { jira: 'Jira', trello: 'Trello', manual: 'Maestro' } as const;
  draft = { name: '', description: '', ...emptyConnectors() };

  constructor() {
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
