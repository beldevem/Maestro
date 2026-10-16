import type { SessionUser } from '../src/auth/roles.js';

/** A user holding every role, for tests about other things than permissions. */
export const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@test.local', name: 'Admin', roles: ['pm', 'lead', 'dev'], mustChangePassword: false };

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A folder that passes the local-repository check (it has a .git folder). */
export function gitFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-repo-'));
  mkdirSync(join(dir, '.git'));
  return dir;
}
