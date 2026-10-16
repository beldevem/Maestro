import { Component, computed, inject, signal } from '@angular/core';
import { Api } from '../api';
import type { SystemCheck } from '../models';
import { Icon } from '../ui/icon';

/** What could stop Maestro from working, with how to fix it; problems first. */
@Component({
  selector: 'app-system-check',
  imports: [Icon],
  template: `
    <section class="panel system-check" aria-labelledby="sc-title">
      <div class="row sc-head">
        <h2 id="sc-title"><app-icon [name]="problems().length ? 'alert' : 'check'" [size]="16" /> System check</h2>
        <span class="hint">{{ loading() ? 'Checking…' : problems().length ? problems().length + ' to look at' : 'Everything looks fine.' }}</span>
        <button type="button" class="quiet" (click)="load()" [disabled]="loading()">Check again</button>
      </div>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <ul class="sc-list">
        @for (c of shown(); track c.id) {
          <li class="sc-{{ c.level }}">
            <strong>{{ c.label }}</strong> <span>{{ c.message }}</span>
            @if (c.hint) { <small class="field-hint">{{ c.hint }}</small> }
          </li>
        }
      </ul>
      @if (problems().length && okCount()) {
        <button type="button" class="link-btn" (click)="all.set(!all())">{{ all() ? 'Hide what is fine' : 'Show all ' + checks().length }}</button>
      }
    </section>
  `,
})
export class SystemCheckPanel {
  private readonly api = inject(Api);
  readonly checks = signal<SystemCheck[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly all = signal(false);
  readonly problems = computed(() => this.checks().filter((c) => c.level !== 'ok'));
  readonly okCount = computed(() => this.checks().length - this.problems().length);
  readonly shown = computed(() => {
    const order = { error: 0, warning: 1, ok: 2 };
    const list = [...this.checks()].sort((a, b) => order[a.level] - order[b.level]);
    return this.all() || !this.problems().length ? list : list.filter((c) => c.level !== 'ok');
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.checks.set(await this.api.systemChecks());
      this.error.set('');
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }
}
