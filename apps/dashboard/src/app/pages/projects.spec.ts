import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Api } from '../api';
import { Confirm } from '../ui/confirm';
import { deletionDetails, ProjectsPage } from './projects';

async function mount(api: Partial<Api>) {
  await TestBed.configureTestingModule({
    imports: [ProjectsPage],
    providers: [provideRouter([]), { provide: Api, useValue: { projects: () => Promise.resolve([]), spend: () => Promise.resolve([]), templates: () => Promise.resolve([{ id: 'angular', name: 'Angular app', description: 'SPA.', bestPractices: '', gates: [{ name: 'test', run: 'ng test' }] }]), ...api } }],
  }).compileComponents();
  const f = TestBed.createComponent(ProjectsPage);
  f.detectChanges();
  await f.whenStable();
  return f;
}

describe('New project wizard', () => {
  it('needs a name, then a repository, before going on', async () => {
    const f = await mount({});
    const page = f.componentInstance;
    page.startWizard();
    await page.next();
    expect(page.step()).toBe('basics');
    expect(page.stepError()).toBe('Give the project a name.');
    page.draft.name = 'Shop';
    await page.next();
    expect(page.step()).toBe('code');
    page.draft.codeHost.provider = 'local';
    await page.next();
    expect(page.step()).toBe('code');
    expect(page.codeError()).toBe('Enter the folder path of the local repository.');
    page.draft.codeHost.localPath = '/home/me/projects/shop';
    await page.next();
    expect(page.step()).toBe('tickets');
    page.goTo('review');
    expect(page.step()).toBe('review');
  });

  it('creates the project with its template and opens it', async () => {
    const createProject = vi.fn().mockResolvedValue({ id: 'p9', name: 'Shop' });
    const f = await mount({ createProject } as Partial<Api>);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const page = f.componentInstance;
    page.startWizard();
    Object.assign(page.draft, { name: ' Shop ', template: 'angular' });
    page.draft.codeHost = { provider: 'github', repo: 'me/shop', defaultBranch: 'main' };
    page.step.set('review');
    await page.next();
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'Shop', template: 'angular', codeHost: { provider: 'github', repo: 'me/shop', defaultBranch: 'main' } }));
    expect(navigate).toHaveBeenCalledWith(['/projects', 'p9'], { queryParams: { tab: 'knowledge' } });
  });

  it('says what deleting removes and what it leaves alone', () => {
    expect(deletionDetails({ pm: { provider: 'jira', settings: {} } })).toEqual([
      'Its runs, their logs and reviews, alerts, spend records, backlog drafts and chat',
      'Not touched: the repository and its branches, and the tickets in Jira',
    ]);
    expect(deletionDetails({ pm: { provider: 'manual', settings: {} } })[1]).toBe('The tickets kept in Maestro for it');
  });

  it('deletes a project only after you confirm', async () => {
    const project = { id: 'p1', name: 'Shop', pm: { provider: 'manual', settings: {} } };
    const deleteProject = vi.fn().mockResolvedValue({ ok: true });
    const f = await mount({ projects: () => Promise.resolve([project]), deleteProject } as unknown as Partial<Api>);
    const asked = f.componentInstance.remove(project as never);
    const confirm = TestBed.inject(Confirm);
    expect(confirm.current()?.details).toContain('The tickets kept in Maestro for it');
    confirm.answer(true);
    await asked;
    expect(deleteProject).toHaveBeenCalledWith('p1');
    expect(f.componentInstance.projects()).toEqual([]);
  });
});
