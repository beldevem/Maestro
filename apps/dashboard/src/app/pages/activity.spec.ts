import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api } from '../api';
import type { ActivityEntry } from '../models';
import { Rights } from '../rights';
import { ActivityPage } from './activity';

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: 1, at: '2026-10-16T10:00:00Z', userId: 'u1', userName: 'Pat', action: 'ticket.create', targetType: 'ticket', targetId: 'SHO-3', projectId: 'p1', projectName: 'Shop', detail: { title: 'Checkout' }, ...over,
});

async function mount(viewAll: boolean, activity = vi.fn().mockResolvedValue([entry({}), entry({ id: 2, action: 'run.start', targetType: 'run', targetId: 'r1', userName: 'Dana', detail: { trigger: 'auto' } })])) {
  const can = (a: string) => viewAll || a !== 'activity.viewAll';
  await TestBed.configureTestingModule({
    imports: [ActivityPage],
    providers: [
      provideRouter([]),
      { provide: Rights, useValue: { can, load: () => Promise.resolve(), actions: signal(new Set()) } },
      { provide: Api, useValue: { activity, projects: () => Promise.resolve([{ id: 'p1', name: 'Shop' }]), users: () => Promise.resolve({ users: [{ id: 'u1', name: 'Pat', roles: ['pm'], active: true }] }) } },
    ],
  }).compileComponents();
  const f = TestBed.createComponent(ActivityPage);
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r));
    f.detectChanges();
    await f.whenStable();
  }
  return { f, activity, el: f.nativeElement as HTMLElement };
}

describe('ActivityPage', () => {
  it('lists who did what in plain words, with links to runs and projects', async () => {
    const { el } = await mount(true);
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].slice(1).map((c) => c.textContent?.replace(/\s+/g, ' ').trim()));
    expect(rows).toEqual([
      ['Pat', 'Created a ticket · Checkout', 'SHO-3', 'Shop'],
      ['Dana', 'Started a run · auto-assign', 'Run', 'Shop'],
    ]);
    expect(el.querySelector('select[name="userId"]')).not.toBeNull();
  });

  it('filters by person, project, kind and dates; a Developer has no person filter', async () => {
    const { f, activity, el } = await mount(false);
    expect(el.querySelector('select[name="userId"]')).toBeNull();
    expect(el.querySelector('.page-sub')?.textContent).toBe('What you did.');
    f.componentInstance.f = { userId: '', projectId: 'p1', action: 'run', from: '2026-10-01', to: '2026-10-16' };
    await f.componentInstance.load();
    const call = activity.mock.lastCall![0];
    expect(call).toMatchObject({ projectId: 'p1', action: 'run', limit: 100 });
    expect(new Date(call.until).getTime() - new Date(call.since).getTime()).toBe(16 * 86_400_000);
  });
});
