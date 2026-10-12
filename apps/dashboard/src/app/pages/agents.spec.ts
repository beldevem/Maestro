import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api, ApiError } from '../api';
import { Live } from '../live';
import type { Agent } from '../models';
import { Confirm } from '../ui/confirm';
import { Toasts } from '../ui/toast';
import { AgentsPage } from './agents';

const agent = (over: Partial<Agent>): Agent => ({ id: 'a1', name: 'Worker 1', role: 'worker', provider: '', model: '', state: 'available', currentRunId: null, note: '', ...over });

async function mount(api: Partial<Api>, agents: Agent[]) {
  const live = { agents: signal(agents), runs: signal([]), refresh: vi.fn().mockResolvedValue(undefined) };
  await TestBed.configureTestingModule({
    imports: [AgentsPage],
    providers: [provideRouter([]), { provide: Api, useValue: api }, { provide: Live, useValue: live }],
  }).compileComponents();
  const f = TestBed.createComponent(AgentsPage);
  f.detectChanges();
  return { f, live };
}

describe('AgentsPage', () => {
  it('renames a worker and changes its model', async () => {
    const updateAgent = vi.fn().mockResolvedValue(agent({ name: 'Ada' }));
    const { f, live } = await mount({ updateAgent } as Partial<Api>, [agent({})]);
    f.componentInstance.startEdit(agent({}));
    f.componentInstance.edit = { name: ' Ada ', provider: 'ollama', model: 'qwen3-coder:30b' };
    await f.componentInstance.save(agent({}));
    expect(updateAgent).toHaveBeenCalledWith('a1', { name: 'Ada', provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(live.refresh).toHaveBeenCalled();
    expect(f.componentInstance.editing()).toBe('');
  });

  it('asks before deleting, and does nothing when you cancel', async () => {
    const deleteAgent = vi.fn().mockResolvedValue({ ok: true });
    const { f } = await mount({ deleteAgent } as Partial<Api>, [agent({})]);
    const confirm = TestBed.inject(Confirm);
    const asked = f.componentInstance.remove(agent({}));
    expect(confirm.current()?.title).toBe('Delete Worker 1?');
    confirm.answer(false);
    await asked;
    expect(deleteAgent).not.toHaveBeenCalled();

    const again = f.componentInstance.remove(agent({}));
    confirm.answer(true);
    await again;
    expect(deleteAgent).toHaveBeenCalledWith('a1');
  });

  it('shows the engine refusing to delete a busy worker', async () => {
    const deleteAgent = vi.fn().mockRejectedValue(new ApiError('Worker 1 is working on a ticket; stop its run before deleting it.', 409));
    const { f } = await mount({ deleteAgent } as Partial<Api>, [agent({})]);
    const confirm = TestBed.inject(Confirm);
    const asked = f.componentInstance.remove(agent({}));
    confirm.answer(true);
    await asked;
    expect(TestBed.inject(Toasts).list()[0]).toMatchObject({ kind: 'error', text: 'Worker 1 is working on a ticket; stop its run before deleting it.' });
  });

  it('disables delete while a worker is busy', async () => {
    const { f } = await mount({} as Partial<Api>, [agent({ state: 'working', currentRunId: 'r1' })]);
    const del = (f.nativeElement as HTMLElement).querySelector('button[aria-label="Delete Worker 1"]') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toBe('Stop its run before deleting it');
  });
});
