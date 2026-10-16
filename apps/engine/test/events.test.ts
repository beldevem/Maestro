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

describe('live events by project', () => {
  it('send a Developer only events of their projects; workers and global alerts to everyone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-events-'));
    const store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    const agent: CodingAgent = { run: async () => ({ sessionId: null, text: '', costUsd: 0, ok: true }) };
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home });
    const dev = { id: 'u-dev', email: 'dev@x.io', name: 'Dev', roles: ['dev' as const], mustChangePassword: false };
    const app = await buildServer({ actAs: dev, store, secrets, agent, orchestrator, reposDir: home });
    const project = (name: string) => store.createProject({ name, description: '', codeHost: { provider: 'local', localPath: home, defaultBranch: 'main' }, pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '' });
    const mine = project('Mine');
    const theirs = project('Theirs');
    store.addMember(mine.id, dev.id, null);
    const theirRun = store.createRun({ projectId: theirs.id, agentId: 'a', ticketKey: 'T-1', ticketTitle: 't', branch: 'b', worktree: '' });
    const myRun = store.createRun({ projectId: mine.id, agentId: 'a', ticketKey: 'M-1', ticketTitle: 't', branch: 'b', worktree: '' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
          if (text.includes(': connected') && !text.includes('sent')) {
            text += 'sent';
            bus.publish({ type: 'run', run: theirRun });
            bus.publish({ type: 'run_event', event: { runId: theirRun.id, message: 'secret work' } });
            bus.publish({ type: 'alert', alert: { projectId: theirs.id, message: 'their alert' } });
            bus.publish({ type: 'run', run: myRun });
            bus.publish({ type: 'alert', alert: { projectId: null, message: 'for everyone' } });
            bus.publish({ type: 'agent', agent: { id: 'last' } });
          }
          if (text.includes('"last"')) {
            req.destroy();
            resolve(text);
          }
        });
      });
      req.on('error', reject);
      req.end();
      setTimeout(() => reject(new Error('no events within 3s')), 3000);
    });
    expect(body).toContain('M-1');
    expect(body).toContain('for everyone');
    expect(body).not.toContain('T-1');
    expect(body).not.toContain('secret work');
    expect(body).not.toContain('their alert');
    await app.close();
  });
});
