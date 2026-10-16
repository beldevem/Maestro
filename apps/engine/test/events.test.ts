import { ADMIN } from './users.js';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { bus } from '../src/events.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

describe('live events', () => {
  it('opens at once, streams bus events and allows no other origin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-events-'));
    const store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    const agent: CodingAgent = { run: async () => ({ sessionId: null, text: '', costUsd: 0, ok: true }) };
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home });
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: home });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const received = await new Promise<{ headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { Origin: 'https://evil.example' } }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes(': connected')) bus.publish({ type: 'agent', agent: { id: 'a1' } });
          if (body.includes('"a1"')) {
            req.destroy();
            resolve({ headers: res.headers, body });
          }
        });
      });
      req.on('error', reject);
      req.end();
      setTimeout(() => reject(new Error('no events within 3s')), 3000);
    });
    expect(received.headers['content-type']).toBe('text/event-stream');
    expect(received.headers['access-control-allow-origin']).toBeUndefined();
    expect(received.body).toContain('data: {"type":"agent","agent":{"id":"a1"}}');
    await app.close();
    store.db.close();
  });
});
