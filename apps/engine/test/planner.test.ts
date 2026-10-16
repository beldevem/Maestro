import { ADMIN } from './users.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask, CodingAgent } from '../src/agents/coding-agent.js';
import { Store } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

const BACKLOG = {
  tickets: [
    { title: 'Parse the name argument', description: 'Read the name.', acceptanceCriteria: '- `greet Ann` reads Ann', size: 's', labels: ['area:cli'], dependsOn: [] },
    { title: 'Print the greeting', description: 'Say hello.', acceptanceCriteria: ['Prints "Hello, Ann!"'], size: 'S', labels: ['area:output'], dependsOn: [0, 0, 5] },
  ],
};

/** Answers like the planner: with structured output, or with a ```json block when `asText` is set. */
class FakePlanner implements CodingAgent {
  calls: AgentTask[] = [];
  constructor(private readonly asText = false) {}
  async run(task: AgentTask): Promise<AgentOutcome> {
    this.calls.push(task);
    return this.asText
      ? { sessionId: 's', text: `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(BACKLOG)}\n\`\`\``, costUsd: 0.2, ok: true }
      : { sessionId: 's', text: 'Done.', costUsd: 0.3, ok: true, structured: BACKLOG };
  }
}

describe('planner and backlog drafts', () => {
  let home: string;
  let store: Store;
  let secrets: SecretStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'maestro-plan-'));
    store = new Store(join(home, 'db.sqlite'));
    secrets = new SecretStore(join(home, 'secrets.json'));
  });
  afterEach(() => store.db.close());

  async function setup(agent: CodingAgent) {
    const orchestrator = new Orchestrator({ store, secrets, agent, reposDir: join(home, 'repos'), worktreesDir: join(home, 'wt') });
    const app = await buildServer({ actAs: ADMIN, store, secrets, agent, orchestrator, reposDir: join(home, 'repos') });
    const res = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'Greeter', codeHost: { provider: 'local', localPath: join(home, 'missing'), defaultBranch: 'main' }, requirements: 'A CLI that greets the user by name' },
    });
    return { app, projectId: res.json().id as string };
  }

  it('stores a draft from structured output, with read-only tools and the planner model', async () => {
    const agent = new FakePlanner();
    const { app, projectId } = await setup(agent);
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'model.planner': 'planner-model' } });
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/plan` });
    expect(res.statusCode).toBe(200);
    const draft = res.json();
    expect(draft.status).toBe('draft');
    expect(draft.costUsd).toBe(0.3);
    expect(draft.items.map((i: { title: string }) => i.title)).toEqual(['Parse the name argument', 'Print the greeting']);
    expect(draft.items[0].size).toBe('S');
    expect(draft.items[1].dependsOn).toEqual([0]);
    expect(draft.items[1].acceptanceCriteria).toBe('- Prints "Hello, Ann!"');
    expect(agent.calls[0].allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(agent.calls[0].model).toBe('planner-model');
    expect(agent.calls[0].outputSchema).toBeDefined();
    expect(agent.calls[0].systemPrompt).toContain('A CLI that greets the user by name');

    const drafts = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/drafts` });
    expect(drafts.json()).toHaveLength(1);
    await app.close();
  });

  it('falls back to the first json block in the text', async () => {
    const { app, projectId } = await setup(new FakePlanner(true));
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/plan` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
    expect(res.json().costUsd).toBe(0.2);
    await app.close();
  });

  it('approves a draft into ordered tickets with mapped dependencies', async () => {
    const { app, projectId } = await setup(new FakePlanner());
    const draft = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/plan` })).json();

    const edited = await app.inject({
      method: 'PATCH', url: `/api/drafts/${draft.id}`,
      payload: { items: [...draft.items, { title: 'Document usage', acceptanceCriteria: '- README shows usage', size: 'XS', labels: ['docs'], dependsOn: [0, 1] }] },
    });
    expect(edited.json().items).toHaveLength(3);

    const approved = await app.inject({ method: 'POST', url: `/api/drafts/${draft.id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().error).toBeNull();
    expect(approved.json().created.map((t: { key: string }) => t.key)).toEqual(['GRE-1', 'GRE-2', 'GRE-3']);
    expect(approved.json().draft.status).toBe('approved');
    expect(store.getManualTicket(projectId, 'GRE-3')!.description).toContain('Depends on: GRE-1, GRE-2');

    const again = await app.inject({ method: 'POST', url: `/api/drafts/${draft.id}/approve` });
    expect(again.statusCode).toBe(409);

    const tickets = async () => Object.fromEntries((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/tickets` })).json()
      .map((t: { key: string; dependsOn: string[]; blockedBy: string[] }) => [t.key, t]));
    let byKey = await tickets();
    expect(byKey['GRE-1'].blockedBy).toEqual([]);
    expect(byKey['GRE-2'].dependsOn).toEqual(['GRE-1']);
    expect(byKey['GRE-2'].blockedBy).toEqual(['GRE-1']);
    expect(byKey['GRE-3'].blockedBy).toEqual(['GRE-1', 'GRE-2']);

    const marked = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/tickets/GRE-1/status`, payload: { status: 'done' } });
    expect(marked.json().status).toBe('done');
    byKey = await tickets();
    expect(byKey['GRE-2'].blockedBy).toEqual([]);
    expect(byKey['GRE-3'].blockedBy).toEqual(['GRE-2']);
    await app.close();
  });

  it('keeps the tickets created before a failure and finishes on the next approve', async () => {
    const { app, projectId } = await setup(new FakePlanner());
    const draft = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/plan` })).json();
    const original = store.createManualTicket.bind(store);
    let calls = 0;
    store.createManualTicket = (...args) => {
      if (++calls === 2) throw new Error('PM tool is down');
      return original(...args);
    };

    const first = (await app.inject({ method: 'POST', url: `/api/drafts/${draft.id}/approve` })).json();
    expect(first.created).toHaveLength(1);
    expect(first.error).toContain('PM tool is down');
    expect(first.draft.status).toBe('draft');

    const second = (await app.inject({ method: 'POST', url: `/api/drafts/${draft.id}/approve` })).json();
    expect(second.error).toBeNull();
    expect(second.created.map((t: { key: string }) => t.key)).toEqual(['GRE-2']);
    expect(store.dependencies(projectId).get('GRE-2')).toEqual(['GRE-1']);
    await app.close();
  });

  it('discards a draft', async () => {
    const { app, projectId } = await setup(new FakePlanner());
    const draft = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/plan` })).json();
    expect((await app.inject({ method: 'POST', url: `/api/drafts/${draft.id}/discard` })).json().status).toBe('discarded');
    expect((await app.inject({ method: 'PATCH', url: `/api/drafts/${draft.id}`, payload: { items: [] } })).statusCode).toBe(409);
    await app.close();
  });
});
