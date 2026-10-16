import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { Api } from './api';
import { ChatPanel } from './components/chat-panel';
import { Live } from './live';
import { USER_ROLE_LABEL, type Project, type UserRole } from './models';
import { Rights } from './rights';
import { Session } from './session';
import { ChatDock } from './ui/chat-dock';
import { ConfirmHost } from './ui/confirm';
import { Icon } from './ui/icon';
import { ThemeService } from './ui/theme';
import { ToastHost } from './ui/toast';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, ToastHost, ConfirmHost, ChatPanel],
  host: { '(document:keydown.escape)': 'dock.drawer() && dock.drawer.set(false)' },
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  readonly live = inject(Live);
  readonly theme = inject(ThemeService);
  readonly nav = [
    { path: '/', label: 'Dashboard', icon: 'home' },
    { path: '/projects', label: 'Projects', icon: 'folder' },
    { path: '/agents', label: 'Workers', icon: 'bot' },
    { path: '/pull-requests', label: 'Pull requests', icon: 'pr' },
    { path: '/metrics', label: 'Metrics', icon: 'chart' },
    { path: '/alerts', label: 'Alerts', icon: 'bell' },
    { path: '/activity', label: 'Activity', icon: 'clock' },
    { path: '/users', label: 'Users', icon: 'key' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  readonly dock = inject(ChatDock);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => (e as NavigationEnd).urlAfterRedirects)), { initialValue: this.router.url });
  readonly onDashboard = computed(() => this.url().split(/[?#]/)[0] === '/');
  /** The project of the page you are on, as the drawer chat's focus. */
  readonly pageProject = computed(() => this.url().match(/^\/projects\/([^/?#]+)/)?.[1] ?? '');
  /** The floating chat button: everywhere except where the chat is already on screen. */
  readonly showLauncher = computed(() => !this.dock.drawer() && !(this.onDashboard() && !this.dock.phone() && this.dock.state() !== 'closed'));
  readonly projects = signal<Pick<Project, 'id' | 'name'>[]>([]);

  readonly session = inject(Session);
  readonly rights = inject(Rights);
  /** Menu items this user can use (Settings is for Tech Leads). */
  readonly navItems = computed(() => this.nav.filter((i) => !this.rights.actions().size || (i.path !== '/settings' || this.rights.can('settings.manage')) && (i.path !== '/users' || this.rights.can('users.manage'))));
  readonly roleLabel = USER_ROLE_LABEL;
  readonly menuOpen = signal(false);

  constructor() {
    void this.session.load();
    // Live updates only with a session (the stream needs one), and none after logout.
    effect(() => (this.session.signedIn() ? this.live.start() : this.live.stop?.()));
  }

  initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  }

  roleText(roles: UserRole[]): string {
    return roles.map((r) => USER_ROLE_LABEL[r]).join(' · ');
  }

  summon(): void {
    if (!this.onDashboard() || this.dock.phone()) void this.api.projects().then((ps) => this.projects.set(ps.map(({ id, name }) => ({ id, name }))), () => undefined);
    this.dock.summon(this.onDashboard());
  }
}
