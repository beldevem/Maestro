import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { git } from '../src/proc.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

class FakeAssistant implements CodingAgent {
  tasks: AgentTask[] = [];
  constructor(private readonly reply: Partial<AgentOutcome> = { text: 'ok' }) {}
  async run(task: AgentTask): Promise<AgentOutcome> {
    this.tasks.push(task);
    return { sessionId: 's', text: '', costUsd: 0.01, ok: true, ...this.reply };
  }
}

async function setup(agent: CodingAgent = new FakeAssistant()) {
  const home = mkdtempSync(join(tmpdir(), 'maestro-home-'));
  const repo = join(home, 'shop');
  mkdirSync(repo);
  await git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# shop\n');
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: join(home, 'wt') });
  const app = await buildServer({ store, secrets, agent, orchestrator, reposDir: home });
  const mk = (name: string, localPath: string) => store.createProject({
    name, description: `${name} app`, codeHost: { provider: 'local', localPath, defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: `${name} requirements`, bestPractices: '',
  });
  const shop = mk('Shop', repo);
  const blog = mk('Blog', join(home, 'missing'));
  store.createManualTicket(shop.id, 'SHO', { title: 'Checkout page', description: '', acceptanceCriteria: 'x', labels: [] });
  store.createManualTicket(blog.id, 'BLO', { title: 'RSS feed', description: '', acceptanceCriteria: 'x', labels: [] });
  const worker = store.createAgent({ name: 'Worker 1', role: 'worker', model: '' });
  return { app, store, shop, blog, worker, repo };
}

describe('chat across projects', () => {
  it('knows every project and its tickets, and reads the code only of the project in focus', async () => {
    const agent = new FakeAssistant({ text: 'Two projects.' });
    const { app, shop, repo } = await setup(agent);
    const res = (await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'What is going on?' } })).json();
    expect(res.answer).toBe('Two projects.');
    expect(agent.tasks[0].systemPrompt).toContain('### Shop');
    expect(agent.tasks[0].systemPrompt).toContain('- SHO-1 [todo] Checkout page');
    expect(agent.tasks[0].systemPrompt).toContain('- BLO-1 [todo] RSS feed');
    expect(agent.tasks[0].allowedTools).toEqual([]);

    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'And the shop?', projectId: shop.id } });
    expect(agent.tasks[1].systemPrompt).toContain('### Shop (in focus)');
    expect(agent.tasks[1].cwd).toBe(repo);
    expect(agent.tasks[1].allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(agent.tasks[1].prompt).toContain('User: What is going on?\n\nAssistant: Two projects.\n\nUser: And the shop?');

    const history = (await app.inject({ method: 'GET', url: '/api/chat' })).json();
    expect(history).toHaveLength(4);
    // The project chats are separate threads.
    expect((await app.inject({ method: 'GET', url: `/api/projects/${shop.id}/chat` })).json()).toEqual([]);
    await app.inject({ method: 'DELETE', url: '/api/chat' });
    expect((await app.inject({ method: 'GET', url: '/api/chat' })).json()).toEqual([]);
    await app.close();
  });

  it('runs a confirmed action in the project it names', async () => {
    const agent = new FakeAssistant({
      structured: { answer: 'Shall I?', actions: [
        { type: 'create_ticket', project: 'blog', title: 'Add tags' },
        { type: 'create_ticket', title: 'No project given' },
        { type: 'pause_agent', agentName: 'Worker 1' },
      ] },
    });
    const { app, store, blog, worker } = await setup(agent);
    const res = (await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Add tags to the blog' } })).json();
    expect(res.actions.map((a: { summary: string }) => a.summary)).toEqual(['blog: Create ticket "Add tags"', 'Create ticket "No project given"', 'Pause Worker 1']);
    const [tag, none, pause] = res.actions.map((a: { id: string }) => a.id);
    expect((await app.inject({ method: 'POST', url: `/api/chat/actions/${tag}` })).json().message).toBe('Created BLO-2.');
    expect(store.getManualTicket(blog.id, 'BLO-2')!.title).toBe('Add tags');
    const failed = await app.inject({ method: 'POST', url: `/api/chat/actions/${none}` });
    expect(failed.json().error).toBe('Say which project this is for.');
    await app.inject({ method: 'POST', url: `/api/chat/actions/${pause}` });
    expect(store.getAgent(worker.id)!.state).toBe('paused');
    await app.close();
  });

  it('uses the model chosen for the conversation and labels each answer with it', async () => {
    const agent = new FakeAssistant({ text: 'ok' });
    const { app, store } = await setup(agent);
    store.setSetting('providers', JSON.stringify([
      { id: 'claude', name: 'Claude', kind: 'claude', baseUrl: '', apiKeySecret: 'ANTHROPIC_API_KEY', structuredOutput: 'json_schema', prices: {} },
      { id: 'ollama', name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeySecret: '', structuredOutput: 'json_schema', prices: {} },
    ]));
    store.setSetting('provider.assistant', 'ollama');
    store.setSetting('model.assistant', 'qwen3-coder:30b');
    const first = (await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })).json();
    expect(agent.tasks[0]).toMatchObject({ provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(agent.tasks[0].systemPrompt).toContain('You run on Ollama (local), model qwen3-coder:30b');
    expect(first.model).toBe('Ollama (local) · qwen3-coder:30b');

    expect((await app.inject({ method: 'PUT', url: '/api/chat/model', payload: { provider: 'ghost', model: 'x' } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/chat/model', payload: { provider: 'ollama', model: 'gpt-oss:20b' } });
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'and now?' } });
    expect(agent.tasks[1]).toMatchObject({ provider: 'ollama', model: 'gpt-oss:20b' });
    const history = (await app.inject({ method: 'GET', url: '/api/chat' })).json();
    expect(history.filter((m: { role: string }) => m.role === 'assistant').map((m: { model: string }) => m.model)).toEqual(['Ollama (local) · qwen3-coder:30b', 'Ollama (local) · gpt-oss:20b']);

    const models = (await app.inject({ method: 'GET', url: '/api/chat/models' })).json();
    expect(models.current).toEqual({ provider: 'ollama', model: 'gpt-oss:20b' });
    expect(models.default).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(models.groups.find((g: { provider: string }) => g.provider === 'claude').models).toContain('claude-opus-5-5');
    expect(models.groups.find((g: { provider: string }) => g.provider === 'ollama').error).toMatch(/Ollama \(local\) is unreachable .* Is it running\?/);

    await app.inject({ method: 'DELETE', url: '/api/chat' });
    expect((await app.inject({ method: 'GET', url: '/api/chat/models' })).json().current).toBeNull();
    await app.close();
  });

  it('fills in the project in focus for ticket actions', async () => {
    const agent = new FakeAssistant({ structured: { answer: 'ok', actions: [{ type: 'plan_backlog' }] } });
    const { app, shop } = await setup(agent);
    const res = (await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'plan it', projectId: shop.id } })).json();
    expect(res.actions[0].summary).toBe('Shop: Run the planner to draft a backlog');
    await app.close();
  });
});

describe('overview', () => {
  it('summarises projects, agents, what needs you, spend and activity', async () => {
    const { app, store, shop, worker } = await setup();
    const run = store.createRun({ projectId: shop.id, agentId: worker.id, ticketKey: 'SHO-1', ticketTitle: 'Checkout page', branch: 'b', worktree: '' });
    store.updateRun(run.id, { status: 'blocked', error: 'Tests fail' });
    store.addEvent(run.id, 'error', 'Tests fail');
    store.addSpend(shop.id, run.id, 'worker', 1.25);
    const o = (await app.inject({ method: 'GET', url: '/api/overview' })).json();
    const shopRow = o.projects.find((p: { name: string }) => p.name === 'Shop');
    expect(shopRow).toMatchObject({ tickets: { todo: 1, in_progress: 0, in_review: 0, done: 0 }, blocked: 1, spendToday: 1.25 });
    expect(o.needsYou).toEqual([expect.objectContaining({ why: 'blocked', ticketKey: 'SHO-1', projectName: 'Shop', error: 'Tests fail' })]);
    expect(o.agents.map((a: { name: string }) => a.name)).toEqual(['Worker 1']);
    expect(o.spend.today).toBe(1.25);
    expect(o.activity[0]).toMatchObject({ ticketKey: 'SHO-1', projectName: 'Shop', message: 'Tests fail' });
    await app.close();
  });
});

describe('workers and projects can be edited and deleted', () => {
  it('renames a worker, changes its model, and refuses to delete one with an active run', async () => {
    const { app, store, worker } = await setup();
    const res = await app.inject({ method: 'PATCH', url: `/api/agents/${worker.id}`, payload: { name: 'Ada', model: 'claude-opus-5-5' } });
    expect(res.json()).toMatchObject({ name: 'Ada', model: 'claude-opus-5-5', role: 'worker' });
    expect(store.getAgent(worker.id)).toMatchObject({ name: 'Ada', model: 'claude-opus-5-5' });
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/${worker.id}`, payload: { name: '' } })).statusCode).toBe(400);

    store.updateAgent(worker.id, { state: 'working', currentRunId: 'r1' });
    const refused = await app.inject({ method: 'DELETE', url: `/api/agents/${worker.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/working on a ticket/);
    store.updateAgent(worker.id, { state: 'available', currentRunId: null });
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${worker.id}` })).statusCode).toBe(200);
    expect(store.getAgent(worker.id)).toBeUndefined();
    await app.close();
  });

  it('edits every project field and keeps the rest', async () => {
    const { app, store, blog } = await setup();
    await app.inject({ method: 'PATCH', url: `/api/projects/${blog.id}`, payload: { name: 'Journal', description: 'Writing', bestPractices: 'Short posts.' } });
    expect(store.getProject(blog.id)).toMatchObject({ name: 'Journal', description: 'Writing', bestPractices: 'Short posts.', requirements: 'Blog requirements' });
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${blog.id}`, payload: { name: ' ' } })).statusCode).toBe(400);
    await app.close();
  });
});
