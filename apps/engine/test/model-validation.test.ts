import { ADMIN } from './users.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateProviders, type ProviderConfig } from '../src/agents/providers/config.js';
import { modelProblem } from '../src/agents/providers/validate.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

const ollama: ProviderConfig = { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } as ProviderConfig;
const claude: ProviderConfig = { id: 'claude', name: 'Claude', kind: 'claude' } as ProviderConfig;
const cli: ProviderConfig = { id: 'copilot', name: 'Copilot', kind: 'cli', cli: { command: 'copilot' } } as ProviderConfig;

describe('modelProblem', () => {
  it('accepts the default model on any provider', async () => {
    for (const p of [ollama, claude, cli]) expect(await modelProblem(p, '  ', async () => [])).toBe('');
  });
  it('checks Claude against its known models', async () => {
    expect(await modelProblem(claude, 'claude-sonnet-5-5', async () => [])).toBe('');
    expect(await modelProblem(claude, 'qwen3-coder:30b', async () => [])).toMatch(/doesn't offer "qwen3-coder:30b"/);
  });
  it('lets a CLI use any model its own config allows', async () => {
    expect(await modelProblem(cli, 'anything', async () => { throw new Error('never asked'); })).toBe('');
  });
  it('checks an OpenAI-compatible server against what it lists', async () => {
    const list = async () => ['qwen3-coder:30b', 'gpt-oss:20b'];
    expect(await modelProblem(ollama, 'gpt-oss:20b', list)).toBe('');
    expect(await modelProblem(ollama, 'claude-opus-5-5', list)).toMatch(/Available: qwen3-coder:30b, gpt-oss:20b/);
  });
  it('keeps the choice when the server is unreachable or slow', async () => {
    expect(await modelProblem(ollama, 'x', async () => { throw new Error('ECONNREFUSED'); })).toBe('');
    expect(await modelProblem(ollama, 'x', () => new Promise(() => {}), 20)).toBe('');
  });
});

describe('model validation on the API', () => {
  it('rejects a model the provider does not offer, everywhere a model is chosen', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-mv-'));
    const store = new Store(join(home, 'db.sqlite'));
    const secrets = new SecretStore(join(home, 's.json'));
    migrateProviders(store);
    const agent = { run: async () => ({ sessionId: '', text: '', costUsd: 0, ok: true }) };
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
    const roles = await app.inject({ method: 'PUT', url: '/api/roles', payload: { worker: { provider: 'claude', model: 'qwen3-coder:30b' } } });
    expect(roles.statusCode).toBe(400);
    expect(roles.json().error).toMatch(/doesn't offer/);
    expect((await app.inject({ method: 'PUT', url: '/api/roles', payload: { worker: { provider: 'claude', model: 'claude-haiku-4-5-20251001' } } })).statusCode).toBe(200);
    const t = (await app.inject({ method: 'POST', url: '/api/chat/threads', payload: {} })).json();
    expect((await app.inject({ method: 'PATCH', url: `/api/chat/threads/${t.id}`, payload: { model: { provider: 'claude', model: 'gpt-oss:20b' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'W', provider: 'claude', model: 'nope' } })).statusCode).toBe(400);
    const w = (await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'W', provider: 'claude', model: '' } })).json();
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/${w.id}`, payload: { model: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/${w.id}`, payload: { model: 'claude-opus-5-5' } })).json().model).toBe('claude-opus-5-5');
    await app.close();
  });
});
