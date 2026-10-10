import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../proc.js';
import type { Project } from '../../types.js';
import type { CodeHostAdapter, PullRequestInput, PullRequestRef } from './types.js';

const API = 'https://api.github.com';

export class GitHubCodeHost implements CodeHostAdapter {
  readonly provider = 'github';

  constructor(
    private readonly token: () => string | undefined,
    private readonly reposDir: string,
  ) {}

  /** The token goes in a per-command header, never in the remote URL or on disk. */
  private authArgs(): string[] {
    const token = this.token();
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  private repo(project: Project): string {
    const repo = project.codeHost.repo?.trim();
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Set the GitHub repository as owner/name.');
    return repo;
  }

  async ensureRepo(project: Project): Promise<string> {
    const repo = this.repo(project);
    const path = join(this.reposDir, project.id);
    if (!existsSync(join(path, '.git'))) {
      await git(this.reposDir, [...this.authArgs(), 'clone', `https://github.com/${repo}.git`, path]);
    }
    return path;
  }

  async syncBase(repoPath: string, base: string): Promise<void> {
    await git(repoPath, [...this.authArgs(), 'fetch', 'origin', base]);
  }

  async pushBranch(worktree: string, branch: string): Promise<void> {
    await git(worktree, [...this.authArgs(), 'push', '-u', 'origin', branch]);
  }

  async openPullRequest(project: Project, input: PullRequestInput): Promise<PullRequestRef> {
    const token = this.token();
    if (!token) throw new Error('Add a GitHub token in Settings to open pull requests.');
    const res = await fetch(`${API}/repos/${this.repo(project)}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: input.title, head: input.branch, base: input.base, body: input.body, draft: input.draft }),
    });
    if (!res.ok) throw new Error(`GitHub refused the pull request (${res.status}): ${await res.text()}`);
    const pr = (await res.json()) as { html_url: string; number: number };
    return { url: pr.html_url, number: pr.number };
  }
}
