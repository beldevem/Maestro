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
      <p class="hint">Stored on this machine in ~/.maestro/secrets.json, readable only by you. Values are never shown again.</p>
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
      <label>Tickets worked on at once <input type="number" min="1" [(ngModel)]="settings['maxConcurrentRuns']" name="mc" /></label>
      <label>Budget per run, USD <input type="number" min="0" step="0.5" [(ngModel)]="settings['budget.perRunUsd']" name="bud" /></label>
      <button class="primary" type="submit">Save</button>
    </form>
  `,
})
export class SettingsPage {
  private readonly api = inject(Api);
  readonly secrets = signal<SecretInfo[]>([]);
  readonly notice = signal('');
  settings: Record<string, string> = {};
  values: Record<string, string> = {};

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    const s = await this.api.settings();
    this.settings = s.settings;
    this.secrets.set(s.secrets);
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
