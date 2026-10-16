import { ADMIN, gitFolder } from './users.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

describe('request guards', () => {
  let app: FastifyInstance;
  let store: Store;
  const project = { name: 'X', codeHost: { provider: 'local', localPath: gitFolder(), defaultBranch: 'main' } };

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-sec-'));
    store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    const agent: CodingAgent = { run: async () => ({ sessionId: null, text: '', costUsd: 0, ok: true }) };
    app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
  });
  afterEach(async () => {
    await app.close();
    store.db.close();
    delete process.env.MAESTRO_ALLOWED_HOSTS;
  });

  it('answers on localhost addresses', async () => {
    for (const host of ['127.0.0.1:4800', 'localhost:4800', '[::1]:4800', 'localhost']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('refuses other host names (DNS rebinding)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: 'evil.example:4800' }, payload: project });
    expect(res.statusCode).toBe(403);
    expect(store.listProjects()).toHaveLength(0);
  });

  it('refuses writes sent from other sites, including simple text/plain posts', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/projects', headers: { host: '127.0.0.1:4800', origin: 'https://evil.example', 'content-type': 'text/plain' },
      payload: JSON.stringify(project),
    });
    expect(res.statusCode).toBe(403);
    const nullOrigin = await app.inject({ method: 'POST', url: '/api/alerts/read', headers: { host: '127.0.0.1:4800', origin: 'null' }, payload: {} });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it('accepts writes from the dashboard and the dev server', async () => {
    for (const origin of ['http://127.0.0.1:4800', 'http://localhost:4200']) {
      const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: '127.0.0.1:4800', origin }, payload: project });
      expect(res.statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { host: '127.0.0.1:4800' }, payload: project })).statusCode).toBe(200);
  });

  it('allows extra host names you list', async () => {
    process.env.MAESTRO_ALLOWED_HOSTS = 'maestro.lan';
    await app.close();
    const home = mkdtempSync(join(tmpdir(), 'maestro-sec-'));
    const s2 = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    const agent: CodingAgent = { run: async () => ({ sessionId: null, text: '', costUsd: 0, ok: true }) };
    app = await buildServer({ actAs: ADMIN, store: s2, secrets, agent, orchestrator: new Orchestrator({ store: s2, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'maestro.lan:4800' } })).statusCode).toBe(200);
    s2.db.close();
  });
});
