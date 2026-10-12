export type CodeHostProvider = 'github' | 'gitlab' | 'bitbucket' | 'local';
export type PmProvider = 'manual' | 'jira' | 'trello';
export type DesignProvider = 'none' | 'figma';

export interface CodeHostConfig {
  provider: CodeHostProvider;
  /** owner/repo for GitHub, group/project for GitLab, workspace/repo for Bitbucket */
  repo?: string;
  /** Self-managed GitLab, e.g. https://gitlab.example.com (default https://gitlab.com) */
  baseUrl?: string;
  /** absolute path for a local folder */
  localPath?: string;
  defaultBranch: string;
}

export interface PmConfig {
  provider: PmProvider;
  /** Jira: baseUrl, projectKey, email. Trello: boardId, list ids per status. */
  settings: Record<string, string>;
}

export interface DesignConfig {
  provider: DesignProvider;
  settings: Record<string, string>;
}

export type DocsProvider = 'none' | 'confluence';

export interface DocsConfig {
  provider: DocsProvider;
  /** Confluence: pages (URLs or ids, one per line); baseUrl and email when the PM tool is not Jira. */
  settings: Record<string, string>;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  codeHost: CodeHostConfig;
  pm: PmConfig;
  design: DesignConfig;
  docs: DocsConfig;
  context: string;
  requirements: string;
  bestPractices: string;
  workflowYaml: string;
  createdAt: string;
}

export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

export interface Ticket {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: TicketStatus;
  size?: string;
  labels: string[];
  url?: string;
}

export type AgentRole = 'worker' | 'orchestrator' | 'reviewer' | 'planner' | 'assistant';
export type AgentState =
  | 'available'
  | 'working'
  | 'running_checks'
  | 'waiting_review'
  | 'addressing_review'
  | 'blocked'
  | 'paused';

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  /** This worker's own AI provider; empty uses the project's or the default for workers. */
  provider: string;
  model: string;
  state: AgentState;
  currentRunId: string | null;
  note: string;
}

/** reviewing: the reviewer agent is looking at it. in_review: waiting for you or the PR. done: approved or merged. */
export type RunStatus = 'running' | 'reviewing' | 'in_review' | 'done' | 'blocked' | 'failed' | 'stopped';
export type ChecksState = 'pending' | 'success' | 'failure' | 'none';

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
  /** The ticket's `area:` label, so one_per_area works without asking the PM tool. */
  area: string | null;
  /** Agent SDK session, resumed when the worker addresses review comments. */
  sessionId: string | null;
  baseRef: string | null;
  prNumber: number | null;
  reviewRounds: number;
  /** CI status of the PR's head commit, from polling the code host. */
  checks: ChecksState | null;
  /** When the change first became ready for review (PR opened or branch ready). */
  readyAt: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type RunEventKind = 'info' | 'agent' | 'tool' | 'command' | 'gate' | 'error';

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  kind: RunEventKind;
  message: string;
}

export type TicketSize = 'XS' | 'S' | 'M' | 'L' | 'XL';

/** One ticket the planner proposes. dependsOn holds indexes of earlier items in the same draft. */
export interface BacklogItem {
  title: string;
  description: string;
  acceptanceCriteria: string;
  size: TicketSize;
  labels: string[];
  dependsOn: number[];
}

export type DraftStatus = 'draft' | 'approved' | 'discarded';

export interface BacklogDraft {
  id: string;
  projectId: string;
  status: DraftStatus;
  items: BacklogItem[];
  /** Ticket keys already created for each item (by index) when approval stopped partway. */
  createdKeys: (string | null)[];
  error: string | null;
  costUsd: number;
  createdAt: string;
  approvedAt: string | null;
}

export type ChatActionStatus = 'pending' | 'done' | 'dismissed' | 'failed';

export interface StoredChatAction {
  id: string;
  type: string;
  summary: string;
  action: unknown;
  state: ChatActionStatus;
  result: string | null;
  runId: string | null;
  createdAt: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  actions: StoredChatAction[];
}

export type SpendKind = 'worker' | 'reviewer' | 'planner' | 'chat';

export type AlertKind = 'blocked' | 'failed' | 'budget' | 'ready';

export interface Alert {
  id: number;
  projectId: string | null;
  runId: string | null;
  kind: AlertKind;
  message: string;
  read: boolean;
  createdAt: string;
}

export type ReviewVerdict = 'approve' | 'changes_requested' | 'comment';
export type ReviewSource = 'agent' | 'human' | 'github';

export interface ReviewComment {
  file: string | null;
  line: number | null;
  body: string;
}

export interface Review {
  id: string;
  runId: string;
  source: ReviewSource;
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewComment[];
  author: string | null;
  /** Id on the code host, so polled reviews are stored once and our own posts are skipped. */
  externalId: string | null;
  /** True once a worker has dealt with it (or it needs no work). */
  addressed: boolean;
  costUsd: number;
  createdAt: string;
}
