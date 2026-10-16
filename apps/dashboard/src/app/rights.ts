import { Injectable, effect, inject, signal } from '@angular/core';
import { Api } from './api';
import { USER_ROLE_LABEL, type UserRole } from './models';
import { Session } from './session';

/** What the logged-in user may do, from the engine's role table (the engine checks again on every request). */
@Injectable({ providedIn: 'root' })
export class Rights {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  readonly actions = signal<Set<string>>(new Set());
  readonly table = signal<Record<string, UserRole[]>>({});
  readonly seesAllProjects = signal(false);

  constructor() {
    effect(() => {
      if (this.session.signedIn()) void this.load();
      else this.actions.set(new Set());
    });
  }

  async load(): Promise<void> {
    try {
      const r = await this.api.myRights();
      this.actions.set(new Set(r.actions));
      this.table.set(r.table);
      this.seesAllProjects.set(r.seesAllProjects);
    } catch {
      // Without the list everything looks allowed; the engine still refuses what isn't.
    }
  }

  can(action: string): boolean {
    return this.actions().has(action);
  }

  /** "Needs the Tech Lead role", for a disabled button's tooltip; '' when allowed. */
  why(action: string): string {
    if (this.can(action)) return '';
    const names = (this.table()[action] ?? []).map((r) => USER_ROLE_LABEL[r]);
    return names.length ? `Needs the ${names.join(' or ')} role` : 'Not allowed for your role';
  }
}
