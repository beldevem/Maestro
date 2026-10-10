export type AgentState = 'available' | 'working' | 'running_checks' | 'waiting_review' | 'addressing_review' | 'blocked' | 'paused';
export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
export type RunStatus = 'running' | 'reviewing' | 'in_review' | 'done' | 'blocked' | 'failed' | 'stopped';
export type ChecksState = 'pending' | 'success' | 'failure' | 'none';

export interface Project {
  id: string;
  name: string;
  description: string;
  codeHost: { provider: 'github' | 'local'; repo?: string; localPath?: string; defaultBranch: string };
  pm: { provider: 'manual' | 'jira' | 'trello'; settings: Record<string, string> };
  design: { provider: 'none' | 'figma'; settings: Record<string, string> };
  context: string;
  requirements: string;
  bestPractices: string;
  workflowYaml: string;
  createdAt: string;
}

export interface Ticket {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: TicketStatus;
  size?: string;
  labels: string[];
  url?: string;
  notReady: string[];
  dependsOn: string[];
  /** Dependencies that are not finished yet. */
  blockedBy: string[];
}

export interface BacklogItem {
  title: string;
  description: string;
  acceptanceCriteria: string;
  size: string;
  labels: string[];
  /** Indexes of earlier items in the same draft. */
  dependsOn: number[];
}

export interface BacklogDraft {
  id: string;
  projectId: string;
  status: 'draft' | 'approved' | 'discarded';
  items: BacklogItem[];
  createdKeys: (string | null)[];
  error: string | null;
  costUsd: number;
  createdAt: string;
  approvedAt: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  state: AgentState;
  currentRunId: string | null;
  note: string;
}

export interface Run {
  id: string;
  projectId: string;
  agentId: string;
  ticketKey: string;
  ticketTitle: string;
  branch: string;
  worktree: string;
  status: RunStatus;
  attempts: number;
  costUsd: number;
  prUrl: string | null;
  error: string | null;
  area: string | null;
  sessionId: string | null;
  baseRef: string | null;
  prNumber: number | null;
  reviewRounds: number;
  checks: ChecksState | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ReviewComment {
  file: string | null;
  line: number | null;
  body: string;
}

export interface Review {
  id: string;
  runId: string;
  source: 'agent' | 'human' | 'github';
  verdict: 'approve' | 'changes_requested' | 'comment';
  summary: string;
  comments: ReviewComment[];
  author: string | null;
  addressed: boolean;
  costUsd: number;
  createdAt: string;
}

export interface PullRequestRow extends Run {
  projectName: string;
  reviewerVerdict: Review['verdict'] | null;
  openComments: number;
  reviewCount: number;
}

export const VERDICT_LABEL: Record<Review['verdict'], string> = {
  approve: 'Approved',
  changes_requested: 'Changes requested',
  comment: 'Commented',
};

export const CHECKS_LABEL: Record<ChecksState, string> = {
  pending: 'Checks running',
  success: 'Checks passed',
  failure: 'Checks failed',
  none: 'No checks',
};

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  kind: 'info' | 'agent' | 'tool' | 'command' | 'gate' | 'error';
  message: string;
}

export interface SecretInfo {
  name: string;
  label: string;
  help: string;
  set: boolean;
}

export const STATE_LABEL: Record<AgentState, string> = {
  available: 'Available',
  working: 'Working on ticket',
  running_checks: 'Running checks',
  waiting_review: 'Waiting for review',
  addressing_review: 'Addressing review',
  blocked: 'Blocked, needs you',
  paused: 'Paused',
};

export const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  reviewing: 'Reviewer agent reviewing',
  in_review: 'Ready for review',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  stopped: 'Stopped',
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};
