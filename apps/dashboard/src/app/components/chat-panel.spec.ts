import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api } from '../api';
import { Live } from '../live';
import type { ChatThread } from '../models';
import { Confirm } from '../ui/confirm';
import { ChatPanel } from './chat-panel';

const thread = (id: string, over: Partial<ChatThread> = {}): ChatThread => ({ id, title: `Chat ${id}`, projectId: null, model: null, createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z', messages: 2, ...over });

const chatModels = () => Promise.resolve({
  groups: [
    { provider: 'ollama', name: 'Ollama (local)', kind: 'openai', models: ['gpt-oss:20b', 'qwen3-coder:30b'], hint: '', error: '' },
    { provider: 'lm', name: 'LM Studio', kind: 'openai', models: [], hint: '', error: 'LM Studio is unreachable (fetch failed). Is it running?' },
    { provider: 'copilot', name: 'Copilot CLI', kind: 'cli', models: [''], hint: 'Slow for chat, and it may not follow the answer format.', error: '' },
  ],
  current: null,
  default: { provider: 'ollama', model: 'qwen3-coder:30b' },
});

async function mount(api: Partial<Api>) {
  const live = { runs: signal([{ id: 'r1', projectId: 'p1', ticketKey: 'SHO-2', ticketTitle: 'Cart', status: 'in_review', prUrl: 'https://github.com/me/shop/pull/4', error: null }]), refresh: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ChatPanel],
    providers: [provideRouter([]), { provide: Live, useValue: live }, { provide: Api, useValue: {
      chatModels, chatThreads: () => Promise.resolve([]), tickets: () => Promise.resolve([{ key: 'SHO-1', title: 'Checkout', status: 'todo' }]), ...api,
    } }],
  }).compileComponents();
  const f = TestBed.createComponent(ChatPanel);
  f.componentRef.setInput('projects', [{ id: 'p1', name: 'Shop' }]);
  f.detectChanges();
  await f.whenStable();
  return f;
}

describe('ChatPanel', () => {
  it('asks with the project in focus and the attached context', async () => {
    const globalChat = vi.fn().mockResolvedValue({ answer: 'It needs a review.', actions: [], createdAt: '2026-10-12T10:00:00Z', thread: thread('t1', { projectId: 'p1', title: 'What is left?' }) });
    const f = await mount({ globalChat } as Partial<Api>);
    const chat = f.componentInstance;
    chat.setScope('p1');
    await f.whenStable();
    expect(chat.pickOptions().map((o) => o.label)).toEqual(['PR SHO-2 · in review', 'SHO-1 Checkout']);
    chat.addChip(chat.pickOptions()[0]);
    chat.text = 'What is left?';
    await chat.send();
    // The first question starts a conversation with the project in focus.
    expect(globalChat).toHaveBeenCalledWith('About pull request https://github.com/me/shop/pull/4 for SHO-2 "Cart" in Shop (in_review):\nWhat is left?', undefined, 'p1');
    expect(chat.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.chips()).toEqual([]);
    expect(chat.threadId()).toBe('t1');
    expect(chat.threads().map((t) => t.title)).toEqual(['What is left?']);
    await chat.send('And then?');
    expect(globalChat).toHaveBeenLastCalledWith('And then?', 't1', 'p1');
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

describe('ChatPanel model picker', () => {
  it('offers the models by provider, with the default, unreachable providers and hints', async () => {
    const f = await mount({});
    f.detectChanges();
    const select = (f.nativeElement as HTMLElement).querySelector('#chat-model') as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Ollama (local)', 'LM Studio', 'Copilot CLI (Slow for chat, and it may not follow the answer format.)']);
    expect(select.options[0].textContent?.trim()).toBe('Default: Ollama (local) · qwen3-coder:30b');
    expect([...select.options].find((o) => o.disabled)?.textContent).toBe('LM Studio is unreachable (fetch failed). Is it running?');
  });

  it('switches the model for the conversation and labels answers with it', async () => {
    const created = thread('t7', { title: 'New chat', messages: 0, model: { provider: 'ollama', model: 'gpt-oss:20b' } });
    const createChatThread = vi.fn().mockResolvedValue(created);
    const updateChatThread = vi.fn().mockResolvedValue({ ...created, model: null });
    const globalChat = vi.fn().mockResolvedValue({ answer: 'I am gpt-oss:20b.\n\n' + 'x'.repeat(400), actions: [], createdAt: '', model: 'Ollama (local) · gpt-oss:20b', thread: created });
    const f = await mount({ createChatThread, updateChatThread, globalChat } as Partial<Api>);
    // Picking a model for a new conversation creates it, so it keeps that model.
    await f.componentInstance.pickModel('ollama::gpt-oss:20b');
    expect(createChatThread).toHaveBeenCalledWith({ projectId: null, model: { provider: 'ollama', model: 'gpt-oss:20b' } });
    await f.componentInstance.send('which model am I talking with');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.msg-assistant .msg-model')?.textContent).toBe('Ollama (local) · gpt-oss:20b');
    expect(el.querySelector('.msg-assistant .md p')?.textContent).toBe('I am gpt-oss:20b.');
    await f.componentInstance.pickModel('');
    expect(updateChatThread).toHaveBeenLastCalledWith('t7', { model: null });
  });
});

describe('ChatPanel conversations', () => {
  const history = [{ id: 1, role: 'user' as const, content: 'Old question', createdAt: '', actions: [] }];

  it('opens the latest conversation with its focus and model, and starts a new chat', async () => {
    const chatThread = vi.fn().mockResolvedValue({ thread: thread('t2', { projectId: 'p1', model: { provider: 'ollama', model: 'gpt-oss:20b' } }), messages: history });
    const f = await mount({ chatThreads: () => Promise.resolve([thread('t2'), thread('t1')]), chatThread } as Partial<Api>);
    await f.whenStable();
    f.detectChanges();
    const chat = f.componentInstance;
    expect(chatThread).toHaveBeenCalledWith('t2');
    expect(chat.messages()).toHaveLength(1);
    expect(chat.scope()).toBe('p1');
    expect(chat.modelKey()).toBe('ollama::gpt-oss:20b');
    const select = (f.nativeElement as HTMLElement).querySelector('#chat-thread') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent?.trim().split(' · ')[0])).toEqual(['Chat t2', 'Chat t1']);

    (f.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click();
    f.detectChanges();
    expect(chat.threadId()).toBe('');
    expect(chat.messages()).toEqual([]);
    expect(chat.scope()).toBe('');
    expect(select.options[0].textContent?.trim()).toBe('New chat');
  });

  it('renames, and deletes only the current conversation after asking', async () => {
    const chatThread = vi.fn((id: string) => Promise.resolve({ thread: thread(id), messages: history }));
    const updateChatThread = vi.fn().mockResolvedValue(thread('t2', { title: 'Release plan' }));
    const deleteChatThread = vi.fn().mockResolvedValue({});
    const ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    TestBed.overrideProvider(Confirm, { useValue: { ask } });
    const f = await mount({ chatThreads: () => Promise.resolve([thread('t2'), thread('t1')]), chatThread, updateChatThread, deleteChatThread } as Partial<Api>);
    await f.whenStable();
    const chat = f.componentInstance;

    chat.startRename();
    expect(chat.titleText).toBe('Chat t2');
    chat.titleText = 'Release plan';
    await chat.saveTitle();
    expect(updateChatThread).toHaveBeenCalledWith('t2', { title: 'Release plan' });
    expect(chat.threads()[0].title).toBe('Release plan');

    await chat.deleteThread();
    expect(deleteChatThread).not.toHaveBeenCalled();
    await chat.deleteThread();
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Delete “Release plan”?' }));
    expect(deleteChatThread).toHaveBeenCalledWith('t2');
    expect(chat.threads().map((t) => t.id)).toEqual(['t1']);
    expect(chat.threadId()).toBe('t1');
  });

  it('offers minimize and close only where the page asks for them', async () => {
    const f = await mount({});
    const el = f.nativeElement as HTMLElement;
    f.detectChanges();
    expect(el.querySelector('[aria-label="Minimize the chat"]')).toBeNull();
    f.componentRef.setInput('canMinimize', true);
    f.componentRef.setInput('canClose', true);
    f.detectChanges();
    const minimized = vi.fn();
    const closed = vi.fn();
    f.componentInstance.minimize.subscribe(minimized);
    f.componentInstance.closed.subscribe(closed);
    const min = el.querySelector<HTMLButtonElement>('[aria-label="Minimize the chat"]')!;
    expect(min.getAttribute('aria-expanded')).toBe('true');
    min.click();
    el.querySelector<HTMLButtonElement>('[aria-label="Close the chat"]')!.click();
    expect(minimized).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
