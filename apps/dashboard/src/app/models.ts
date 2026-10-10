export type AgentState = 'available' | 'working' | 'running_checks' | 'waiting_review' | 'addressing_review' | 'blocked' | 'paused';
export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
export type RunStatus = 'running' | 'in_review' | 'blocked' | 'failed' | 'stopped';

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
  startedAt: string;
  endedAt: string | null;
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
  in_review: 'Ready for review',
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
