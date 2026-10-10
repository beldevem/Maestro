import { join } from 'node:path';
import type { ChecksState, Project } from '../../types.js';
import { HttpGit, reviewText } from './http-git.js';
import { MAESTRO_MARK, type CodeHostAdapter, type FeedbackItem, type PostedReview, type PullRequestInput, type PullRequestRef, type PullRequestStatus, type ReviewToPost } from './types.js';

const API = 'https://api.bitbucket.org/2.0';
const STATUS: Record<string, ChecksState> = { SUCCESSFUL: 'success', FAILED: 'failure', STOPPED: 'failure', INPROGRESS: 'pending' };

/** Bitbucket Cloud with a username and app password (Repositories and Pull requests: read and write). */
export class BitbucketCodeHost implements CodeHostAdapter {
  readonly provider = 'bitbucket';

  constructor(
    private readonly credentials: () => { user: string; secret: string } | undefined,
    private readonly reposDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private readonly http = new HttpGit('https://bitbucket.org', () => this.credentials());

  private repo(project: Project): string {
    const repo = project.codeHost.repo?.trim();
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Set the Bitbucket repository as workspace/repo.');
    return repo;
  }

  private async call<T>(project: Project, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const c = this.credentials();
    if (!c) throw new Error('Add the Bitbucket username and app password in Settings to use pull requests.');
    const res = await this.fetchImpl(`${API}/repositories/${this.repo(project)}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.user}:${c.secret}`).toString('base64')}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw Object.assign(new Error(`Bitbucket ${init.method ?? 'GET'} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`), { status: res.status });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  ensureRepo(project: Project): Promise<string> {
    return this.http.ensureClone(`https://bitbucket.org/${this.repo(project)}.git`, join(this.reposDir, project.id), this.reposDir);
  }

  syncBase(repoPath: string, base: string): Promise<void> {
    return this.http.fetch(repoPath, base);
  }

  pushBranch(worktree: string, branch: string): Promise<void> {
    return this.http.push(worktree, branch);
  }

  async openPullRequest(project: Project, input: PullRequestInput): Promise<PullRequestRef> {
    const pr = await this.call<{ id: number; links: { html: { href: string } } }>(project, '/pullrequests', {
      method: 'POST',
      body: {
        title: input.title, description: input.body, draft: input.draft, close_source_branch: true,
        source: { branch: { name: input.branch } }, destination: { branch: { name: input.base } },
      },
    });
    return { url: pr.links.html.href, number: pr.id };
  }

  /** Line comments go inline where Bitbucket takes them; approve and request-changes are tried, since you cannot do either on your own PR. */
  async postReview(project: Project, id: number, review: ReviewToPost): Promise<PostedReview> {
    const ids: string[] = [];
    const leftover: typeof review.comments = [];
    for (const c of review.comments) {
      if (!(c.file && c.line)) {
        leftover.push(c);
        continue;
      }
      try {
        const res = await this.call<{ id: number }>(project, `/pullrequests/${id}/comments`, {
          method: 'POST', body: { content: { raw: `${c.body}\n\n${MAESTRO_MARK}` }, inline: { path: c.file, to: c.line } },
        });
        ids.push(`comment:${res.id}`);
      } catch {
        leftover.push(c);
      }
    }
    const heading = review.verdict === 'approve' ? '**Approved** by the Maestro reviewer agent.' : review.verdict === 'changes_requested' ? '**Changes requested** by the Maestro reviewer agent.' : undefined;
    const res = await this.call<{ id: number }>(project, `/pullrequests/${id}/comments`, {
      method: 'POST', body: { content: { raw: `${reviewText(review.summary, leftover, heading)}\n\n${MAESTRO_MARK}` } },
    });
    ids.push(`comment:${res.id}`);
    let note: string | undefined;
    const action = review.verdict === 'approve' ? 'approve' : review.verdict === 'changes_requested' ? 'request-changes' : null;
    if (action) {
      await this.call(project, `/pullrequests/${id}/${action}`, { method: 'POST' }).catch(() => {
        note = `Bitbucket did not accept "${action}" (not allowed on your own pull request), so it is a comment.`;
      });
    }
    return { externalIds: ids, note };
  }

  async pullRequestStatus(project: Project, id: number): Promise<PullRequestStatus> {
    const pr = await this.call<{ state: string; source: { commit: { hash: string } } }>(project, `/pullrequests/${id}`);
    const [statuses, comments] = await Promise.all([
      this.call<{ values: { state: string }[] }>(project, `/pullrequests/${id}/statuses?pagelen=100`),
      this.call<{ values: any[] }>(project, `/pullrequests/${id}/comments?pagelen=100`),
    ]);
    const states = statuses.values.map((s) => STATUS[s.state] ?? 'pending');
    const checks: ChecksState = !states.length ? 'none' : states.includes('failure') ? 'failure' : states.includes('pending') ? 'pending' : 'success';
    const feedback: FeedbackItem[] = [];
    for (const c of comments.values) {
      const body: string = c.content?.raw ?? '';
      if (c.deleted || body.includes(MAESTRO_MARK)) continue;
      const inline = c.inline?.path;
      if (!inline && !/@maestro\b/i.test(body)) continue;
      feedback.push({
        externalId: `comment:${c.id}`, author: c.user?.display_name ?? c.user?.nickname ?? 'someone', verdict: 'changes_requested', body,
        file: inline ? c.inline.path : null, line: inline ? c.inline.to ?? null : null, createdAt: c.created_on,
      });
    }
    feedback.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      state: pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
      checks,
      headSha: pr.source.commit.hash,
      feedback,
    };
  }
}
