import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_RULES } from '../src/auth/routes.js';
import { Auth } from '../src/auth/sessions.js';
import type { Role } from '../src/auth/roles.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

async function world() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-share-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent = { run: async () => ({ sessionId: 's', text: 'ok', costUsd: 0, ok: true, structured: { answer: 'ok', actions: [] } }) };
  const app = await buildServer({ store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
  const auth = new Auth(store);
  const ids: Record<string, string> = {};
  for (const [name, roles] of [['pm', ['pm']], ['lead', ['lead']], ['dev', ['dev']], ['outsider', ['dev']]] as [string, Role[]][]) {
    ids[name] = (await auth.createUser({ email: `${name}@x.io`, name, password: 'a long test password', roles })).id;
  }
  const as = (who: string) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: `maestro_session=${auth.startSession(ids[who], null)}` } });
  const project = (name: string) => store.createProject({ name, description: '', codeHost: { provider: 'local', localPath: home, defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '' });
  return { app, store, ids, as, project };
}

describe('shared projects', () => {
  it('a non-member can’t see or reach a project through any route', async () => {
    const { app, store, ids, as, project } = await world();
    const p = project('Secret');
    store.addMember(p.id, ids.dev, null);
    const run = store.createRun({ projectId: p.id, agentId: 'a', ticketKey: 'S-1', ticketTitle: 't', branch: 'b', worktree: '' });
    const draft = store.createDraft(p.id, [], 0);
    store.addAlert({ projectId: p.id, runId: run.id, kind: 'failed', message: 'S-1 failed' });

    const outsider = as('outsider');
    for (const [route, rule] of Object.entries(ROUTE_RULES)) {
      if (!rule.scope) continue;
      const [method, path] = route.split(' ');
      const id = rule.scope === 'project' ? p.id : rule.scope === 'run' ? run.id : draft.id;
      const res = await outsider(method as 'GET', path.replace(':id', id).replace(':key', 'S-1').replace(':actionId', 'x'), method === 'GET' || method === 'DELETE' ? undefined : {});
      // Refused either way: 404 where a Developer could act in their own project, 403 where no Developer could.
      expect([403, 404], route).toContain(res.statusCode);
    }
    // And no list shows it.
    expect((await outsider('GET', '/api/projects')).json()).toEqual([]);
    expect((await outsider('GET', '/api/runs')).json()).toEqual([]);
    expect((await outsider('GET', '/api/spend')).json()).toEqual([]);
    expect((await outsider('GET', '/api/alerts')).json().alerts).toEqual([]);
    expect((await outsider('GET', '/api/overview')).json().projects).toEqual([]);
    expect((await outsider('GET', `/api/metrics?projectId=${p.id}`)).statusCode).toBe(404);
    expect((await outsider('POST', '/api/chat', { message: 'hi', projectId: p.id })).statusCode).toBe(404);
    // The member sees it; a Tech Lead sees every project.
    expect((await as('dev')('GET', '/api/projects')).json().map((x: { name: string }) => x.name)).toEqual(['Secret']);
    expect((await as('dev')('GET', '/api/runs')).json()).toHaveLength(1);
    expect((await as('lead')('GET', '/api/projects')).json()).toHaveLength(1);
    await app.close();
  });

  it('Project Managers manage members; removing one hides the project at once', async () => {
    const { app, ids, as, project } = await world();
    const p = project('Shop');
    const pm = as('pm');
    expect((await as('lead')('PUT', `/api/projects/${p.id}/members/${ids.dev}`)).statusCode).toBe(403);
    expect((await pm('PUT', `/api/projects/${p.id}/members/${ids.dev}`)).json()).toEqual({ ok: true });
    // A Project Manager can add themselves to any project.
    await pm('PUT', `/api/projects/${p.id}/members/${ids.pm}`);
    expect((await pm('GET', `/api/projects/${p.id}/members`)).json().map((m: { name: string }) => m.name)).toEqual(['dev', 'pm']);
    expect((await as('dev')('GET', `/api/projects/${p.id}`)).statusCode).toBe(200);
    await pm('DELETE', `/api/projects/${p.id}/members/${ids.dev}`);
    expect((await as('dev')('GET', `/api/projects/${p.id}`)).statusCode).toBe(404);
    await app.close();
  });

  it('conversations are private', async () => {
    const { app, as } = await world();
    const mine = (await as('dev')('POST', '/api/chat', { message: 'my question' })).json().thread;
    expect((await as('dev')('GET', '/api/chat/threads')).json()).toHaveLength(1);
    expect((await as('lead')('GET', '/api/chat/threads')).json()).toEqual([]);
    expect((await as('lead')('GET', `/api/chat/threads/${mine.id}`)).statusCode).toBe(404);
    expect((await as('lead')('POST', '/api/chat', { message: 'sneak', threadId: mine.id })).statusCode).toBe(404);
    expect((await as('lead')('DELETE', `/api/chat/threads/${mine.id}`)).statusCode).toBe(404);
    await app.close();
  });
});

describe('people', () => {
  it('a Project Manager adds a person with a one-time password, resets and deactivates them', async () => {
    const { app, store, as, project } = await world();
    const p = project('Shop');
    const pm = as('pm');
    const added = (await pm('POST', '/api/users', { email: 'new@x.io', name: 'New Person', roles: ['dev'], projects: [p.id] })).json();
    expect(added.password).toMatch(/^[a-zA-Z2-9]{5}(-[a-zA-Z2-9]{5}){3}$/);
    expect(added.user).toMatchObject({ email: 'new@x.io', roles: ['dev'], mustChangePassword: true, projects: [p.id] });
    expect((await pm('POST', '/api/users', { email: 'new@x.io', name: 'Again', roles: ['dev'] })).statusCode).toBe(409);
    expect((await pm('POST', '/api/users', { email: 'x@x.io', name: 'X', roles: [] })).statusCode).toBe(400);

    // Logging in with the one-time password requires choosing a new one.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@x.io', password: added.password } });
    expect(login.json().user.mustChangePassword).toBe(true);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).json().code).toBe('password_change_required');

    const reset = (await pm('POST', `/api/users/${added.user.id}/reset-password`)).json();
    expect(reset.password).not.toBe(added.password);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })).json().user).toBeNull();

    expect((await pm('DELETE', `/api/users/${added.user.id}`)).json()).toEqual({ ok: true });
    expect(store.getUser(added.user.id)!.deactivatedAt).not.toBeNull();
    expect(store.memberProjectIds(added.user.id).size).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@x.io', password: reset.password } })).statusCode).toBe(401);
    // Only Project Managers manage people; others see names and roles only.
    expect((await as('lead')('POST', '/api/users', { email: 'y@x.io', name: 'Y', roles: ['dev'] })).statusCode).toBe(403);
    const seen = (await as('dev')('GET', '/api/users')).json();
    expect(seen.projects).toBeUndefined();
    expect(Object.keys(seen.users[0]).sort()).toEqual(['active', 'id', 'name', 'roles']);
    await app.close();
  });

  it('never leaves Maestro without a Project Manager, and nobody deletes themselves', async () => {
    const { app, ids, as } = await world();
    const pm = as('pm');
    expect((await pm('DELETE', `/api/users/${ids.pm}`)).json().error).toBe("You can't delete your own account.");
    expect((await pm('PATCH', `/api/users/${ids.pm}`, { roles: ['dev'] })).json().error).toMatch(/at least one Project Manager/);
    // With a second Project Manager, the first can step down.
    await pm('PATCH', `/api/users/${ids.lead}`, { roles: ['lead', 'pm'] });
    expect((await pm('PATCH', `/api/users/${ids.pm}`, { roles: ['dev'] })).json().roles).toEqual(['dev']);
    expect((await as('lead')('DELETE', `/api/users/${ids.lead}`)).json().error).toBe("You can't delete your own account.");
    expect((await as('lead')('PATCH', `/api/users/${ids.lead}`, { roles: ['lead'] })).json().error).toMatch(/at least one Project Manager/);
    await app.close();
  });
});
