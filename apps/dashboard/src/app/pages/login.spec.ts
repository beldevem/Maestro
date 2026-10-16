import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { Api, ApiError } from '../api';
import { routes } from '../app.routes';
import type { SessionUser } from '../models';
import { Session } from '../session';
import { LoginPage } from './login';

const user = (over: Partial<SessionUser> = {}): SessionUser => ({ id: 'u1', email: 'me@x.io', name: 'Me', roles: ['dev'], mustChangePassword: false, ...over });

async function boot(api: Partial<Api>) {
  await TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: Api, useValue: { authStatus: () => Promise.resolve({ setupNeeded: false, user: null }), ...api } }] }).compileComponents();
  return TestBed.inject(Router);
}

describe('route guards', () => {
  it('send a logged-out visitor to login, keeping where they were going', async () => {
    const router = await boot({});
    await router.navigateByUrl('/metrics');
    expect(router.url).toBe('/login?next=%2Fmetrics');
  });

  it('send everyone to setup until the first account exists, and never back to it', async () => {
    const router = await boot({ authStatus: () => Promise.resolve({ setupNeeded: true, user: null }) });
    await router.navigateByUrl('/');
    expect(router.url).toBe('/setup');
    await router.navigateByUrl('/login');
    expect(router.url).toBe('/setup');
  });

  it('send a user with a temporary password to choose a new one', async () => {
    const router = await boot({ authStatus: () => Promise.resolve({ setupNeeded: false, user: user({ mustChangePassword: true }) }) });
    await router.navigateByUrl('/projects');
    expect(router.url).toBe('/password');
  });

  it('let a logged-in user in, and keep them away from the login page', async () => {
    const router = await boot({ authStatus: () => Promise.resolve({ setupNeeded: false, user: user() }), overview: () => new Promise(() => {}), chatThreads: () => Promise.resolve([]) } as Partial<Api>);
    await router.navigateByUrl('/login');
    expect(router.url).toBe('/');
  });

  it('go to login when the session ends while using the app', async () => {
    const router = await boot({ authStatus: () => Promise.resolve({ setupNeeded: false, user: user() }), overview: () => new Promise(() => {}), chatThreads: () => Promise.resolve([]) } as Partial<Api>);
    await router.navigateByUrl('/');
    window.dispatchEvent(new CustomEvent('maestro:unauthorized'));
    await new Promise((r) => setTimeout(r, 20));
    expect(router.url).toBe('/login?next=%2F&expired=1');
    expect(TestBed.inject(Session).user()).toBeNull();
  });
});

describe('LoginPage', () => {
  it('logs in and goes where you were heading; shows the engine’s message on failure', async () => {
    const login = vi.fn().mockRejectedValueOnce(new ApiError('Wrong email or password.', 401)).mockResolvedValue({ user: user() });
    const router = await boot({ login, overview: () => new Promise(() => {}), chatThreads: () => Promise.resolve([]) } as Partial<Api>);
    await router.navigateByUrl('/login?next=%2Fmetrics');
    const f = TestBed.createComponent(LoginPage);
    const page = f.componentInstance;
    page.email = 'me@x.io';
    page.password = 'wrong one here';
    await page.submit();
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent).toBe('Wrong email or password.');
    expect(page.password).toBe('');
    page.password = 'the right password';
    await page.submit();
    expect(login).toHaveBeenLastCalledWith('me@x.io', 'the right password');
  });

  it('checks the setup form before sending it', async () => {
    const setup = vi.fn().mockResolvedValue({ user: user({ roles: ['pm', 'lead'] }) });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Api, useValue: { setup, authStatus: () => Promise.resolve({ setupNeeded: true, user: null }) } },
        { provide: ActivatedRoute, useValue: { snapshot: { data: { setup: true }, queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();
    const f = TestBed.createComponent(LoginPage);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe('Set up Maestro');
    const page = f.componentInstance;
    page.name = 'Me';
    page.email = 'me@x.io';
    page.password = 'short';
    page.again = 'short';
    await page.submit();
    expect(page.error()).toBe('Use at least 12 characters for the password.');
    page.password = 'a long enough password';
    page.again = 'a different password!!';
    await page.submit();
    expect(page.error()).toBe('The two passwords differ.');
    page.again = 'a long enough password';
    await page.submit();
    expect(setup).toHaveBeenCalledWith({ name: 'Me', email: 'me@x.io', password: 'a long enough password' });
  });
});
