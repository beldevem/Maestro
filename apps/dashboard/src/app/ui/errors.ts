import { ErrorHandler, Injectable, inject } from '@angular/core';
import { Toasts } from './toast';

/**
 * Anything nobody caught (a failed request in a click handler, a bug) is shown as a toast,
 * so a problem is never silent. Expected cases are handled where they happen.
 */
@Injectable()
export class ShowErrors implements ErrorHandler {
  private readonly toasts = inject(Toasts);
  private last = { text: '', at: 0 };

  handleError(error: unknown): void {
    console.error(error);
    const e = (error as { rejection?: unknown })?.rejection ?? error;
    const text = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong. Reload the page and try again.';
    // The same error twice in a row (e.g. a retry loop) shows once.
    if (text === this.last.text && Date.now() - this.last.at < 3000) return;
    this.last = { text, at: Date.now() };
    this.toasts.error(text);
  }
}
