import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureHome } from '../src/config.js';
import { Store } from '../src/db.js';

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

describe('file permissions', () => {
  it('creates the home folders and a new database for you only', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'maestro-perm-')), 'home');
    ensureHome([home, join(home, 'repos'), join(home, 'worktrees')]);
    expect([mode(home), mode(join(home, 'repos')), mode(join(home, 'worktrees'))]).toEqual(['700', '700', '700']);
    const store = new Store(join(home, 'maestro.db'));
    store.setSetting('x', '1');
    expect(mode(join(home, 'maestro.db'))).toBe('600');
    expect(mode(join(home, 'maestro.db-wal'))).toBe('600');
    expect(mode(join(home, 'maestro.db-shm'))).toBe('600');
    store.db.close();
  });

  it('tightens folders and database files made before', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'maestro-perm-')), 'home');
    mkdirSync(home, { mode: 0o775 });
    chmodSync(home, 0o775);
    const first = new Store(join(home, 'maestro.db'));
    first.setSetting('x', '1');
    first.db.close();
    for (const f of ['maestro.db', 'maestro.db-wal', 'maestro.db-shm']) {
      writeFileSync(join(home, f), '', { flag: 'a' });
      chmodSync(join(home, f), 0o644);
    }
    ensureHome([home]);
    const store = new Store(join(home, 'maestro.db'));
    expect(mode(home)).toBe('700');
    expect(store.getSetting('x')).toBe('1');
    for (const f of ['maestro.db', 'maestro.db-wal', 'maestro.db-shm']) expect(mode(join(home, f))).toBe('600');
    store.db.close();
  });
});
