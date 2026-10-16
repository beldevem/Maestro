import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from './api';
import type { SessionUser, UserRole } from './models';

/** Who is logged in, from the engine's session cookie (never stored in the page). */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly user = signal<SessionUser | null>(null);
  readonly setupNeeded = signal(false);
  readonly ready = signal(false);
  readonly signedIn = computed(() => !!this.user() && !this.user()!.mustChangePassword);
  private loading?: Promise<void>;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('maestro:unauthorized', () => {
        if (!this.user()) return;
        this.user.set(null);
        void this.router.navigate(['/login'], { queryParams: { next: this.router.url, expired: 1 } });
      });
      window.addEventListener('maestro:password-required', () => void this.router.navigate(['/password']));
    }
  }

  /** Asks the engine once (again with `force`). */
  load(force = false): Promise<void> {
    if (!this.loading || force) {
      this.loading = Promise.resolve().then(() => this.api.authStatus()).then(
        (s) => {
          this.user.set(s.user);
          this.setupNeeded.set(s.setupNeeded);
          this.ready.set(true);
        },
        () => this.ready.set(true),
      );
    }
    return this.loading;
  }

  has(role: UserRole): boolean {
    return !!this.user()?.roles.includes(role);
  }

  async login(email: string, password: string): Promise<SessionUser> {
    const { user } = await this.api.login(email, password);
    this.user.set(user);
    return user;
  }

  async setup(account: { email: string; name: string; password: string }): Promise<SessionUser> {
    const { user } = await this.api.setup(account);
    this.user.set(user);
    this.setupNeeded.set(false);
    return user;
  }

  async changePassword(current: string, next: string): Promise<void> {
    const { user } = await this.api.changePassword(current, next);
    this.user.set(user);
  }

  async logout(): Promise<void> {
    await this.api.logout().catch(() => undefined);
    this.user.set(null);
    await this.router.navigate(['/login']);
  }
}
