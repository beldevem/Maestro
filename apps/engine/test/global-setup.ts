import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every temp folder the tests make goes under one folder per run, removed at the end. */
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-tests-'));
  process.env.TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
