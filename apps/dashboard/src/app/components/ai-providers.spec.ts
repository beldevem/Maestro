import { TestBed } from '@angular/core/testing';
import { Api } from '../api';
import type { ProvidersInfo } from '../models';
import { AiProviders, providerStatus, slug } from './ai-providers';

const info = (): ProvidersInfo => ({
  providers: [
    { id: 'claude', name: 'Claude', kind: 'claude', baseUrl: '', apiKeySecret: 'ANTHROPIC_API_KEY', structuredOutput: 'json_schema', prices: {}, keySet: false, claudeLogin: { found: true, valid: true, message: 'Claude Code login is active.' }, warnings: [] },
  ],
  roles: { worker: { provider: 'claude', model: '' }, reviewer: { provider: 'claude', model: '' }, planner: { provider: 'claude', model: '' }, assistant: { provider: 'claude', model: '' } },
  presets: {
    openai: [
      { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', dockerBaseUrl: 'http://host.docker.internal:11434/v1', needsKey: false, keyHint: 'No key needed.', structuredOutput: 'json_schema' },
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyHint: 'An API key.', structuredOutput: 'json_schema' },
    ],
    cli: [{ id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', args: ['-p', '{prompt}', '--allow-all-tools'], modelArgs: ['--model', '{model}'], install: 'npm install -g @github/copilot', auth: 'Sign in.', installed: false }],
    claudeModels: ['claude-opus-5-5'],
  },
  inDocker: false,
});

async function mount(api: Partial<Api>) {
  await TestBed.configureTestingModule({ imports: [AiProviders], providers: [{ provide: Api, useValue: { providers: () => Promise.resolve(info()), providerModels: () => Promise.resolve([]), ...api } }] }).compileComponents();
  const f = TestBed.createComponent(AiProviders);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return f;
}

describe('AI providers settings', () => {
  it('adds an Ollama provider from its preset, saving the key in the secret store', async () => {
    const saveProvider = vi.fn().mockResolvedValue({});
    const setSecret = vi.fn().mockResolvedValue({});
    const f = await mount({ saveProvider, setSecret } as Partial<Api>);
    const c = f.componentInstance;
    c.startAdd();
    expect(c.draft()).toMatchObject({ kind: 'openai', preset: 'ollama', id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' });
    await c.save();
    expect(setSecret).not.toHaveBeenCalled();
    expect(saveProvider).toHaveBeenCalledWith({ id: 'ollama', name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', apiKeySecret: '', structuredOutput: 'json_schema', prices: {} });

    c.startAdd();
    c.applyPreset('openai');
    c.draft.update((d) => ({ ...d!, apiKey: 'sk-test', priceIn: 2, priceOut: 8 }));
    await c.save();
    expect(setSecret).toHaveBeenCalledWith('PROVIDER_OPENAI_API_KEY', 'sk-test');
    expect(saveProvider).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'openai', apiKeySecret: 'PROVIDER_OPENAI_API_KEY', prices: { '*': { input: 2, output: 8 } } }));
  });

  it('sets up a coding CLI from its preset and says when it is not installed', async () => {
    const saveProvider = vi.fn().mockResolvedValue({});
    const f = await mount({ saveProvider } as Partial<Api>);
    const c = f.componentInstance;
    c.startAdd();
    c.setKind('cli');
    f.detectChanges();
    expect(c.draft()).toMatchObject({ kind: 'cli', command: 'copilot', args: '-p\n{prompt}\n--allow-all-tools' });
    expect((f.nativeElement as HTMLElement).textContent).toContain('copilot is not installed where Maestro runs. Install: npm install -g @github/copilot');
    await c.save();
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cli', cli: { preset: 'copilot', command: 'copilot', args: ['-p', '{prompt}', '--allow-all-tools'], modelArgs: ['--model', '{model}'], timeoutMinutes: 30 } }));
  });

  it('validates the form before saving', async () => {
    const saveProvider = vi.fn();
    const f = await mount({ saveProvider } as Partial<Api>);
    const c = f.componentInstance;
    c.startAdd();
    c.draft.update((d) => ({ ...d!, baseUrl: 'localhost:11434' }));
    await c.save();
    expect(c.formError()).toBe('The base URL must start with http:// or https://.');
    c.draft.update((d) => ({ ...d!, baseUrl: 'http://x/v1', id: 'claude' }));
    await c.save();
    expect(c.formError()).toBe('A provider with this ID exists.');
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it('saves which provider and model each role uses, and warns about missing models', async () => {
    const saveRoles = vi.fn().mockResolvedValue({});
    const f = await mount({ saveRoles } as Partial<Api>);
    const c = f.componentInstance;
    c.info.update((i) => ({ ...i!, providers: [...i!.providers, { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://x/v1', apiKeySecret: '', structuredOutput: 'json_schema', prices: {}, keySet: false, warnings: [] }] }));
    c.choices.worker = { provider: 'ollama', model: '' };
    expect(c.roleWarnings()).toEqual(['Workers: choose a model for Ollama.']);
    c.choices.worker.model = 'qwen3-coder:30b';
    await c.saveRoles();
    expect(saveRoles).toHaveBeenCalledWith(expect.objectContaining({ worker: { provider: 'ollama', model: 'qwen3-coder:30b' }, reviewer: { provider: 'claude', model: '' } }));
  });

  it('summarises whether a provider can run', () => {
    const base = { baseUrl: '', apiKeySecret: '', structuredOutput: 'json_schema' as const, prices: {}, keySet: false, warnings: [] };
    expect(providerStatus({ ...base, id: 'c', name: 'C', kind: 'claude', claudeLogin: { found: true, valid: false, message: 'expired' } })).toEqual({ ok: false, text: 'expired' });
    expect(providerStatus({ ...base, id: 'c', name: 'C', kind: 'claude', keySet: true })).toEqual({ ok: true, text: 'API key saved' });
    expect(providerStatus({ ...base, id: 'o', name: 'O', kind: 'openai', baseUrl: 'http://x/v1', apiKeySecret: 'K' })).toEqual({ ok: false, text: 'No API key saved' });
    expect(providerStatus({ ...base, id: 'x', name: 'X', kind: 'cli', installed: false, cli: { preset: 'copilot', command: 'copilot', args: [], modelArgs: [], timeoutMinutes: 30 } }).ok).toBe(false);
    expect(slug('GitHub Models (EU)')).toBe('github-models-eu');
  });
});
