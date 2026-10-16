import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api } from '../api';
import type { SecretInfo } from '../models';
import { AiProviders, providerStatus } from '../components/ai-providers';
import type { ProvidersInfo } from '../models';
import { Icon } from '../ui/icon';
import { Toasts } from '../ui/toast';
import { Currency, formatTokens } from '../ui/usage';
import { SystemCheckPanel } from '../components/system-check';

type StepId = 'ai' | 'code' | 'pm' | 'design' | 'limits' | 'notify';
type Status = 'done' | 'optional' | 'todo';

interface Field {
  key: string;
  label: string;
  hint: string;
  type: 'number';
  min?: number;
  step?: number;
}

interface Step {
  id: StepId;
  title: string;
  icon: string;
  blurb: string;
  secrets: string[];
  fields: Field[];
  tests: { provider: string; label: string; needs: string[] }[];
  note?: string;
}


const STEPS: Step[] = [
  {
    id: 'ai', title: 'AI providers', icon: 'sparkles',
    blurb: 'Choose the AI that does the work: Claude, local models (Ollama, LM Studio, vLLM), an OpenAI-compatible service, or a coding CLI such as GitHub Copilot CLI. Then pick the provider and model for each role.',
    secrets: [], fields: [], tests: [],
  },
  {
    id: 'code', title: 'Code hosts', icon: 'pr',
    blurb: 'Tokens Maestro uses to clone, push branches and open pull requests. Local-folder projects need none.',
    secrets: ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'BITBUCKET_USERNAME', 'BITBUCKET_APP_PASSWORD'], fields: [],
    tests: [
      { provider: 'github', label: 'Test GitHub', needs: ['GITHUB_TOKEN'] },
      { provider: 'gitlab', label: 'Test GitLab', needs: ['GITLAB_TOKEN'] },
      { provider: 'bitbucket', label: 'Test Bitbucket', needs: ['BITBUCKET_USERNAME', 'BITBUCKET_APP_PASSWORD'] },
    ],
  },
  {
    id: 'pm', title: 'PM tools', icon: 'board',
    blurb: 'Where tickets live. Not needed for projects that keep their tickets in Maestro. The Jira site and email are set on each project.',
    secrets: ['JIRA_API_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN'], fields: [],
    tests: [{ provider: 'trello', label: 'Test Trello', needs: ['TRELLO_API_KEY', 'TRELLO_TOKEN'] }],
  },
  {
    id: 'design', title: 'Design and docs', icon: 'palette',
    blurb: 'Give agents the Figma frames a ticket links. Confluence pages are read with the Atlassian token from PM tools.',
    secrets: ['FIGMA_TOKEN'], fields: [],
    tests: [{ provider: 'figma', label: 'Test Figma', needs: ['FIGMA_TOKEN'] }],
  },
  {
    id: 'limits', title: 'Workers and limits', icon: 'sliders',
    blurb: 'How much runs at once and how much it may use. Budgets count tokens, so they also stop free local models; a euro cap can be added on top. A run stops at its budget; a project at its daily budget starts nothing new until tomorrow.',
    secrets: [],
    fields: [
      { key: 'maxConcurrentRuns', label: 'Tickets worked on at once', hint: 'Across all projects. At least 1.', type: 'number', min: 1, step: 1 },
      { key: 'budget.perRunTokens', label: 'Budget per run (tokens)', hint: 'Input, output and cache tokens over all of a run’s agent calls. 0 means no limit.', type: 'number', min: 0, step: 100000 },
      { key: 'budget.projectDailyTokens', label: 'Daily budget per project (tokens)', hint: 'A project can override it on its Runs tab. 0 means no limit.', type: 'number', min: 0, step: 1000000 },
      { key: 'budget.perRunEur', label: 'Optional cap per run (€)', hint: 'From each provider’s prices; local models cost €0. 0 means no euro cap.', type: 'number', min: 0, step: 0.5 },
      { key: 'budget.projectDailyEur', label: 'Optional daily cap per project (€)', hint: '0 means no euro cap.', type: 'number', min: 0, step: 1 },
      { key: 'budget.userDailyTokens', label: 'Daily budget per person (tokens)', hint: 'Optional: the tokens one person’s runs, chat and planning may use per day. 0 means no limit.', type: 'number', min: 0, step: 100000 },
      { key: 'currency.eurPerUsd', label: 'USD → EUR rate (rough estimate)', hint: 'Provider prices are in USD; euro figures are only an estimate with this rate. Not fetched online.', type: 'number', min: 0, step: 0.01 },
      { key: 'worktrees.keepDays', label: 'Keep worktrees of finished runs (days)', hint: 'Branches always stay. -1 keeps worktrees forever.', type: 'number', min: -1, step: 1 },
    ],
    tests: [],
  },
  {
    id: 'notify', title: 'Notifications', icon: 'bell',
    blurb: 'Get a desktop notification from this browser when an agent is blocked, a run fails, a budget is reached or a change is ready for review.',
    secrets: [], fields: [], tests: [],
  },
];

/** Settings as a guided set of steps you can also jump between freely. */
@Component({
  selector: 'app-settings',
  imports: [SystemCheckPanel, FormsModule, Icon, AiProviders],
  template: `
    <header class="page-head">
      <div>
        <h1>Settings</h1>
        <p class="page-sub">{{ doneCount() }} of {{ steps.length }} steps set up. Everything here can be changed later.</p>
      </div>
    </header>
    @if (loadError()) { <p class="error">{{ loadError() }}</p> }
    <app-system-check />

    <div class="stepper">
      @for (s of steps; track s.id; let i = $index) {
        <section class="step" [class.open]="active() === s.id">
          <button type="button" class="step-head" (click)="open(s.id)" [attr.aria-expanded]="active() === s.id" [attr.aria-controls]="'step-' + s.id">
            <span class="step-num step-{{ status(s.id) }}">
              @if (status(s.id) === 'done') { <app-icon name="check" [size]="14" /> } @else { {{ i + 1 }} }
            </span>
            <span class="step-title">{{ s.title }}<small>{{ statusText(s.id) }}</small></span>
          </button>
          @if (active() === s.id) {
            <div class="step-body" [id]="'step-' + s.id" role="region" [attr.aria-label]="s.title">
              <h2><app-icon [name]="s.icon" /> {{ s.title }}</h2>
              <p class="hint">{{ s.blurb }}</p>
              @if (s.id === 'ai') { <app-ai-providers (changed)="providers.set($event)" /> }
              @if (s.secrets.length) {
                @if (backend() === 'keychain') {
                  <p class="note-box"><app-icon name="key" [size]="16" /> Keys are stored in your system keychain and never shown again.</p>
                } @else {
                  <p class="note-box"><app-icon name="key" [size]="16" /> Keys are stored on this machine in ~/.maestro/secrets.json (readable only by you) and never shown again.</p>
                }
              }

              @for (sec of secretsFor(s); track sec.name) {
                <div class="secret-row">
                  <div class="secret-info">
                    <label [for]="'sec-' + sec.name"><strong>{{ sec.label }}</strong></label>
                    <span class="state" [class.state-available]="sec.set">{{ sec.set ? 'Saved' : 'Not set' }}</span>
                    <p class="hint">{{ sec.help }}</p>
                  </div>
                  <form class="secret-form" (ngSubmit)="saveSecret(sec)">
                    <input [id]="'sec-' + sec.name" [type]="sec.name === 'BITBUCKET_USERNAME' ? 'text' : 'password'" [(ngModel)]="values[sec.name]" [name]="sec.name"
                      [placeholder]="sec.set ? 'Replace the saved value' : 'Paste the value'" autocomplete="off" spellcheck="false" />
                    <button type="submit" [disabled]="!values[sec.name] || busy()">Save</button>
                    @if (sec.set) { <button type="button" class="icon-btn" (click)="removeSecret(sec)" [attr.aria-label]="'Remove ' + sec.label" title="Remove"><app-icon name="trash" /></button> }
                  </form>
                </div>
              }

              @if (s.tests.length) {
                <div class="test-row">
                  @for (t of s.tests; track t.provider) {
                    <button type="button" (click)="test(t.provider)" [disabled]="!hasAll(t.needs) || testing() === t.provider" [title]="hasAll(t.needs) ? '' : 'Save the token first'">
                      @if (testing() === t.provider) { <span class="spinner"></span> } @else { <app-icon name="plug" [size]="16" /> }
                      {{ t.label }}
                    </button>
                  }
                </div>
                @for (r of testResults(s); track r.provider) {
                  <p [class.ok]="r.ok" [class.error]="!r.ok" class="test-result"><app-icon [name]="r.ok ? 'check' : 'alert'" [size]="14" /> {{ r.message }}</p>
                }
              }

              @if (s.fields.length) {
                <form class="step-fields" (ngSubmit)="saveFields(s)" novalidate>
                  @for (f of s.fields; track f.key) {
                    <label>
                      {{ f.label }}
                      <input type="number" [attr.min]="f.min ?? null" [attr.step]="f.step ?? null" [(ngModel)]="settings[f.key]" [name]="f.key" [attr.aria-invalid]="!!fieldError(f)" [attr.aria-describedby]="'h-' + f.key" />
                      <small [id]="'h-' + f.key" [class.error]="!!fieldError(f)" class="field-hint">{{ fieldError(f) || f.hint }}</small>
                    </label>
                  }
                  <div class="row">
                    <button class="primary" type="submit" [disabled]="busy() || hasErrors(s)">Save {{ s.title.toLowerCase() }}</button>
                  </div>
                </form>
              }

              @if (s.id === 'notify') {
                @if (notifySupported) {
                  <label class="toggle"><input type="checkbox" [checked]="notify()" (change)="setNotify($any($event.target).checked)" /> Notify me on this computer</label>
                  @if (notifyDenied()) { <p class="warn">The browser blocks notifications for this page; allow them in the site settings, then switch this on.</p> }
                } @else {
                  <p class="muted">This browser does not support notifications.</p>
                }
              }

              <div class="step-nav">
                @if (i > 0) { <button type="button" class="quiet" (click)="open(steps[i - 1].id)">Back</button> }
                @if (i < steps.length - 1) {
                  <button type="button" (click)="open(steps[i + 1].id)">Next: {{ steps[i + 1].title }} <app-icon name="arrow" [size]="14" /></button>
                } @else {
                  <span class="hint">That's everything.</span>
                }
              </div>
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class SettingsPage {
  private readonly api = inject(Api);
  private readonly currency = inject(Currency);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  readonly steps = STEPS;
  readonly secrets = signal<SecretInfo[]>([]);
  readonly backend = signal<'keychain' | 'file'>('file');
  readonly active = signal<StepId>((inject(ActivatedRoute).snapshot.queryParamMap.get('step') as StepId) || 'ai');
  readonly busy = signal(false);
  readonly testing = signal('');
  readonly loadError = signal('');
  readonly results = signal<Record<string, { ok: boolean; message: string }>>({});
  readonly saved = signal<Record<string, string>>({});
  readonly providers = signal<ProvidersInfo | null>(null);
  settings: Record<string, string> = {};
  values: Record<string, string> = {};

  readonly notifySupported = typeof Notification !== 'undefined';
  readonly notify = signal(this.notifySupported && this.readNotify() && Notification.permission === 'granted');
  readonly notifyDenied = signal(this.notifySupported && Notification.permission === 'denied');

  readonly doneCount = computed(() => this.steps.filter((s) => this.status(s.id) === 'done').length);

  constructor() {
    void this.load();
    void this.api.providers().then((p) => this.providers.set(p), () => undefined);
  }

  /** Whether every role's provider can run now. */
  private aiReady(): boolean | null {
    const i = this.providers();
    if (!i) return null;
    return Object.values(i.roles).every((c) => {
      const p = i.providers.find((x) => x.id === c.provider);
      return !!p && providerStatus(p).ok;
    });
  }

  async load(): Promise<void> {
    try {
      const s = await this.api.settings();
      this.settings = { ...s.settings };
      this.saved.set({ ...s.settings });
      this.secrets.set(s.secrets);
      this.backend.set(s.secretsBackend);
      this.loadError.set('');
    } catch (e) {
      this.loadError.set(`Couldn't load the settings: ${(e as Error).message}`);
    }
  }

  open(id: StepId): void {
    this.active.set(id);
    void this.router.navigate([], { queryParams: { step: id }, replaceUrl: true });
  }

  private isSet(name: string): boolean {
    return this.secrets().some((s) => s.name === name && s.set);
  }

  hasAll(names: string[]): boolean {
    return names.every((n) => this.isSet(n));
  }

  secretsFor(s: Step): SecretInfo[] {
    return s.secrets.map((n) => this.secrets().find((x) => x.name === n)).filter((x): x is SecretInfo => !!x);
  }

  testResults(s: Step) {
    return s.tests.map((t) => ({ provider: t.provider, ...this.results()[t.provider] })).filter((r) => r.message);
  }

  status(id: StepId): Status {
    switch (id) {
      case 'ai': return this.aiReady() === false ? 'todo' : 'done';
      case 'code': return ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'BITBUCKET_APP_PASSWORD'].some((n) => this.isSet(n)) ? 'done' : 'todo';
      case 'pm': return ['JIRA_API_TOKEN', 'TRELLO_TOKEN'].some((n) => this.isSet(n)) ? 'done' : 'optional';
      case 'design': return this.isSet('FIGMA_TOKEN') ? 'done' : 'optional';
      case 'limits': return 'done';
      case 'notify': return this.notify() ? 'done' : 'optional';
    }
  }

  statusText(id: StepId): string {
    const s = this.status(id);
    switch (id) {
      case 'ai': {
        const i = this.providers();
        if (!i) return 'Loading…';
        const used = [...new Set(Object.values(i.roles).map((c) => i.providers.find((p) => p.id === c.provider)?.name ?? c.provider))];
        return s === 'done' ? used.join(' · ') : `${used.join(' · ')}: needs attention`;
      }
      case 'code': return s === 'done' ? `${['GITHUB_TOKEN', 'GITLAB_TOKEN', 'BITBUCKET_APP_PASSWORD'].filter((n) => this.isSet(n)).length} connected` : 'Needed for GitHub, GitLab or Bitbucket';
      case 'pm': return s === 'done' ? 'Connected' : 'Optional';
      case 'design': return s === 'done' ? 'Figma connected' : 'Optional';
      case 'limits': return `${this.saved()['maxConcurrentRuns'] ?? 3} at once · ${formatTokens(Number(this.saved()['budget.perRunTokens'] ?? 2000000))} per run`;
      case 'notify': return s === 'done' ? 'On' : 'Off';
    }
  }

  fieldError(f: Field): string {
    const raw = this.settings[f.key];
    if (f.type !== 'number') return raw !== undefined && !String(raw).trim() ? 'Required.' : '';
    if (raw === null || raw === undefined || String(raw).trim() === '') return 'Enter a number.';
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (f.min !== undefined && n < f.min) return `At least ${f.min}.`;
    if (f.step && Number.isInteger(f.step) && !Number.isInteger(n)) return 'A whole number.';
    return '';
  }

  hasErrors(s: Step): boolean {
    return s.fields.some((f) => !!this.fieldError(f));
  }

  async saveFields(s: Step): Promise<void> {
    if (this.hasErrors(s)) return;
    await this.attempt(async () => {
      await this.api.saveSettings(Object.fromEntries(s.fields.map((f) => [f.key, String(this.settings[f.key]).trim()])));
      this.saved.update((x) => ({ ...x, ...Object.fromEntries(s.fields.map((f) => [f.key, String(this.settings[f.key])])) }));
      if (s.fields.some((f) => f.key === 'currency.eurPerUsd')) this.currency.load(true);
      this.toasts.ok(`${s.title} saved.`);
    });
  }

  async saveSecret(sec: SecretInfo): Promise<void> {
    await this.attempt(async () => {
      await this.api.setSecret(sec.name, this.values[sec.name].trim());
      this.values[sec.name] = '';
      await this.load();
      this.toasts.ok(`${sec.label} saved.`);
    });
  }

  async removeSecret(sec: SecretInfo): Promise<void> {
    await this.attempt(async () => {
      await this.api.deleteSecret(sec.name);
      await this.load();
      this.toasts.info(`${sec.label} removed.`);
    });
  }

  async test(provider: string): Promise<void> {
    this.testing.set(provider);
    try {
      const r = await this.api.testConnection(provider);
      this.results.update((x) => ({ ...x, [provider]: r }));
    } catch (e) {
      this.results.update((x) => ({ ...x, [provider]: { ok: false, message: (e as Error).message } }));
    } finally {
      this.testing.set('');
    }
  }

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
      // Storage may be blocked; the switch then lasts for this page only.
    }
    this.notify.set(enabled);
    this.notifyDenied.set(permission === 'denied');
    if (enabled) new Notification('Maestro', { body: 'Notifications are on.' });
    else if (on) this.toasts.error('The browser did not allow notifications.');
  }

  private async attempt(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
