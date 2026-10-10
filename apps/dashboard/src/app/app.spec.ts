import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { Live } from './live';

describe('App', () => {
  it('renders the navigation and starts live updates', async () => {
    const live = { start: vi.fn(), connected: () => false, agents: () => [], runs: () => [], alerts: () => [], unread: () => 2 };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), { provide: Live, useValue: live }],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.brand')?.textContent).toContain('Maestro');
    expect(el.textContent).toContain('Engine offline');
    expect([...el.querySelectorAll('.nav a')].map((a) => a.textContent?.trim())).toEqual(['Agents', 'Projects', 'Pull requests', 'Alerts 2', 'Settings']);
    expect(el.querySelector('.badge')?.textContent).toBe('2');
    expect(live.start).toHaveBeenCalled();
  });
});
