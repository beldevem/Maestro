import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from '../session';

/** Login, or the first-run setup that creates the first account (route data: { setup: true }). */
@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <main class="auth-page">
      <form class="auth-card" (ngSubmit)="submit()" novalidate>
        <div class="brand auth-brand"><span class="brand-mark" aria-hidden="true">M</span><span class="brand-name">Maestro</span></div>
        @if (setup) {
          <h1>Set up Maestro</h1>
          <p class="hint">Create the first account. It gets the Project Manager and Tech Lead roles, and owns everything already here. You'll add other people from the Users page.</p>
          <label>Your name <input name="name" [(ngModel)]="name" autocomplete="name" required maxlength="100" /></label>
        } @else {
          <h1>Log in</h1>
          @if (expired) { <p class="hint" role="status">Your session ended. Log in again.</p> }
        }
        <label>Email <input name="email" type="email" [(ngModel)]="email" autocomplete="username" required maxlength="254" /></label>
        <label>Password
          <input name="password" type="password" [(ngModel)]="password" [attr.autocomplete]="setup ? 'new-password' : 'current-password'" required maxlength="256"
            [attr.aria-describedby]="setup ? 'pw-hint' : null" />
          @if (setup) { <small id="pw-hint" class="field-hint">At least 12 characters.</small> }
        </label>
        @if (setup) {
          <label>Repeat the password <input name="again" type="password" [(ngModel)]="again" autocomplete="new-password" required /></label>
        }
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        <button class="primary" type="submit" [disabled]="busy()">
          @if (busy()) { <span class="spinner"></span> } {{ setup ? 'Create account' : 'Log in' }}
        </button>
        @if (!setup) { <p class="hint">Forgot your password? Ask a Project Manager to reset it.</p> }
      </form>
    </main>
  `,
})
export class LoginPage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly setup = !!this.route.snapshot.data['setup'];
  readonly expired = this.route.snapshot.queryParamMap.has('expired');
  name = '';
  email = '';
  password = '';
  again = '';
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.error.set('');
    if (!this.email.trim() || !this.password || (this.setup && !this.name.trim())) return this.error.set('Fill in every field.');
    if (this.setup && this.password.length < 12) return this.error.set('Use at least 12 characters for the password.');
    if (this.setup && this.password !== this.again) return this.error.set('The two passwords differ.');
    this.busy.set(true);
    try {
      const user = this.setup
        ? await this.session.setup({ name: this.name.trim(), email: this.email.trim(), password: this.password })
        : await this.session.login(this.email.trim(), this.password);
      const next = this.route.snapshot.queryParamMap.get('next');
      await this.router.navigateByUrl(user.mustChangePassword ? '/password' : next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (e) {
      this.error.set((e as Error).message);
      this.password = '';
    } finally {
      this.busy.set(false);
    }
  }
}
