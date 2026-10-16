import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Api } from './api';
import { App } from './app';
import { Live } from './live';
import { Session } from './session';

/** A Session that is already logged in. */
function signedInAs(roles: ('pm' | 'lead' | 'dev')[] = ['pm', 'lead']) {
  const user = signal({ id: 'u1', email: 'me@x.io', name: 'Ada Lovelace', roles, mustChangePassword: false });
  return { provide: Session, useValue: { user, signedIn: () => !!user(), ready: () => true, load: () => Promise.resolve(), has: (r: string) => roles.includes(r as never), logout: vi.fn() } };
}

describe('App', () => {
  it('renders the navigation and starts live updates', async () => {
    const live = { start: vi.fn(), connected: () => false, agents: () => [], runs: () => [], alerts: () => [], unread: () => 2 };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), { provide: Live, useValue: live }, signedInAs()],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.brand')?.textContent).toContain('Maestro');
    expect(el.textContent).toContain('Engine offline');
    expect([...el.querySelectorAll('.nav a')].map((a) => a.getAttribute('aria-label'))).toEqual(['Dashboard', 'Projects', 'Workers', 'Pull requests', 'Metrics', 'Alerts', 'Settings']);
    expect(el.querySelector('.badge')?.textContent).toBe('2');
    expect(live.start).toHaveBeenCalled();
    // The user menu: initials, name and roles.
    expect(el.querySelector('.avatar')?.textContent).toBe('AL');
    expect(el.querySelector('.user-chip-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Ada LovelaceProject Manager · Tech Lead');
  });

  it('shows only the page (no menu, no live updates) when nobody is logged in', async () => {
    const live = { start: vi.fn(), stop: vi.fn(), connected: () => false, agents: () => [], runs: () => [], alerts: () => [], unread: () => 0 };
    const user = signal(null);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), { provide: Live, useValue: live }, { provide: Session, useValue: { user, signedIn: () => false, load: () => Promise.resolve() } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.nav')).toBeNull();
    expect(el.querySelector('.chat-launcher')).toBeNull();
    expect(live.start).not.toHaveBeenCalled();
  });
});

describe('Ask Maestro from any page', () => {
  it('opens the chat in a drawer from the floating button and the menu, and closes it', async () => {
    localStorage.clear();
    const live = { start: vi.fn(), connected: () => true, agents: () => [], runs: () => [], alerts: () => [], unread: () => 0 };
    const api = { projects: () => Promise.resolve([{ id: 'p1', name: 'Shop' }]), chatThreads: () => Promise.resolve([]), tickets: () => Promise.resolve([]) };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([{ path: 'metrics', children: [] }]), { provide: Live, useValue: live }, { provide: Api, useValue: api }, signedInAs()],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/metrics');
    fixture.detectChanges();
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    const launcher = el.querySelector<HTMLButtonElement>('.chat-launcher')!;
    expect(launcher.getAttribute('aria-label')).toBe('Ask Maestro');
    launcher.click();
    fixture.detectChanges();
    expect(el.querySelector('.chat-drawer[role="dialog"] app-chat-panel')).not.toBeNull();
    expect(el.querySelector('.chat-launcher')).toBeNull();
    expect(el.querySelector('.nav-chat')?.getAttribute('aria-expanded')).toBe('true');
    el.querySelector<HTMLButtonElement>('.chat-drawer [aria-label="Close the chat"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.chat-drawer')).toBeNull();
    el.querySelector<HTMLButtonElement>('.nav-chat')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.chat-drawer')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(el.querySelector('.chat-drawer')).toBeNull();
  });
});

describe('duration', () => {
  it('formats minutes, hours and days', async () => {
    const { duration } = await import('./pages/metrics');
    expect(duration(null)).toBe('–');
    expect(duration(12 * 60_000)).toBe('12m');
    expect(duration(125 * 60_000)).toBe('2h 05m');
    expect(duration(76 * 3_600_000)).toBe('3d 4h');
  });
});
