import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import type { SecretInfo } from '../models';

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  template: `
    <header class="page-head"><h1>Settings</h1></header>
    @if (notice()) { <p class="notice">{{ notice() }}</p> }

    <section class="panel">
      <h2>API keys and tokens</h2>
      @if (backend() === 'keychain') {
        <p class="hint">Stored in your system keychain. Values are never shown again.</p>
      } @else {
        <p class="hint">Stored on this machine in ~/.maestro/secrets.json, readable only by you. Values are never shown again.
          To keep them in the system keychain instead, install secret-tool (on Ubuntu: <span class="mono">sudo apt install libsecret-tools</span>) and restart Maestro; it moves them over.</p>
      }
      @for (s of secrets(); track s.name) {
        <div class="secret">
          <div>
            <strong>{{ s.label }}</strong>
            <span class="state" [class.state-available]="s.set">{{ s.set ? 'Set' : 'Not set' }}</span>
            <p class="hint">{{ s.help }}</p>
          </div>
          <form class="row" (ngSubmit)="setSecret(s)">
            <input type="password" [(ngModel)]="values[s.name]" [name]="s.name" [placeholder]="s.set ? 'Replace' : 'Paste value'" autocomplete="off" />
            <button type="submit" [disabled]="!values[s.name]">Save</button>
            @if (s.set) { <button type="button" class="quiet" (click)="clear(s)">Remove</button> }
          </form>
        </div>
      }
    </section>

    <form class="panel" (ngSubmit)="save()">
      <h2>Agents</h2>
      <label>Worker model <input [(ngModel)]="settings['model.worker']" name="mw" /></label>
      <label>Chat model <input [(ngModel)]="settings['model.assistant']" name="ma" /></label>
      <label>Planner model <input [(ngModel)]="settings['model.planner']" name="mp" /></label>
      <label>Reviewer model <input [(ngModel)]="settings['model.reviewer']" name="mr" /></label>
      <label>Tickets worked on at once <input type="number" min="1" [(ngModel)]="settings['maxConcurrentRuns']" name="mc" /></label>
      <label>Budget per run, USD <input type="number" min="0" step="0.5" [(ngModel)]="settings['budget.perRunUsd']" name="bud" /></label>
      <label>Keep worktrees of finished runs, days (-1 = keep) <input type="number" min="-1" step="1" [(ngModel)]="settings['worktrees.keepDays']" name="keep" /></label>
      <label>Daily budget per project, USD (0 = no limit) <input type="number" min="0" step="1" [(ngModel)]="settings['budget.projectDailyUsd']" name="daily" /></label>
      <p class="hint">A run stops when it has spent its budget. When a project reaches its daily budget (set one per project on its Runs tab), nothing new starts and auto-assign pauses until tomorrow.</p>
      <button class="primary" type="submit">Save</button>
    </form>

    <section class="panel">
      <h2>Desktop notifications</h2>
      <p class="hint">Get a notification from this browser when an agent is blocked, a run fails, a budget is reached or a change is ready for review.</p>
      @if (notifySupported) {
        <label class="toggle"><input type="checkbox" [checked]="notify()" (change)="setNotify($any($event.target).checked)" /> Notify me on this computer</label>
        @if (notifyDenied()) { <p class="warn">The browser blocks notifications for this page; allow them in the site settings.</p> }
      } @else {
        <p class="muted">This browser does not support notifications.</p>
      }
    </section>
  `,
})
export class SettingsPage {
  private readonly api = inject(Api);
  readonly secrets = signal<SecretInfo[]>([]);
  readonly backend = signal<'keychain' | 'file'>('file');
  readonly notice = signal('');
  settings: Record<string, string> = {};
  readonly notifySupported = typeof Notification !== 'undefined';
  readonly notify = signal(this.notifySupported && this.readNotify() && Notification.permission === 'granted');
  readonly notifyDenied = signal(this.notifySupported && Notification.permission === 'denied');

  private readNotify(): boolean {
    try {
      return localStorage.getItem('maestro.notify') === '1';
    } catch {
      return false;
    }
  }

  async setNotify(on: boolean): Promise<void> {
    const permission = on && Notification.permission !== 'granted' ? await Notification.requestPermission() : Notification.permission;
    const enabled = on && permission === 'granted';
    try {
      localStorage.setItem('maestro.notify', enabled ? '1' : '0');
    } catch {
      // Private windows may refuse storage; the toggle then lasts for this page only.
    }
    this.notify.set(enabled);
    this.notifyDenied.set(permission === 'denied');
    if (enabled) new Notification('Maestro', { body: 'Notifications are on.' });
  }
  values: Record<string, string> = {};

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    const s = await this.api.settings();
    this.settings = s.settings;
    this.secrets.set(s.secrets);
    this.backend.set(s.secretsBackend);
  }

  async setSecret(s: SecretInfo): Promise<void> {
    await this.api.setSecret(s.name, this.values[s.name]);
    this.values[s.name] = '';
    await this.load();
    this.flash(`${s.label} saved.`);
  }

  async clear(s: SecretInfo): Promise<void> {
    await this.api.deleteSecret(s.name);
    await this.load();
  }

  async save(): Promise<void> {
    await this.api.saveSettings(Object.fromEntries(Object.entries(this.settings).map(([k, v]) => [k, String(v)])));
    this.flash('Saved.');
  }

  private flash(text: string): void {
    this.notice.set(text);
    setTimeout(() => this.notice.set(''), 3000);
  }
}
