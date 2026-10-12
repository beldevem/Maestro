import { TestBed } from '@angular/core/testing';
import { Api } from '../api';
import type { BacklogDraft, BacklogItem } from '../models';
import { BacklogDraftPanel } from './backlog-draft';

const item = (title: string, dependsOn: number[] = []): BacklogItem => ({ title, description: '', acceptanceCriteria: '- ok', size: 'S', labels: [], dependsOn });
const draft = (over: Partial<BacklogDraft> = {}): BacklogDraft => ({
  id: 'd1', projectId: 'p1', status: 'draft', createdKeys: [], error: null, costUsd: 0.12, usage: { input: 30_000, output: 2_000, cache: 0 }, createdAt: '', approvedAt: null,
  items: [item('A'), item('B', [0]), item('C', [0, 1]), item('D', [2])], ...over,
});

async function mount(d: BacklogDraft, api: Partial<Api> = {}) {
  await TestBed.configureTestingModule({ imports: [BacklogDraftPanel], providers: [{ provide: Api, useValue: api }] }).compileComponents();
  const fixture = TestBed.createComponent(BacklogDraftPanel);
  fixture.componentRef.setInput('draft', d);
  fixture.componentRef.setInput('pmName', 'Jira');
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

describe('BacklogDraftPanel', () => {
  it('removing an item drops dependencies on it and shifts later ones down', async () => {
    const fixture = await mount(draft());
    fixture.componentInstance.remove(1);
    expect(fixture.componentInstance.items().map((i) => [i.title, i.dependsOn])).toEqual([['A', []], ['C', [0]], ['D', [1]]]);
  });

  it('saves your edits before creating the tickets, and reports what was created', async () => {
    const updateDraft = vi.fn().mockResolvedValue(draft());
    const approveDraft = vi.fn().mockResolvedValue({ draft: draft({ status: 'approved' }), created: [{ key: 'APP-1' }], error: null });
    const fixture = await mount(draft(), { updateDraft, approveDraft } as Partial<Api>);
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);

    fixture.componentInstance.remove(3);
    await fixture.componentInstance.approve();
    expect(updateDraft).toHaveBeenCalledWith('d1', expect.arrayContaining([expect.objectContaining({ title: 'A' })]));
    expect(updateDraft.mock.calls[0][1]).toHaveLength(3);
    expect(approveDraft).toHaveBeenCalledWith('d1');
    expect(done).toHaveBeenCalledWith(null);

    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Create 3 tickets in Jira');
  });

  it('locks a draft that was partly created and only finishes it', async () => {
    const approveDraft = vi.fn().mockResolvedValue({ draft: draft(), created: [], error: 'Stopped at "C": down' });
    const updateDraft = vi.fn();
    const fixture = await mount(draft({ createdKeys: ['APP-1', 'APP-2', null, null], error: 'Stopped at "C": down' }), { approveDraft, updateDraft } as Partial<Api>);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('2 of 4 tickets were already created');
    expect(el.textContent).toContain('Create 2 tickets in Jira');
    expect(el.querySelectorAll('input[disabled]').length).toBeGreaterThan(0);
    fixture.componentInstance.touch();
    await fixture.componentInstance.approve();
    expect(updateDraft).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toBe('0 created. Stopped at "C": down');
  });
});
