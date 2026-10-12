import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import type { Overview } from '../models';
import { HomePage } from './home';

const overview: Overview = {
  projects: [{ id: 'p1', name: 'Shop', description: '', codeHost: 'local', pm: 'manual', tickets: { todo: 2, in_progress: 1, in_review: 1, done: 3 }, running: 1, inReview: 1, blocked: 1, spendToday: 1.5, dailyCap: 10, autoAssign: true }],
  agents: [{ id: 'a1', name: 'Worker 1', role: 'worker', provider: '', model: '', state: 'working', currentRunId: 'r1', note: 'On SHO-2' }],
  active: [{ runId: 'r1', projectId: 'p1', projectName: 'Shop', ticketKey: 'SHO-2', ticketTitle: 'Cart', status: 'running', prUrl: null, checks: null, error: null, costUsd: 0.4, since: '' }],
  needsYou: [{ runId: 'r2', projectId: 'p1', projectName: 'Shop', ticketKey: 'SHO-1', ticketTitle: 'Checkout', status: 'blocked', prUrl: null, checks: null, error: 'Tests fail', costUsd: 1, since: '', why: 'blocked' }],
  spend: { today: 1.5, last7Days: 4.25, perRunCap: 5, dailyCapDefault: 0 },
  alertsUnread: 2,
  activity: [{ id: 1, runId: 'r2', ts: '2026-10-12T10:00:00Z', kind: 'error', message: 'Tests fail\nmore', ticketKey: 'SHO-1', projectId: 'p1', projectName: 'Shop' }],
};

describe('HomePage', () => {
  it('shows what is running, what needs you, projects and spend', async () => {
    const api = { overview: () => Promise.resolve(overview), globalChatHistory: () => Promise.resolve([]), tickets: () => Promise.resolve([]) };
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
    const tiles = [...el.querySelectorAll('.tile')].map((t) => [...t.querySelectorAll('span')].map((x) => x.textContent?.trim()));
    expect(tiles).toEqual([
      ['Working now', '1', '1 of 1 workers busy'],
      ['Waiting for you', '0', 'changes ready for review'],
      ['Blocked', '1', '2 unread alerts'],
      ['Spent today', '$1.50', '$4.25 in 7 days'],
    ]);
    expect(el.textContent).toContain('SHO-1 Checkout');
    expect(el.textContent).toContain('Shop · Blocked: Tests fail');
    expect(el.textContent).toContain('2 to do · 1 in progress · 1 in review · 3 done');
    expect(el.querySelector('app-chat-panel')).not.toBeNull();
  });
});
