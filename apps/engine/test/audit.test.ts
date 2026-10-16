import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { AUDIT_RULES, NOT_AUDITED } from '../src/auth/audit.js';
import { ROUTE_RULES } from '../src/auth/routes.js';
import { Auth } from '../src/auth/sessions.js';
import type { Role } from '../src/auth/roles.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

class Writer implements CodingAgent {
  async run(task: AgentTask): Promise<AgentOutcome> {
    if (task.outputSchema) return { sessionId: 'r', text: '', costUsd: 0, ok: true, structured: { verdict: 'approve', summary: '', comments: [] } };
    writeFileSync(join(task.cwd, 'hello.txt'), 'hello\n');
    return { sessionId: 's', text: 'done', costUsd: 0, ok: true };
  }
}

async function world() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-audit-'));
  const repo = join(home, 'app');
  mkdirSync(repo);
  await git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# app\n');
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent = new Writer();
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: join(home, 'wt') });
  const app = await buildServer({ store, secrets, agent, orchestrator, reposDir: home });
  const auth = new Auth(store);
  const ids: Record<string, string> = {};
  for (const [name, roles] of [['pm', ['pm']], ['lead', ['lead']], ['dev', ['dev']]] as [string, Role[]][]) {
    ids[name] = (await auth.createUser({ email: `${name}@x.io`, name: name.toUpperCase(), password: 'a long test password', roles })).id;
  }
  const as = (who: string) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: `maestro_session=${auth.startSession(ids[who], null)}` } });
  const p = store.createProject({
    name: 'Shop', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} },
    context: '', requirements: '', bestPractices: '', workflowYaml: 'pull_before_start: false\nquality_gates: []\n',
  });
  for (const id of Object.values(ids)) store.addMember(p.id, id, null);
  store.createAgent({ name: 'W', role: 'worker', model: '' });
  const settle = async (runId: string) => {
    const until = Date.now() + 10_000;
    while (['running', 'reviewing'].includes(store.getRun(runId)!.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  };
  return { app, store, ids, as, p, settle };
}

describe('activity log', () => {
  it('every changing route has an audit rule', () => {
    const changing = Object.keys(ROUTE_RULES).filter((k) => !k.startsWith('GET '));
    expect(changing.filter((k) => !AUDIT_RULES[k] && !NOT_AUDITED.has(k))).toEqual([]);
  });

  it('records each action once, with who did it, and never a secret value', async () => {
    const { app, store, ids, as, p, settle } = await world();
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'dev@x.io', password: 'wrong password!!' } });
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'dev@x.io', password: 'a long test password' } });
    const ticket = (await as('pm')('POST', `/api/projects/${p.id}/tickets`, { title: 'Say hello', acceptanceCriteria: 'hello.txt' })).json();
    const run = (await as('dev')('POST', `/api/projects/${p.id}/tickets/${ticket.key}/start`, {})).json();
    await settle(run.id);
    await as('lead')('PUT', '/api/secrets/GITHUB_TOKEN', { value: 'ghp_supersecretvalue1234567890abcd' });
    await as('lead')('PUT', '/api/settings', { maxConcurrentRuns: '2' });
    await as('pm')('PUT', `/api/projects/${p.id}/members/${ids.lead}`);
    // Refused attempts change nothing, so they leave nothing.
    await as('pm')('POST', `/api/projects/${p.id}/tickets/${ticket.key}/start`, {});

    const log = store.listAudit();
    const summary = log.map((e) => `${e.userId === ids.pm ? 'pm' : e.userId === ids.dev ? 'dev' : e.userId === ids.lead ? 'lead' : e.userId} ${e.action}`).reverse();
    expect(summary).toEqual([
      'dev auth.login_failed', 'dev auth.login', 'pm ticket.create', 'dev run.start', 'system run.review', 'lead secret.set', 'lead settings.update', 'pm member.add',
    ]);
    expect(log.find((e) => e.action === 'secret.set')).toMatchObject({ targetType: 'secret', targetId: 'GITHUB_TOKEN', detail: null });
    expect(log.find((e) => e.action === 'run.start')).toMatchObject({ projectId: p.id, targetId: ticket.key, detail: { ticket: ticket.key, trigger: 'manual' } });
    expect(log.find((e) => e.action === 'settings.update')!.detail).toEqual({ keys: ['maxConcurrentRuns'] });
    const everything = JSON.stringify(store.db.prepare('SELECT * FROM audit_log').all());
    expect(everything).not.toContain('supersecret');
    expect(everything).not.toContain('a long test password');
    expect(everything).not.toContain('wrong password');
    // The run knows who started it.
    expect(store.getRun(run.id)).toMatchObject({ startedBy: ids.dev, trigger: 'manual' });
    await app.close();
  });

  it('auto-assigned runs are credited to whoever switched auto-assign on', async () => {
    const { app, store, ids, as, p, settle } = await world();
    await as('pm')('POST', `/api/projects/${p.id}/tickets`, { title: 'Auto one', acceptanceCriteria: 'x' });
    await as('lead')('PUT', `/api/projects/${p.id}/auto-assign`, { enabled: true });
    const until = Date.now() + 5000;
    while (!store.listRuns(p.id).length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    const [run] = store.listRuns(p.id);
    await settle(run.id);
    expect(run).toMatchObject({ startedBy: ids.lead, trigger: 'auto' });
    expect(store.listAudit({ action: 'run.start' })[0]).toMatchObject({ userId: ids.lead, detail: { trigger: 'auto' } });
    await app.close();
  });

  it('Project Managers and Tech Leads see everyone’s activity, a Developer only their own', async () => {
    const { app, ids, as, p } = await world();
    await as('pm')('POST', `/api/projects/${p.id}/tickets`, { title: 'By the PM' });
    await as('dev')('POST', `/api/projects/${p.id}/tickets`, { title: 'By the dev' });
    const all = (await as('lead')('GET', '/api/activity')).json();
    expect(all.map((e: { userName: string }) => e.userName)).toEqual(['DEV', 'PM']);
    expect(all[0]).toMatchObject({ action: 'ticket.create', projectName: 'Shop', detail: { title: 'By the dev' } });
    expect((await as('pm')('GET', `/api/activity?userId=${ids.dev}`)).json()).toHaveLength(1);
    expect((await as('lead')('GET', '/api/activity?action=ticket')).json()).toHaveLength(2);
    const own = (await as('dev')('GET', `/api/activity?userId=${ids.pm}`)).json();
    expect(own.map((e: { userName: string }) => e.userName)).toEqual(['DEV']);
    await app.close();
  });
});
