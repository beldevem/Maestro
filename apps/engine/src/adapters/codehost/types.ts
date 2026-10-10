import type { Project } from '../../types.js';

export interface PullRequestInput {
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequestRef {
  /** Link to the PR, or null when the code host has no PRs (local folder). */
  url: string | null;
  number: number | null;
}

/** What the engine needs from any code host (GitHub, GitLab, Bitbucket, a local folder). */
export interface CodeHostAdapter {
  readonly provider: string;
  /** Make sure a local clone exists and return its path. */
  ensureRepo(project: Project): Promise<string>;
  /** Bring the base branch up to date in the clone. */
  syncBase(repoPath: string, base: string): Promise<void>;
  /** Publish the branch so a PR can be opened. */
  pushBranch(worktree: string, branch: string): Promise<void>;
  openPullRequest(project: Project, input: PullRequestInput): Promise<PullRequestRef>;
}
