import { Component, ElementRef, Injectable, effect, inject, signal, viewChild } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Items listed under the body, e.g. what will be deleted. */
  details?: string[];
  confirm: string;
  danger?: boolean;
}

/** One accessible confirm dialog for the whole app: `await confirm.ask({...})`. */
@Injectable({ providedIn: 'root' })
export class Confirm {
  readonly current = signal<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);

  ask(req: ConfirmRequest): Promise<boolean> {
    this.current()?.resolve(false);
    return new Promise((resolve) => this.current.set({ ...req, resolve }));
  }

  answer(ok: boolean): void {
    const c = this.current();
    this.current.set(null);
    c?.resolve(ok);
  }
}

@Component({
  selector: 'app-confirm',
  template: `
    <dialog #dialog class="dialog" (cancel)="$event.preventDefault(); confirm.answer(false)" aria-labelledby="confirm-title">
      @if (confirm.current(); as c) {
        <h2 id="confirm-title">{{ c.title }}</h2>
        <p>{{ c.body }}</p>
        @if (c.details?.length) {
          <ul class="dialog-list">@for (d of c.details; track d) { <li>{{ d }}</li> }</ul>
        }
        <div class="dialog-actions">
          <button type="button" (click)="confirm.answer(false)">Cancel</button>
          <button type="button" [class.danger-solid]="c.danger" [class.primary]="!c.danger" (click)="confirm.answer(true)">{{ c.confirm }}</button>
        </div>
      }
    </dialog>
  `,
})
export class ConfirmHost {
  readonly confirm = inject(Confirm);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.confirm.current() && !el.open) el.showModal?.();
      if (!this.confirm.current() && el.open) el.close();
    });
  }
}
