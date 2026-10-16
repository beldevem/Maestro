import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { USER_ROLE_LABEL, type UserRole, type UserView } from '../models';
import { Rights } from '../rights';
import { Confirm } from '../ui/confirm';
import { Toasts } from '../ui/toast';

/** Who can see a project. Everyone sees the list; Project Managers add and remove people. */
@Component({
  selector: 'app-project-members',
  imports: [FormsModule],
  template: `
    <section class="panel members">
      <h2>Members</h2>
      <p class="hint">Members see this project, its board, runs and usage. Tech Leads see every project without being members.</p>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <ul class="member-list">
        @for (m of members(); track m.userId) {
          <li>
            <span class="avatar" aria-hidden="true">{{ initials(m.name) }}</span>
            <span class="member-name">{{ m.name }}</span>
            <span class="role-badges">@for (r of m.roles; track r) { <span class="pill role-{{ r }}">{{ label[r] }}</span> }</span>
            @if (canManage()) {
              <button type="button" class="quiet" (click)="remove(m.userId, m.name)" [attr.aria-label]="'Remove ' + m.name + ' from this project'">Remove</button>
            }
          </li>
        } @empty {
          <li class="hint">No members yet.</li>
        }
      </ul>
      @if (canManage()) {
        <form class="row member-add" (ngSubmit)="add()">
          <label class="sr-only" for="member-pick">Person to add</label>
          <select id="member-pick" [(ngModel)]="pick" name="pick">
            <option value="">Add a person…</option>
            @for (u of addable(); track u.id) { <option [value]="u.id">{{ u.name }}{{ u.email ? ' · ' + u.email : '' }}</option> }
          </select>
          <button type="submit" class="primary" [disabled]="!pick || busy()">Add</button>
        </form>
      } @else {
        <p class="hint" [title]="rights.why('project.members')">Project Managers add and remove members.</p>
      }
    </section>
  `,
})
export class ProjectMembers {
  private readonly api = inject(Api);
  readonly rights = inject(Rights);
  private readonly confirm = inject(Confirm);
  private readonly toasts = inject(Toasts);
  readonly projectId = input.required<string>();
  readonly label = USER_ROLE_LABEL;
  readonly members = signal<{ userId: string; name: string; roles: UserRole[] }[]>([]);
  readonly people = signal<UserView[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canManage = computed(() => this.rights.can('project.members'));
  readonly addable = computed(() => this.people().filter((u) => u.active && !this.members().some((m) => m.userId === u.id)));
  pick = '';

  constructor() {
    effect(() => void this.load(this.projectId()));
  }

  async load(projectId: string): Promise<void> {
    try {
      const [members, people] = await Promise.all([this.api.members(projectId), this.canManage() ? this.api.users().then((r) => r.users) : Promise.resolve([])]);
      this.members.set(members);
      this.people.set(people);
      this.error.set('');
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  async add(): Promise<void> {
    if (!this.pick) return;
    this.busy.set(true);
    try {
      await this.api.addMember(this.projectId(), this.pick);
      this.pick = '';
      await this.load(this.projectId());
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(userId: string, name: string): Promise<void> {
    if (!(await this.confirm.ask({ title: `Remove ${name} from this project?`, body: 'They stop seeing it at once. What they did stays in the activity log.', confirm: 'Remove', danger: true }))) return;
    try {
      await this.api.removeMember(this.projectId(), userId);
      await this.load(this.projectId());
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  }
}
