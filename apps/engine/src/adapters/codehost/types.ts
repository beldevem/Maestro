import type { ChecksState, Project, ReviewComment, ReviewVerdict } from '../../types.js';

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

/** Hidden marker on everything Maestro posts, so polling never mistakes it for your feedback. */
export const MAESTRO_MARK = '<!-- maestro -->';

export interface ReviewToPost {
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewComment[];
  commitSha: string;
}

export interface PostedReview {
  /** Ids of what was created, so polling can skip our own posts. */
  externalIds: string[];
  /** How it was posted, when the code host did not accept it as asked (e.g. no self-approval). */
  note?: string;
}

export interface FeedbackItem {
  externalId: string;
  author: string;
  verdict: ReviewVerdict;
  body: string;
  file: string | null;
  line: number | null;
  createdAt: string;
}

export interface PullRequestStatus {
  state: 'open' | 'closed' | 'merged';
  checks: ChecksState;
  headSha: string;
  /** Reviews and comments on the PR, oldest first. */
  feedback: FeedbackItem[];
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
  /** Post a review on the PR. Hosts without PRs leave it out and reviews stay in Maestro. */
  postReview?(project: Project, prNumber: number, review: ReviewToPost): Promise<PostedReview>;
  /** State, CI checks and feedback of a PR, for polling. */
  pullRequestStatus?(project: Project, prNumber: number): Promise<PullRequestStatus>;
}
