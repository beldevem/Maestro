import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { can, RIGHTS, type Action } from '../src/auth/policy.js';
import type { Role } from '../src/auth/roles.js';
import { ROUTE_RULES } from '../src/auth/routes.js';
import { Auth } from '../src/auth/sessions.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

const PASSWORD = 'a long test password';

async function world() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-perm-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent = { run: async () => ({ sessionId: 's', text: '[]', costUsd: 0, ok: true, structured: { items: [], answer: 'ok', actions: [] } }) };
  const app = await buildServer({ store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
  const auth = new Auth(store);
  const sessions: Record<string, string> = {};
  const users: Record<string, { id: string; roles: Role[] }> = {};
  for (const [name, roles] of [['pm', ['pm']], ['lead', ['lead']], ['dev', ['dev']]] as const) {
    const u = await auth.createUser({ email: `${name}@x.io`, name, password: PASSWORD, roles: [...roles] });
    users[name] = { id: u.id, roles: [...roles] };
    sessions[name] = u.id;
  }
  /** A fresh session per call (the matrix also calls logout). */
  const cookies = new Proxy({} as Record<string, string>, { get: (_t, who: string) => `maestro_session=${auth.startSession(sessions[who], null)}` });
  /** A fresh project the three are members of, with a run and a draft in it. */
  const fixture = () => {
    const p = store.createProject({ name: `P${Math.random()}`, description: '', codeHost: { provider: 'local', localPath: home, defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '' });
    for (const u of Object.values(users)) store.addMember(p.id, u.id, null);
    const run = store.createRun({ projectId: p.id, agentId: 'a', ticketKey: 'P-1', ticketTitle: 't', branch: 'b', worktree: join(home, 'none') });
    store.updateRun(run.id, { status: 'failed' });
    const draft = store.createDraft(p.id, [], 0);
    return { project: p.id, run: run.id, draft: draft.id };
  };
  return { app, store, cookies, users, fixture };
}

const SCOPE_PARAM: Record<string, 'project' | 'run' | 'draft'> = {};
for (const [key, rule] of Object.entries(ROUTE_RULES)) if (rule.scope) SCOPE_PARAM[key] = rule.scope;

describe('permissions', () => {
  it('every API route has a permission rule, and every rule a route', async () => {
    const { app } = await world();
    const routes = (app as unknown as { maestroRoutes: string[] }).maestroRoutes;
    const rules = Object.keys(ROUTE_RULES);
    expect(routes.filter((r) => !rules.includes(r))).toEqual([]);
    // Rules for routes built in later steps (users, activity, usage) are allowed to wait for them.
    const later: string[] = [];
    expect(rules.filter((r) => !routes.includes(r) && !later.some((l) => r.split(' ')[1].startsWith(l)))).toEqual([]);
    await app.close();
  });

  it('allows and refuses every route by role, as the role table says, and nothing without a session', async () => {
    const { app, cookies, users, fixture } = await world();
    const routes = (app as unknown as { maestroRoutes: string[] }).maestroRoutes;
    const outcomes: string[] = [];
    for (const route of routes) {
      const [method, path] = route.split(' ');
      const rule = ROUTE_RULES[route];
      // The event stream never ends for a logged-in user; it has its own tests.
      for (const who of route === 'GET /api/events' ? ['nobody'] : ['nobody', 'pm', 'dev', 'lead']) {
        const f = fixture();
        const scope = SCOPE_PARAM[route];
        const id = scope ? f[scope] : 'missing-id';
        const url = path
          .replace(':id', encodeURIComponent(id))
          .replace(':key', 'P-404')
          .replace(':actionId', 'missing')
          .replace(':userId', 'missing')
          .replace(':name', 'MISSING_SECRET')
          .replace(':provider', 'github');
        const res = await app.inject({ method: method as 'GET', url, headers: who === 'nobody' ? {} : { cookie: cookies[who] }, payload: method === 'GET' || method === 'DELETE' ? undefined : {} });
        let expected: 'allow' | 'deny';
        if (rule.action === 'public') expected = 'allow';
        else if (who === 'nobody') expected = 'deny';
        else if (rule.action === 'session') expected = 'allow';
        else expected = can({ ...users[who], email: '', name: who, mustChangePassword: false }, rule.action as Action) ? 'allow' : 'deny';
        const got = [401, 403].includes(res.statusCode) ? 'deny' : 'allow';
        if (got !== expected) outcomes.push(`${who} ${route} → ${res.statusCode} ${res.body.slice(0, 120)} (expected ${expected})`);
        if (who === 'nobody' && rule.action !== 'public') expect(res.statusCode, route).toBe(401);
      }
    }
    expect(outcomes).toEqual([]);
    await app.close();
  }, 60_000);

  it('the role table: a Project Manager never starts AI work, a Tech Lead never manages people', () => {
    const roles = (a: Action) => RIGHTS[a];
    for (const a of ['run.start', 'run.control', 'run.merge', 'planner.run', 'settings.manage', 'workers.manage', 'project.configure'] as Action[]) expect(roles(a)).not.toContain('pm');
    for (const a of ['users.manage', 'project.members'] as Action[]) expect(roles(a)).toEqual(['pm']);
    expect(roles('run.merge')).toEqual(['lead']);
    expect(roles('run.review')).toEqual(['lead', 'dev']);
    expect(roles('chat.ask')).toEqual(['pm', 'lead', 'dev']);
    expect(roles('ticket.edit')).toEqual(['pm', 'lead', 'dev']);
  });

  it('chat proposals: a Project Manager may confirm ticket changes but not agent work, and is never offered it', async () => {
    const { app, store, cookies, users, fixture } = await world();
    const f = fixture();
    const t = store.createThread({ projectId: f.project, userId: users.pm.id });
    const msg = store.addChatMessage(`chat:${t.id}`, 'assistant', 'ok');
    const name = store.getProject(f.project)!.name;
    const assign = store.addChatAction(`chat:${t.id}`, msg.id, { type: 'assign', summary: 'x', action: { type: 'assign', project: name, ticketKey: 'P-1' } });
    const create = store.addChatAction(`chat:${t.id}`, msg.id, { type: 'create_ticket', summary: 'x', action: { type: 'create_ticket', project: name, title: 'By the PM' } });
    const refused = await app.inject({ method: 'POST', url: `/api/chat/actions/${assign.id}`, headers: { cookie: cookies.pm } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('This needs the Tech Lead or Developer role.');
    // Refused, it stays pending for someone who may confirm it.
    expect(store.getThreadAction(assign.id)!.state).toBe('pending');
    const ok = await app.inject({ method: 'POST', url: `/api/chat/actions/${create.id}`, headers: { cookie: cookies.pm } });
    expect(ok.json().message).toMatch(/^Created /);
    await app.close();
  });
});
