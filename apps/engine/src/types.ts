export type CodeHostProvider = 'github' | 'local';
export type PmProvider = 'manual' | 'jira' | 'trello';
export type DesignProvider = 'none' | 'figma';

export interface CodeHostConfig {
  provider: CodeHostProvider;
  /** owner/repo for GitHub */
  repo?: string;
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

export interface Project {
  id: string;
  name: string;
  description: string;
  codeHost: CodeHostConfig;
  pm: PmConfig;
  design: DesignConfig;
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
  model: string;
  state: AgentState;
  currentRunId: string | null;
  note: string;
}

export type RunStatus = 'running' | 'in_review' | 'blocked' | 'failed' | 'stopped';

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
