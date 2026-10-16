import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Session } from '../session';
import { Toasts } from '../ui/toast';

/** Change your own password; required after a reset or for a new account. */
@Component({
  selector: 'app-password',
  imports: [FormsModule],
  template: `
    <main class="auth-page">
      <form class="auth-card" (ngSubmit)="submit()" novalidate>
        <h1>{{ required() ? 'Choose your password' : 'Change your password' }}</h1>
        @if (required()) { <p class="hint">You logged in with a temporary password. Choose your own to continue.</p> }
        <label>{{ required() ? 'Temporary password' : 'Current password' }} <input name="current" type="password" [(ngModel)]="current" autocomplete="current-password" required /></label>
        <label>New password <input name="next" type="password" [(ngModel)]="next" autocomplete="new-password" required aria-describedby="np-hint" />
          <small id="np-hint" class="field-hint">At least 12 characters. Your other browsers will be logged out.</small></label>
        <label>Repeat the new password <input name="again" type="password" [(ngModel)]="again" autocomplete="new-password" required /></label>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        <div class="row">
          <button class="primary" type="submit" [disabled]="busy()">Save password</button>
          @if (!required()) { <button type="button" class="quiet" (click)="back()">Cancel</button> }
          @else { <button type="button" class="quiet" (click)="session.logout()">Log out</button> }
        </div>
      </form>
    </main>
  `,
})
export class PasswordPage {
  readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  current = '';
  next = '';
  again = '';
  readonly busy = signal(false);
  readonly error = signal('');
  required = () => !!this.session.user()?.mustChangePassword;

  async submit(): Promise<void> {
    this.error.set('');
    if (this.next.length < 12) return this.error.set('Use at least 12 characters.');
    if (this.next !== this.again) return this.error.set('The two new passwords differ.');
    this.busy.set(true);
    try {
      await this.session.changePassword(this.current, this.next);
      this.toasts.ok('Password changed.');
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  back(): void {
    void this.router.navigate(['/']);
  }
}
