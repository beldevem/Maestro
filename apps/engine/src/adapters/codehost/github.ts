import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../proc.js';
import type { Project } from '../../types.js';
import type { ChecksState, ReviewVerdict } from '../../types.js';
import { MAESTRO_MARK, type CodeHostAdapter, type FeedbackItem, type PostedReview, type PullRequestInput, type PullRequestRef, type PullRequestStatus, type ReviewToPost } from './types.js';
import { httpFetch } from '../../http.js';

const API = 'https://api.github.com';

export class GitHubCodeHost implements CodeHostAdapter {
  readonly provider = 'github';

  constructor(
    private readonly token: () => string | undefined,
    private readonly reposDir: string,
    private readonly fetchImpl: typeof fetch = httpFetch,
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

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = this.token();
    if (!token) throw new Error('Add a GitHub token in Settings to use pull requests.');
    const res = await this.fetchImpl(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`), { status: res.status });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async openPullRequest(project: Project, input: PullRequestInput): Promise<PullRequestRef> {
    const pr = await this.call<{ html_url: string; number: number }>(`/repos/${this.repo(project)}/pulls`, {
      method: 'POST',
      body: { title: input.title, head: input.branch, base: input.base, body: input.body, draft: input.draft },
    }).catch((e: Error) => {
      throw new Error(`GitHub refused the pull request: ${e.message}`);
    });
    return { url: pr.html_url, number: pr.number };
  }

  /**
   * GitHub refuses APPROVE and REQUEST_CHANGES on your own PR, and inline comments on lines outside the diff.
   * So this falls back step by step: as asked, then as a COMMENT, then with every comment in the review body.
   */
  async postReview(project: Project, prNumber: number, review: ReviewToPost): Promise<PostedReview> {
    const event = { approve: 'APPROVE', changes_requested: 'REQUEST_CHANGES', comment: 'COMMENT' }[review.verdict];
    const inline = review.comments.filter((c) => c.file && c.line);
    const loose = review.comments.filter((c) => !(c.file && c.line));
    const bodyWith = (cs: typeof review.comments) =>
      [review.summary.trim(), ...cs.map((c) => `- ${c.file ? `\`${c.file}${c.line ? `:${c.line}` : ''}\`: ` : ''}${c.body}`), MAESTRO_MARK].filter(Boolean).join('\n\n');
    const attempts = [
      { event, comments: inline, body: bodyWith(loose), note: undefined },
      { event: 'COMMENT', comments: inline, body: bodyWith(loose), note: `Posted as a comment: GitHub did not accept ${event} here.` },
      { event: 'COMMENT', comments: [], body: bodyWith(review.comments), note: 'Posted as one comment: GitHub did not accept the inline comments.' },
    ].filter((a, i) => i !== 1 || event !== 'COMMENT');
    let lastError: unknown;
    for (const a of attempts) {
      try {
        const res = await this.call<{ id: number }>(`/repos/${this.repo(project)}/pulls/${prNumber}/reviews`, {
          method: 'POST',
          body: {
            commit_id: review.commitSha, event: a.event, body: a.body,
            comments: a.comments.map((c) => ({ path: c.file, line: c.line, side: 'RIGHT', body: `${c.body}\n\n${MAESTRO_MARK}` })),
          },
        });
        return { externalIds: [`review:${res.id}`], note: a.note };
      } catch (e) {
        lastError = e;
        if ((e as { status?: number }).status !== 422) throw e;
      }
    }
    throw lastError;
  }

  async pullRequestStatus(project: Project, prNumber: number): Promise<PullRequestStatus> {
    const repo = this.repo(project);
    const pr = await this.call<{ state: string; merged: boolean; head: { sha: string } }>(`/repos/${repo}/pulls/${prNumber}`);
    const [reviews, comments, issueComments, checkRuns, status] = await Promise.all([
      this.call<any[]>(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`),
      this.call<any[]>(`/repos/${repo}/pulls/${prNumber}/comments?per_page=100`),
      this.call<any[]>(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`),
      this.call<{ check_runs: { status: string; conclusion: string | null }[] }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
      this.call<{ state: string; statuses: unknown[] }>(`/repos/${repo}/commits/${pr.head.sha}/status`),
    ]);

    const feedback: FeedbackItem[] = [];
    const ours = (body: string | null) => (body ?? '').includes(MAESTRO_MARK);
    const verdictOf: Record<string, ReviewVerdict> = { CHANGES_REQUESTED: 'changes_requested', APPROVED: 'approve', COMMENTED: 'comment' };
    for (const r of reviews) {
      const verdict = verdictOf[r.state];
      if (!verdict || ours(r.body) || (verdict === 'comment' && !r.body?.trim())) continue;
      feedback.push({ externalId: `review:${r.id}`, author: r.user?.login ?? 'someone', verdict, body: r.body ?? '', file: null, line: null, createdAt: r.submitted_at });
    }
    // Line comments ask for a change; plain conversation comments only when they mention @maestro.
    for (const c of comments) {
      if (ours(c.body)) continue;
      feedback.push({ externalId: `comment:${c.id}`, author: c.user?.login ?? 'someone', verdict: 'changes_requested', body: c.body, file: c.path ?? null, line: c.line ?? c.original_line ?? null, createdAt: c.created_at });
    }
    for (const c of issueComments) {
      if (ours(c.body) || !/@maestro\b/i.test(c.body ?? '')) continue;
      feedback.push({ externalId: `issue-comment:${c.id}`, author: c.user?.login ?? 'someone', verdict: 'changes_requested', body: c.body, file: null, line: null, createdAt: c.created_at });
    }
    feedback.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      checks: combineChecks(checkRuns.check_runs, status),
      headSha: pr.head.sha,
      feedback,
    };
  }
}

export function combineChecks(runs: { status: string; conclusion: string | null }[], status: { state: string; statuses: unknown[] }): ChecksState {
  const states: ChecksState[] = runs.map((r) =>
    r.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '') ? 'success' : 'failure',
  );
  if (status.statuses.length) states.push(status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure');
  if (!states.length) return 'none';
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  return 'success';
}
