import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { Live } from './live';

describe('App', () => {
  it('renders the navigation and starts live updates', async () => {
    const live = { start: vi.fn(), connected: () => false, agents: () => [], runs: () => [] };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), { provide: Live, useValue: live }],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.brand')?.textContent).toContain('Maestro');
    expect(el.textContent).toContain('Engine offline');
    expect(live.start).toHaveBeenCalled();
  });
});
