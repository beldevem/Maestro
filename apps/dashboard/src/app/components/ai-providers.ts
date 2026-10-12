import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { ROLE_LABEL, type Choice, type CliPreset, type OpenAIPreset, type ProviderConfig, type ProviderKind, type ProvidersInfo, type ProviderView, type Role } from '../models';
import { Confirm } from '../ui/confirm';
import { Icon } from '../ui/icon';
import { ModelCatalog } from '../ui/model-catalog';
import { ModelSelect } from '../ui/model-select';
import { Toasts } from '../ui/toast';

const ROLES: Role[] = ['worker', 'reviewer', 'planner', 'assistant'];
const KIND_LABEL: Record<ProviderKind, string> = { claude: 'Claude (Agent SDK)', openai: 'OpenAI-compatible API', cli: 'Coding CLI' };

interface Draft {
  isNew: boolean;
  kind: 'openai' | 'cli';
  preset: string;
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  structuredOutput: ProviderConfig['structuredOutput'];
  priceIn: number;
  priceOut: number;
  command: string;
  args: string;
  modelArgs: string;
  timeoutMinutes: number;
}

export function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider';
}

/** Status line for a provider: whether it can run now, and if not, what is missing. */
export function providerStatus(p: ProviderView): { ok: boolean; text: string } {
  if (p.kind === 'claude') {
    if (p.keySet) return { ok: true, text: 'API key saved' };
    return { ok: !!p.claudeLogin?.valid, text: p.claudeLogin?.message ?? 'Needs an API key or the Claude Code login' };
  }
  if (p.kind === 'cli') return p.installed ? { ok: true, text: `${p.cli?.command} is installed` } : { ok: false, text: `${p.cli?.command || 'The command'} is not installed where Maestro runs` };
  if (!p.baseUrl) return { ok: false, text: 'No base URL' };
  return p.apiKeySecret && !p.keySet ? { ok: false, text: 'No API key saved' } : { ok: true, text: p.baseUrl };
}

/** Settings step 1: which AI does the work, and which model each role uses. */
@Component({
  selector: 'app-ai-providers',
  imports: [FormsModule, Icon, ModelSelect],
  template: `
    @if (info(); as i) {
      <h3 class="sub-head">Providers</h3>
      <div class="provider-list">
        @for (p of i.providers; track p.id) {
          <article class="provider" [attr.aria-label]="p.name">
            <div class="provider-head">
              <div>
                <strong>{{ p.name }}</strong> <span class="pill">{{ kindLabel[p.kind] }}</span>
                <p class="meta" [class.ok]="status(p).ok" [class.warn]="!status(p).ok">
                  <app-icon [name]="status(p).ok ? 'check' : 'alert'" [size]="13" /> {{ status(p).text }}
                </p>
              </div>
              <div class="row">
                <button type="button" (click)="test(p)" [disabled]="testing() === p.id">
                  @if (testing() === p.id) { <span class="spinner"></span> } @else { <app-icon name="plug" [size]="14" /> } Test
                </button>
                @if (p.kind !== 'claude') {
                  <button type="button" class="icon-btn" (click)="startEdit(p)" [attr.aria-label]="'Edit ' + p.name" title="Edit"><app-icon name="edit" /></button>
                  <button type="button" class="icon-btn" (click)="remove(p)" [attr.aria-label]="'Delete ' + p.name" title="Delete"><app-icon name="trash" /></button>
                }
              </div>
            </div>
            @if (results()[p.id]; as r) { <p class="test-result" [class.ok]="r.ok" [class.error]="!r.ok"><app-icon [name]="r.ok ? 'check' : 'alert'" [size]="14" /> {{ r.message }}</p> }
            @for (w of p.warnings; track w) { <p class="warn">{{ w }}</p> }
            @if (p.kind === 'claude') {
              <form class="secret-form" (ngSubmit)="saveClaudeKey()">
                <label class="sr-only" for="claude-key">Anthropic API key</label>
                <input id="claude-key" type="password" [(ngModel)]="claudeKey" name="ck" autocomplete="off" [placeholder]="p.keySet ? 'Replace the saved API key' : 'Anthropic API key (optional with a Claude Code login)'" />
                <button type="submit" [disabled]="!claudeKey.trim() || busy()">Save key</button>
                @if (p.keySet) { <button type="button" class="icon-btn" (click)="removeClaudeKey()" aria-label="Remove the Anthropic API key" title="Remove key"><app-icon name="trash" /></button> }
              </form>
            }
          </article>
        }
      </div>

      @if (draft(); as d) {
        <form class="provider-form" (ngSubmit)="save()" novalidate [attr.aria-label]="d.isNew ? 'Add a provider' : 'Edit ' + d.name">
          <h3>{{ d.isNew ? 'Add a provider' : 'Edit ' + d.name }}</h3>
          @if (d.isNew) {
            <div class="kind-pick" role="radiogroup" aria-label="Kind of provider">
              <label class="radio-card" [class.on]="d.kind === 'openai'"><input type="radio" name="kind" value="openai" [ngModel]="d.kind" (ngModelChange)="setKind('openai')" />
                <strong>API</strong><span>Local models (Ollama, LM Studio, vLLM) or a service like OpenAI, OpenRouter, GitHub Models</span></label>
              <label class="radio-card" [class.on]="d.kind === 'cli'"><input type="radio" name="kind" value="cli" [ngModel]="d.kind" (ngModelChange)="setKind('cli')" />
                <strong>Coding CLI</strong><span>GitHub Copilot CLI, Codex, Gemini CLI, Aider, OpenCode or your own command</span></label>
            </div>
            <label>Preset
              <select [ngModel]="d.preset" (ngModelChange)="applyPreset($event)" name="preset">
                @if (d.kind === 'openai') { @for (p of i.presets.openai; track p.id) { <option [value]="p.id">{{ p.name }}</option> } }
                @else { @for (p of i.presets.cli; track p.id) { <option [value]="p.id">{{ p.name }}{{ p.id !== 'custom' && !p.installed ? ' (not installed)' : '' }}</option> } }
              </select>
            </label>
          }
          <div class="row">
            <label>Name <input [(ngModel)]="d.name" name="name" required maxlength="60" (ngModelChange)="d.isNew && (d.id = slug($event))" /></label>
            <label>ID <input [(ngModel)]="d.id" name="id" [disabled]="!d.isNew" pattern="[a-z0-9][a-z0-9-]*" /><small class="field-hint">Used in settings; lowercase, digits, dashes.</small></label>
          </div>
          @if (d.kind === 'openai') {
            <label>Base URL <input [(ngModel)]="d.baseUrl" name="baseUrl" placeholder="http://localhost:11434/v1" spellcheck="false" />
              <small class="field-hint">{{ openaiPreset()?.keyHint }}
                @if (i.inDocker && openaiPreset()?.dockerBaseUrl) { Maestro runs in Docker: use {{ openaiPreset()!.dockerBaseUrl }} if the server listens on all interfaces, or localhost with docker-compose.local-ai.yml. }
              </small></label>
            <label>API key <input type="password" [(ngModel)]="d.apiKey" name="apiKey" autocomplete="off" [placeholder]="keyPlaceholder()" />
              <small class="field-hint">Stored in Maestro's secret store, never shown again. Leave empty for local servers.</small></label>
            <div class="row">
              <label>JSON answers
                <select [(ngModel)]="d.structuredOutput" name="so">
                  <option value="json_schema">JSON schema mode (best)</option>
                  <option value="json_object">JSON object mode</option>
                  <option value="prompt">Instructions only (any model)</option>
                </select>
                <small class="field-hint">How the reviewer, planner and chat ask for structured answers.</small>
              </label>
              <label>Price per million tokens in, USD <input type="number" min="0" step="0.01" [(ngModel)]="d.priceIn" name="pin" /></label>
              <label>Price per million tokens out, USD <input type="number" min="0" step="0.01" [(ngModel)]="d.priceOut" name="pout" /><small class="field-hint">0 for local models. Used for budgets and spend.</small></label>
            </div>
          } @else {
            @if (cliPreset(); as c) {
              @if (c.id !== 'custom') {
                <p class="note-box">
                  <app-icon [name]="c.installed ? 'check' : 'alert'" [size]="16" />
                  <span>{{ c.installed ? c.command + ' is installed.' : c.command + ' is not installed where Maestro runs. Install: ' + c.install }} {{ c.auth }}
                    @if (i.inDocker) { In Docker, the CLI must be installed in the image. }</span>
                </p>
              }
            }
            <label>Command <input [(ngModel)]="d.command" name="command" placeholder="copilot" spellcheck="false" /></label>
            <label>Arguments, one per line <textarea [(ngModel)]="d.args" name="args" rows="4" spellcheck="false" class="code"></textarea>
              <small class="field-hint">{{ '{prompt}' }} is replaced by the task, {{ '{model}' }} by the model. Check them against the CLI's --help: flags change between versions.</small></label>
            <div class="row">
              <label>Model arguments, one per line <textarea [(ngModel)]="d.modelArgs" name="margs" rows="2" spellcheck="false" class="code"></textarea><small class="field-hint">Added only when a model is chosen.</small></label>
              <label>Timeout, minutes <input type="number" min="1" [(ngModel)]="d.timeoutMinutes" name="to" /></label>
            </div>
          }
          @if (formError()) { <p class="error">{{ formError() }}</p> }
          <div class="row">
            <button class="primary" type="submit" [disabled]="busy()">{{ d.isNew ? 'Add provider' : 'Save provider' }}</button>
            <button type="button" class="quiet" (click)="draft.set(null)">Cancel</button>
          </div>
        </form>
      } @else {
        <button type="button" (click)="startAdd()"><app-icon name="plus" [size]="16" /> Add a provider</button>
      }

      <h3 class="sub-head">Who does what</h3>
      <p class="hint">Mix freely: for example a local model for workers and Claude for reviews. Workers and projects can override this.</p>
      <form (ngSubmit)="saveRoles()">
        <div class="roles-table" role="table" aria-label="Provider and model per role">
          @for (r of roles; track r) {
            <div class="role-row" role="row">
              <div role="cell"><strong>{{ roleLabel[r].label }}</strong><small class="field-hint">{{ roleLabel[r].hint }}</small></div>
              <label role="cell"><span class="sr-only">{{ roleLabel[r].label }} provider</span>
                <select [(ngModel)]="choices[r].provider" [name]="'p-' + r">
                  @for (p of i.providers; track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                </select>
              </label>
              <div role="cell">
                <app-model-select [provider]="choices[r].provider" [(value)]="choices[r].model" [selectId]="'m-' + r" [label]="roleLabel[r].label + ' model'"
                  [defaultLabel]="kindOf(choices[r].provider) === 'claude' ? 'Recommended for this role' : kindOf(choices[r].provider) === 'cli' ? 'The CLI’s default model' : ''" />
              </div>
            </div>
          }
        </div>
        @for (w of roleWarnings(); track w) { <p class="warn">{{ w }}</p> }
        <div class="row"><button class="primary" type="submit" [disabled]="busy()">Save assignments</button></div>
      </form>
    } @else if (error()) {
      <p class="error">{{ error() }}</p>
    } @else {
      <div class="skeleton" style="height:120px"></div>
    }
  `,
})
export class AiProviders {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly confirm = inject(Confirm);
  private readonly catalog = inject(ModelCatalog);
  /** Emitted after anything changes, so the page can refresh step statuses. */
  readonly changed = output<ProvidersInfo>();
  readonly roles = ROLES;
  readonly roleLabel = ROLE_LABEL;
  readonly kindLabel = KIND_LABEL;
  readonly slug = slug;
  readonly info = signal<ProvidersInfo | null>(null);
  readonly error = signal('');
  readonly draft = signal<Draft | null>(null);
  readonly formError = signal('');
  readonly busy = signal(false);
  readonly testing = signal('');
  readonly results = signal<Record<string, { ok: boolean; message: string }>>({});
  choices = {} as Record<Role, Choice>;
  claudeKey = '';

  readonly openaiPreset = computed((): OpenAIPreset | undefined => this.info()?.presets.openai.find((p) => p.id === this.draft()?.preset));
  readonly cliPreset = computed((): CliPreset | undefined => this.info()?.presets.cli.find((p) => p.id === this.draft()?.preset));

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const i = await this.api.providers();
      this.info.set(i);
      this.choices = Object.fromEntries(ROLES.map((r) => [r, { ...i.roles[r] }])) as Record<Role, Choice>;
      this.changed.emit(i);
      this.error.set('');
    } catch (e) {
      this.error.set(`Couldn't load the AI providers: ${(e as Error).message}`);
    }
  }

  status(p: ProviderView) {
    return providerStatus(p);
  }

  kindOf(id: string): string {
    return this.info()?.providers.find((x) => x.id === id)?.kind ?? '';
  }

  roleWarnings(): string[] {
    const i = this.info();
    if (!i) return [];
    const out: string[] = [];
    for (const r of ROLES) {
      const p = i.providers.find((x) => x.id === this.choices[r]?.provider);
      if (p?.kind === 'openai' && !this.choices[r].model.trim()) out.push(`${ROLE_LABEL[r].label}: choose a model for ${p.name}.`);
      if (p?.kind === 'cli' && r !== 'worker') out.push(`${ROLE_LABEL[r].label} on a coding CLI is slow and its JSON answers are less reliable; an API provider is better for this role.`);
    }
    return out;
  }

  startAdd(): void {
    this.formError.set('');
    this.draft.set(this.blank('openai'));
    this.applyPreset('ollama');
  }

  startEdit(p: ProviderView): void {
    this.formError.set('');
    const price = p.prices['*'] ?? { input: 0, output: 0 };
    this.draft.set({
      isNew: false, kind: p.kind === 'cli' ? 'cli' : 'openai', preset: p.cli?.preset ?? 'custom', id: p.id, name: p.name, baseUrl: p.baseUrl,
      apiKey: '', structuredOutput: p.structuredOutput, priceIn: price.input, priceOut: price.output,
      command: p.cli?.command ?? '', args: (p.cli?.args ?? []).join('\n'), modelArgs: (p.cli?.modelArgs ?? []).join('\n'), timeoutMinutes: p.cli?.timeoutMinutes ?? 30,
    });
  }

  private blank(kind: 'openai' | 'cli'): Draft {
    return { isNew: true, kind, preset: kind === 'openai' ? 'ollama' : 'copilot', id: '', name: '', baseUrl: '', apiKey: '', structuredOutput: 'json_schema', priceIn: 0, priceOut: 0, command: '', args: '', modelArgs: '', timeoutMinutes: 30 };
  }

  setKind(kind: 'openai' | 'cli'): void {
    this.draft.set(this.blank(kind));
    this.applyPreset(kind === 'openai' ? 'ollama' : 'copilot');
  }

  applyPreset(id: string): void {
    const d = this.draft();
    const i = this.info();
    if (!d || !i) return;
    const taken = new Set(i.providers.map((p) => p.id));
    const unique = (base: string) => { let s = base, n = 2; while (taken.has(s)) s = `${base}-${n++}`; return s; };
    if (d.kind === 'openai') {
      const p = i.presets.openai.find((x) => x.id === id)!;
      this.draft.set({ ...d, preset: id, name: p.id === 'custom' ? '' : p.name, id: p.id === 'custom' ? '' : unique(p.id), baseUrl: p.baseUrl, structuredOutput: p.structuredOutput });
    } else {
      const p = i.presets.cli.find((x) => x.id === id)!;
      this.draft.set({ ...d, preset: id, name: p.id === 'custom' ? '' : p.name, id: p.id === 'custom' ? '' : unique(p.id), command: p.command, args: p.args.join('\n'), modelArgs: p.modelArgs.join('\n') });
    }
  }

  keyPlaceholder(): string {
    const d = this.draft();
    const existing = this.info()?.providers.find((p) => p.id === d?.id);
    return existing?.keySet ? 'Replace the saved key' : this.openaiPreset()?.needsKey ? 'Paste the API key' : 'Optional';
  }

  async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    this.formError.set('');
    if (!d.name.trim()) return this.formError.set('Give the provider a name.');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(d.id)) return this.formError.set('The ID must use lowercase letters, digits and dashes.');
    if (d.isNew && this.info()?.providers.some((p) => p.id === d.id)) return this.formError.set('A provider with this ID exists.');
    if (d.kind === 'openai' && !/^https?:\/\//.test(d.baseUrl.trim())) return this.formError.set('The base URL must start with http:// or https://.');
    if (d.kind === 'cli' && !d.command.trim()) return this.formError.set('Set the command to run.');
    const keySecret = `PROVIDER_${d.id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const existing = this.info()?.providers.find((p) => p.id === d.id);
    const cfg: ProviderConfig = d.kind === 'openai'
      ? { id: d.id, name: d.name.trim(), kind: 'openai', baseUrl: d.baseUrl.trim(), apiKeySecret: d.apiKey.trim() || existing?.keySet ? keySecret : '', structuredOutput: d.structuredOutput,
          prices: d.priceIn || d.priceOut ? { '*': { input: Number(d.priceIn) || 0, output: Number(d.priceOut) || 0 } } : {} }
      : { id: d.id, name: d.name.trim(), kind: 'cli', baseUrl: '', apiKeySecret: '', structuredOutput: 'prompt', prices: {},
          cli: { preset: d.preset, command: d.command.trim(), args: lines(d.args), modelArgs: lines(d.modelArgs), timeoutMinutes: Number(d.timeoutMinutes) || 30 } };
    this.busy.set(true);
    try {
      if (d.kind === 'openai' && d.apiKey.trim()) await this.api.setSecret(keySecret, d.apiKey.trim());
      await this.api.saveProvider(cfg);
      this.draft.set(null);
      this.toasts.ok(`${cfg.name} saved.`);
      this.catalog.forget(cfg.id);
      await this.load();
    } catch (e) {
      this.formError.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(p: ProviderView): Promise<void> {
    const ok = await this.confirm.ask({ title: `Delete ${p.name}?`, body: 'Roles, workers and projects must use another provider first. Its saved key stays in the secret store until you remove it.', confirm: 'Delete provider', danger: true });
    if (!ok) return;
    try {
      await this.api.deleteProvider(p.id);
      this.toasts.ok(`${p.name} deleted.`);
      await this.load();
    } catch (e) {
      this.toasts.error((e as Error).message);
    }
  }

  async test(p: ProviderView): Promise<void> {
    this.testing.set(p.id);
    try {
      const r = await this.api.testProvider(p.id);
      this.results.update((x) => ({ ...x, [p.id]: r }));
      if (r.models) this.catalog.forget(p.id);
    } catch (e) {
      this.results.update((x) => ({ ...x, [p.id]: { ok: false, message: (e as Error).message } }));
    } finally {
      this.testing.set('');
    }
  }

  async saveClaudeKey(): Promise<void> {
    await this.api.setSecret('ANTHROPIC_API_KEY', this.claudeKey.trim());
    this.claudeKey = '';
    this.toasts.ok('Anthropic API key saved.');
    await this.load();
  }

  async removeClaudeKey(): Promise<void> {
    await this.api.deleteSecret('ANTHROPIC_API_KEY');
    await this.load();
  }

  async saveRoles(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.saveRoles(this.choices);
      this.toasts.ok('Assignments saved.');
      await this.load();
    } catch (e) {
      this.toasts.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}
