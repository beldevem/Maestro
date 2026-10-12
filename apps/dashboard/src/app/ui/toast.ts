import { Component, Injectable, inject, signal } from '@angular/core';
import { Icon } from './icon';

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

/** Short confirmations and errors, shown bottom-right and dismissed on their own. */
@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly list = signal<Toast[]>([]);
  private next = 1;

  ok(text: string): void {
    this.show('ok', text);
  }
  error(text: string): void {
    this.show('error', text, 7000);
  }
  info(text: string): void {
    this.show('info', text);
  }
  dismiss(id: number): void {
    this.list.update((xs) => xs.filter((t) => t.id !== id));
  }

  private show(kind: Toast['kind'], text: string, ms = 4000): void {
    const id = this.next++;
    this.list.update((xs) => [...xs.slice(-3), { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
}

@Component({
  selector: 'app-toasts',
  imports: [Icon],
  template: `
    <div class="toasts" role="status" aria-live="polite">
      @for (t of toasts.list(); track t.id) {
        <div class="toast toast-{{ t.kind }}">
          <app-icon [name]="t.kind === 'error' ? 'alert' : 'check'" />
          <span>{{ t.text }}</span>
          <button class="icon-btn" (click)="toasts.dismiss(t.id)" aria-label="Dismiss"><app-icon name="x" [size]="14" /></button>
        </div>
      }
    </div>
  `,
})
export class ToastHost {
  readonly toasts = inject(Toasts);
}
