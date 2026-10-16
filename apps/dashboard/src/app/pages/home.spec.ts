import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import type { Overview } from '../models';
import { ChatDock } from '../ui/chat-dock';
import { HomePage } from './home';

const overview: Overview = {
  projects: [{ id: 'p1', name: 'Shop', description: '', codeHost: 'local', pm: 'manual', tickets: { todo: 2, in_progress: 1, in_review: 1, done: 3 }, running: 1, inReview: 1, blocked: 1, spendToday: { usd: 1.5, usage: { input: 1_000_000, output: 240_000, cache: 0 } }, dailyCaps: { tokens: 20_000_000, eur: 0 }, autoAssign: true }],
  agents: [{ id: 'a1', name: 'Worker 1', role: 'worker', provider: '', model: '', state: 'working', currentRunId: 'r1', note: 'On SHO-2' }],
  active: [{ runId: 'r1', projectId: 'p1', projectName: 'Shop', ticketKey: 'SHO-2', ticketTitle: 'Cart', status: 'running', prUrl: null, checks: null, error: null, costUsd: 0, usage: { input: 8000, output: 400, cache: 0 }, since: '' }],
  needsYou: [{ runId: 'r2', projectId: 'p1', projectName: 'Shop', ticketKey: 'SHO-1', ticketTitle: 'Checkout', status: 'blocked', prUrl: null, checks: null, error: 'Tests fail', costUsd: 1, usage: null, since: '', why: 'blocked' }],
  spend: { today: { usd: 1.5, usage: { input: 1_000_000, output: 240_000, cache: 0 } }, last7Days: { usd: 0, usage: { input: 3_000_000, output: 0, cache: 0 } }, perRunCaps: { tokens: 2_000_000, eur: 0 }, dailyCapsDefault: { tokens: 20_000_000, eur: 0 } },
  alertsUnread: 2,
  activity: [{ id: 1, runId: 'r2', ts: '2026-10-12T10:00:00Z', kind: 'error', message: 'Tests fail\nmore', ticketKey: 'SHO-1', projectId: 'p1', projectName: 'Shop' }],
};

describe('HomePage', () => {
  it('shows what is running, what needs you, projects and spend', async () => {
    const api = { overview: () => Promise.resolve(overview), chatThreads: () => Promise.resolve([]), tickets: () => Promise.resolve([]) };
    await TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [provideRouter([]), { provide: Api, useValue: api }, { provide: Live, useValue: { runs: signal([]), agents: signal([]), refresh: vi.fn() } }],
    }).compileComponents();
    const f = TestBed.createComponent(HomePage);
    f.detectChanges();
    await new Promise((r) => setTimeout(r, 10));
    await f.whenStable();
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const tiles = [...el.querySelectorAll('.tile')].map((t) => [text(t.querySelector('.tile-label')), text(t.querySelector('.tile-value')), text(t.querySelector('.tile-note'))]);
    expect(tiles).toEqual([
      ['Working now', '1', '1 of 1 workers busy'],
      ['Waiting for you', '0', 'changes ready for review'],
      ['Blocked', '1', '2 unread alerts'],
      ['Usage today', '1.24M tokens≈ €1.35', '3M tokens≈ €0 (local) in 7 days'],
    ]);
    expect(el.textContent).toContain('SHO-1 Checkout');
    // A running ticket on a local model: tokens, with the free estimate in grey.
    expect(text(el.querySelector('.row-item .usage'))).toBe('8.4k tokens≈ €0 (local)');
    expect(el.querySelector('.row-item .usage-tokens')?.getAttribute('title')).toBe('8,000 in · 400 out');
    expect(el.textContent).toContain('Shop · Blocked: Tests fail');
    expect(el.textContent).toContain('2 to do · 1 in progress · 1 in review · 3 done');
    expect(el.querySelector('app-chat-panel')).not.toBeNull();
  });

  it('minimizes the chat to a bar, closes it, and opens it again, remembering the choice', async () => {
    localStorage.clear();
    const api = { overview: () => Promise.resolve(overview), chatThreads: () => Promise.resolve([]), tickets: () => Promise.resolve([]) };
    await TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [provideRouter([]), { provide: Api, useValue: api }, { provide: Live, useValue: { runs: signal([]), agents: signal([]), refresh: vi.fn() } }],
    }).compileComponents();
    const f = TestBed.createComponent(HomePage);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    const click = (label: string) => {
      el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
      f.detectChanges();
    };
    expect(el.querySelector('.home')?.classList.contains('solo')).toBe(false);

    click('Minimize the chat');
    expect(el.querySelector('app-chat-panel')).toBeNull();
    expect(el.querySelector('.chat-bar')).not.toBeNull();
    expect(el.querySelector('.home')?.classList.contains('solo')).toBe(true);
    expect(el.querySelector('.chat-bar-open')?.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('maestro.chat.dock')).toBe('minimized');

    click('Close the chat');
    expect(el.querySelector('.chat-bar')).toBeNull();
    expect(el.querySelector('app-chat-panel')).toBeNull();
    expect(localStorage.getItem('maestro.chat.dock')).toBe('closed');

    TestBed.inject(ChatDock).summon(true);
    f.detectChanges();
    expect(el.querySelector('app-chat-panel')).not.toBeNull();
    expect(localStorage.getItem('maestro.chat.dock')).toBe('open');
  });
});
