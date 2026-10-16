import { ADMIN } from './users.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { migrateProviders } from '../src/agents/providers/config.js';
import { MIGRATIONS, Store } from '../src/db.js';
import { timedFetch } from '../src/http.js';
import { createLogger, redact, registerSecret } from '../src/log.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

function capture(level = 'debug', format = 'json') {
  const lines: string[] = [];
  return { lines, log: createLogger({ level, format, sink: { write: (l) => lines.push(l) } }) };
}

describe('logging', () => {
  it('writes JSON lines with a level, hiding lower levels', () => {
    const { lines, log } = capture('info');
    log.debug('noise');
    log.info('Engine up', { port: 4800 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', msg: 'Engine up', port: 4800 });
  });

  it('never writes a secret', () => {
    const { lines, log } = capture();
    registerSecret('hunter2-very-private');
    log.error('Push failed for https://bob:pa55word@github.com/x/y.git with sk-ant-abcdefghijklmnop1234', {
      apiKey: 'plain-value',
      headers: { Authorization: 'Bearer abc.def.ghi' },
      detail: 'token ghp_abcdefghijklmnopqrstuvwxyz0123 and hunter2-very-private',
      error: new Error('401 for glpat-abcdefghijklmnopqrst'),
    });
    const out = lines.join('\n');
    for (const s of ['pa55word', 'sk-ant-abcdef', 'plain-value', 'abc.def.ghi', 'ghp_abc', 'hunter2', 'glpat-abc']) expect(out).not.toContain(s);
    expect(out).toContain('https://***@github.com');
  });

  it('masks secrets in plain text too', () => {
    expect(redact('Authorization: Bearer abcdefghijkl')).toBe('Authorization: Bearer ***');
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });
});

describe('database', () => {
  it('migrates a new database to the latest version, and again is a no-op', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'maestro-db-')), 'db.sqlite');
    const a = new Store(file);
    expect(a.schemaVersion()).toBe(MIGRATIONS.length);
    a.createAgent({ name: 'W', role: 'worker', model: '' });
    a.close();
    const b = new Store(file);
    expect(b.schemaVersion()).toBe(MIGRATIONS.length);
    expect(b.listAgents()).toHaveLength(1);
    expect((b.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
    b.close();
  });

  it('upgrades a database from before versioning, keeping its data', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'maestro-db-')), 'db.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'available', current_run_id TEXT, note TEXT NOT NULL DEFAULT '');
      INSERT INTO agents (id, name, role, model) VALUES ('a1', 'Old worker', 'worker', '');`);
    old.close();
    const s = new Store(file);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    expect(s.getAgent('a1')).toMatchObject({ name: 'Old worker', provider: '' });
    s.close();
  });

  it('moves dollar budgets into euro budgets when tokens become the measure', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'maestro-db-')), 'db.sqlite');
    const a = new Store(file);
    a.db.exec('PRAGMA user_version = 2');
    for (const [k, v] of [['budget.perRunUsd', '5'], ['budget.projectDailyUsd', '0'], ['budget.daily.p1', '2'], ['currency.eurPerUsd', '0.9']]) a.setSetting(k, v);
    a.close();
    const b = new Store(file);
    expect(b.schemaVersion()).toBe(MIGRATIONS.length);
    expect(b.getSetting('budget.perRunEur')).toBe('4.5');
    expect(b.getSetting('budget.projectDailyEur')).toBeUndefined();
    expect(b.getSetting('budget.dailyEur.p1')).toBe('1.8');
    for (const old of ['budget.perRunUsd', 'budget.projectDailyUsd', 'budget.daily.p1']) expect(b.getSetting(old)).toBeUndefined();
    // Runs from before token counts show no usage (n/a), not zero.
    const run = b.createRun({ projectId: 'p1', agentId: 'a', ticketKey: 'K-1', ticketTitle: 't', branch: 'b', worktree: '' });
    expect(b.getRun(run.id)!.usage).toBeNull();
    b.close();
  });

  it('turns the one Dashboard conversation into the first of several, keeping its model', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'maestro-db-')), 'db.sqlite');
    const a = new Store(file);
    a.db.exec('PRAGMA user_version = 3');
    a.db.exec('DROP TABLE chat_threads');
    a.addChatMessage('', 'user', 'Which tickets are blocked, and why?');
    const answer = a.addChatMessage('', 'assistant', 'None.');
    a.addChatAction('', answer.id, { type: 'create_ticket', summary: 'x', action: {} });
    a.setSetting('chat.model', JSON.stringify({ provider: 'ollama', model: 'gpt-oss:20b' }));
    a.close();
    const b = new Store(file);
    const [t] = b.listThreads();
    expect(t).toMatchObject({ title: 'Which tickets are blocked, and why?', model: { provider: 'ollama', model: 'gpt-oss:20b' }, messages: 2 });
    expect(b.listChat(`chat:${t.id}`)[1].actions).toHaveLength(1);
    expect(b.listChat('')).toEqual([]);
    expect(b.getSetting('chat.model')).toBeUndefined();
    b.close();
  });

  it('refuses a database from a newer Maestro', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'maestro-db-')), 'db.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
    db.close();
    expect(() => new Store(file)).toThrow(/newer Maestro/);
  });
});

describe('outbound calls', () => {
  it('give up after the timeout with a clear message', async () => {
    const { createServer } = await import('node:http');
    const server = createServer(() => undefined).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    await expect(timedFetch(100)(`http://127.0.0.1:${port}/`)).rejects.toThrow(/No answer within 0 seconds/);
    server.closeAllConnections();
    server.close();
  });
});

class Slow implements CodingAgent {
  async run(task: AgentTask): Promise<AgentOutcome> {
    return new Promise((_, reject) => task.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  }
}

describe('shutdown', () => {
  it('reports ready, then not ready once shutting down', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-sd-'));
    const store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    migrateProviders(store);
    const agent = new Slow();
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home });
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: home });
    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true, schema: MIGRATIONS.length });
    expect(await orchestrator.shutdown(100)).toBe(0);
    expect((await orchestrator.tick())).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(503);
    await app.close();
  });
});
