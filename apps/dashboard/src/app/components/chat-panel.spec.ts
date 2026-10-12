import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import { ChatPanel } from './chat-panel';

async function mount(api: Partial<Api>) {
  const live = { runs: signal([{ id: 'r1', projectId: 'p1', ticketKey: 'SHO-2', ticketTitle: 'Cart', status: 'in_review', prUrl: 'https://github.com/me/shop/pull/4', error: null }]), refresh: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ChatPanel],
    providers: [provideRouter([]), { provide: Live, useValue: live }, { provide: Api, useValue: { globalChatHistory: () => Promise.resolve([]), tickets: () => Promise.resolve([{ key: 'SHO-1', title: 'Checkout', status: 'todo' }]), ...api } }],
  }).compileComponents();
  const f = TestBed.createComponent(ChatPanel);
  f.componentRef.setInput('projects', [{ id: 'p1', name: 'Shop' }]);
  f.detectChanges();
  await f.whenStable();
  return f;
}

describe('ChatPanel', () => {
  it('asks with the project in focus and the attached context', async () => {
    const globalChat = vi.fn().mockResolvedValue({ answer: 'It needs a review.', actions: [], createdAt: '2026-10-12T10:00:00Z' });
    const f = await mount({ globalChat } as Partial<Api>);
    const chat = f.componentInstance;
    chat.setScope('p1');
    await f.whenStable();
    expect(chat.pickOptions().map((o) => o.label)).toEqual(['PR SHO-2 · in review', 'SHO-1 Checkout']);
    chat.addChip(chat.pickOptions()[0]);
    chat.text = 'What is left?';
    await chat.send();
    expect(globalChat).toHaveBeenCalledWith('About pull request https://github.com/me/shop/pull/4 for SHO-2 "Cart" in Shop (in_review):\nWhat is left?', 'p1');
    expect(chat.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.chips()).toEqual([]);
  });

  it('runs a proposal only when you confirm it', async () => {
    const globalChat = vi.fn().mockResolvedValue({ answer: 'Shall I?', createdAt: '', actions: [{ id: 'x1', type: 'assign', summary: 'Shop: Assign SHO-1 to a free worker', state: 'pending' }] });
    const confirmGlobalAction = vi.fn().mockResolvedValue({ message: 'SHO-1 is assigned to Worker 1.', runId: 'r9' });
    const f = await mount({ globalChat, confirmGlobalAction } as Partial<Api>);
    await f.componentInstance.send('Assign SHO-1');
    expect(confirmGlobalAction).not.toHaveBeenCalled();
    await f.componentInstance.confirm(f.componentInstance.messages()[1].actions![0]);
    expect(confirmGlobalAction).toHaveBeenCalledWith('x1');
    expect(f.componentInstance.messages()[1].actions![0]).toMatchObject({ state: 'done', result: 'SHO-1 is assigned to Worker 1.', runId: 'r9' });
  });
});
