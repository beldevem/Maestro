import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api, ApiError } from '../api';
import { Toasts } from '../ui/toast';
import { SettingsPage } from './settings';

const secrets = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', help: '', set: false },
  { name: 'GITHUB_TOKEN', label: 'GitHub token', help: '', set: true },
];
const settings = () => Promise.resolve({
  settings: { maxConcurrentRuns: '3', 'budget.perRunTokens': '2000000', 'budget.projectDailyTokens': '20000000', 'budget.perRunEur': '0', 'budget.projectDailyEur': '0', 'budget.userDailyTokens': '0', 'currency.eurPerUsd': '0.9', 'worktrees.keepDays': '3', 'model.worker': 'claude-sonnet-5-5' },
  secrets, secretsBackend: 'file' as const,
});

const providersInfo = {
  providers: [
    { id: 'claude', name: 'Claude', kind: 'claude', baseUrl: '', apiKeySecret: 'ANTHROPIC_API_KEY', structuredOutput: 'json_schema', prices: {}, keySet: false, claudeLogin: { found: true, valid: false, message: 'The Claude Code login has expired.' }, warnings: [] },
    { id: 'ollama', name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', apiKeySecret: '', structuredOutput: 'json_schema', prices: {}, keySet: false, warnings: [] },
  ],
  roles: { worker: { provider: 'ollama', model: 'qwen3-coder:30b' }, reviewer: { provider: 'ollama', model: 'qwen3-coder:30b' }, planner: { provider: 'claude', model: '' }, assistant: { provider: 'claude', model: '' } },
  presets: { openai: [], cli: [], claudeModels: [] },
  inDocker: true,
};
const providers = () => Promise.resolve(providersInfo);

async function mount(api: Partial<Api>) {
  await TestBed.configureTestingModule({ imports: [SettingsPage], providers: [provideRouter([]), { provide: Api, useValue: { settings, providers, providerModels: () => Promise.resolve([]), ...api } }] }).compileComponents();
  const fixture = TestBed.createComponent(SettingsPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}
const text = (f: { nativeElement: HTMLElement }) => f.nativeElement.textContent ?? '';

describe('SettingsPage', () => {
  it('shows each step with its status', async () => {
    const f = await mount({});
    const heads = [...(f.nativeElement as HTMLElement).querySelectorAll('.step-head')].map((h) => h.textContent?.replace(/\s+/g, ' ').trim());
    expect(heads).toEqual([
      '1 AI providersOllama (local) · Claude: needs attention',
      'Code hosts1 connected',
      '3 PM toolsOptional',
      '4 Design and docsOptional',
      'Workers and limits3 at once · 2M tokens per run',
      '6 NotificationsOff',
    ]);
    expect(text(f)).toContain('2 of 6 steps set up');
    expect(text(f)).not.toContain('Agents run on Claude');
  });

  it('saves only the open step, and validates numbers before sending', async () => {
    const saveSettings = vi.fn().mockResolvedValue({ ok: true });
    const f = await mount({ saveSettings } as Partial<Api>);
    const page = f.componentInstance;
    page.open('limits');
    const limits = page.steps.find((s) => s.id === 'limits')!;
    (page.settings as Record<string, unknown>)['maxConcurrentRuns'] = null;
    expect(page.fieldError(limits.fields[0])).toBe('Enter a number.');
    expect(page.hasErrors(limits)).toBe(true);
    await page.saveFields(limits);
    expect(saveSettings).not.toHaveBeenCalled();

    page.settings['maxConcurrentRuns'] = '0';
    expect(page.fieldError(limits.fields[0])).toBe('At least 1.');
    page.settings['maxConcurrentRuns'] = '2';
    await page.saveFields(limits);
    expect(saveSettings).toHaveBeenCalledWith({ maxConcurrentRuns: '2', 'budget.perRunTokens': '2000000', 'budget.projectDailyTokens': '20000000', 'budget.perRunEur': '0', 'budget.projectDailyEur': '0', 'budget.userDailyTokens': '0', 'currency.eurPerUsd': '0.9', 'worktrees.keepDays': '3' });
  });

  it('shows why the engine refused a save', async () => {
    const saveSettings = vi.fn().mockRejectedValue(new ApiError('budget.perRunTokens must be a number.', 400));
    const f = await mount({ saveSettings } as Partial<Api>);
    const toasts = TestBed.inject(Toasts);
    await f.componentInstance.saveFields(f.componentInstance.steps.find((s) => s.id === 'limits')!);
    expect(toasts.list().map((t) => [t.kind, t.text])).toEqual([['error', 'budget.perRunTokens must be a number.']]);
  });

  it('tests a connection and shows the answer', async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, message: 'Signed in to GitHub as beldevem.' });
    const f = await mount({ testConnection } as Partial<Api>);
    f.componentInstance.open('code');
    f.detectChanges();
    const button = [...(f.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.includes('Test GitHub'))!;
    expect(button.disabled).toBe(false);
    button.click();
    await f.whenStable();
    f.detectChanges();
    expect(testConnection).toHaveBeenCalledWith('github');
    expect(text(f)).toContain('Signed in to GitHub as beldevem.');
    const gitlab = [...(f.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.includes('Test GitLab'))!;
    expect(gitlab.disabled).toBe(true);
  });

  it('shows a failure to load', async () => {
    const f = await mount({ settings: () => Promise.reject(new Error('Engine offline')) } as Partial<Api>);
    expect((f.nativeElement as HTMLElement).querySelector('.error')?.textContent).toContain('Engine offline');
  });
});
