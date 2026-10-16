import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveProviders } from '../src/agents/providers/config.js';
import { Store } from '../src/db.js';
import { classify } from '../src/errors.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { selfCheck } from '../src/selfcheck.js';
import { buildServer } from '../src/server.js';
import { ADMIN, gitFolder } from './users.js';

async function world() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-edge-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const agent = { run: async () => ({ sessionId: 's', text: 'ok', costUsd: 0, ok: true, structured: { answer: 'Fine.', actions: [] } }) };
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt') });
  const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: join(home, 'repos') });
  return { home, store, secrets, app, orchestrator };
}
const local = (localPath: string) => ({ name: 'P', codeHost: { provider: 'local', localPath, defaultBranch: 'main' } });

describe('errors people can act on', () => {
  it('a local folder must exist, be a full path and be a git repository', async () => {
    const { home, app } = await world();
    const post = (body: object) => app.inject({ method: 'POST', url: '/api/projects', payload: body }).then((r) => [r.statusCode, r.json().code, r.json().hint ?? '']);
    expect(await post(local(join(home, 'nope')))).toEqual([400, 'folder_missing', 'Check the path, or use Browse….']);
    expect((await post(local('relative/app')))[1]).toBe('folder_relative');
    mkdirSync(join(home, 'plain'));
    expect(await post(local(join(home, 'plain')))).toEqual([400, 'not_git_repo', 'Run "git init" there and make a first commit, then save again.']);
    expect((await post({ name: 'G', codeHost: { provider: 'github', repo: '', defaultBranch: 'main' } }))[1]).toBe('repo_missing');
    expect((await post({ name: 'G', codeHost: { provider: 'github', repo: 'just-a-name', defaultBranch: 'main' } }))[1]).toBe('repo_invalid');
    expect((await post(local(gitFolder())))[0]).toBe(200);
    // Editing the folder is checked the same way.
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: local(gitFolder()) })).json();
    const bad = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { codeHost: { provider: 'local', localPath: join(home, 'gone'), defaultBranch: 'main' } } });
    expect(bad.json().code).toBe('folder_missing');
    await app.close();
  });

  it('a project with a run still working can’t be deleted', async () => {
    const { store, app } = await world();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: local(gitFolder()) })).json();
    store.createRun({ projectId: p.id, agentId: 'a', ticketKey: 'P-1', ticketTitle: 't', branch: 'b', worktree: '' });
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'project_busy', error: '1 run is still working in this project (P-1).', hint: 'Stop them on the run page first, then delete the project.' });
    await app.close();
  });

  it('starting a ticket without workers says what to do', async () => {
    const { app } = await world();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: local(gitFolder()) })).json();
    const t = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/tickets`, payload: { title: 'x', acceptanceCriteria: 'y' } })).json();
    const res = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/tickets/${t.key}/start`, payload: {} })).json();
    expect(res).toMatchObject({ code: 'no_workers', hint: 'A Tech Lead can add one on the Workers page.' });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/tickets/NOPE-9/start`, payload: {} })).json().code).toBe('ticket_not_found');
    await app.close();
  });

  it('the chat says when a project’s tickets couldn’t be read, and refuses huge messages', async () => {
    const { store, app } = await world();
    store.createProject({ name: 'Jira one', description: '', codeHost: { provider: 'local', localPath: gitFolder(), defaultBranch: 'main' }, pm: { provider: 'jira', settings: { baseUrl: 'http://127.0.0.1:9', projectKey: 'J', email: 'a@b.c' } }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '' });
    const res = (await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'status?' } })).json();
    expect(res.answer).toBe('Fine.');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^Couldn't read the tickets of Jira one \(.+\), so the answer leaves them out\.$/);
    const huge = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'x'.repeat(20_001) } });
    expect(huge.json()).toMatchObject({ code: 'invalid_input', error: 'message: Keep a message under 20,000 characters; attach less context or split it.' });
    expect((await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '   ' } })).json().error).toBe('message: Write a question first.');
    await app.close();
  });

  it('low-level failures become codes with a fix', () => {
    expect(classify(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))?.code).toBe('disk_full');
    expect(classify(new Error('database is locked'))?.code).toBe('db_busy');
    expect(classify(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'Jira')).toMatchObject({ code: 'unreachable', message: 'Jira could not be reached.' });
    expect(classify(new Error('EACCES: permission denied, open /data/x'))?.code).toBe('permission_denied');
    expect(classify(new Error('something else'))).toBeNull();
  });

  it('a broken secrets file is reported, not crashed on', () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-edge-'));
    writeFileSync(join(home, 's.json'), '{ not json');
    const secrets = new SecretStore(join(home, 's.json'));
    expect(() => secrets.names()).toThrow(/is not valid JSON/);
  });
});

describe('self-check', () => {
  it('reports what would stop Maestro, with fixes', async () => {
    const { home, store, secrets } = await world();
    store.createProject({ name: 'Lost', description: '', codeHost: { provider: 'local', localPath: join(home, 'deleted'), defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '' });
    saveProviders(store, [{ id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeySecret: '', structuredOutput: 'json_schema', prices: {} }]);
    const checks = await selfCheck({ store, secrets, home });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.data_dir.level).toBe('ok');
    expect(by.database).toMatchObject({ level: 'ok', message: 'OK (schema 5).' });
    expect(by.git.level).toBe('ok');
    expect(by.workers).toMatchObject({ level: 'warning', hint: 'Add one on the Workers page.' });
    expect(Object.values(by).find((c) => c.label === 'Project Lost')).toMatchObject({ level: 'error', message: expect.stringContaining('is missing') });
    expect(by.provider_ollama).toMatchObject({ level: 'warning', message: expect.stringContaining("can't be reached") });
  });

  it('is offered to Tech Leads on the API', async () => {
    const { app } = await world();
    const res = await app.inject({ method: 'GET', url: '/api/system/checks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['data_dir', 'database', 'secrets', 'git', 'workers']));
    await app.close();
  });
});
