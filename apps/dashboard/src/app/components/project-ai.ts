import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { ROLE_LABEL, type ProvidersInfo, type Role } from '../models';
import { Toasts } from '../ui/toast';

const ROLES: Role[] = ['worker', 'reviewer', 'planner', 'assistant'];

/** Which AI this project uses per role, when it differs from the defaults in Settings. */
@Component({
  selector: 'app-project-ai',
  imports: [FormsModule],
  template: `
    <fieldset>
      <legend>AI for this project</legend>
      <p class="hint">Leave a role on its default to use the provider set in Settings. A worker's own provider still comes first.</p>
      @if (info(); as i) {
        <form (ngSubmit)="save()">
          @for (r of roles; track r) {
            <div class="role-row">
              <div><strong>{{ roleLabel[r].label }}</strong><small class="field-hint">{{ roleLabel[r].hint }}</small></div>
              <label><span class="sr-only">{{ roleLabel[r].label }} provider</span>
                <select [(ngModel)]="rows[r].provider" [name]="'pp-' + r">
                  <option value="">Default ({{ nameOf(i.roles[r].provider) }}{{ i.roles[r].model ? ', ' + i.roles[r].model : '' }})</option>
                  @for (p of i.providers; track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                </select>
              </label>
              <label><span class="sr-only">{{ roleLabel[r].label }} model</span>
                <input [(ngModel)]="rows[r].model" [name]="'pm-' + r" [disabled]="!rows[r].provider" placeholder="Model" spellcheck="false" />
              </label>
            </div>
          }
          <div class="row"><button class="primary" type="submit" [disabled]="busy()">Save AI choices</button></div>
        </form>
      } @else {
        <div class="skeleton" style="height:60px"></div>
      }
    </fieldset>
  `,
})
export class ProjectAi {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly projectId = input.required<string>();
  readonly roles = ROLES;
  readonly roleLabel = ROLE_LABEL;
  readonly info = signal<ProvidersInfo | null>(null);
  readonly busy = signal(false);
  rows = Object.fromEntries(ROLES.map((r) => [r, { provider: '', model: '' }])) as Record<Role, { provider: string; model: string }>;

  constructor() {
    effect(() => {
      const id = this.projectId();
      void Promise.all([this.api.providers(), this.api.projectRoles(id)]).then(([i, own]) => {
        this.rows = Object.fromEntries(ROLES.map((r) => [r, { provider: own[r]?.provider ?? '', model: own[r]?.model ?? '' }])) as typeof this.rows;
        this.info.set(i);
      }, () => undefined);
    });
  }

  nameOf(id: string): string {
    return this.info()?.providers.find((p) => p.id === id)?.name ?? id;
  }

  async save(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.saveProjectRoles(this.projectId(), Object.fromEntries(ROLES.map((r) => [r, this.rows[r].provider ? { provider: this.rows[r].provider, model: this.rows[r].model.trim() } : null])));
      this.toasts.ok('AI choices saved for this project.');
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
