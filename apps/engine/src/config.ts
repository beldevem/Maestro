import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const MAESTRO_HOME = process.env.MAESTRO_HOME ?? join(homedir(), '.maestro');
export const PORT = Number(process.env.MAESTRO_PORT ?? 4800);
export const HOST = process.env.MAESTRO_HOST ?? '127.0.0.1';

export const paths = {
  db: join(MAESTRO_HOME, 'maestro.db'),
  secrets: join(MAESTRO_HOME, 'secrets.json'),
  repos: join(MAESTRO_HOME, 'repos'),
  worktrees: join(MAESTRO_HOME, 'worktrees'),
};

export function ensureHome(): void {
  for (const dir of [MAESTRO_HOME, paths.repos, paths.worktrees]) mkdirSync(dir, { recursive: true });
}
