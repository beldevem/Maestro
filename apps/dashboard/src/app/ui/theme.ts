import { Injectable, signal } from '@angular/core';

export type Theme = 'system' | 'light' | 'dark';

/** Light, dark or follow the system; remembered in this browser. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(this.read());

  constructor() {
    this.apply(this.theme());
  }

  cycle(): void {
    const next: Theme = this.theme() === 'system' ? 'light' : this.theme() === 'light' ? 'dark' : 'system';
    this.theme.set(next);
    this.apply(next);
    try {
      localStorage.setItem('maestro.theme', next);
    } catch {
      // Storage may be blocked; the choice then lasts for this page.
    }
  }

  private read(): Theme {
    try {
      const t = localStorage.getItem('maestro.theme');
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
      return 'system';
    }
  }

  private apply(t: Theme): void {
    if (typeof document === 'undefined') return;
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }
}
