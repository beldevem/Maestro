import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Api } from '../api';
import { ModelSelect } from './model-select';

const lists: Record<string, string[] | Error> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  ollama: ['qwen3-coder:30b', 'gpt-oss:20b'],
  down: new Error('fetch failed'),
};

@Component({
  imports: [ModelSelect],
  template: `<app-model-select [provider]="provider()" [(value)]="value" [defaultLabel]="defaultLabel()" label="Worker model" />`,
})
class Host {
  readonly provider = signal('claude');
  value = '';
  readonly defaultLabel = signal('Recommended');
}

async function mount(setup?: (h: Host) => void) {
  const providerModels = vi.fn((id: string) => {
    const l = lists[id];
    return l instanceof Error ? Promise.reject(l) : Promise.resolve(l ?? []);
  });
  await TestBed.configureTestingModule({ imports: [Host], providers: [{ provide: Api, useValue: { providerModels } }] }).compileComponents();
  const f = TestBed.createComponent(Host);
  setup?.(f.componentInstance);
  await settle(f);
  return { f, providerModels };
}

async function settle(f: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 3; i++) {
    f.detectChanges();
    await f.whenStable();
  }
}

const select = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelector('select') as HTMLSelectElement;
const options = (f: { nativeElement: HTMLElement }) => [...select(f).options].map((o) => o.textContent!.trim());

describe('ModelSelect', () => {
  it("offers the provider's models as a dropdown, plus a default and Other", async () => {
    const { f } = await mount();
    expect(options(f)).toEqual(['Recommended', 'claude-opus-5-5', 'claude-sonnet-5-5', 'Other model…']);
    expect(f.nativeElement.querySelector('input')).toBeNull();
  });

  it('resets a model that the new provider does not offer', async () => {
    const { f } = await mount((h) => (h.value = 'claude-opus-5-5'));
    f.componentInstance.defaultLabel.set('');
    f.componentInstance.provider.set('ollama');
    await settle(f);
    expect(f.componentInstance.value).toBe('qwen3-coder:30b');
    expect(options(f)).toEqual(['qwen3-coder:30b', 'gpt-oss:20b', 'Other model…']);
  });

  it('resets to the default when the provider has one', async () => {
    const { f } = await mount((h) => (h.value = 'claude-opus-5-5'));
    f.componentInstance.provider.set('ollama');
    await settle(f);
    expect(f.componentInstance.value).toBe('');
  });

  it('keeps a saved model the provider no longer lists, marked as such', async () => {
    const { f } = await mount((h) => (h.value = 'claude-old'));
    expect(options(f)).toContain('claude-old (not listed)');
    expect(f.componentInstance.value).toBe('claude-old');
  });

  it('shows a text box only after "Other model…" is picked', async () => {
    const { f } = await mount();
    const s = select(f);
    s.value = s.options[s.options.length - 1].value;
    s.dispatchEvent(new Event('change'));
    await settle(f);
    const input = f.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = ' my-model ';
    input.dispatchEvent(new Event('input'));
    await settle(f);
    expect(f.componentInstance.value).toBe('my-model');
  });

  it('shows the error with a retry that asks the provider again', async () => {
    const { f, providerModels } = await mount((h) => h.provider.set('down'));
    expect(f.nativeElement.textContent).toContain("Couldn't list models: fetch failed");
    lists['down'] = ['llama3'];
    (f.nativeElement.querySelector('.link-btn') as HTMLButtonElement).click();
    await settle(f);
    expect(providerModels).toHaveBeenCalledTimes(2);
    expect(options(f)).toContain('llama3');
    expect(f.nativeElement.textContent).not.toContain("Couldn't list models");
  });
});
