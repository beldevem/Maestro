import { Injectable } from '@angular/core';
import type { ActivityEntry, UserUsage, SessionUser, UserRole, UserView, Agent, Alert, BacklogDraft, Caps, ChatThread, DirListing, Usage, ChatAction, ChatMessage, ChatModels, Choice, Metrics, Overview, ProviderConfig, ProviderView, ProvidersInfo, Role, ProjectTemplate, ProjectSpend, BacklogItem, Project, PullRequestRow, Review, ReviewComment, Run, RunEvent, SecretInfo, Ticket, TicketStatus } from './models';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly reasons: string[] = [], readonly code?: string) {
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
    if (!res.ok) {
      // A lost session or a required password change sends the app to the right page (see Session).
      if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('maestro:unauthorized'));
      if (res.status === 403 && data?.code === 'password_change_required') window.dispatchEvent(new CustomEvent('maestro:password-required'));
      throw new ApiError(data?.error ?? res.statusText, res.status, data?.reasons ?? [], data?.code);
    }
    return data as T;
  }

  authStatus = () => this.call<{ setupNeeded: boolean; user: SessionUser | null }>('GET', '/auth/status');
  login = (email: string, password: string) => this.call<{ user: SessionUser }>('POST', '/auth/login', { email, password });
  setup = (account: { email: string; name: string; password: string }) => this.call<{ user: SessionUser }>('POST', '/auth/setup', account);
  logout = () => this.call('POST', '/auth/logout', {});
  myRights = () => this.call<{ actions: string[]; seesAllProjects: boolean; table: Record<string, UserRole[]> }>('GET', '/me/rights');
  changePassword = (current: string, next: string) => this.call<{ user: SessionUser }>('POST', '/auth/password', { current, next });

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
  mergeRun = (id: string) => this.call<Run>('POST', `/runs/${id}/merge`, {});
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

  overview = () => this.call<Overview>('GET', '/overview');
  /** Dashboard conversations, most recent activity first. */
  chatThreads = () => this.call<ChatThread[]>('GET', '/chat/threads');
  chatThread = (id: string) => this.call<{ thread: ChatThread; messages: ChatMessage[] }>('GET', `/chat/threads/${id}`);
  createChatThread = (init: { projectId?: string | null; model?: Choice | null } = {}) => this.call<ChatThread>('POST', '/chat/threads', init);
  updateChatThread = (id: string, patch: { title?: string; projectId?: string | null; model?: Choice | null }) => this.call<ChatThread>('PATCH', `/chat/threads/${id}`, patch);
  deleteChatThread = (id: string) => this.call('DELETE', `/chat/threads/${id}`);
  /** Asks in a conversation; without a threadId the engine starts a new one. */
  globalChat = (message: string, threadId?: string, projectId?: string | null) =>
    this.call<ChatMessage & { answer: string; costUsd: number; usage: Usage | null; actions: ChatAction[]; thread: ChatThread }>('POST', '/chat', {
      message, ...(threadId ? { threadId } : {}), ...(projectId !== undefined ? { projectId } : {}),
    });
  chatModels = () => this.call<ChatModels>('GET', '/chat/models');
  confirmGlobalAction = (actionId: string) => this.call<{ message: string; runId?: string }>('POST', `/chat/actions/${actionId}`, {});
  dismissGlobalAction = (actionId: string) => this.call('DELETE', `/chat/actions/${actionId}`);
  chatHistory = (projectId: string) => this.call<ChatMessage[]>('GET', `/projects/${projectId}/chat`);
  clearChat = (projectId: string) => this.call('DELETE', `/projects/${projectId}/chat`);
  chat = (projectId: string, message: string) =>
    this.call<ChatMessage & { answer: string; costUsd: number; usage: Usage | null; actions: ChatAction[] }>('POST', `/projects/${projectId}/chat`, { message });
  confirmAction = (projectId: string, actionId: string) =>
    this.call<{ message: string; runId?: string }>('POST', `/projects/${projectId}/chat/actions/${actionId}`, {});
  dismissAction = (projectId: string, actionId: string) => this.call('DELETE', `/projects/${projectId}/chat/actions/${actionId}`);

  alerts = () => this.call<{ alerts: Alert[]; unread: number }>('GET', '/alerts');
  markAlertsRead = (ids?: number[]) => this.call('POST', '/alerts/read', ids ? { ids } : {});
  metrics = (projectId?: string, days = 0) =>
    this.call<Metrics>('GET', `/metrics?${new URLSearchParams({ ...(projectId ? { projectId } : {}), days: String(days) })}`);
  spend = () => this.call<ProjectSpend[]>('GET', '/spend');
  /** null puts a cap back to the default from Settings; a missing one stays as it is. */
  setProjectBudget = (projectId: string, caps: { dailyTokens?: number | null; dailyEur?: number | null }) =>
    this.call<{ dailyCaps: Caps }>('PUT', `/projects/${projectId}/budget`, caps);
  /** Subfolders for the local-folder picker (never files), inside the folders the engine may browse. */
  fsDirs = (path?: string, hidden = false) =>
    this.call<DirListing>('GET', `/fs/dirs?${new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: '1' } : {}) })}`);
  fsCheck = (path: string) => this.call<{ path: string; isGitRepo: boolean; branch: string | null }>('GET', `/fs/check?${new URLSearchParams({ path })}`);
  users = () => this.call<{ users: UserView[]; projects?: { id: string; name: string }[] }>('GET', '/users');
  createUser = (u: { email: string; name: string; roles: UserRole[]; projects?: string[] }) => this.call<{ user: UserView; password: string }>('POST', '/users', u);
  updateUser = (id: string, patch: { name?: string; roles?: UserRole[]; active?: boolean }) => this.call<UserView>('PATCH', `/users/${id}`, patch);
  resetPassword = (id: string) => this.call<{ password: string }>('POST', `/users/${id}/reset-password`, {});
  deleteUser = (id: string) => this.call('DELETE', `/users/${id}`);
  members = (projectId: string) => this.call<{ userId: string; name: string; roles: UserRole[]; addedAt: string }[]>('GET', `/projects/${projectId}/members`);
  addMember = (projectId: string, userId: string) => this.call('PUT', `/projects/${projectId}/members/${userId}`, {});
  removeMember = (projectId: string, userId: string) => this.call('DELETE', `/projects/${projectId}/members/${userId}`);
  activity = (f: Record<string, string | number | undefined>) =>
    this.call<ActivityEntry[]>('GET', `/activity?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`);
  usageByUser = (f: { days?: number; projectId?: string; today?: boolean } = {}) =>
    this.call<UserUsage[]>('GET', `/usage/users?${new URLSearchParams({ ...(f.days ? { days: String(f.days) } : {}), ...(f.projectId ? { projectId: f.projectId } : {}), ...(f.today ? { today: '1' } : {}) })}`);
  currency = () => this.call<{ eurPerUsd: number }>('GET', '/currency');

  settings = () => this.call<{ settings: Record<string, string>; secrets: SecretInfo[]; secretsBackend: 'keychain' | 'file' }>('GET', '/settings');
  providers = () => this.call<ProvidersInfo>('GET', '/providers');
  saveProvider = (p: ProviderConfig) => this.call<ProviderView>('PUT', `/providers/${p.id}`, p);
  deleteProvider = (id: string) => this.call('DELETE', `/providers/${id}`);
  testProvider = (id: string) => this.call<{ ok: boolean; message: string; models?: string[] }>('POST', `/providers/${id}/test`, {});
  providerModels = (id: string) => this.call<string[]>('GET', `/providers/${id}/models`);
  saveRoles = (roles: Partial<Record<Role, Choice>>) => this.call<Record<Role, Choice>>('PUT', '/roles', roles);
  projectRoles = (projectId: string) => this.call<Partial<Record<Role, Choice>>>('GET', `/projects/${projectId}/roles`);
  saveProjectRoles = (projectId: string, roles: Partial<Record<Role, Choice | null>>) => this.call<Partial<Record<Role, Choice>>>('PUT', `/projects/${projectId}/roles`, roles);
  testConnection = (provider: string) => this.call<{ ok: boolean; message: string }>('POST', `/settings/test/${provider}`, {});
  saveSettings = (s: Record<string, string>) => this.call('PUT', '/settings', s);
  setSecret = (name: string, value: string) => this.call('PUT', `/secrets/${name}`, { value });
  deleteSecret = (name: string) => this.call('DELETE', `/secrets/${name}`);
}
