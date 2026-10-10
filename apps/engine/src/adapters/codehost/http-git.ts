import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../proc.js';

/**
 * Clone, fetch and push over HTTPS with the credentials in a per-command header,
 * so they never land in the remote URL, the git config or on disk.
 */
export class HttpGit {
  constructor(
    /** e.g. https://gitlab.com */
    private readonly origin: string,
    private readonly credentials: () => { user: string; secret: string } | undefined,
  ) {}

  authArgs(): string[] {
    const c = this.credentials();
    if (!c) return [];
    const basic = Buffer.from(`${c.user}:${c.secret}`).toString('base64');
    return ['-c', `http.${this.origin.replace(/\/+$/, '')}/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  async ensureClone(cloneUrl: string, path: string, reposDir: string): Promise<string> {
    if (!existsSync(join(path, '.git'))) await git(reposDir, [...this.authArgs(), 'clone', cloneUrl, path]);
    return path;
  }

  async fetch(repoPath: string, branch: string): Promise<void> {
    await git(repoPath, [...this.authArgs(), 'fetch', 'origin', branch]);
  }

  async push(worktree: string, branch: string): Promise<void> {
    await git(worktree, [...this.authArgs(), 'push', '-u', 'origin', branch]);
  }
}

/** Formats review comments that could not be posted inline into one text. */
export function reviewText(summary: string, comments: { file: string | null; line: number | null; body: string }[], heading?: string): string {
  return [
    heading,
    summary.trim(),
    ...comments.map((c) => `- ${c.file ? `\`${c.file}${c.line ? `:${c.line}` : ''}\`: ` : ''}${c.body}`),
  ].filter(Boolean).join('\n\n');
}
