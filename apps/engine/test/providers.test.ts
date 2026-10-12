import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { CliAgent, cliArgs } from '../src/agents/providers/cli.js';
import { chooseModel, listProviders, migrateProviders, type ProviderConfig } from '../src/agents/providers/config.js';
import { ProviderRouter } from '../src/agents/providers/router.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'maestro-prov-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  return { home, store, secrets };
}

class Recorder implements CodingAgent {
  tasks: AgentTask[] = [];
  async run(task: AgentTask): Promise<AgentOutcome> {
    this.tasks.push(task);
    return { sessionId: 's', text: 'claude answered', costUsd: 0, ok: true };
  }
}

describe('provider configuration', () => {
  it('migrates an existing install to Claude for every role, keeping its models', () => {
    const { store } = setup();
    store.setSetting('model.worker', 'claude-haiku-4-5-20251001');
    migrateProviders(store);
    expect(listProviders(store).map((p) => p.id)).toEqual(['claude']);
    expect(chooseModel(store, 'worker')).toEqual({ provider: 'claude', model: 'claude-haiku-4-5-20251001' });
    expect(chooseModel(store, 'reviewer')).toEqual({ provider: 'claude', model: 'claude-opus-5-5' });
    store.setSetting('provider.worker', 'ollama');
    migrateProviders(store);
    expect(store.getSetting('provider.worker')).toBe('ollama');
  });

  it('chooses the worker’s own provider, then the project’s, then the role default', () => {
    const { store } = setup();
    migrateProviders(store);
    store.setSetting('provider.worker', 'ollama');
    store.setSetting('model.worker', 'qwen3-coder:30b');
    expect(chooseModel(store, 'worker')).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
    store.setSetting('roles.p1', JSON.stringify({ worker: { provider: 'openai', model: 'gpt-4.1' } }));
    expect(chooseModel(store, 'worker', { projectId: 'p1' })).toEqual({ provider: 'openai', model: 'gpt-4.1' });
    expect(chooseModel(store, 'worker', { projectId: 'p1', agent: { provider: 'claude', model: '' } })).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
    expect(chooseModel(store, 'worker', { projectId: 'p2', agent: { provider: '', model: 'qwen3:30b' } })).toEqual({ provider: 'ollama', model: 'qwen3:30b' });
  });

  it('routes each task to its provider', async () => {
    const { home, store, secrets } = setup();
    migrateProviders(store);
    const claude = new Recorder();
    secrets.set('ANTHROPIC_API_KEY', 'sk-ant');
    const router = new ProviderRouter(store, secrets, join(home, 'sessions'), claude);
    expect((await router.run({ cwd: home, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [] })).text).toBe('claude answered');
    expect(claude.tasks[0].env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
    const missing = await router.run({ provider: 'nope', cwd: home, prompt: 'p', systemPrompt: 's', model: 'm', allowedTools: [] });
    expect(missing.error).toMatch(/No AI provider called "nope"/);
  });
});

describe('provider API', () => {
  it('adds, tests, assigns and deletes providers without exposing keys', async () => {
    const { home, store, secrets } = setup();
    migrateProviders(store);
    const agent = new Recorder();
    const app = await buildServer({ store, secrets, agent, orchestrator: new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home }), reposDir: home });
    const bad = await app.inject({ method: 'PUT', url: '/api/providers/local', payload: { name: 'Local', kind: 'openai', baseUrl: 'localhost:11434' } });
    expect(bad.json().error).toBe('The base URL must start with http:// or https://.');
    const added = await app.inject({ method: 'PUT', url: '/api/providers/local', payload: { name: 'Local', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeySecret: 'PROVIDER_LOCAL_API_KEY' } });
    expect(added.json()).toMatchObject({ id: 'local', keySet: false });
    await app.inject({ method: 'PUT', url: '/api/secrets/PROVIDER_LOCAL_API_KEY', payload: { value: 'sk-local-secret' } });
    const list = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(list.body).not.toContain('sk-local-secret');
    expect(list.json().providers.find((p: { id: string }) => p.id === 'local').keySet).toBe(true);
    expect(list.json().presets.openai.map((p: { id: string }) => p.id)).toContain('ollama');

    const test = (await app.inject({ method: 'POST', url: '/api/providers/local/test' })).json();
    expect(test.ok).toBe(false);
    expect(test.message).toMatch(/Is the server running/);

    const roles = await app.inject({ method: 'PUT', url: '/api/roles', payload: { worker: { provider: 'local', model: 'qwen3-coder:30b' } } });
    expect(roles.json().worker).toEqual({ provider: 'local', model: 'qwen3-coder:30b' });
    expect((await app.inject({ method: 'PUT', url: '/api/roles', payload: { worker: { provider: 'ghost' } } })).statusCode).toBe(400);
    const inUse = await app.inject({ method: 'DELETE', url: '/api/providers/local' });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error).toMatch(/the worker role/);
    await app.inject({ method: 'PUT', url: '/api/roles', payload: { worker: { provider: 'claude', model: '' } } });
    expect((await app.inject({ method: 'DELETE', url: '/api/providers/local' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('CLI agents', () => {
  function fakeCli(home: string, body: string): string {
    const bin = join(home, 'fake-coder');
    writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }
  const cfg = (command: string, args = ['--task', '{prompt}'], modelArgs = ['--model', '{model}']): ProviderConfig => ({
    id: 'cli', name: 'Fake CLI', kind: 'cli', baseUrl: '', apiKeySecret: '', structuredOutput: 'prompt', prices: {},
    cli: { preset: 'custom', command, args, modelArgs, timeoutMinutes: 1 },
  });

  it('fills the prompt and model into the command line', () => {
    expect(cliArgs(cfg('x').cli!, 'do it', 'm1')).toEqual(['--task', 'do it', '--model', 'm1']);
    expect(cliArgs(cfg('x').cli!, 'do it', '')).toEqual(['--task', 'do it']);
  });

  it('runs the CLI in the worktree and reads its answer and JSON', async () => {
    const { home } = setup();
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bin = fakeCli(home, `const fs=require('fs'); const p=process.argv[process.argv.indexOf('--task')+1];
fs.writeFileSync('hello.txt', 'hi\\n');
console.log(p.includes('JSON schema') ? '{"verdict":"approve"}' : 'I wrote hello.txt (' + process.cwd() + ')');`);
    const seen: string[] = [];
    const out = await new CliAgent(cfg(bin)).run({ cwd: repo, prompt: 'Say hi', systemPrompt: 'Rules.', model: '', allowedTools: [], onMessage: (m) => seen.push(m.kind) });
    expect(out).toMatchObject({ ok: true, costUsd: 0, sessionId: null });
    expect(out.text).toContain(`I wrote hello.txt (${repo})`);
    expect(seen).toEqual(['info', 'agent']);
    const json = await new CliAgent(cfg(bin)).run({ cwd: repo, prompt: 'Review', systemPrompt: 'Rules.', model: '', allowedTools: [], outputSchema: { type: 'object' } });
    expect(json.structured).toEqual({ verdict: 'approve' });
  });

  it('reports failures, a missing CLI and timeouts clearly', async () => {
    const { home } = setup();
    const fails = fakeCli(home, `console.error('no credits'); process.exit(3);`);
    expect((await new CliAgent(cfg(fails)).run({ cwd: home, prompt: 'p', systemPrompt: 's', model: '', allowedTools: [] })).error).toMatch(/exited with code 3: no credits/);
    expect((await new CliAgent(cfg('definitely-not-installed-cli')).run({ cwd: home, prompt: 'p', systemPrompt: 's', model: '', allowedTools: [] })).error).toMatch(/is not installed/);
  });

  it('works as a worker, including CLIs that commit their own work', async () => {
    const { home, store, secrets } = setup();
    const repo = join(home, 'repo');
    mkdirSync(repo);
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), '# r\n');
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    const bin = fakeCli(home, `const {execSync}=require('child_process'); require('fs').writeFileSync('done.txt','x\\n');
execSync('git add -A && git -c user.name=cli -c user.email=cli@x commit -qm "cli commit"'); console.log('Committed it myself.');`);
    store.setSetting('providers', JSON.stringify([cfg(bin)]));
    store.setSetting('provider.worker', 'cli');
    const router = new ProviderRouter(store, secrets, join(home, 'sessions'), new Recorder());
    const orchestrator = new Orchestrator({ store, secrets, agent: router, reposDir: home, worktreesDir: join(home, 'wt') });
    const p = store.createProject({
      name: 'Cli', description: '', codeHost: { provider: 'local', localPath: repo, defaultBranch: 'main' },
      pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '',
      workflowYaml: 'pull_before_start: false\nquality_gates: []\nreview:\n  enabled: false\n',
    });
    store.createAgent({ name: 'W', role: 'worker', model: '' });
    const t = store.createManualTicket(p.id, 'CLI', { title: 'Do', description: '', acceptanceCriteria: 'x', labels: [] });
    const run = await orchestrator.start(p.id, t.key);
    const until = Date.now() + 10_000;
    while (store.getRun(run.id)!.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(store.getRun(run.id)!.status).toBe('in_review');
    expect(await git(repo, ['log', '--format=%s', `main..${run.branch}`])).toBe('cli commit');
    store.db.close();
  });
});
