import { join } from 'node:path';
import type { ChecksState, Project } from '../../types.js';
import { HttpGit, reviewText } from './http-git.js';
import { MAESTRO_MARK, type CodeHostAdapter, type FeedbackItem, type PostedReview, type PullRequestInput, type PullRequestRef, type PullRequestStatus, type ReviewToPost } from './types.js';
import { httpFetch } from '../../http.js';

const PIPELINE: Record<string, ChecksState> = {
  success: 'success', failed: 'failure', canceled: 'failure',
  running: 'pending', pending: 'pending', created: 'pending', preparing: 'pending', waiting_for_resource: 'pending', scheduled: 'pending', manual: 'pending',
  skipped: 'none',
};

/** GitLab (gitlab.com or self-managed) with a personal or project access token. Merge requests are the PRs. */
export class GitLabCodeHost implements CodeHostAdapter {
  readonly provider = 'gitlab';

  constructor(
    private readonly token: () => string | undefined,
    private readonly reposDir: string,
    private readonly fetchImpl: typeof fetch = httpFetch,
  ) {}

  private origin(project: Project): string {
    return (project.codeHost.baseUrl?.trim() || 'https://gitlab.com').replace(/\/+$/, '');
  }

  private path(project: Project): string {
    const repo = project.codeHost.repo?.trim().replace(/^\/+|\/+$/g, '');
    if (!repo || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw new Error('Set the GitLab project path, like group/project.');
    return repo;
  }

  private git(project: Project): HttpGit {
    return new HttpGit(this.origin(project), () => {
      const t = this.token();
      return t ? { user: 'oauth2', secret: t } : undefined;
    });
  }

  private async call<T>(project: Project, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = this.token();
    if (!token) throw new Error('Add a GitLab token in Settings to use merge requests.');
    const url = `${this.origin(project)}/api/v4/projects/${encodeURIComponent(this.path(project))}${path}`;
    const res = await this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { 'PRIVATE-TOKEN': token, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw Object.assign(new Error(`GitLab ${init.method ?? 'GET'} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`), { status: res.status });
    return (await res.json()) as T;
  }

  ensureRepo(project: Project): Promise<string> {
    return this.git(project).ensureClone(`${this.origin(project)}/${this.path(project)}.git`, join(this.reposDir, project.id), this.reposDir);
  }

  syncBase(repoPath: string, base: string, project: Project): Promise<void> {
    return this.git(project).fetch(repoPath, base);
  }

  pushBranch(worktree: string, branch: string, project: Project): Promise<void> {
    return this.git(project).push(worktree, branch);
  }

  async openPullRequest(project: Project, input: PullRequestInput): Promise<PullRequestRef> {
    const mr = await this.call<{ web_url: string; iid: number }>(project, '/merge_requests', {
      method: 'POST',
      body: {
        source_branch: input.branch, target_branch: input.base,
        title: input.draft ? `Draft: ${input.title}` : input.title, description: input.body, remove_source_branch: true,
      },
    });
    return { url: mr.web_url, number: mr.iid };
  }

  /** Inline comments become diff discussions where GitLab accepts the line, the rest one note. Approve is tried, never required. */
  async postReview(project: Project, iid: number, review: ReviewToPost): Promise<PostedReview> {
    const ids: string[] = [];
    const notes: string[] = [];
    const leftover: typeof review.comments = [];
    const versions = await this.call<{ base_commit_sha: string; start_commit_sha: string; head_commit_sha: string }[]>(project, `/merge_requests/${iid}/versions`).catch(() => []);
    const v = versions[0];
    for (const c of review.comments) {
      if (!(v && c.file && c.line)) {
        leftover.push(c);
        continue;
      }
      try {
        const d = await this.call<{ id: string }>(project, `/merge_requests/${iid}/discussions`, {
          method: 'POST',
          body: {
            body: `${c.body}\n\n${MAESTRO_MARK}`,
            position: { position_type: 'text', base_sha: v.base_commit_sha, start_sha: v.start_commit_sha, head_sha: v.head_commit_sha, new_path: c.file, new_line: c.line },
          },
        });
        ids.push(`discussion:${d.id}`);
      } catch {
        leftover.push(c);
      }
    }
    const heading = review.verdict === 'approve' ? '**Approved** by the Maestro reviewer agent.' : review.verdict === 'changes_requested' ? '**Changes requested** by the Maestro reviewer agent.' : undefined;
    const note = await this.call<{ id: number }>(project, `/merge_requests/${iid}/notes`, {
      method: 'POST', body: { body: `${reviewText(review.summary, leftover, heading)}\n\n${MAESTRO_MARK}` },
    });
    ids.push(`note:${note.id}`);
    if (review.verdict === 'approve') {
      await this.call(project, `/merge_requests/${iid}/approve`, { method: 'POST', body: {} }).catch(() => notes.push('GitLab did not accept the approval (you cannot approve your own merge request), so it is a comment.'));
    }
    if (leftover.some((c) => c.file && c.line)) notes.push('Some line comments were posted in the summary note.');
    return { externalIds: ids, note: notes.join(' ') || undefined };
  }

  async pullRequestStatus(project: Project, iid: number): Promise<PullRequestStatus> {
    const mr = await this.call<{ state: string; sha: string; head_pipeline?: { status: string } | null }>(project, `/merge_requests/${iid}`);
    const notes = await this.call<any[]>(project, `/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=100`);
    const feedback: FeedbackItem[] = [];
    for (const n of notes) {
      if (n.system || (n.body ?? '').includes(MAESTRO_MARK)) continue;
      const pos = n.position;
      const inline = n.type === 'DiffNote' && pos?.new_path;
      if (!inline && !/@maestro\b/i.test(n.body ?? '')) continue;
      feedback.push({
        externalId: `note:${n.id}`, author: n.author?.username ?? 'someone', verdict: 'changes_requested', body: n.body,
        file: inline ? pos.new_path : null, line: inline ? pos.new_line ?? null : null, createdAt: n.created_at,
      });
    }
    return {
      state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
      checks: mr.head_pipeline ? PIPELINE[mr.head_pipeline.status] ?? 'pending' : 'none',
      headSha: mr.sha,
      feedback,
    };
  }
}
