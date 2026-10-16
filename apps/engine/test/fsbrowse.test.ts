import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { Store } from '../src/db.js';
import { browseRoots, checkFolder, listDirs } from '../src/fsbrowse.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

function tree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'maestro-fs-')));
  const root = join(base, 'projects');
  const outside = join(base, 'secret');
  for (const d of [root, join(root, 'shop', '.git'), join(root, 'blog'), join(root, '.cache'), join(root, 'Zeta'), join(root, 'app10'), join(root, 'app9'), outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'shop', '.git', 'HEAD'), 'ref: refs/heads/develop\n');
  writeFileSync(join(root, 'blog', 'package.json'), '{}');
  writeFileSync(join(root, 'notes.txt'), 'a file, never listed');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(root, 'blog'), join(root, 'blog-link'));
  return { base, root, outside };
}

describe('folder picker', () => {
  it('lists subfolders only, sorted naturally, with git and package hints and the branch', () => {
    const { root } = tree();
    const l = listDirs(root, { roots: [root] });
    expect(l.dirs.map((d) => d.name)).toEqual(['app9', 'app10', 'blog', 'blog-link', 'shop', 'Zeta']);
    expect(l.dirs.find((d) => d.name === 'shop')).toMatchObject({ isGitRepo: true, hasPackageJson: false });
    expect(l.dirs.find((d) => d.name === 'blog')).toMatchObject({ isGitRepo: false, hasPackageJson: true });
    expect(l).toMatchObject({ path: root, parent: null, crumbs: [{ name: root, path: root }], isGitRepo: false });
    expect(listDirs(root, { roots: [root], hidden: true }).dirs.map((d) => d.name)).toContain('.cache');

    const shop = listDirs(join(root, 'shop'), { roots: [root] });
    expect(shop).toMatchObject({ isGitRepo: true, branch: 'develop', parent: root });
    expect(shop.crumbs.map((c) => c.name)).toEqual([root, 'shop']);
    expect(checkFolder(join(root, 'shop'), [root])).toEqual({ path: join(root, 'shop'), isGitRepo: true, branch: 'develop' });
  });

  it('refuses anything outside the roots: other folders, .. and links that escape', () => {
    const { root, outside } = tree();
    expect(() => listDirs(outside, { roots: [root] })).toThrow(/outside the folders Maestro can see/);
    expect(() => listDirs(join(root, '..', 'secret'), { roots: [root] })).toThrow(/outside/);
    expect(() => listDirs(join(root, 'escape'), { roots: [root] })).toThrow(/outside/);
    expect(() => listDirs('relative/path', { roots: [root] })).toThrow(/absolute/);
    expect(() => listDirs(join(root, 'nope'), { roots: [root] })).toThrow(/does not exist/);
    expect(() => listDirs(join(root, 'notes.txt'), { roots: [root] })).toThrow(/not a folder/);
  });

  it('starts at the roots when there are several, and reads them from MAESTRO_BROWSE_ROOTS', () => {
    const a = tree();
    const b = tree();
    const l = listDirs(undefined, { roots: [a.root, b.root] });
    expect(l).toMatchObject({ path: '', parent: null });
    expect(l.dirs.map((d) => d.path)).toEqual([a.root, b.root]);
    expect(listDirs(a.root, { roots: [a.root, b.root] }).parent).toBe('');
    expect(browseRoots({ MAESTRO_BROWSE_ROOTS: `${a.root}, ${b.root},/does/not/exist` })).toEqual([a.root, b.root]);
  });

  it('answers on the API, with 403 outside the roots', async () => {
    const { base, root, outside } = tree();
    const before = process.env.MAESTRO_BROWSE_ROOTS;
    process.env.MAESTRO_BROWSE_ROOTS = root;
    try {
      const store = new Store(join(base, 'db.sqlite'));
      const secrets = new SecretStore(join(base, 's.json'));
      const agent = { run: async () => ({ sessionId: '', text: '', costUsd: 0, ok: true }) };
      const app = await buildServer({ store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: base, worktreesDir: base }), reposDir: base });
      const res = await app.inject({ method: 'GET', url: '/api/fs/dirs' });
      expect(res.json().dirs.map((d: { name: string }) => d.name)).toContain('shop');
      const denied = await app.inject({ method: 'GET', url: `/api/fs/dirs?path=${encodeURIComponent(outside)}` });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatch(/MAESTRO_BROWSE_ROOTS/);
      expect((await app.inject({ method: 'GET', url: `/api/fs/check?path=${encodeURIComponent(join(root, 'shop'))}` })).json()).toMatchObject({ isGitRepo: true, branch: 'develop' });
      expect((await app.inject({ method: 'GET', url: '/api/fs/dirs', headers: { host: 'evil.example' } })).statusCode).toBe(403);
      await app.close();
    } finally {
      if (before === undefined) delete process.env.MAESTRO_BROWSE_ROOTS;
      else process.env.MAESTRO_BROWSE_ROOTS = before;
    }
  });
});
