import { Injectable } from '@angular/core';
import type { Agent, Alert, BacklogDraft, ChatAction, Metrics, ProjectTemplate, ProjectSpend, BacklogItem, Project, PullRequestRow, Review, ReviewComment, Run, RunEvent, SecretInfo, Ticket, TicketStatus } from './models';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly reasons: string[] = []) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class Api {
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
    if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status, data?.reasons ?? []);
    return data as T;
  }

  projects = () => this.call<Project[]>('GET', '/projects');
  project = (id: string) => this.call<Project>('GET', `/projects/${id}`);
  templates = () => this.call<ProjectTemplate[]>('GET', '/templates');
  createProject = (p: Partial<Project> & { template?: string }) => this.call<Project>('POST', '/projects', p);
  updateProject = (id: string, p: Partial<Project>) => this.call<Project>('PATCH', `/projects/${id}`, p);
  deleteProject = (id: string) => this.call('DELETE', `/projects/${id}`);
  checkProject = (id: string) => this.call<Record<string, { ok: boolean; message: string }>>('POST', `/projects/${id}/check`, {});

  tickets = (projectId: string) => this.call<Ticket[]>('GET', `/projects/${projectId}/tickets`);
  createTicket = (projectId: string, t: Partial<Ticket>) => this.call<Ticket>('POST', `/projects/${projectId}/tickets`, t);
  startTicket = (projectId: string, key: string, force = false) =>
    this.call<Run>('POST', `/projects/${projectId}/tickets/${encodeURIComponent(key)}/start`, { force });
  setTicketStatus = (projectId: string, key: string, status: TicketStatus) =>
    this.call<Ticket>('POST', `/projects/${projectId}/tickets/${encodeURIComponent(key)}/status`, { status });

  autoAssign = (projectId: string) => this.call<{ enabled: boolean }>('GET', `/projects/${projectId}/auto-assign`);
  setAutoAssign = (projectId: string, enabled: boolean) => this.call<{ enabled: boolean }>('PUT', `/projects/${projectId}/auto-assign`, { enabled });

  memory = (projectId: string) => this.call<{ content: string; pending: boolean }>('GET', `/projects/${projectId}/memory`);
  saveMemory = (projectId: string, content: string) => this.call<{ content: string; pending: boolean }>('PUT', `/projects/${projectId}/memory`, { content });
  discardMemory = (projectId: string) => this.call('DELETE', `/projects/${projectId}/memory`);

  plan = (projectId: string) => this.call<BacklogDraft>('POST', `/projects/${projectId}/plan`, {});
  drafts = (projectId: string) => this.call<BacklogDraft[]>('GET', `/projects/${projectId}/drafts`);
  updateDraft = (id: string, items: BacklogItem[]) => this.call<BacklogDraft>('PATCH', `/drafts/${id}`, { items });
  approveDraft = (id: string) => this.call<{ draft: BacklogDraft; created: Ticket[]; error: string | null }>('POST', `/drafts/${id}/approve`, {});
  discardDraft = (id: string) => this.call<BacklogDraft>('POST', `/drafts/${id}/discard`, {});

  runs = (projectId?: string) => this.call<Run[]>('GET', `/runs${projectId ? `?projectId=${projectId}` : ''}`);
  run = (id: string) => this.call<Run & { active: boolean; events: RunEvent[]; reviews: Review[] }>('GET', `/runs/${id}`);
  review = (id: string, verdict: 'approve' | 'changes_requested', summary = '', comments: ReviewComment[] = []) =>
    this.call<Review>('POST', `/runs/${id}/reviews`, { verdict, summary, comments });
  pullRequests = () => this.call<PullRequestRow[]>('GET', '/pull-requests');
  pollPullRequests = () => this.call('POST', '/pull-requests/poll', {});
  diff = (id: string) => this.call<{ base: string; diff: string }>('GET', `/runs/${id}/diff`);
  stopRun = (id: string) => this.call('POST', `/runs/${id}/stop`, {});
  cleanupWorktrees = (projectId: string) => this.call<{ removed: number }>('POST', `/projects/${projectId}/cleanup`, {});
  removeWorktree = (id: string) => this.call('DELETE', `/runs/${id}/worktree`);

  agents = () => this.call<Agent[]>('GET', '/agents');
  createAgent = (a: Partial<Agent>) => this.call<Agent>('POST', '/agents', a);
  updateAgent = (id: string, a: Partial<Agent>) => this.call<Agent>('PATCH', `/agents/${id}`, a);
  agentAction = (id: string, action: 'pause' | 'resume' | 'unblock') => this.call<Agent>('POST', `/agents/${id}/action`, { action });
  deleteAgent = (id: string) => this.call('DELETE', `/agents/${id}`);

  chat = (projectId: string, message: string, history: { role: 'user' | 'assistant'; content: string }[]) =>
    this.call<{ answer: string; costUsd: number; actions: ChatAction[] }>('POST', `/projects/${projectId}/chat`, { message, history });
  confirmAction = (projectId: string, actionId: string) =>
    this.call<{ message: string; runId?: string }>('POST', `/projects/${projectId}/chat/actions/${actionId}`, {});
  dismissAction = (projectId: string, actionId: string) => this.call('DELETE', `/projects/${projectId}/chat/actions/${actionId}`);

  alerts = () => this.call<{ alerts: Alert[]; unread: number }>('GET', '/alerts');
  markAlertsRead = (ids?: number[]) => this.call('POST', '/alerts/read', ids ? { ids } : {});
  metrics = (projectId?: string, days = 0) =>
    this.call<Metrics>('GET', `/metrics?${new URLSearchParams({ ...(projectId ? { projectId } : {}), days: String(days) })}`);
  spend = () => this.call<ProjectSpend[]>('GET', '/spend');
  setProjectBudget = (projectId: string, dailyUsd: number | null) => this.call<{ dailyCap: number }>('PUT', `/projects/${projectId}/budget`, { dailyUsd });

  settings = () => this.call<{ settings: Record<string, string>; secrets: SecretInfo[]; secretsBackend: 'keychain' | 'file' }>('GET', '/settings');
  saveSettings = (s: Record<string, string>) => this.call('PUT', '/settings', s);
  setSecret = (name: string, value: string) => this.call('PUT', `/secrets/${name}`, { value });
  deleteSecret = (name: string) => this.call('DELETE', `/secrets/${name}`);
}
