/** Tokens one or more agent calls used; null where unknown (shown as n/a). */
export interface Usage {
  input: number;
  output: number;
  cache: number;
}

/** Spend over a period: USD from provider prices (for the euro estimate) and tokens. */
export interface Spent {
  usd: number;
  usage: Usage | null;
}

/** A budget in tokens and optionally euros; 0 means no limit. */
export interface Caps {
  tokens: number;
  eur: number;
}

export type AgentState = 'available' | 'working' | 'running_checks' | 'waiting_review' | 'addressing_review' | 'blocked' | 'paused';
export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
export type RunStatus = 'running' | 'reviewing' | 'in_review' | 'done' | 'blocked' | 'failed' | 'stopped';
export type ChecksState = 'pending' | 'success' | 'failure' | 'none';

export interface Project {
  id: string;
  name: string;
  description: string;
  codeHost: { provider: 'github' | 'gitlab' | 'bitbucket' | 'local'; repo?: string; baseUrl?: string; localPath?: string; defaultBranch: string };
  pm: { provider: 'manual' | 'jira' | 'trello'; settings: Record<string, string> };
  design: { provider: 'none' | 'figma'; settings: Record<string, string> };
  docs: { provider: 'none' | 'confluence'; settings: Record<string, string> };
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
  usage: Usage | null;
  createdAt: string;
  approvedAt: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  /** The worker's own AI provider; empty uses the project's or the default. */
  provider: string;
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
  usage: Usage | null;
  prUrl: string | null;
  error: string | null;
  area: string | null;
  sessionId: string | null;
  baseRef: string | null;
  prNumber: number | null;
  reviewRounds: number;
  checks: ChecksState | null;
  readyAt: string | null;
  startedBy?: string | null;
  trigger?: 'manual' | 'auto' | 'chat' | null;
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

export type ProviderKind = 'claude' | 'openai' | 'cli';
export type Role = 'worker' | 'reviewer' | 'planner' | 'assistant';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeySecret: string;
  structuredOutput: 'json_schema' | 'json_object' | 'prompt';
  prices: Record<string, { input: number; output: number }>;
  cli?: { preset: string; command: string; args: string[]; modelArgs: string[]; timeoutMinutes: number };
}

export interface ProviderView extends ProviderConfig {
  keySet: boolean;
  installed?: boolean;
  claudeLogin?: { found: boolean; valid: boolean; message: string };
  warnings: string[];
}

export interface OpenAIPreset { id: string; name: string; baseUrl: string; dockerBaseUrl?: string; needsKey: boolean; keyHint: string; structuredOutput: ProviderConfig['structuredOutput'] }
export interface CliPreset { id: string; name: string; command: string; args: string[]; modelArgs: string[]; install: string; auth: string; installed: boolean }
export interface Choice { provider: string; model: string }

export interface ProvidersInfo {
  providers: ProviderView[];
  roles: Record<Role, Choice>;
  presets: { openai: OpenAIPreset[]; cli: CliPreset[]; claudeModels: string[] };
  inDocker: boolean;
}

export const ROLE_LABEL: Record<Role, { label: string; hint: string }> = {
  worker: { label: 'Workers', hint: 'Write the code for each ticket. Needs file and command tools.' },
  reviewer: { label: 'Reviewer', hint: 'Reviews each change; answers in JSON.' },
  planner: { label: 'Planner', hint: 'Turns requirements into a backlog; answers in JSON.' },
  assistant: { label: 'Chat', hint: 'Answers your questions on the Dashboard.' },
};

export interface ChatModelGroup {
  provider: string;
  name: string;
  kind: ProviderKind;
  models: string[];
  hint: string;
  error: string;
}

/** A Dashboard conversation: its own title, project focus and model. */
export interface ChatThread {
  id: string;
  title: string;
  projectId: string | null;
  model: Choice | null;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

export interface ChatModels {
  groups: ChatModelGroup[];
  current: Choice | null;
  default: Choice;
}

export interface RunBrief {
  runId: string;
  projectId: string;
  projectName: string;
  ticketKey: string;
  ticketTitle: string;
  status: RunStatus;
  prUrl: string | null;
  checks: ChecksState | null;
  error: string | null;
  costUsd: number;
  usage: Usage | null;
  since: string;
}

export interface ProjectOverview {
  id: string;
  name: string;
  description: string;
  codeHost: string;
  pm: string;
  /** null when the PM tool could not be reached. */
  tickets: Record<TicketStatus, number> | null;
  running: number;
  inReview: number;
  blocked: number;
  spendToday: Spent;
  dailyCaps: Caps;
  autoAssign: boolean;
}

export interface Overview {
  projects: ProjectOverview[];
  agents: Agent[];
  active: RunBrief[];
  needsYou: (RunBrief & { why: 'blocked' | 'review' | 'failed' })[];
  spend: { today: Spent; last7Days: Spent; perRunCaps: Caps; dailyCapsDefault: Caps; byUser?: UserUsage[] };
  alertsUnread: number;
  activity: (RunEvent & { ticketKey: string; projectId: string; projectName: string })[];
}

export interface TicketMetrics {
  ticketKey: string;
  ticketTitle: string;
  runs: number;
  costUsd: number;
  usage: Usage | null;
  fixAttempts: number;
  reviewRounds: number;
  status: RunStatus;
  cycleTimeMs: number | null;
}

export interface Metrics {
  runs: number;
  finished: number;
  successRate: number | null;
  byStatus: Partial<Record<RunStatus, number>>;
  meanTimeToPrMs: number | null;
  meanCycleTimeMs: number | null;
  firstPassReviewRate: number | null;
  meanFixAttempts: number | null;
  meanReviewRounds: number | null;
  totalCostUsd: number;
  costPerTicketUsd: number | null;
  totalUsage: Usage | null;
  tokensPerTicket: number | null;
  tickets: TicketMetrics[];
}

export interface Alert {
  id: number;
  projectId: string | null;
  runId: string | null;
  kind: 'blocked' | 'failed' | 'budget' | 'ready';
  message: string;
  read: boolean;
  createdAt: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  bestPractices: string;
  gates: { name: string; run: string }[];
}

export interface ProjectSpend {
  projectId: string;
  name: string;
  today: Spent;
  last7Days: Spent;
  total: Spent;
  dailyCaps: Caps;
  /** The project's own caps as stored, or null where it uses the default. */
  own: { tokens: string | null; eur: string | null };
}

export interface ChatAction {
  id: string;
  type: string;
  summary: string;
  /** Set in the dashboard once you act on it. */
  state?: 'pending' | 'running' | 'done' | 'dismissed' | 'failed';
  result?: string;
  runId?: string;
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  /** Which AI answered. */
  model?: string | null;
  createdAt?: string;
  actions?: ChatAction[];
}

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

/** A folder listing from the engine's folder picker. */
export interface DirListing {
  /** '' when listing the roots themselves. */
  path: string;
  parent: string | null;
  roots: string[];
  crumbs: { name: string; path: string }[];
  dirs: { name: string; path: string; isGitRepo: boolean; hasPackageJson: boolean; hidden: boolean }[];
  isGitRepo: boolean;
  branch: string | null;
  truncated: boolean;
}

export type UserRole = 'pm' | 'lead' | 'dev';
export const USER_ROLE_LABEL: Record<UserRole, string> = { pm: 'Project Manager', lead: 'Tech Lead', dev: 'Developer' };

/** The logged-in user. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
  mustChangePassword: boolean;
}

/** A person, as the Users page (full) or anyone else (name and roles) sees them. */
export interface UserView {
  id: string;
  name: string;
  roles: UserRole[];
  active: boolean;
  email?: string;
  mustChangePassword?: boolean;
  locked?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
  projects?: string[];
}

/** One entry of the activity log. */
export interface ActivityEntry {
  id: number;
  at: string;
  userId: string;
  userName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  projectName: string | null;
  detail: Record<string, unknown> | null;
}

/** Usage by one person (or "system" for Maestro's own calls). */
export interface UserUsage {
  userId: string;
  name: string;
  roles: UserRole[];
  active: boolean;
  usd: number;
  usage: Usage | null;
  runs: number;
  successRate: number | null;
}
