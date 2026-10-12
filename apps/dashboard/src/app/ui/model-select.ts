import { Component, effect, inject, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModelCatalog } from './model-catalog';

const OTHER = '__other__';

/**
 * A model dropdown for one provider: its models (from the provider), an optional "default" entry,
 * and "Other…" to type a name the provider doesn't list. When the provider changes and the current
 * model isn't one of its models, the choice resets.
 */
@Component({
  selector: 'app-model-select',
  imports: [FormsModule],
  template: `
    <div class="model-select">
      <div class="model-select-row">
      <select [id]="selectId()" [ngModel]="selectValue()" (ngModelChange)="pick($event)" [attr.aria-label]="label()" [disabled]="disabled()" [name]="selectId()">
        @if (loading()) { <option [value]="value()" disabled>Loading models…</option> }
        @if (defaultLabel()) { <option value="">{{ defaultLabel() }}</option> }
        @for (m of models(); track m) { <option [value]="m">{{ m }}</option> }
        @if (custom() && value()) { <option [value]="value()">{{ value() }} (not listed)</option> }
        <option [value]="other">Other model…</option>
      </select>
      <button type="button" class="icon-btn" (click)="refresh()" [disabled]="loading() || disabled()" title="Refresh the model list" [attr.aria-label]="'Refresh models for ' + label()">↻</button>
      </div>
      @if (typing()) {
        <input [ngModel]="value()" (ngModelChange)="value.set($event.trim())" [name]="selectId() + '-other'" placeholder="Model name" spellcheck="false" [attr.aria-label]="label() + ', model name'" />
      }
      @if (error()) {
        <small class="field-hint warn">Couldn't list models: {{ error() }} <button type="button" class="link-btn" (click)="refresh()">Retry</button></small>
      } @else if (!loading() && !models().length && !typing()) {
        <small class="field-hint">This provider lists no models; choose “Other model…” to type one.</small>
      }
    </div>
  `,
})
export class ModelSelect {
  private readonly catalog = inject(ModelCatalog);
  readonly provider = input.required<string>();
  readonly value = model<string>('');
  /** Text of the empty choice, e.g. "Default (claude-sonnet-5-5)"; no empty choice when blank. */
  readonly defaultLabel = input('');
  readonly label = input('Model');
  readonly selectId = input('model');
  readonly disabled = input(false);
  readonly other = OTHER;
  readonly models = signal<string[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly typing = signal(false);
  private lastProvider = '';

  constructor() {
    effect(() => {
      const provider = this.provider();
      const changed = this.lastProvider !== '' && provider !== this.lastProvider;
      this.lastProvider = provider;
      void this.load(provider, changed);
    });
  }

  private async load(provider: string, providerChanged: boolean): Promise<void> {
    this.loading.set(true);
    this.typing.set(false);
    const { models, error } = await this.catalog.get(provider);
    if (provider !== this.provider()) return;
    this.models.set(models);
    this.error.set(error);
    this.loading.set(false);
    // A model of another provider makes no sense here: reset it.
    if (providerChanged && this.value() && !models.includes(this.value())) this.value.set(this.defaultLabel() ? '' : models[0] ?? '');
    if (!providerChanged && !this.value() && !this.defaultLabel() && models.length) this.value.set(models[0]);
    if (error && !models.length) this.typing.set(true);
  }

  refresh(): void {
    this.catalog.forget(this.provider());
    void this.load(this.provider(), false);
  }

  custom(): boolean {
    return !this.loading() && !!this.value() && !this.models().includes(this.value());
  }

  selectValue(): string {
    return this.typing() ? OTHER : this.value();
  }

  pick(v: string): void {
    if (v === OTHER) {
      this.typing.set(true);
      return;
    }
    this.typing.set(false);
    this.value.set(v);
  }
}
