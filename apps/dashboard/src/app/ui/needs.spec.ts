import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Rights } from '../rights';
import { Needs } from './needs';

@Component({ imports: [Needs], template: `<button appNeeds="run.start" (click)="clicked = clicked + 1">Assign</button><button appNeeds="ticket.edit" (click)="clicked = clicked + 10">New ticket</button>` })
class Host {
  clicked = 0;
}

describe('appNeeds', () => {
  it('makes what your role can’t do inert, and says which role is needed', async () => {
    const actions = signal(new Set(['ticket.edit', 'chat.ask']));
    const rights = { actions, can: (a: string) => actions().has(a), why: (a: string) => (actions().has(a) ? '' : a === 'run.start' ? 'Needs the Tech Lead or Developer role' : '') };
    await TestBed.configureTestingModule({ imports: [Host], providers: [{ provide: Rights, useValue: rights }] }).compileComponents();
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const [assign, ticket] = [...(f.nativeElement as HTMLElement).querySelectorAll('button')];
    expect(assign.classList.contains('denied')).toBe(true);
    expect(assign.getAttribute('aria-disabled')).toBe('true');
    expect(assign.getAttribute('title')).toBe('Needs the Tech Lead or Developer role');
    assign.click();
    expect(f.componentInstance.clicked).toBe(0);
    expect(ticket.classList.contains('denied')).toBe(false);
    ticket.click();
    expect(f.componentInstance.clicked).toBe(10);
  });
});
