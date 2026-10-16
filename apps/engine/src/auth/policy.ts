import { ROLE_LABEL, type Role, type SessionUser } from './roles.js';

/**
 * Everything a person can do in Maestro. The engine checks one of these on every API route;
 * the dashboard reads the same table to hide or disable what someone can't do.
 */
export type Action =
  | 'project.view' // a project's board, tickets, runs, PRs, metrics, usage, members
  | 'project.create'
  | 'project.configure' // details, connectors, workflow, memory, AI overrides, budget, auto-assign
  | 'project.delete'
  | 'project.members' // add and remove members
  | 'ticket.edit' // create, edit and move tickets by hand
  | 'run.start' // assign a ticket to an agent
  | 'run.control' // stop a run, guide a blocked one, clean up worktrees, refresh PRs
  | 'run.review' // approve or request changes
  | 'run.merge'
  | 'planner.run' // the AI planner and its drafts
  | 'chat.ask'
  | 'workers.manage'
  | 'settings.manage' // AI providers, secrets, settings, connection tests
  | 'users.manage' // add and delete users, roles, password resets
  | 'activity.viewAll' // everyone's activity (otherwise your own)
  | 'usage.viewAll'; // usage by every user

/** The role table: who may do what. Change roles here and nowhere else. */
export const RIGHTS: Record<Action, readonly Role[]> = {
  'project.view': ['pm', 'lead', 'dev'],
  'project.create': ['lead'],
  'project.configure': ['lead'],
  'project.delete': ['lead'],
  'project.members': ['pm'],
  'ticket.edit': ['pm', 'lead', 'dev'],
  'run.start': ['lead', 'dev'],
  'run.control': ['lead', 'dev'],
  'run.review': ['lead', 'dev'],
  'run.merge': ['lead'],
  'planner.run': ['lead', 'dev'],
  'chat.ask': ['pm', 'lead', 'dev'],
  'workers.manage': ['lead'],
  'settings.manage': ['lead'],
  'users.manage': ['pm'],
  'activity.viewAll': ['pm', 'lead'],
  'usage.viewAll': ['pm', 'lead'],
};

/** Actions on one project: the person must also be able to see that project. */
const SCOPED = new Set<Action>(['project.view', 'project.configure', 'project.delete', 'ticket.edit', 'run.start', 'run.control', 'run.review', 'run.merge', 'planner.run', 'chat.ask']);

/** Tech Leads see every project; others see the projects they are members of. */
export function seesAllProjects(user: SessionUser): boolean {
  return user.roles.includes('lead');
}

export interface Membership {
  isMember(projectId: string, userId: string): boolean;
}

/** May `user` do `action` (on `projectId`, when the action is about one project)? */
export function can(user: SessionUser | undefined, action: Action, projectId?: string | null, members?: Membership): boolean {
  if (!user) return false;
  if (!RIGHTS[action].some((r) => user.roles.includes(r))) return false;
  if (!projectId || !SCOPED.has(action) || seesAllProjects(user)) return true;
  return !!members?.isMember(projectId, user.id);
}

/** What a refusal says: the roles that may do it. */
export function neededRoles(action: Action): string {
  const names = RIGHTS[action].map((r) => ROLE_LABEL[r]);
  return names.length === 1 ? `the ${names[0]} role` : `the ${names.slice(0, -1).join(', ')} or ${names.at(-1)} role`;
}

/** Chat proposals, by what confirming them does. */
export const CHAT_ACTION_RIGHTS: Record<string, Action> = {
  create_ticket: 'ticket.edit',
  move_ticket: 'ticket.edit',
  assign: 'run.start',
  plan_backlog: 'planner.run',
  pause_agent: 'workers.manage',
  resume_agent: 'workers.manage',
};

/** Every action someone holds, for the dashboard. */
export function actionsOf(user: SessionUser): Action[] {
  return (Object.keys(RIGHTS) as Action[]).filter((a) => RIGHTS[a].some((r) => user.roles.includes(r)));
}
