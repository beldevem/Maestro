import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';

export const MAESTRO_HOME = process.env.MAESTRO_HOME ?? join(homedir(), '.maestro');
export const PORT = Number(process.env.MAESTRO_PORT ?? 4800);
export const HOST = process.env.MAESTRO_HOST ?? '127.0.0.1';

export const paths = {
  db: join(MAESTRO_HOME, 'maestro.db'),
  secrets: join(MAESTRO_HOME, 'secrets.json'),
  repos: join(MAESTRO_HOME, 'repos'),
  worktrees: join(MAESTRO_HOME, 'worktrees'),
};

/** Creates Maestro's folders readable only by you (700), and tightens ones made before. */
export function ensureHome(dirs = [MAESTRO_HOME, paths.repos, paths.worktrees]): void {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
