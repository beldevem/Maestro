import { TestBed } from '@angular/core/testing';
import { Api, ApiError } from '../api';
import { SettingsPage } from './settings';

describe('SettingsPage', () => {
  async function mount(api: Partial<Api>) {
    await TestBed.configureTestingModule({ imports: [SettingsPage], providers: [{ provide: Api, useValue: api }] }).compileComponents();
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }
  const settings = () => Promise.resolve({ settings: { maxConcurrentRuns: '3', 'budget.perRunUsd': '5' }, secrets: [], secretsBackend: 'file' as const });

  it('sends an emptied number field as "" and shows why it was refused', async () => {
    const saveSettings = vi.fn().mockRejectedValue(new ApiError('maxConcurrentRuns must be a number.', 400));
    const fixture = await mount({ settings, saveSettings } as Partial<Api>);
    (fixture.componentInstance.settings as Record<string, unknown>)['maxConcurrentRuns'] = null;
    await fixture.componentInstance.save();
    fixture.detectChanges();
    expect(saveSettings).toHaveBeenCalledWith({ maxConcurrentRuns: '', 'budget.perRunUsd': '5' });
    expect((fixture.nativeElement as HTMLElement).querySelector('.error')?.textContent).toBe('maxConcurrentRuns must be a number.');
  });

  it('shows a failure to load instead of failing silently', async () => {
    const fixture = await mount({ settings: () => Promise.reject(new Error('Engine offline')) } as Partial<Api>);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.error')?.textContent).toBe('Engine offline');
  });
});
