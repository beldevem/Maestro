import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';
import type { Run } from './models';

/** Names of people by id, for "Started by" and the like (loaded once). */
@Injectable({ providedIn: 'root' })
export class People {
  private readonly api = inject(Api);
  readonly names = signal<Map<string, string>>(new Map());
  private loading?: Promise<void>;

  load(): Promise<void> {
    this.loading ??= this.api.users?.().then(
      (r) => this.names.set(new Map(r.users.map((u) => [u.id, u.name]))),
      () => undefined,
    ) ?? Promise.resolve();
    return this.loading;
  }

  /** "Ada", "Ada (auto-assign)", "Ada (from chat)", or "Maestro". */
  startedBy(run: Pick<Run, 'startedBy' | 'trigger'>): string {
    void this.load();
    const name = run.startedBy ? this.names().get(run.startedBy) ?? 'Someone' : run.trigger ? 'Maestro' : '';
    if (!name) return '';
    return run.trigger === 'auto' ? `${name} (auto-assign)` : run.trigger === 'chat' ? `${name} (from chat)` : name;
  }
}
