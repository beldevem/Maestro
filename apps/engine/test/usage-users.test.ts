import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Auth } from '../src/auth/sessions.js';
import type { Role } from '../src/auth/roles.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

/** The worker uses 1000 input tokens, the reviewer 300, the chat 50 (and 0.01 USD each call). */
class Metered implements CodingAgent {
  async run(task: AgentTask): Promise<AgentOutcome> {
    if (task.outputSchema && 'verdict' in ((task.outputSchema as { properties?: object }).properties ?? {})) {
      return { sessionId: 'r', text: '', costUsd: 0.01, usage: { input: 300, output: 0, cache: 0 }, ok: true, structured: { verdict: 'approve', summary: '', comments: [] } };
    }
    if (task.outputSchema) return { sessionId: 'c', text: '', costUsd: 0.01, usage: { input: 50, output: 0, cache: 0 }, ok: true, structured: { answer: 'ok', actions: [] } };
    writeFileSync(join(task.cwd, 'hello.txt'), 'hello\n');
    return { sessionId: 's', text: 'done', costUsd: 0.01, usage: { input: 1000, output: 0, cache: 0 }, ok: true };
  }
}

async function world() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-uu-'));
  const repo = join(home, 'app');
  mkdirSync(repo);
  await git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# app\n');
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent = new Metered();
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: join(home, 'wt') });
  const app = await buildServer({ store, secrets, agent, orchestrator, reposDir: home });
  const auth = new Auth(store);
  const ids: Record<string, string> = {};
  for (const [name, roles] of [['pm', ['pm']], ['lead', ['lead']], ['dev', ['dev']]] as [string, Role[]][]) {
    ids[name] = (await auth.createUser({ email: `${name}@x.io`, name: name.toUpperCase(), password: 'a long test password', roles })).id;
  }
  const as = (who: string) => (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: `maestro_session=${auth.startSession(ids[who], null)}` } });
  const p = store.createProject({
    name: 'Shop', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} },
    context: '', requirements: '', bestPractices: '', workflowYaml: 'pull_before_start: false\nquality_gates: []\n',
  });
  for (const id of Object.values(ids)) store.addMember(p.id, id, null);
  store.createAgent({ name: 'W', role: 'worker', model: '' });
  const runTicket = async (who: string, title: string) => {
    const t = (await as(who)('POST', `/api/projects/${p.id}/tickets`, { title, acceptanceCriteria: 'x' })).json();
    const res = await as(who)('POST', `/api/projects/${p.id}/tickets/${t.key}/start`, {});
    if (res.statusCode !== 200) return res;
    const until = Date.now() + 10_000;
    while (['running', 'reviewing'].includes(store.getRun(res.json().id)!.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    return res;
  };
  return { app, store, ids, as, p, runTicket };
}

describe('usage by user', () => {
  it('credits worker tokens to who started the run, reviewer tokens to Maestro, chat to who asked', async () => {
    const { app, ids, as, runTicket } = await world();
    await runTicket('dev', 'One');
    await as('pm')('POST', '/api/chat', { message: 'how is it going?' });
    const rows = (await as('lead')('GET', '/api/usage/users')).json();
    const by = Object.fromEntries(rows.map((r: { userId: string; usage: { input: number } | null; runs: number; successRate: number | null }) => [r.userId, [r.usage?.input ?? 0, r.runs, r.successRate]]));
    expect(by).toEqual({ [ids.dev]: [1000, 1, 1], system: [300, 0, null], [ids.pm]: [50, 0, null] });
    expect(rows[0]).toMatchObject({ name: 'DEV', roles: ['dev'] });
    // The Dashboard's split for today.
    const today = (await as('pm')('GET', '/api/overview')).json().spend.byUser;
    expect(today.map((r: { name: string }) => r.name)).toEqual(['DEV', 'Maestro (reviewer, automatic)', 'PM']);
    // A Developer sees only their own row.
    expect((await as('dev')('GET', '/api/usage/users')).json().map((r: { userId: string }) => r.userId)).toEqual([ids.dev]);
    await app.close();
  });

  it('a per-person daily cap stops that person’s new work, not anyone else’s', async () => {
    const { app, store, as, runTicket } = await world();
    store.setSetting('budget.userDailyTokens', '1000');
    expect((await runTicket('dev', 'First')).statusCode).toBe(200);
    const refused = await runTicket('dev', 'Second');
    expect(refused.statusCode).toBe(429);
    expect(refused.json().code).toBe('user_budget_reached');
    expect(refused.json().error).toBe('DEV has used their daily budget of 1k tokens. It resets tomorrow, or a Tech Lead can raise it in Settings.');
    const chat = await as('dev')('POST', '/api/chat', { message: 'hi' });
    expect(chat.statusCode).toBe(429);
    expect((await runTicket('lead', 'Third')).statusCode).toBe(200);
    await app.close();
  });
});
