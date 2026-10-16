import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Api } from '../api';
import type { UserView } from '../models';
import { Session } from '../session';
import { Confirm } from '../ui/confirm';
import { UsersPage } from './users';

const people: UserView[] = [
  { id: 'u1', name: 'Pat Manager', email: 'pat@x.io', roles: ['pm', 'lead'], active: true, lastLoginAt: null, projects: ['p1'] },
  { id: 'u2', name: 'Dana Dev', email: 'dana@x.io', roles: ['dev'], active: true, lastLoginAt: null, projects: [] },
];

async function mount(api: Partial<Api>) {
  await TestBed.configureTestingModule({
    imports: [UsersPage],
    providers: [
      { provide: Api, useValue: { users: () => Promise.resolve({ users: people, projects: [{ id: 'p1', name: 'Shop' }] }), ...api } },
      { provide: Session, useValue: { user: signal({ id: 'u1' }) } },
      { provide: Confirm, useValue: { ask: () => Promise.resolve(true) } },
    ],
  }).compileComponents();
  const f = TestBed.createComponent(UsersPage);
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r));
    f.detectChanges();
    await f.whenStable();
  }
  return { f, el: f.nativeElement as HTMLElement };
}

describe('UsersPage', () => {
  it('lists people with their roles and projects; you can’t delete yourself', async () => {
    const { el } = await mount({});
    const cards = [...el.querySelectorAll('.user-card')];
    expect(cards.map((c) => c.querySelector('strong')?.textContent?.trim())).toEqual(['Pat Manager (you)', 'Dana Dev']);
    expect(cards[0].querySelector('.role-badges')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Project ManagerTech Lead');
    expect(cards[0].textContent).toContain('Shop');
    expect([...cards[0].querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Roles', 'Reset password']);
    expect([...cards[1].querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Roles', 'Reset password', 'Delete']);
  });

  it('adds a person and shows their one-time password once', async () => {
    const createUser = vi.fn().mockResolvedValue({ user: { ...people[1], id: 'u3', name: 'New One' }, password: 'abcde-fghij-kmnpq-rstuv' });
    const { f, el } = await mount({ createUser });
    const page = f.componentInstance;
    page.startAdd();
    page.draft = { name: ' New One ', email: 'new@x.io', roles: [], projects: ['p1'] };
    await page.add();
    expect(page.formError()).toBe('Give at least one role.');
    page.draft.roles = ['dev'];
    await page.add();
    expect(createUser).toHaveBeenCalledWith({ name: 'New One', email: 'new@x.io', roles: ['dev'], projects: ['p1'] });
    f.detectChanges();
    expect(el.querySelector('.one-time')?.textContent).toBe('abcde-fghij-kmnpq-rstuv');
  });
});
