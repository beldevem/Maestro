import { TestBed } from '@angular/core/testing';
import { Api, ApiError } from '../api';
import { SystemCheckPanel } from '../components/system-check';
import { ShowErrors } from './errors';
import { Toasts } from './toast';

describe('errors people see', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('an engine error carries its code, and its fix is part of the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Every worker is busy or paused.', code: 'no_free_worker', hint: 'Wait for a run to finish.' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const api = TestBed.inject(Api);
    const e = (await api.projects().catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'no_free_worker', hint: 'Wait for a run to finish.', message: 'Every worker is busy or paused. Wait for a run to finish.' });
  });

  it('says so plainly when the engine is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const e = (await TestBed.inject(Api).projects().catch((x) => x)) as ApiError;
    expect(e).toMatchObject({ code: 'engine_unreachable', message: "Maestro's engine isn't answering. Check that it is running (docker compose ps), then try again." });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    expect(((await TestBed.inject(Api).projects().catch((x) => x)) as ApiError).code).toBe('engine_unreachable');
  });

  it('anything nobody caught shows as a toast, once', () => {
    TestBed.configureTestingModule({ providers: [ShowErrors] });
    const toasts = TestBed.inject(Toasts);
    const spy = vi.spyOn(toasts, 'error');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = TestBed.inject(ShowErrors);
    handler.handleError({ rejection: new Error('Saving failed.') });
    handler.handleError(new Error('Saving failed.'));
    handler.handleError('odd');
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['Saving failed.', 'odd']);
  });

  it('the system check lists problems first, with their fixes', async () => {
    const systemChecks = vi.fn().mockResolvedValue([
      { id: 'git', label: 'git', level: 'ok', message: 'git version 2.43' },
      { id: 'workers', label: 'Workers', level: 'warning', message: 'There are no workers.', hint: 'Add one on the Workers page.' },
      { id: 'database', label: 'Database', level: 'error', message: 'The database is damaged.', hint: 'Restore a backup.' },
    ]);
    await TestBed.configureTestingModule({ imports: [SystemCheckPanel], providers: [{ provide: Api, useValue: { systemChecks } }] }).compileComponents();
    const f = TestBed.createComponent(SystemCheckPanel);
    await new Promise((r) => setTimeout(r));
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.sc-head .hint')?.textContent).toBe('2 to look at');
    expect([...el.querySelectorAll('.sc-list li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'DatabaseThe database is damaged.Restore a backup.', 'WorkersThere are no workers.Add one on the Workers page.',
    ]);
  });
});
