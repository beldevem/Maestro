import { ADMIN } from './users.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { parseActions } from '../src/agents/assistant.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

class FakeAssistant implements CodingAgent {
  tasks: AgentTask[] = [];
  constructor(private readonly reply: Partial<AgentOutcome>) {}
  async run(task: AgentTask): Promise<AgentOutcome> {
    this.tasks.push(task);
    return { sessionId: 's', text: '', costUsd: 0.01, ok: true, ...this.reply };
  }
}

async function setup(agent: CodingAgent) {
  const home = mkdtempSync(join(tmpdir(), 'maestro-chat-'));
  const store = new Store(join(home, 'db.sqlite'));
  const secrets = new SecretStore(join(home, 's.json'));
  const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: home, worktreesDir: home });
  const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: home });
  const p = store.createProject({
    name: 'Chatty', description: '', codeHost: { provider: 'local', localPath: join(home, 'none'), defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, context: '', requirements: '', bestPractices: '',
  });
  const worker = store.createAgent({ name: 'Worker 2', role: 'worker', model: '' });
  store.createManualTicket(p.id, 'CHA', { title: 'Existing', description: '', acceptanceCriteria: 'x', labels: [] });
  return { app, store, p, worker };
}

describe('chat actions', () => {
  it('proposes actions without running them, and runs each once when confirmed', async () => {
    const agent = new FakeAssistant({
      structured: {
        answer: 'I can create the ticket, move CHA-1 and pause Worker 2.',
        actions: [
          { type: 'create_ticket', title: 'Add logout', description: null, acceptanceCriteria: '- logs out', size: 'S', labels: ['area:auth'], ticketKey: null, status: null, agentName: null },
          { type: 'move_ticket', ticketKey: 'CHA-1', status: 'done' },
          { type: 'pause_agent', agentName: 'worker 2' },
          { type: 'delete_everything' },
          { type: 'assign' },
        ],
      },
    });
    const { app, store, p, worker } = await setup(agent);
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat`, payload: { message: 'Add a logout ticket, close CHA-1, pause Worker 2' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toContain('I can create');
    expect(body.actions.map((a: { summary: string }) => a.summary)).toEqual(['Create ticket "Add logout" (S)', 'Move CHA-1 to done', 'Pause worker 2']);
    expect(agent.tasks[0].systemPrompt).toContain('- Worker 2 (worker): available');
    expect(agent.tasks[0].allowedTools).toEqual(['Read', 'Glob', 'Grep']);

    // Nothing happened yet.
    expect(store.listManualTickets(p.id)).toHaveLength(1);
    expect(store.getAgent(worker.id)!.state).toBe('available');

    const [create, move, pause] = body.actions.map((a: { id: string }) => a.id);
    const created = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${create}` });
    expect(created.json().message).toBe('Created CHA-2.');
    expect(store.getManualTicket(p.id, 'CHA-2')).toMatchObject({ title: 'Add logout', size: 'S', labels: ['area:auth'] });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${create}` })).statusCode).toBe(404);

    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${move}` });
    expect(store.getManualTicket(p.id, 'CHA-1')!.status).toBe('done');

    await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/chat/actions/${pause}` });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${pause}` })).statusCode).toBe(404);
    expect(store.getAgent(worker.id)!.state).toBe('available');
    await app.close();
  });

  it('reports a failed action instead of pretending', async () => {
    const { app, p } = await setup(new FakeAssistant({ structured: { answer: 'Moving it.', actions: [{ type: 'move_ticket', ticketKey: 'CHA-99', status: 'done' }] } }));
    const id = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat`, payload: { message: 'close CHA-99' } })).json().actions[0].id;
    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${id}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('CHA-99 not found');
    await app.close();
  });

  it('falls back to plain text answers, and never reads the engine folder when the repo is missing', async () => {
    const agent = new FakeAssistant({ text: 'Just an answer.' });
    const { app, p } = await setup(agent);
    const res = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat`, payload: { message: 'hi' } })).json();
    expect(res).toMatchObject({ answer: 'Just an answer.', actions: [] });
    // The reply says which model answered, as on the dashboard chat.
    expect(res.model).toMatch(/\S/);
    expect(agent.tasks[0].cwd).not.toBe(process.cwd());
    await app.close();
  });

  it('keeps the conversation and action states, and gives the assistant the history', async () => {
    const agent = new FakeAssistant({ structured: { answer: 'Shall I add it?', actions: [{ type: 'create_ticket', title: 'Add logout' }] } });
    const { app, store, p } = await setup(agent);
    const first = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat`, payload: { message: 'We need logout' } })).json();
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${first.actions[0].id}` });
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat`, payload: { message: 'Thanks' } });
    expect(agent.tasks[1].prompt).toBe('User: We need logout\n\nAssistant: Shall I add it?\n\nUser: Thanks');

    const history = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/chat` })).json();
    expect(history.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)).toEqual([
      'user: We need logout', 'assistant: Shall I add it?', 'user: Thanks', 'assistant: Shall I add it?',
    ]);
    expect(history[1].actions[0]).toMatchObject({ summary: 'Create ticket "Add logout"', state: 'done', result: 'Created CHA-2.' });
    expect(history[3].actions[0].state).toBe('pending');

    // A new engine (restart) still knows the pending proposal, and a cleared chat forgets it.
    expect(store.getChatAction(p.id, history[3].actions[0].id)!.state).toBe('pending');
    await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/chat` });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/chat` })).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${history[3].actions[0].id}` })).statusCode).toBe(404);
    await app.close();
  });

  it('records a failed action', async () => {
    const { app, store, p } = await setup(new FakeAssistant({ structured: { answer: 'Moving it.', actions: [{ type: 'move_ticket', ticketKey: 'CHA-99', status: 'done' }] } }));
    const id = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat`, payload: { message: 'close CHA-99' } })).json().actions[0].id;
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/chat/actions/${id}` });
    expect(store.getChatAction(p.id, id)).toMatchObject({ state: 'failed', result: 'Ticket CHA-99 not found.' });
    await app.close();
  });

  it('drops malformed actions', () => {
    expect(parseActions([{ type: 'assign', ticketKey: 'A-1' }, { type: 'assign' }, null, 'x'])).toEqual([{ type: 'assign', ticketKey: 'A-1' }]);
    expect(parseActions(undefined)).toEqual([]);
  });
});
