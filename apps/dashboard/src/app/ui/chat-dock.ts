import { Injectable, signal } from '@angular/core';

export type DockState = 'open' | 'minimized' | 'closed';
const KEY = 'maestro.chat.dock';

function read(): DockState {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'minimized' || v === 'closed' ? v : 'open';
  } catch {
    return 'open';
  }
}

/**
 * Where the "Ask Maestro" chat is: open beside the Dashboard, minimized to a bar, or closed.
 * Remembered per browser. From any other page (and on phones) it opens in a drawer instead.
 */
@Injectable({ providedIn: 'root' })
export class ChatDock {
  readonly state = signal<DockState>(read());
  /** The chat drawer over the current page. */
  readonly drawer = signal(false);
  /** Phone width: the chat only opens as a full-screen sheet. */
  readonly phone = signal(typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches);

  constructor() {
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(max-width: 760px)');
      mq.addEventListener?.('change', (e) => this.phone.set(e.matches));
    }
  }

  set(state: DockState): void {
    this.state.set(state);
    try {
      localStorage.setItem(KEY, state);
    } catch {
      // Private windows may refuse storage; the choice then lasts for this visit.
    }
  }

  open(): void {
    this.set('open');
  }
  minimize(): void {
    this.set('minimized');
  }
  close(): void {
    this.set('closed');
    this.drawer.set(false);
  }
  /** The floating button and the menu item: on the Dashboard (wide screens) it docks the chat again; elsewhere it opens the drawer. */
  summon(onDashboard: boolean): void {
    if (onDashboard && !this.phone()) this.open();
    else this.drawer.set(true);
  }
}
