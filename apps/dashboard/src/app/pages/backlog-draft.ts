import { Component, effect, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import type { BacklogDraft, BacklogItem } from '../models';
import { Confirm } from '../ui/confirm';

/** The planner's proposed backlog: edit it, then create the tickets or throw it away. */
@Component({
  selector: 'app-backlog-draft',
  imports: [FormsModule, DecimalPipe],
  template: `
    <section class="panel draft">
      <div class="draft-head">
        <h2>Backlog draft <span class="count">{{ items().length }} tickets · \${{ draft().costUsd | number: '1.2-2' }}</span></h2>
        <span class="hint">Edit before creating. Nothing is in {{ pmName() }} yet.</span>
      </div>
      @if (started()) {
        <p class="warn">{{ createdCount() }} of {{ items().length }} tickets were already created. Create again to finish the rest.</p>
      }
      @for (item of items(); track $index; let i = $index) {
        <article class="draft-item">
          <div class="row">
            <span class="draft-index">#{{ i + 1 }}</span>
            <label class="grow">Title <input [(ngModel)]="item.title" [name]="'t' + i" [disabled]="started()" (ngModelChange)="touch()" /></label>
            <label>Size
              <select [(ngModel)]="item.size" [name]="'s' + i" [disabled]="started()" (ngModelChange)="touch()">
                @for (s of sizes; track s) { <option [value]="s">{{ s }}</option> }
              </select>
            </label>
            @if (!started()) { <button type="button" class="quiet" (click)="remove(i)" title="Remove this ticket">Remove</button> }
            @if (draft().createdKeys[i]; as key) { <span class="pill">{{ key }}</span> }
          </div>
          <label>Labels
            <input [ngModel]="item.labels.join(', ')" (ngModelChange)="setLabels(item, $event)" [name]="'l' + i" [disabled]="started()" placeholder="area:api, bug" />
          </label>
          <label>Acceptance criteria
            <textarea [(ngModel)]="item.acceptanceCriteria" [name]="'ac' + i" rows="3" [disabled]="started()" (ngModelChange)="touch()"></textarea>
          </label>
          @if (item.description) {
            <details><summary class="muted">Description</summary>
              <textarea [(ngModel)]="item.description" [name]="'d' + i" rows="3" [disabled]="started()" (ngModelChange)="touch()"></textarea>
            </details>
          }
          <div class="chips">
            <span class="muted">Depends on</span>
            @for (d of item.dependsOn; track d) {
              <span class="chip">#{{ d + 1 }} {{ items()[d]?.title }}
                @if (!started()) { <button type="button" class="chip-x" (click)="dropDep(item, d)" title="Remove dependency">×</button> }
              </span>
            } @empty { <span class="muted">nothing</span> }
            @if (!started() && i > 0) {
              <select [ngModel]="''" (ngModelChange)="addDep(item, $event)" [name]="'dep' + i" class="chip-add">
                <option value="">Add…</option>
                @for (other of items().slice(0, i); track $index; let j = $index) {
                  @if (!item.dependsOn.includes(j)) { <option [value]="j">#{{ j + 1 }} {{ other.title }}</option> }
                }
              </select>
            }
          </div>
        </article>
      }
      @if (error()) { <p class="error">{{ error() }}</p> }
      <div class="row">
        <button class="primary" type="button" (click)="approve()" [disabled]="busy() || items().length === 0">
          Create {{ items().length - createdCount() }} tickets in {{ pmName() }}
        </button>
        <button type="button" (click)="discard()" [disabled]="busy() || started()">Discard</button>
        @if (busy()) { <span class="spinner"></span> }
      </div>
    </section>
  `,
})
export class BacklogDraftPanel {
  private readonly api = inject(Api);
  private readonly confirmDialog = inject(Confirm);
  readonly draft = input.required<BacklogDraft>();
  readonly pmName = input('Maestro');
  /** Emitted once the draft is approved or discarded, so the board reloads. */
  readonly done = output<string | null>();

  readonly sizes = ['XS', 'S', 'M', 'L', 'XL'];
  readonly items = signal<BacklogItem[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  private dirty = false;

  constructor() {
    effect(() => {
      const d = this.draft();
      this.items.set(structuredClone(d.items));
      this.error.set(d.error ?? '');
      this.dirty = false;
    });
  }

  started(): boolean {
    return this.draft().createdKeys.some(Boolean);
  }

  createdCount(): number {
    return this.draft().createdKeys.filter(Boolean).length;
  }

  touch(): void {
    this.dirty = true;
  }

  setLabels(item: BacklogItem, text: string): void {
    item.labels = text.split(',').map((l) => l.trim()).filter(Boolean);
    this.touch();
  }

  addDep(item: BacklogItem, value: string): void {
    if (value === '') return;
    item.dependsOn = [...item.dependsOn, Number(value)].sort((a, b) => a - b);
    this.items.update((xs) => [...xs]);
    this.touch();
  }

  dropDep(item: BacklogItem, d: number): void {
    item.dependsOn = item.dependsOn.filter((x) => x !== d);
    this.items.update((xs) => [...xs]);
    this.touch();
  }

  /** Removing an item drops dependencies on it and shifts the later indexes down. */
  remove(i: number): void {
    this.items.update((xs) =>
      xs.filter((_, j) => j !== i).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== i).map((d) => (d > i ? d - 1 : d)) })),
    );
    this.touch();
  }

  async approve(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.dirty && !this.started()) await this.api.updateDraft(this.draft().id, this.items());
      const res = await this.api.approveDraft(this.draft().id);
      if (res.error) this.error.set(`${res.created.length} created. ${res.error}`);
      this.done.emit(res.error);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async discard(): Promise<void> {
    if (!(await this.confirmDialog.ask({ title: 'Discard this backlog draft?', body: 'No tickets are created. You can plan again later.', confirm: 'Discard', danger: true }))) return;
    this.busy.set(true);
    try {
      await this.api.discardDraft(this.draft().id);
      this.done.emit(null);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
