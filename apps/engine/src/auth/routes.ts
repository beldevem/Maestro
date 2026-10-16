import type { Action } from './policy.js';

/** Where a route's project comes from: its own :id, or the run or draft it names. */
export type Scope = 'project' | 'run' | 'draft';

export interface RouteRule {
  /** 'public': no session; 'session': any logged-in user (lists are filtered to what they can see). */
  action: Action | 'session' | 'public';
  scope?: Scope;
}

const r = (action: RouteRule['action'], scope?: Scope): RouteRule => ({ action, scope });

/**
 * The permission rule of every API route, as "METHOD /path". A route missing here is refused,
 * so a new route can't be reachable by mistake (a test checks that every route has a rule).
 */
export const ROUTE_RULES: Record<string, RouteRule> = {
  'GET /api/health': r('public'),
  'GET /api/ready': r('public'),
  'GET /api/auth/status': r('public'),
  'POST /api/auth/setup': r('public'),
  'POST /api/auth/login': r('public'),
  'POST /api/auth/logout': r('session'),
  'POST /api/auth/password': r('session'),
  'GET /api/events': r('session'),
  'GET /api/currency': r('session'),
  'GET /api/templates': r('session'),

  'GET /api/projects': r('session'),
  'POST /api/projects': r('project.create'),
  'GET /api/projects/:id': r('project.view', 'project'),
  'PATCH /api/projects/:id': r('project.configure', 'project'),
  'DELETE /api/projects/:id': r('project.delete', 'project'),
  'POST /api/projects/:id/check': r('project.configure', 'project'),
  'GET /api/fs/dirs': r('project.create'),
  'GET /api/fs/check': r('project.create'),
  'GET /api/projects/:id/memory': r('project.view', 'project'),
  'PUT /api/projects/:id/memory': r('project.configure', 'project'),
  'DELETE /api/projects/:id/memory': r('project.configure', 'project'),
  'GET /api/projects/:id/roles': r('project.view', 'project'),
  'PUT /api/projects/:id/roles': r('project.configure', 'project'),
  'PUT /api/projects/:id/budget': r('project.configure', 'project'),
  'GET /api/projects/:id/auto-assign': r('project.view', 'project'),
  'PUT /api/projects/:id/auto-assign': r('project.configure', 'project'),
  'GET /api/projects/:id/members': r('project.view', 'project'),
  'PUT /api/projects/:id/members/:userId': r('project.members'),
  'DELETE /api/projects/:id/members/:userId': r('project.members'),

  'GET /api/projects/:id/tickets': r('project.view', 'project'),
  'POST /api/projects/:id/tickets': r('ticket.edit', 'project'),
  'POST /api/projects/:id/tickets/:key/status': r('ticket.edit', 'project'),
  'POST /api/projects/:id/tickets/:key/start': r('run.start', 'project'),
  'POST /api/projects/:id/plan': r('planner.run', 'project'),
  'GET /api/projects/:id/drafts': r('project.view', 'project'),
  'PATCH /api/drafts/:id': r('planner.run', 'draft'),
  'POST /api/drafts/:id/approve': r('planner.run', 'draft'),
  'POST /api/drafts/:id/discard': r('planner.run', 'draft'),

  'GET /api/runs': r('session'),
  'GET /api/runs/:id': r('project.view', 'run'),
  'GET /api/runs/:id/diff': r('project.view', 'run'),
  'POST /api/runs/:id/stop': r('run.control', 'run'),
  'POST /api/runs/:id/reviews': r('run.review', 'run'),
  'POST /api/runs/:id/merge': r('run.merge', 'run'),
  'DELETE /api/runs/:id/worktree': r('run.control', 'run'),
  'POST /api/projects/:id/cleanup': r('run.control', 'project'),
  'GET /api/pull-requests': r('session'),
  'POST /api/pull-requests/poll': r('run.control'),

  'GET /api/agents': r('session'),
  'POST /api/agents': r('workers.manage'),
  'PATCH /api/agents/:id': r('workers.manage'),
  'POST /api/agents/:id/action': r('workers.manage'),
  'DELETE /api/agents/:id': r('workers.manage'),

  'GET /api/projects/:id/chat': r('chat.ask', 'project'),
  'POST /api/projects/:id/chat': r('chat.ask', 'project'),
  'DELETE /api/projects/:id/chat': r('project.configure', 'project'),
  'POST /api/projects/:id/chat/actions/:actionId': r('chat.ask', 'project'),
  'DELETE /api/projects/:id/chat/actions/:actionId': r('chat.ask', 'project'),
  'GET /api/chat/threads': r('chat.ask'),
  'POST /api/chat/threads': r('chat.ask'),
  'GET /api/chat/threads/:id': r('chat.ask'),
  'PATCH /api/chat/threads/:id': r('chat.ask'),
  'DELETE /api/chat/threads/:id': r('chat.ask'),
  'GET /api/chat/models': r('chat.ask'),
  'POST /api/chat': r('chat.ask'),
  'POST /api/chat/actions/:actionId': r('chat.ask'),
  'DELETE /api/chat/actions/:actionId': r('chat.ask'),

  'GET /api/overview': r('session'),
  'GET /api/alerts': r('session'),
  'POST /api/alerts/read': r('session'),
  'GET /api/metrics': r('session'),
  'GET /api/spend': r('session'),

  'GET /api/providers': r('session'),
  'GET /api/providers/:id/models': r('session'),
  'PUT /api/providers/:id': r('settings.manage'),
  'DELETE /api/providers/:id': r('settings.manage'),
  'POST /api/providers/:id/test': r('settings.manage'),
  'PUT /api/roles': r('settings.manage'),
  'GET /api/settings': r('settings.manage'),
  'GET /api/system/checks': r('settings.manage'),
  'PUT /api/settings': r('settings.manage'),
  'POST /api/settings/test/:provider': r('settings.manage'),
  'PUT /api/secrets/:name': r('settings.manage'),
  'DELETE /api/secrets/:name': r('settings.manage'),

  'GET /api/users': r('session'),
  'POST /api/users': r('users.manage'),
  'PATCH /api/users/:id': r('users.manage'),
  'POST /api/users/:id/reset-password': r('users.manage'),
  'DELETE /api/users/:id': r('users.manage'),
  'GET /api/me/rights': r('session'),
  'GET /api/activity': r('session'),
  'GET /api/usage/users': r('session'),
};
