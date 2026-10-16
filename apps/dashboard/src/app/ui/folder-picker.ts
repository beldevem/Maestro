import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import type { DirListing } from '../models';
import { Icon } from './icon';

export interface PickedFolder {
  path: string;
  isGitRepo: boolean;
  branch: string | null;
}

/**
 * Browse the folders the engine can see and pick one. Browsers never tell a page a folder's full path,
 * so the engine lists them (folders only, inside its allowed roots).
 */
@Component({
  selector: 'app-folder-picker',
  imports: [FormsModule, Icon],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="modal-backdrop" (click)="cancel.emit()" aria-hidden="true"></div>
    <div class="modal folder-picker" role="dialog" aria-modal="true" aria-labelledby="fp-title">
      <h2 id="fp-title">Choose the repository folder</h2>
      <nav class="fp-crumbs" aria-label="Folder path">
        @if ((listing()?.roots?.length ?? 0) > 1) { <button type="button" class="link-btn" (click)="go('')">All folders</button><span aria-hidden="true">/</span> }
        @for (c of listing()?.crumbs ?? []; track c.path; let last = $last) {
          <button type="button" class="link-btn" (click)="go(c.path)" [attr.aria-current]="last ? 'location' : null">{{ c.name }}</button>
          @if (!last) { <span aria-hidden="true">/</span> }
        }
      </nav>
      <div class="fp-tools">
        <button type="button" (click)="up()" [disabled]="listing()?.parent === null || listing()?.parent === undefined" aria-label="Up one folder"><app-icon name="arrow" [size]="14" /> Up</button>
        <label class="sr-only" for="fp-filter">Filter folders</label>
        <input #filterBox id="fp-filter" [ngModel]="filter()" (ngModelChange)="filter.set($event)" name="fp-filter" placeholder="Filter" autocomplete="off" />
        <label class="toggle"><input type="checkbox" [ngModel]="hidden()" (ngModelChange)="toggleHidden($event)" name="fp-hidden" /> Show hidden</label>
      </div>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <ul class="fp-list" role="listbox" aria-label="Folders" [attr.aria-busy]="loading()">
        @for (d of shown(); track d.path) {
          <li role="option" [attr.aria-selected]="picked() === d.path">
            <button type="button" class="fp-item" [class.selected]="picked() === d.path" (click)="picked.set(d.path)" (dblclick)="go(d.path)" (keydown.enter)="$event.preventDefault(); go(d.path)"
              [attr.aria-label]="d.name + (d.isGitRepo ? ', git repository' : '') + '. Enter opens it.'">
              <app-icon name="folder" [size]="16" />
              <span class="fp-name">{{ d.name }}</span>
              @if (d.isGitRepo) { <span class="pill pill-git">git</span> }
              @if (d.hasPackageJson) { <span class="pill">package.json</span> }
            </button>
          </li>
        } @empty {
          @if (!loading()) { <li class="hint">{{ filter() ? 'No folder matches.' : 'No subfolders here.' }}</li> }
        }
      </ul>
      @if (listing()?.truncated) { <p class="hint">Showing the first 500 folders; filter or open one to narrow down.</p> }
      <p class="fp-choice">
        @if (choice()) { <span class="hint">Selected:</span> <code>{{ choice() }}</code> } @else { <span class="hint">Open a folder or select one in the list.</span> }
      </p>
      <div class="row fp-actions">
        <button type="button" class="quiet" (click)="cancel.emit()">Cancel</button>
        <button type="button" class="primary" (click)="select()" [disabled]="!choice() || selecting()">Select this folder</button>
      </div>
    </div>
  `,
})
export class FolderPicker {
  private readonly api = inject(Api);
  /** Where to start: the field's current value when it is inside the allowed folders. */
  readonly start = input('');
  readonly chosen = output<PickedFolder>();
  readonly cancel = output<void>();

  readonly listing = signal<DirListing | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly hidden = signal(false);
  readonly picked = signal('');
  readonly selecting = signal(false);
  readonly filter = signal('');
  private readonly filterBox = viewChild<ElementRef<HTMLInputElement>>('filterBox');

  readonly shown = computed(() => {
    const f = this.filter().trim().toLowerCase();
    return (this.listing()?.dirs ?? []).filter((d) => !f || d.name.toLowerCase().includes(f));
  });
  /** The highlighted folder, else the folder being shown. */
  readonly choice = computed(() => this.picked() || this.listing()?.path || '');

  constructor() {
    queueMicrotask(async () => {
      const start = this.start().trim();
      // Start beside the field's folder (highlighted) when it can be opened, else at the top.
      const parent = start.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
      if (start && (await this.go(parent, true)) && this.listing()?.dirs.some((d) => d.path === start.replace(/\/+$/, ''))) this.picked.set(start.replace(/\/+$/, ''));
      else if (!start || !(await this.go(start, true))) await this.go('');
      this.filterBox()?.nativeElement.focus();
    });
  }

  async go(path: string, quiet = false): Promise<boolean> {
    this.loading.set(true);
    try {
      const l = await this.api.fsDirs(path || undefined, this.hidden());
      this.listing.set(l);
      this.picked.set('');
      this.filter.set('');
      this.error.set('');
      return true;
    } catch (e) {
      if (!quiet) this.error.set((e as Error).message);
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  up(): void {
    const parent = this.listing()?.parent;
    if (parent !== null && parent !== undefined) void this.go(parent);
  }

  toggleHidden(v: boolean): void {
    this.hidden.set(v);
    void this.go(this.listing()?.path ?? '');
  }

  async select(): Promise<void> {
    const path = this.choice();
    if (!path) return;
    this.selecting.set(true);
    try {
      this.chosen.emit(await this.api.fsCheck(path));
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.selecting.set(false);
    }
  }
}
