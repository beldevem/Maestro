/**
 * What each changing API route records in the activity log: an action name, what it acted on, and a
 * few safe details. Details are built from an allowlist of fields, so no secret value or message
 * text is ever stored (a secret's name, never its value).
 */
type Params = Record<string, string>;
type Body = Record<string, unknown>;

export interface AuditRule {
  action: string;
  target: string;
  /** The target's id; default: the route's :id. */
  id?: (p: Params, body: Body) => string | undefined;
  detail?: (p: Params, body: Body) => Record<string, unknown>;
}

const pick = (body: Body, ...keys: string[]) => Object.fromEntries(keys.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
const a = (action: string, target: string, detail?: AuditRule['detail'], id?: AuditRule['id']): AuditRule => ({ action, target, detail, id });

export const AUDIT_RULES: Record<string, AuditRule> = {
  'POST /api/auth/setup': a('account.setup', 'user', (_p, b) => pick(b, 'email')),
  'POST /api/auth/logout': a('auth.logout', 'user'),
  'POST /api/auth/password': a('auth.password_change', 'user'),

  'POST /api/projects': a('project.create', 'project', (_p, b) => pick(b, 'name'), () => undefined),
  'PATCH /api/projects/:id': a('project.update', 'project', (_p, b) => ({ fields: Object.keys(b ?? {}) })),
  'DELETE /api/projects/:id': a('project.delete', 'project'),
  'POST /api/projects/:id/check': a('project.check', 'project'),
  'PUT /api/projects/:id/memory': a('project.memory_update', 'project'),
  'DELETE /api/projects/:id/memory': a('project.memory_discard', 'project'),
  'PUT /api/projects/:id/roles': a('project.ai_update', 'project', (_p, b) => ({ roles: Object.keys(b ?? {}) })),
  'PUT /api/projects/:id/budget': a('project.budget_update', 'project', (_p, b) => pick(b, 'dailyTokens', 'dailyEur')),
  'PUT /api/projects/:id/auto-assign': a('project.auto_assign', 'project', (_p, b) => pick(b, 'enabled')),
  'PUT /api/projects/:id/members/:userId': a('member.add', 'user', undefined, (p) => p.userId),
  'DELETE /api/projects/:id/members/:userId': a('member.remove', 'user', undefined, (p) => p.userId),

  'POST /api/projects/:id/tickets': a('ticket.create', 'ticket', (_p, b) => pick(b, 'title'), () => undefined),
  'POST /api/projects/:id/tickets/:key/status': a('ticket.move', 'ticket', (_p, b) => pick(b, 'status'), (p) => p.key),
  'POST /api/projects/:id/tickets/:key/start': a('run.start', 'ticket', (p) => ({ ticket: p.key, trigger: 'manual' }), (p) => p.key),
  'POST /api/projects/:id/plan': a('planner.run', 'project'),
  'PATCH /api/drafts/:id': a('draft.update', 'draft'),
  'POST /api/drafts/:id/approve': a('draft.approve', 'draft'),
  'POST /api/drafts/:id/discard': a('draft.discard', 'draft'),

  'POST /api/runs/:id/stop': a('run.stop', 'run'),
  'POST /api/runs/:id/reviews': a('run.review', 'run', (_p, b) => pick(b, 'verdict')),
  'POST /api/runs/:id/merge': a('run.merge', 'run'),
  'DELETE /api/runs/:id/worktree': a('run.worktree_remove', 'run'),
  'POST /api/projects/:id/cleanup': a('run.cleanup', 'project'),
  'POST /api/pull-requests/poll': a('pr.refresh', 'pull_request'),

  'POST /api/agents': a('worker.create', 'worker', (_p, b) => pick(b, 'name', 'provider', 'model')),
  'PATCH /api/agents/:id': a('worker.update', 'worker', (_p, b) => pick(b, 'name', 'provider', 'model')),
  'POST /api/agents/:id/action': a('worker.action', 'worker', (_p, b) => pick(b, 'action')),
  'DELETE /api/agents/:id': a('worker.delete', 'worker'),

  'POST /api/projects/:id/chat': a('chat.ask', 'project'),
  'DELETE /api/projects/:id/chat': a('chat.clear', 'project'),
  'POST /api/projects/:id/chat/actions/:actionId': a('chat.confirm', 'proposal', undefined, (p) => p.actionId),
  'DELETE /api/projects/:id/chat/actions/:actionId': a('chat.dismiss', 'proposal', undefined, (p) => p.actionId),
  'POST /api/chat': a('chat.ask', 'conversation', undefined, (_p, b) => b?.threadId as string | undefined),
  'POST /api/chat/threads': a('chat.new', 'conversation'),
  'PATCH /api/chat/threads/:id': a('chat.update', 'conversation', (_p, b) => ({ fields: Object.keys(b ?? {}) })),
  'DELETE /api/chat/threads/:id': a('chat.delete', 'conversation'),
  'POST /api/chat/actions/:actionId': a('chat.confirm', 'proposal', undefined, (p) => p.actionId),
  'DELETE /api/chat/actions/:actionId': a('chat.dismiss', 'proposal', undefined, (p) => p.actionId),

  'PUT /api/providers/:id': a('provider.save', 'provider', (_p, b) => pick(b, 'name', 'kind', 'baseUrl')),
  'DELETE /api/providers/:id': a('provider.delete', 'provider'),
  'POST /api/providers/:id/test': a('provider.test', 'provider'),
  'PUT /api/roles': a('settings.ai_roles', 'settings', (_p, b) => ({ roles: Object.keys(b ?? {}) })),
  'PUT /api/settings': a('settings.update', 'settings', (_p, b) => ({ keys: Object.keys(b ?? {}) })),
  'POST /api/settings/test/:provider': a('settings.test', 'connection', undefined, (p) => p.provider),
  'PUT /api/secrets/:name': a('secret.set', 'secret', undefined, (p) => p.name),
  'DELETE /api/secrets/:name': a('secret.delete', 'secret', undefined, (p) => p.name),

  'POST /api/users': a('user.create', 'user', (_p, b) => pick(b, 'email', 'roles')),
  'PATCH /api/users/:id': a('user.update', 'user', (_p, b) => pick(b, 'name', 'roles', 'active')),
  'POST /api/users/:id/reset-password': a('user.password_reset', 'user'),
  'DELETE /api/users/:id': a('user.delete', 'user'),
};

/** Routes that change nothing worth recording. */
export const NOT_AUDITED = new Set(['POST /api/alerts/read', 'POST /api/auth/login']);
