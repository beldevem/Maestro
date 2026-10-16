import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Api } from '../api';
import type { DirListing } from '../models';
import { ConnectorFields, emptyConnectors } from '../pages/connector-fields';
import { FolderPicker } from './folder-picker';

const root: DirListing = {
  path: '/home/me/projects', parent: null, roots: ['/home/me/projects'], crumbs: [{ name: '/home/me/projects', path: '/home/me/projects' }],
  dirs: [
    { name: 'blog', path: '/home/me/projects/blog', isGitRepo: false, hasPackageJson: true, hidden: false },
    { name: 'shop', path: '/home/me/projects/shop', isGitRepo: true, hasPackageJson: true, hidden: false },
  ],
  isGitRepo: false, branch: null, truncated: false,
};
const shop: DirListing = { ...root, path: '/home/me/projects/shop', parent: '/home/me/projects', crumbs: [...root.crumbs, { name: 'shop', path: '/home/me/projects/shop' }], dirs: [], isGitRepo: true, branch: 'develop' };

const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r));
    f.detectChanges();
    await f.whenStable();
  }
};

describe('FolderPicker', () => {
  it('browses folders with git badges, filters, opens on Enter and selects', async () => {
    const fsDirs = vi.fn((path?: string) => Promise.resolve(path === '/home/me/projects/shop' ? shop : root));
    const fsCheck = vi.fn().mockResolvedValue({ path: '/home/me/projects/shop', isGitRepo: true, branch: 'develop' });
    await TestBed.configureTestingModule({ imports: [FolderPicker], providers: [{ provide: Api, useValue: { fsDirs, fsCheck } }] }).compileComponents();
    const f = TestBed.createComponent(FolderPicker);
    const chosen = vi.fn();
    f.componentInstance.chosen.subscribe(chosen);
    await settle(f);
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    const names = () => [...el.querySelectorAll('.fp-name')].map((n) => n.textContent);
    expect(names()).toEqual(['blog', 'shop']);
    expect(el.querySelector('.fp-item:nth-child(1)')).toBeTruthy();
    expect([...el.querySelectorAll('.pill-git')]).toHaveLength(1);

    f.componentInstance.filter.set('sh');
    f.detectChanges();
    expect(names()).toEqual(['shop']);

    el.querySelector<HTMLButtonElement>('.fp-item')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(f);
    expect(fsDirs).toHaveBeenLastCalledWith('/home/me/projects/shop', false);
    expect(el.querySelector('.fp-choice code')?.textContent).toBe('/home/me/projects/shop');
    expect(el.querySelector('[aria-label="Up one folder"]')?.hasAttribute('disabled')).toBe(false);

    el.querySelector<HTMLButtonElement>('.fp-actions .primary')!.click();
    await settle(f);
    expect(fsCheck).toHaveBeenCalledWith('/home/me/projects/shop');
    expect(chosen).toHaveBeenCalledWith({ path: '/home/me/projects/shop', isGitRepo: true, branch: 'develop' });
  });

  it('shows why a folder cannot be opened', async () => {
    const fsDirs = vi.fn((path?: string) => (path ? Promise.reject(new Error('/etc is outside the folders Maestro can see')) : Promise.resolve(root)));
    await TestBed.configureTestingModule({ imports: [FolderPicker], providers: [{ provide: Api, useValue: { fsDirs, fsCheck: vi.fn() } }] }).compileComponents();
    const f = TestBed.createComponent(FolderPicker);
    await settle(f);
    await f.componentInstance.go('/etc');
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent).toContain('outside the folders Maestro can see');
  });
});

@Component({ imports: [ConnectorFields], template: `<form><app-connector-fields [model]="m" only="codeHost" /></form>` })
class Host {
  m = emptyConnectors();
  readonly unused = signal(0);
}

describe('Local folder field', () => {
  it('fills the path and branch from the picker, keeps typing possible, and warns when it is not a git repository', async () => {
    const fsCheck = vi.fn().mockResolvedValue({ path: '/home/me/projects/blog', isGitRepo: false, branch: null });
    await TestBed.configureTestingModule({ imports: [Host], providers: [{ provide: Api, useValue: { fsDirs: () => Promise.resolve(root), fsCheck } }] }).compileComponents();
    const f = TestBed.createComponent(Host);
    f.componentInstance.m.codeHost.provider = 'local';
    await settle(f);
    const el: HTMLElement = f.nativeElement;
    const field = el.querySelector<HTMLInputElement>('input[name="ch-path"]')!;
    expect(field.readOnly).toBe(false);
    el.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
    await settle(f);
    expect(el.querySelector('app-folder-picker')).not.toBeNull();

    const fields = f.debugElement.query((d) => d.componentInstance instanceof ConnectorFields).componentInstance as ConnectorFields;
    fields.picked(f.componentInstance.m, { path: '/home/me/projects/shop', isGitRepo: true, branch: 'develop' });
    await settle(f);
    expect(f.componentInstance.m.codeHost).toMatchObject({ localPath: '/home/me/projects/shop', defaultBranch: 'develop' });
    expect(el.querySelector('app-folder-picker')).toBeNull();
    expect(el.querySelector('#ch-path-note')).toBeNull();

    await fields.check('/home/me/projects/blog');
    f.detectChanges();
    expect(el.querySelector('#ch-path-note')?.textContent).toContain('isn\'t a git repository yet. Run "git init"');
  });
});
