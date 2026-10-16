import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { USER_ROLE_LABEL, type UserRole, type UserView } from '../models';
import { Session } from '../session';
import { Confirm } from '../ui/confirm';
import { Toasts } from '../ui/toast';

const ROLES: { id: UserRole; hint: string }[] = [
  { id: 'pm', hint: 'Follows progress, edits tickets, chats, manages people. Never starts AI work.' },
  { id: 'lead', hint: 'Everything technical: projects, settings, workers, runs, merges. No people management.' },
  { id: 'dev', hint: 'Works on tickets and runs in their projects. No merge, no settings.' },
];

/** People and their roles (Project Managers only). */
@Component({
  selector: 'app-users',
  imports: [FormsModule, DatePipe],
  template: `
    <header class="page-head">
      <div>
        <h1>Users</h1>
        <p class="page-sub">Who can log in, with which roles, in which projects.</p>
      </div>
      @if (!adding()) { <button class="primary" type="button" (click)="startAdd()">Add user</button> }
    </header>

    @if (secret(); as s) {
      <section class="panel secret-once" role="status">
        <h2>{{ s.title }}</h2>
        <p>Give {{ s.name }} this one-time password. It's shown only now; they choose their own at first login.</p>
        <p class="row"><code class="one-time">{{ s.password }}</code><button type="button" (click)="copy(s.password)">Copy</button><button type="button" class="quiet" (click)="secret.set(null)">Done</button></p>
      </section>
    }

    @if (adding()) {
      <form class="panel user-form" (ngSubmit)="add()" novalidate>
        <h2>Add a user</h2>
        <div class="row">
          <label>Name <input name="name" [(ngModel)]="draft.name" required maxlength="100" autocomplete="off" /></label>
          <label>Email <input name="email" type="email" [(ngModel)]="draft.email" required maxlength="254" autocomplete="off" /></label>
        </div>
        <fieldset class="role-pick">
          <legend>Roles</legend>
          @for (r of roles; track r.id) {
            <label class="toggle"><input type="checkbox" [checked]="draft.roles.includes(r.id)" (change)="toggle(draft.roles, r.id)" /> <span class="pill role-{{ r.id }}">{{ label[r.id] }}</span> <small class="hint">{{ r.hint }}</small></label>
          }
        </fieldset>
        @if (projects().length) {
          <fieldset class="role-pick">
            <legend>Projects</legend>
            @for (p of projects(); track p.id) {
              <label class="toggle"><input type="checkbox" [checked]="draft.projects.includes(p.id)" (change)="toggle(draft.projects, p.id)" /> {{ p.name }}</label>
            }
          </fieldset>
        }
        @if (formError()) { <p class="error" role="alert">{{ formError() }}</p> }
        <div class="row">
          <button class="primary" type="submit" [disabled]="busy()">Add user</button>
          <button class="quiet" type="button" (click)="adding.set(false)">Cancel</button>
        </div>
      </form>
    }

    @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
    <div class="cards users-list">
      @for (u of users(); track u.id) {
        <article class="card user-card" [class.inactive]="!u.active">
          <div class="user-card-head">
            <span class="avatar" aria-hidden="true">{{ initials(u.name) }}</span>
            <div class="user-card-who">
              <strong>{{ u.name }}@if (u.id === me()) { <span class="meta"> (you)</span> }</strong>
              <span class="hint">{{ u.email }}</span>
            </div>
          </div>
          <p class="role-badges">
            @for (r of u.roles; track r) { <span class="pill role-{{ r }}">{{ label[r] }}</span> }
            @if (!u.active) { <span class="pill">Deactivated</span> }
            @if (u.locked) { <span class="pill role-pm">Locked</span> }
            @if (u.mustChangePassword && u.active) { <span class="pill">Password to choose</span> }
          </p>
          <p class="meta">{{ u.lastLoginAt ? 'Last login ' + (u.lastLoginAt | date: 'MMM d, HH:mm') : 'Never logged in' }} · {{ projectNames(u) }}</p>
          @if (editing() === u.id) {
            <form class="role-pick" (ngSubmit)="saveRoles(u)">
              @for (r of roles; track r.id) {
                <label class="toggle"><input type="checkbox" [checked]="editRoles.includes(r.id)" (change)="toggle(editRoles, r.id)" /> {{ label[r.id] }}</label>
              }
              <div class="row"><button class="primary" type="submit">Save roles</button><button type="button" class="quiet" (click)="editing.set('')">Cancel</button></div>
            </form>
          } @else {
            <div class="card-actions">
              @if (u.active) {
                <button type="button" (click)="startRoles(u)">Roles</button>
                <button type="button" (click)="reset(u)">Reset password</button>
                @if (u.id !== me()) { <button type="button" class="danger" (click)="deactivate(u)">Delete</button> }
              } @else {
                <button type="button" (click)="reactivate(u)">Reactivate</button>
              }
            </div>
          }
        </article>
      }
    </div>
  `,
})
export class UsersPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly confirm = inject(Confirm);
  private readonly toasts = inject(Toasts);
  readonly roles = ROLES;
  readonly label = USER_ROLE_LABEL;
  readonly users = signal<UserView[]>([]);
  readonly projects = signal<{ id: string; name: string }[]>([]);
  readonly adding = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly formError = signal('');
  readonly editing = signal('');
  readonly secret = signal<{ title: string; name: string; password: string } | null>(null);
  readonly me = computed(() => this.session.user()?.id ?? '');
  draft = { name: '', email: '', roles: ['dev'] as UserRole[], projects: [] as string[] };
  editRoles: UserRole[] = [];

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const r = await this.api.users();
      this.users.set(r.users);
      this.projects.set(r.projects ?? []);
      this.error.set('');
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  startAdd(): void {
    this.draft = { name: '', email: '', roles: ['dev'], projects: [] };
    this.formError.set('');
    this.adding.set(true);
  }

  toggle<T>(list: T[], v: T): void {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    else list.push(v);
  }

  async add(): Promise<void> {
    if (!this.draft.name.trim() || !this.draft.email.trim()) return this.formError.set('Give a name and an email.');
    if (!this.draft.roles.length) return this.formError.set('Give at least one role.');
    this.busy.set(true);
    try {
      const { user, password } = await this.api.createUser({ ...this.draft, name: this.draft.name.trim(), email: this.draft.email.trim() });
      this.adding.set(false);
      this.secret.set({ title: `${user.name} was added`, name: user.name, password });
      await this.load();
    } catch (e) {
      this.formError.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  startRoles(u: UserView): void {
    this.editRoles = [...u.roles];
    this.editing.set(u.id);
  }

  async saveRoles(u: UserView): Promise<void> {
    if (!this.editRoles.length) return this.toasts.error('Give at least one role.');
    try {
      await this.api.updateUser(u.id, { roles: this.editRoles });
      this.editing.set('');
      this.toasts.ok(`${u.name}'s roles were saved.`);
      await this.load();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  async reset(u: UserView): Promise<void> {
    if (!(await this.confirm.ask({ title: `Reset ${u.name}'s password?`, body: 'They are logged out everywhere and must log in with a one-time password you give them.', confirm: 'Reset' }))) return;
    try {
      const { password } = await this.api.resetPassword(u.id);
      this.secret.set({ title: `${u.name}'s password was reset`, name: u.name, password });
      await this.load();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  async deactivate(u: UserView): Promise<void> {
    if (!(await this.confirm.ask({ title: `Delete ${u.name}?`, body: 'They can no longer log in and leave all projects. What they did stays in the activity log and usage. You can reactivate them later.', confirm: 'Delete', danger: true }))) return;
    try {
      await this.api.deleteUser(u.id);
      await this.load();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  async reactivate(u: UserView): Promise<void> {
    try {
      await this.api.updateUser(u.id, { active: true });
      this.toasts.ok(`${u.name} can log in again. Add them back to their projects.`);
      await this.load();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  projectNames(u: UserView): string {
    const names = (u.projects ?? []).map((id) => this.projects().find((p) => p.id === id)?.name).filter(Boolean);
    return names.length ? names.join(', ') : 'No projects';
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => this.toasts.ok('Copied.'), () => undefined);
  }

  initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  }
}
